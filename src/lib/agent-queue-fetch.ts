import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { buildAgentQueue } from "@/lib/agent-queue";
import { listQueuedPrFixItems, toAgentQueuePrFixItem } from "@/lib/pr-fix-queue";
import { findLeasedIssueIds } from "@/lib/lease";
import { parseExcludedLabels } from "@/lib/config";
import { resolveRequestLane, getLaneIds, prFixLaneForRequest } from "@/lib/lane-config";
import { dependencyKey } from "@/lib/issue-dependencies";
import {
  ADMISSION_ISSUE_SELECT,
  evaluateQueueAdmission,
  getQueueAdmissionMode,
  loadAdmissionRuns,
  type AdmissionIssueState,
  type QueueAdmissionMode,
} from "@/lib/queue-admission";
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
  /**
   * Ranked and filtered issue queue: what implementation pickup may take.
   * In enforce mode, issues withheld by grooming admission (#1065) are not here.
   */
  rankedQueue: RankedIssue[];
  /**
   * The ranked queue before admission filtering, in the same order. Equal to
   * rankedQueue unless admission is enforced; linked-PR follow-up routing
   * scans this so it is unaffected by issue admission.
   */
  fullQueue: RankedIssue[];
  /** Issues withheld by admission (enforce mode only), each carrying `admission`. */
  withheldQueue: RankedIssue[];
  /** The grooming admission mode this fetch ran under. */
  admissionMode: QueueAdmissionMode;
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
  const admissionMode = getQueueAdmissionMode();
  // Renovate exclusion is intentionally NOT applied at the DB level here.
  // `buildAgentQueue` owns that decision (via the `includeRenovate` option and
  // the shared `isRenovateIssue` criteria in issue-filters.ts), so filtering
  // here would silently override includeRenovate=true.
  const issueWhere: Record<string, unknown> = {
    state: "open",
    repository: { enabled: true },
  };

  // Resolve and validate the request lane through the configured-lane helpers
  // BEFORE filtering PR-fix work. The PR-fix queue uses its own internal enum,
  // so we derive the PR-fix lane from the already-resolved configured lane's
  // role rather than feeding the raw request lane to `normalizePrFixLane`
  // (which would coerce unknown/custom lane ids to `NEEDS_HUMAN` and silently
  // hide queued PR-fix work — #1046).
  const resolvedLane = resolveRequestLane(lane?.toLowerCase());
  const availableLanes = getLaneIds();
  // An invalid request must not run the unfiltered PR-fix lookup (or any queue fetch).
  if (lane && resolvedLane === null) {
    return {
      resolvedLane,
      laneValid: false,
      rankedQueue: [],
      fullQueue: [],
      withheldQueue: [],
      admissionMode,
      prFixItems: [],
      availableLanes,
    };
  }
  const prFixLane = prFixLaneForRequest(resolvedLane);

  // The open-issue list, active leases, and queued PR fix items are
  // independent — fetch them in parallel.
  const [issues, leasedIssueIds, prFixItemsRaw] = await Promise.all([
    // Fetch all open issues from enabled repos (GitHub Issues as source of truth)
    prisma.issue.findMany({
      where: issueWhere,
      select: {
        id: true,
        number: true,
        createdAt: true,
        title: true,
        body: true,
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
        // Freshness/override columns, read only when admission is on so the
        // off-mode query is unchanged.
        ...(admissionMode === "off" ? {} : ADMISSION_ISSUE_SELECT),
      },
    }),
    // Find issues that have active leases from OTHER agents — exclude them
    findLeasedIssueIds(agentName),
    // null is a configured lane with no PR-fix equivalent; undefined is unfiltered.
    prFixLane === null
      ? Promise.resolve([])
      : listQueuedPrFixItems(asPrFixQueueClient(prisma), { lane: prFixLane }),
  ]);

  // Filter out leased issue IDs before building the queue
  const leasedIssueIdSet = new Set(leasedIssueIds);
  const filteredIssues = issues.filter((issue) => !leasedIssueIdSet.has(issue.id));

  // Open-issue key set for dependency gating (issues are already filtered to state: "open")
  const openIssueKeys = new Set(issues.map((i) => dependencyKey(i.repository.fullName, i.number)));

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
      openIssueKeys,
    },
  );

  const prFixItems = prFixItemsRaw.map(toAgentQueuePrFixItem);

  if (admissionMode === "off") {
    return {
      resolvedLane,
      laneValid: true,
      rankedQueue,
      fullQueue: rankedQueue,
      withheldQueue: [],
      admissionMode,
      prFixItems,
      availableLanes,
    };
  }

  // Grooming freshness admission (#1065): evaluated after every existing
  // filter (including #1038 dependency gating), from persisted state only.
  // PR-fix items are never subject to it.
  const issueById = new Map<string, AdmissionIssueState>(
    filteredIssues.map((issue) => [issue.id, issue as unknown as AdmissionIssueState]),
  );
  const rankedStates = rankedQueue
    .map((item) => (item.issueId ? issueById.get(item.issueId) : undefined))
    .filter((state): state is AdmissionIssueState => state !== undefined);
  const runs = await loadAdmissionRuns(rankedStates);

  const fullQueue: RankedIssue[] = rankedQueue.map((item) => {
    const state = item.issueId ? issueById.get(item.issueId) : undefined;
    const admission = evaluateQueueAdmission(state ?? { labels: item.labels, title: item.title, body: null }, {
      mode: admissionMode,
      run: state?.groomedRunId ? runs.get(state.groomedRunId) : null,
      dependencyBlockReason: item.dependencyBlockReason,
    });
    return { ...item, admission };
  });

  if (admissionMode === "audit") {
    return {
      resolvedLane,
      laneValid: true,
      rankedQueue: fullQueue,
      fullQueue,
      withheldQueue: [],
      admissionMode,
      prFixItems,
      availableLanes,
    };
  }

  return {
    resolvedLane,
    laneValid: true,
    rankedQueue: fullQueue.filter((item) => item.admission?.admitted !== false),
    fullQueue,
    withheldQueue: fullQueue
      .filter((item) => item.admission?.admitted === false)
      .map((item) => ({ ...item, claimable: false })),
    admissionMode,
    prFixItems,
    availableLanes,
  };
}
