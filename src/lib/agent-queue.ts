import {
  STATUS_LABELS,
  PRIORITY_LABELS,
  AGENT_PREFIX,
  getStatusFromLabels,
  getAgentFromLabels,
  getPriorityFromLabels,
} from "@/types";
import { isIssueExcludedByLabels, isRenovateIssue } from "@/lib/issue-filters";
import { isBacklogLane, resolveLaneId, laneMatchesConfigured } from "@/lib/lane-config";

export { isRenovateIssue } from "@/lib/issue-filters";

const DONE_STATUS: string = "status/done";
const IN_PROGRESS_STATUS: string = "status/in-progress";
const IN_REVIEW_STATUS: string = "status/in-review";
const BACKLOG_STATUS: string = "status/backlog";
const READY_STATUS: string = "status/ready";

/**
 * Compact linked-PR-health summary carried on queue items, sourced from the
 * persisted Issue columns (populated by reconcile / the refresh endpoint).
 */
export interface QueueLinkedPrHealth {
  number: number | null;
  url: string | null;
  needsFollowup: boolean;
  followupReasons: string[];
  reviewDecision: string | null;
  mergeState: string | null;
  checkedAt: string | null;
}

export interface RankedIssue {
  type?: "issue";
  number: number;
  title: string;
  url: string;
  labels: string[];
  priority: string | null;
  status: string | null;
  agentMatch: boolean;
  rankingReason: string;
  lane?: string;
  decomposed?: boolean;
  issueId?: string;
  repoFullName?: string;
  claimable?: boolean;
  linkedPrHealth?: QueueLinkedPrHealth | null;
}

/**
 * Score an issue for a given agent. Lower score = higher priority.
 */
function rankIssue(issueLabels: string[], agentName: string): { score: number; reason: string } {
  const status = getStatusFromLabels(issueLabels);
  const agentLabel = getAgentFromLabels(issueLabels);
  const priority = getPriorityFromLabels(issueLabels);

  // Check if this issue is directly assigned to the agent
  const agentMatch = Boolean(agentLabel && agentLabel === `agent/${agentName}`);

  // Exclude done issues entirely
  if (status === DONE_STATUS) {
    return { score: Infinity, reason: "excluded: status/done" };
  }

  // Build ranking reason
  const parts: string[] = [];

  // Priority component (primary sort key): p0=0, p1=1, p2=2, p3=3
  let priorityScore = 4; // default: no priority label
  if (priority) {
    const idx = PRIORITY_LABELS.indexOf(priority);
    if (idx !== -1) {
      priorityScore = idx;
      parts.push(`priority/${priority.replace("priority/", "")}`);
    }
  }

  // Agent match component: agent-specific issues come first within same priority
  const agentScore = agentMatch ? 0 : 1;
  if (agentMatch) {
    parts.push(`${AGENT_PREFIX}${agentName}`);
  }

  // Status component: in-progress before in-review before ready before backlog before no-status
  let statusScore = 3;
  if (status === IN_PROGRESS_STATUS) {
    statusScore = 0;
    parts.push("in-progress");
  } else if (status === IN_REVIEW_STATUS) {
    statusScore = 1;
    parts.push("in-review");
  } else if (status === READY_STATUS) {
    statusScore = 2;
    parts.push("ready");
  } else if (status === BACKLOG_STATUS) {
    statusScore = 3;
    parts.push("backlog");
  } else if (status === null) {
    statusScore = 4;
    parts.push("no-status");
  }

  const score = priorityScore * 100 + agentScore * 10 + statusScore;
  return { score, reason: parts.join(", ") };
}

/**
 * Determine if an issue is actionable for the agent queue.
 * - Must be open (not closed)
 * - Must not have status/done
 */
function isActionable(issueLabels: string[]): boolean {
  const status = getStatusFromLabels(issueLabels);

  // Exclude done
  if (status === DONE_STATUS) return false;

  // Include all non-done statuses including no-status
  return true;
}

/**
 * Check if an issue's status is claimable for the default worker queue.
 * Only status/ready and status/in-progress are worker-actionable.
 * Excludes: no-status, status/in-review, status/backlog (filtered earlier).
 */
function isClaimableStatus(labels: string[]): boolean {
  const status = getStatusFromLabels(labels);
  if (status === null) return false;
  if (status === IN_REVIEW_STATUS) return false;
  // status/backlog already filtered above; remaining statuses (ready, in-progress) are actionable
  return true;
}

