/**
 * Read-side collector for the release pulse (#1482).
 *
 * Mirrors the pure-derivation/reader split of `observability-snapshot.ts`:
 * this module only runs findMany queries against Dispatch's Postgres cache
 * and hands plain rows to the pure `buildReleasePulse`. No GitHub/forge
 * calls, no model calls, no writes; errors propagate to the caller (the
 * route's `handleApiError`) rather than degrading silently.
 *
 * The gate is checked before any issue/event read: a repo whose release
 * delta is not `identical`/`ahead` (or whose baseline lacks a publication
 * time) cannot produce a pulse, so fleet views for such repos stay cheap —
 * the pure module already renders the non-ready snapshot from the repo row
 * alone.
 */
import { prisma } from "@/lib/prisma";
import {
  buildReleasePulse,
  isReleasePulseReady,
  type ReleasePulseEventInput,
  type ReleasePulseIssueInput,
  type ReleasePulseRepoInput,
  type ReleasePulseSnapshot,
} from "@/lib/release-pulse";
import { toLifecycleEventRecord } from "@/lib/issue-lifecycle-read";
import {
  deriveReleaseReadiness,
  releaseCiStatus,
  type ReleaseReadiness,
} from "@/lib/release-readiness";

import type { ReleaseDeltaState } from "./automation-sync";

/**
 * Merge/close/reopen evidence the pure pulse consumes. `pr_merged` rows are
 * read across ALL intervals: a delivered issue's highlight retains links to
 * every authoritative merged PR (#1482), including pre-baseline ones.
 * Close/reopen rows only concern post-baseline closes, so they keep the
 * baseline filter.
 */
const POST_BASELINE_EVENT_KINDS = ["completed", "issue_closed", "issue_reopened"];

/** Fail-closed narrowing of the persisted string column into the delta state. */
export function asReleaseDeltaState(value: string): ReleaseDeltaState {
  switch (value) {
    case "identical":
    case "ahead":
    case "diverged":
    case "no-baseline":
      return value;
    default:
      return "unknown";
  }
}

function toReleasePulseEvent(row: {
  kind: string;
  source: string;
  actor: string;
  agentName: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  sourceEventId: string | null;
  occurredAt: Date;
  observedAt: Date;
  metadata: unknown;
  issueNumber: number;
}): ReleasePulseEventInput {
  return { ...toLifecycleEventRecord(row), issueNumber: row.issueNumber };
}

export async function collectReleasePulse(
  repo: ReleasePulseRepoInput,
): Promise<ReleasePulseSnapshot> {
  // Gate (shared helper from the pure module, so the two can never drift),
  // checked before any issue/event read so fleet views for non-ready repos
  // stay cheap. The parseability half of the guard also keeps an unparseable
  // string baseline from reaching Prisma as an Invalid Date.
  if (!isReleasePulseReady(repo) || repo.releaseBaselinePublishedAt === null) {
    return buildReleasePulse(repo, [], []);
  }
  const baselineDate = new Date(repo.releaseBaselinePublishedAt);

  const eventRows = await prisma.issueLifecycleEvent.findMany({
    where: {
      repoFullName: repo.fullName,
      // Merge evidence is needed across every interval (a delivered issue's
      // highlight retains pre-baseline PR links); close/reopen evidence is
      // baseline-scoped.
      OR: [
        { kind: "pr_merged" },
        { kind: { in: POST_BASELINE_EVENT_KINDS }, occurredAt: { gte: baselineDate } },
      ],
    },
    orderBy: { occurredAt: "asc" },
  });
  const events = eventRows.map(toReleasePulseEvent);

  const eventIssueNumbers = [...new Set(events.map((event) => event.issueNumber))];

  const issueRows = await prisma.issue.findMany({
    where: {
      repository: { fullName: repo.fullName },
      OR: [
        // Open issues can still be merge-delivered (timeline delivery
        // "merged"), so numbers with merge evidence count regardless of
        // state. The arm is dropped when no events matched — an empty `in`
        // is built conditionally on purpose.
        ...(eventIssueNumbers.length > 0 ? [{ number: { in: eventIssueNumbers } }] : []),
        { state: "closed" },
        { decomposed: true, followUpUrls: { isEmpty: false } },
      ],
    },
    select: {
      number: true,
      title: true,
      url: true,
      state: true,
      closedAt: true,
      labels: true,
      releaseSignal: true,
      decomposed: true,
      followUpUrls: true,
    },
  });

  const issues: ReleasePulseIssueInput[] = issueRows.map((row) => ({
    number: row.number,
    title: row.title,
    url: row.url,
    state: row.state,
    closedAt: row.closedAt,
    labels: row.labels,
    // Raw persisted value; the pure module normalizes tombstones.
    releaseSignal: row.releaseSignal,
    decomposed: row.decomposed,
    followUpUrls: row.followUpUrls,
  }));

  return buildReleasePulse(repo, issues, events);
}

/**
 * The automation-repo row fields the health composition reads: the row id for
 * the workflow-run counts plus the raw release-delta columns the pulse takes.
 */
export interface RepoReleaseHealthInput {
  id: string;
  fullName: string;
  releaseState: string;
  releaseBaselineTag: string | null;
  releaseBaselineSha: string | null;
  releaseBaselinePublishedAt: Date | string | null;
  releaseHeadSha: string | null;
  releaseAheadBy: number | null;
}

export interface RepoReleaseHealth {
  failingRuns: number;
  runningRuns: number;
  succeededRuns: number;
  pulse: ReleasePulseSnapshot;
  readiness: ReleaseReadiness;
}

/**
 * The one composition of a repo's CI context, release pulse, and advisory
 * readiness (#1483/#1484). The fleet route, the single-repo route, and the
 * board strip all need the same triple; keeping the counts, the pulse inputs,
 * and the CI→readiness policy here means the three readers cannot drift.
 * Cached rows only — no forge calls, no model calls, no writes.
 *
 * Positive success evidence separates "CI green" from "no usable run
 * evidence" for the readiness context, so `succeededRuns` is counted even
 * where the caller does not render it.
 */
export async function collectRepoReleaseHealth(
  repo: RepoReleaseHealthInput,
  now: Date = new Date(),
): Promise<RepoReleaseHealth> {
  const [failingRuns, runningRuns, succeededRuns, pulse] = await Promise.all([
    prisma.githubWorkflowRun.count({
      where: { workflow: { repoId: repo.id }, conclusion: "failure" },
    }),
    prisma.githubWorkflowRun.count({
      where: { workflow: { repoId: repo.id }, status: "in_progress" },
    }),
    prisma.githubWorkflowRun.count({
      where: { workflow: { repoId: repo.id }, conclusion: "success" },
    }),
    collectReleasePulse({
      fullName: repo.fullName,
      releaseState: asReleaseDeltaState(repo.releaseState),
      releaseBaselineTag: repo.releaseBaselineTag,
      releaseBaselineSha: repo.releaseBaselineSha,
      releaseBaselinePublishedAt: repo.releaseBaselinePublishedAt,
      releaseHeadSha: repo.releaseHeadSha,
      releaseAheadBy: repo.releaseAheadBy,
    }),
  ]);

  return {
    failingRuns,
    runningRuns,
    succeededRuns,
    pulse,
    readiness: deriveReleaseReadiness({
      pulse,
      now,
      ci: releaseCiStatus({ failingRuns, runningRuns, succeededRuns }),
    }),
  };
}
