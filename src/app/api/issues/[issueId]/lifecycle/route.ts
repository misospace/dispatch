import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { rejectAgentCaller } from "@/lib/operator-only";
import { enforceRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { buildIssueLifecycleTimeline, type LifecycleEventRecord } from "@/lib/issue-lifecycle-read";
import { backfillMergesFromRunHistory, touchedPullRequestNumbers } from "@/lib/lifecycle-backfill";

const BACKFILL_RATE_LIMIT = { limit: 5, windowMs: 60_000 };

/**
 * Bounded read window (#1203): the timeline is a current-state read, not a
 * full-history export. A row count above the window is surfaced as
 * `truncated` rather than silently dropped or expanded into an unbounded scan.
 */
const MAX_EVENTS = 500;

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
 * taxonomy in docs/issue-lifecycle-events.md.
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

  const limited = enforceRateLimit(`lifecycle-backfill:${auth.actor}`, BACKFILL_RATE_LIMIT);
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