/**
 * Build the agent queue: filter, rank, and return issues for a given agent.
 * Optionally filters by execution lane. By default excludes backlog lane items.
 * Optionally excludes decomposed audit parents.
 * Excludes claimed issues by default; pass includeClaimed to include agent/* labels.
 * Note: includeClaimed and claimableOnly are independent options — not a rename.
 *   includeClaimed: whether to show issues claimed by other agents
 *   claimableOnly: whether to filter to only status/ready and status/in-progress
 * Excludes Renovate issues by default; pass includeRenovate=true to include them.
 * By default, only claimable work is returned (excludes status/backlog).
 * Pass claimableOnly=false to include all actionable issues including backlog.
 * Excludes issues with labels matching DISPATCH_EXCLUDED_LABELS by default.
 */
export function buildAgentQueue(
  issues: Array<{
    labels: string[];
    number: number;
    title: string;
    url: string;
    lane?: string;
    decomposed?: boolean;
    issueId?: string;
    repoFullName?: string;
    linkedPrHealth?: QueueLinkedPrHealth | null;
  }>,
  agentName: string,
  options?: {
    lane?: string;
    excludeDecomposed?: boolean;
    includeClaimed?: boolean;
    includeRenovate?: boolean;
    claimableOnly?: boolean;
    excludedLabels?: string[];
  },
): RankedIssue[] {
  // Normalize lane to lowercase for consistent comparison
  const normalizedLane = options?.lane?.toLowerCase();

  // Default claimableOnly to true per the worker contract (backlog is triage-only)
  const claimableOnly = options?.claimableOnly ?? true;

  // Filter actionable issues (open, not done)
  let actionable = issues.filter((issue) => isActionable(issue.labels));

  // Exclude non-claimable work by default (status/backlog is triage-only)
  if (claimableOnly) {
    actionable = actionable.filter((issue) => getStatusFromLabels(issue.labels) !== BACKLOG_STATUS);
  }

  // Default claimed filter: keep work assigned to the requesting agent, exclude other agents' claims
  if (!options?.includeClaimed) {
    actionable = actionable.filter((issue) => {
      const agentLabel = getAgentFromLabels(issue.labels);
      return !agentLabel || agentLabel === `${AGENT_PREFIX}${agentName}`;
    });

    // Exclude unclaimed no-status and in-review issues from default worker queue.
    // Worker queues should only return status/ready or status/in-progress work.
    // When claimableOnly=false (triage/grooming views), include them for review.
    if (claimableOnly) {
      actionable = actionable.filter((issue) => isClaimableStatus(issue.labels));
    }
  }

  // Exclude Renovate issues by default (unless explicitly included)
  if (!options?.includeRenovate) {
    actionable = actionable.filter((issue) => !isRenovateIssue(issue));
  }

  // Exclude decomposed audit parents if requested
  if (options?.excludeDecomposed) {
    actionable = actionable.filter((issue) => !issue.decomposed);
  }

  // Exclude issues with labels matching the excluded labels config
  const excludedLabels = options?.excludedLabels;
  if (excludedLabels && excludedLabels.length > 0) {
    actionable = actionable.filter((issue) => !isIssueExcludedByLabels(issue.labels, excludedLabels));
  }

  // Lane filter: exclude backlog lane items from normal agent queue
  // When claimableOnly=false, include all lanes (including backlog/non-claimable)
  const filtered = normalizedLane
    ? actionable.filter((issue) => {
        // Include issues whose raw lane matches the filter or aliases to it
        return laneMatchesConfigured(issue.lane?.toLowerCase(), normalizedLane);
      })
    : claimableOnly
      ? actionable.filter((issue) => {
          const resolved = resolveLaneId(issue.lane?.toLowerCase() ?? null);
          if (!resolved) return true; // no lane set — include
          // Don't exclude unknown lanes (preserve visibility)
          if (!isBacklogLane(resolved)) return true;
          return false;
        })
      : actionable;

  // Rank and filter out excluded items
  const ranked = filtered
    .map((issue) => {
      const { score, reason } = rankIssue(issue.labels, agentName);
      return { ...issue, score, reason };
    })
    // Exclude items with Infinity score (done issues that slipped through)
    .filter((item) => item.score !== Infinity);

  // Sort by score ascending (lower = higher priority)
  ranked.sort((a, b) => a.score - b.score);

  // Build result
  return ranked.map((item) => {
    const agentLabel = getAgentFromLabels(item.labels);
    const agentMatch = Boolean(agentLabel && agentLabel === `agent/${agentName}`);
    const priority = getPriorityFromLabels(item.labels);
    const status = getStatusFromLabels(item.labels);

    return {
      type: "issue" as const,
      number: item.number,
      title: item.title,
      url: item.url,
      labels: item.labels,
      priority,
      status,
      agentMatch,
      rankingReason: item.reason,
      lane: item.lane,
      decomposed: item.decomposed ?? false,
      issueId: item.issueId,
      repoFullName: item.repoFullName,
      claimable: status !== BACKLOG_STATUS,
      linkedPrHealth: item.linkedPrHealth ?? null,
    };
  });
}
