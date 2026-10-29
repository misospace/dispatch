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
import type { LifecycleEventRecord } from "@/lib/issue-lifecycle-read";

import type { ReleaseDeltaState } from "./automation-sync";

/**
 * Merge/close/reopen evidence the pure pulse consumes. Post-baseline rows
 * are sufficient: delivery requires a post-baseline `pr_merged`, and
 * reopen-after-close checks only concern closes that are themselves
 * post-baseline.
 */
const PULSE_EVENT_KINDS = ["pr_merged", "completed", "issue_closed", "issue_reopened"];

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

function toEventRecord(row: {
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
  const event: LifecycleEventRecord = {
    kind: row.kind,
    source: row.source,
    actor: row.actor,
    agentName: row.agentName,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    sourceEventId: row.sourceEventId,
    occurredAt: row.occurredAt,
    observedAt: row.observedAt,
    metadata:
      typeof row.metadata === "object" && row.metadata !== null
        ? (row.metadata as Record<string, unknown>)
        : null,
  };
  return { ...event, issueNumber: row.issueNumber };
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
      kind: { in: PULSE_EVENT_KINDS },
      occurredAt: { gte: baselineDate },
    },
    orderBy: { occurredAt: "asc" },
  });
  const events = eventRows.map(toEventRecord);

  const eventIssueNumbers = [...new Set(events.map((event) => event.issueNumber))];

  const issueRows = await prisma.issue.findMany({
    where: {
      repository: { fullName: repo.fullName },
      OR: [
        // Open issues can still be merge-delivered (timeline delivery
        // "merged"), so numbers with post-baseline evidence count
        // regardless of state. The arm is dropped when no events matched —
        // an empty `in` is built conditionally on purpose.
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
