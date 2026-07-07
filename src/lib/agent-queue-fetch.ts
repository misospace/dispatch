import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { buildAgentQueue } from "@/lib/agent-queue";
import { listQueuedPrFixItems, toAgentQueuePrFixItem } from "@/lib/pr-fix-queue";
import { findLeasedIssueIds } from "@/lib/lease";
import { parseExcludedLabels } from "@/lib/config";
import { resolveRequestLane, getLaneIds } from "@/lib/lane-config";
import type { RankedIssue } from "@/lib/agent-queue";

/**
 * Parameters for fetching the agent queue.
 */
export interface AgentQueueFetchParams {
  /** Agent name (used for lease exclusion and ranking) */
  agentName: string;
  /** Raw lane filter from query string (may be null/undefined) */
  lane: string | null;
  /** Whether to exclude decomposed audit parents */
  excludeDecomposed: boolean;
  /** Whether to include issues claimed by other agents */
  includeClaimed: boolean;
  /** Whether to include Renovate issues */
  includeRenovate: boolean;
}

/**
 * Result of fetching the agent queue data.
 */
export interface AgentQueueFetchResult {
  /** Resolved lane id (after alias resolution), or null if no lane was provided */
  resolvedLane: string | null;
  /** Whether the lane is valid (false if an invalid lane was provided) */
  laneValid: boolean;
  /** Ranked and filtered issue queue */
  rankedQueue: RankedIssue[];
  /** PR fix queue items */
  prFixItems: ReturnType<typeof toAgentQueuePrFixItem>[];
  /** Available lane ids for error messages */
  availableLanes: string[];
}

/**
 * Fetch and build the agent queue data shared by `/queue` and `/next-task` routes.
 *
 * This function:
 * 1. Fetches all open issues from enabled repos
 * 2. Filters out issues leased by other agents
 * 3. Builds a ranked issue queue via `buildAgentQueue`, which owns the
 *    Renovate exclusion (honoring `includeRenovate`) and excluded-label
 *    filtering — no issue-level filtering happens at the DB layer
 * 4. Lists queued PR fix items
 *
 * Lane resolution uses `resolveRequestLane` which handles alias mapping.
 */
export async function fetchAgentQueueData(
  params: AgentQueueFetchParams,
): Promise<AgentQueueFetchResult> {
  const { agentName, lane, excludeDecomposed, includeClaimed, includeRenovate } = params;
  // Renovate exclusion is intentionally NOT applied at the DB level here.
  // `buildAgentQueue` owns that decision (via the `includeRenovate` option and
  // the shared `isRenovateIssue` criteria in issue-filters.ts), so filtering
  // here would silently override includeRenovate=true.
  const issueWhere: Record<string, unknown> = {
    state: "open",
    repository: { enabled: true },
  };

  // The open-issue list, active leases, and queued PR fix items are
  // independent — fetch them in parallel.
  const [issues, leasedIssueIds, prFixItemsRaw] = await Promise.all([
    // Fetch all open issues from enabled repos (GitHub Issues as source of truth)
    prisma.issue.findMany({
      where: issueWhere,
      select: {
        id: true,
        number: true,
        title: true,
        url: true,
        labels: true,
        currentLane: true,
        decomposed: true,
        repository: { select: { fullName: true } },
        linkedPrNumber: true,
        linkedPrUrl: true,
        linkedPrNeedsFollowup: true,
        linkedPrFollowupReasons: true,
        linkedPrReviewDecision: true,
        linkedPrMergeState: true,
        linkedPrHealthCheckedAt: true,
      },
    }),
    // Find issues that have active leases from OTHER agents — exclude them
    findLeasedIssueIds(agentName),
    // List queued PR fix items (uses raw lane for pr-fix queue normalization)
    listQueuedPrFixItems(asPrFixQueueClient(prisma), { lane }),
  ]);

  // Resolve lane through alias map (returns null for unknown lanes)
  const resolvedLane = resolveRequestLane(lane?.toLowerCase());
  const availableLanes = getLaneIds();

  // Validate: if a lane was provided but resolution returned null, it's invalid
  const laneValid = !(lane && resolvedLane === null);

  // Filter out leased issue IDs before building the queue
  const leasedIssueIdSet = new Set(leasedIssueIds);
  const filteredIssues = issues.filter((issue) => !leasedIssueIdSet.has(issue.id));

  // Build ranked issue queue
  const rankedQueue = buildAgentQueue(
    filteredIssues.map((issue) => ({
      ...issue,
      lane: issue.currentLane ?? undefined,
      issueId: issue.id,
      repoFullName: issue.repository.fullName,
      linkedPrHealth: {
        number: issue.linkedPrNumber,
        url: issue.linkedPrUrl,
        needsFollowup: issue.linkedPrNeedsFollowup,
        followupReasons: issue.linkedPrFollowupReasons,
        reviewDecision: issue.linkedPrReviewDecision,
        mergeState: issue.linkedPrMergeState,
        checkedAt: issue.linkedPrHealthCheckedAt?.toISOString() ?? null,
      },
    })),
    agentName,
    {
      lane: resolvedLane ?? undefined,
      excludeDecomposed,
      includeClaimed,
      includeRenovate,
      excludedLabels: parseExcludedLabels(process.env.DISPATCH_EXCLUDED_LABELS),
    },
  );

  return {
    resolvedLane,
    laneValid,
    rankedQueue,
    prFixItems: prFixItemsRaw.map(toAgentQueuePrFixItem),
    availableLanes,
  };
}
