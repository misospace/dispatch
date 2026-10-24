import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { rejectAgentCaller } from "@/lib/operator-only";
import { enforceRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { buildIssueLifecycleTimeline, type LifecycleEventRecord } from "@/lib/issue-lifecycle-read";
import {
  buildWorkItemDeliveryChain,
  type WorkAttemptPrFixItemRecord,
  type WorkAttemptRunRecord,
} from "@/lib/work-attempt-chain";
import { backfillMergesFromRunHistory, touchedPullRequestNumbers } from "@/lib/lifecycle-backfill";
import { normalizeQueueRepo } from "@/lib/pr-fix-queue";

const BACKFILL_RATE_LIMIT = { limit: 5, windowMs: 60_000 };

/**
 * Bounded read window (#1203): the timeline is a current-state read, not a
 * full-history export. A row count above the window is surfaced as
 * `truncated` rather than silently dropped or expanded into an unbounded scan.
 */
const MAX_EVENTS = 500;

/**
 * Bounded attempt read (#1183): the run evidence behind the attempt chain is
 * capped like the event window; hitting the cap is surfaced as
 * `attemptsTruncated` rather than silently dropped.
 */
const MAX_ATTEMPT_RUNS = 500;
const MAX_ATTEMPT_HISTORY = 100;

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
}): LifecycleEventRecord {
  return {
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
}

/**
 * GET /api/issues/[issueId]/lifecycle — the source-neutral lifecycle read
 * contract for one work item (#1203).
 *
 * Projects the durable `IssueLifecycleEvent` stream into first claim,
 * subsequent claims, done/close/reopen milestones, every authoritatively
 * observed merged PR, and claim-to-done / claim-to-merge intervals in
 * milliseconds. Unknowns stay null with explicit provenance — a missing first
 * claim never reads as zero, and a close without an observed merge is
 * `closed-unmerged`, never "shipped". The contract is worker-neutral: it
 * assumes nothing Courier- or Dispatch-writer-specific beyond the event
 * taxonomy in docs/issue-lifecycle-events.md. Additively (#1183), the
 * response also carries `attempts` — the work item's attempt chain from
 * docs/work-attempt-chain.md — with an `attemptsTruncated` flag when the
 * bounded run read hit its cap; no existing field changes shape.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ issueId: string }> }) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  try {
    const { issueId } = await context.params;

    const issue = await prisma.issue.findUnique({
      where: { id: issueId },
      include: { repository: true },
    });

    if (!issue) {
      return errorResponse("Issue not found in local cache", 404);
    }

    // One bounded read, ordered at the source; the projection re-sorts by
    // occurrence regardless, so a redelivered or late-landed row cannot
    // reorder the timeline.
    const rows = await prisma.issueLifecycleEvent.findMany({
      where: { issueId },
      orderBy: [{ occurredAt: "asc" }, { observedAt: "asc" }],
      take: MAX_EVENTS + 1,
    });
    const truncated = rows.length > MAX_EVENTS;
    const events = (truncated ? rows.slice(0, MAX_EVENTS) : rows).map(toEventRecord);

    const timeline = buildIssueLifecycleTimeline(
      {
        repoFullName: issue.repository.fullName,
        issueNumber: issue.number,
        state: issue.state,
        closedAt: issue.closedAt,
      },
      events,
    );

    // Bounded attempt evidence (#1183): the PR-fix items matching this item's
    // exact (repo, issue) coordinates — the filter is bounded to the linked
    // PRs (one row per PR), each item's history capped at the OLDEST 100
    // entries per item (asc order) — and the runs attached to this issue OR
    // durably associated to one of those items' fix rounds (#1183 review:
    // a followup-pr run may not carry an issueId; its prFixQueueItemId stamp
    // is what pulls its evidence into this item's chain). The run read is
    // capped at MAX_ATTEMPT_RUNS. Both feeds are plain data for the pure
    // projection; neither read can expand into a full-history scan.
    const prFixRows = await prisma.prFixQueueItem.findMany({
      // Queue writes fold repo through normalizeQueueRepo (#1145);
      // Repository.fullName keeps caller casing, so reads must fold too.
      where: { repo: normalizeQueueRepo(issue.repository.fullName), issue: issue.number },
      // Secondary `id` key: with >100 rows tied on `at` at the cap boundary,
      // a lone `at` order would leave WHICH row survives DB-nondeterministic.
      include: { history: { orderBy: [{ at: "asc" }, { id: "asc" }], take: MAX_ATTEMPT_HISTORY + 1 } },
    });
    const runRows = await prisma.agentRun.findMany({
      where: {
        OR: [{ issueId }, { prFixQueueItemId: { in: prFixRows.map((row) => row.id) } }],
      },
      orderBy: { startedAt: "asc" },
      take: MAX_ATTEMPT_RUNS + 1,
      select: {
        id: true,
        agentName: true,
        runType: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        executionMetadata: true,
        prFixQueueItemId: true,
        prFixGeneration: true,
      },
    });
    const attemptsTruncated = runRows.length > MAX_ATTEMPT_RUNS;
    const attemptsRunRows = attemptsTruncated ? runRows.slice(0, MAX_ATTEMPT_RUNS) : runRows;

    const runs: WorkAttemptRunRecord[] = attemptsRunRows.map((row) => ({
      id: row.id,
      agentName: row.agentName,
      runType: row.runType,
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      executionMetadata:
        typeof row.executionMetadata === "object" && row.executionMetadata !== null
          ? (row.executionMetadata as Record<string, unknown>)
          : null,
      prFixQueueItemId: row.prFixQueueItemId,
      prFixGeneration: row.prFixGeneration,
    }));
    const prFixItems: WorkAttemptPrFixItemRecord[] = prFixRows.map((row) => ({
      id: row.id,
      repo: row.repo,
      pr: row.pr,
      issue: row.issue,
      generation: row.generation,
      fixAttempts: row.fixAttempts,
      status: row.status,
      outcome: row.outcome,
      type: row.type,
      queuedAt: row.queuedAt,
      historyTruncated: row.history.length > MAX_ATTEMPT_HISTORY,
      history: row.history.slice(0, MAX_ATTEMPT_HISTORY).map((entry) => ({
        id: entry.id,
        at: entry.at,
        action: entry.action,
        status: entry.status,
        outcome: entry.outcome,
        evidenceKey: entry.evidenceKey,
      })),
    }));

    const attempts = buildWorkItemDeliveryChain(
      { repoFullName: issue.repository.fullName, issueNumber: issue.number },
      { events, runs, prFixItems },
    );

    return NextResponse.json({
      issue: {
        id: issue.id,
        repoFullName: issue.repository.fullName,
        issueNumber: issue.number,
        state: issue.state,
        url: issue.url,
      },
      timeline,
      events,
      truncated,
      // #1183, additive: the attempt chain rides alongside the timeline;
      // no existing field changes shape.
      attempts,
      attemptsTruncated,
    });
  } catch (error) {
    console.error("Failed to build issue lifecycle timeline:", error);
    return errorResponse("Failed to retrieve issue lifecycle timeline", 500);
  }
}

/**
 * POST /api/issues/[issueId]/lifecycle — bounded merge backfill for one issue
 * (#1203), operator-only.
 *
 * Derives `pr_merged` events solely from verifiable existing records: an
 * `AgentRun` attached to this issue naming a PR URL, correlated with the PR's
 * authoritative GitHub merge time already persisted in Dispatch. It never
 * fabricates claim events or first-claim times, never treats an unmerged PR
 * as merged, and is idempotent across replays via the canonical merge dedupe
 * identity shared with the reconciler. Its PR read is bounded to the PRs this
 * issue's runs touch; the repo's merged-PR total is an aggregate count.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ issueId: string }> }) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }
  const rejected = rejectAgentCaller(auth, "Lifecycle backfill");
  if (rejected) return rejected;

  const limited = enforceRateLimit(`lifecycle-backfill:${auth.throttleKey}`, BACKFILL_RATE_LIMIT);
  if (limited) return limited;

  try {
    const { issueId } = await context.params;

    const issue = await prisma.issue.findUnique({
      where: { id: issueId },
      include: { repository: true },
    });

    if (!issue) {
      return errorResponse("Issue not found in local cache", 404);
    }

    const [agentRuns, automationRepo] = await Promise.all([
      prisma.agentRun.findMany({
        where: { issueId },
        select: { touchedIssueUrls: true },
      }),
      prisma.automationRepo.findUnique({ where: { fullName: issue.repository.fullName } }),
    ]);

    let pullRequests: Array<{ number: number; url: string; mergedAt: Date | null }> = [];
    let repoMergedPrCount = 0;
    if (automationRepo) {
      // Bounded read: only the PR rows for the numbers this issue's runs
      // touch, never every PR of the repo. The repo's merged-PR total comes
      // from an aggregate count, so no unbounded row set is materialized.
      const candidateNumbers = touchedPullRequestNumbers(agentRuns, issue.repository.fullName);
      const [rows, mergedCount] = await Promise.all([
        prisma.githubPullRequest.findMany({
          where: { repoId: automationRepo.id, number: { in: candidateNumbers } },
          select: { number: true, url: true, mergedAt: true },
        }),
        prisma.githubPullRequest.count({
          where: { repoId: automationRepo.id, mergedAt: { not: null } },
        }),
      ]);
      pullRequests = rows;
      repoMergedPrCount = mergedCount;
    }

    const result = await backfillMergesFromRunHistory(prisma, {
      issueId,
      repoFullName: issue.repository.fullName,
      issueNumber: issue.number,
      agentRuns,
      pullRequests,
      repoMergedPrCount,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("Issue lifecycle backfill failed:", error);
    return errorResponse("Failed to backfill issue lifecycle merges", 500);
  }
}
