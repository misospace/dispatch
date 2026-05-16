import {
  STATUS_LABELS,
  PRIORITY_LABELS,
  AGENT_PREFIX,
  getStatusFromLabels,
  getAgentFromLabels,
  getPriorityFromLabels,
} from "@/types";

const DONE_STATUS: string = "status/done";
const IN_PROGRESS_STATUS: string = "status/in-progress";
const BACKLOG_STATUS: string = "status/backlog";

export interface RankedIssue {
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

  // Status component: in-progress before backlog before no-status
  let statusScore = 2;
  if (status === IN_PROGRESS_STATUS) {
    statusScore = 0;
    parts.push("in-progress");
  } else if (status === BACKLOG_STATUS || status === null) {
    statusScore = 1;
    parts.push(status ?? "no-status");
  }

  const score = priorityScore * 100 + agentScore * 10 + statusScore;
  return { score, reason: parts.join(", ") };
}

/**
 * Determine if an issue is actionable for the agent queue.
 * - Must be open (not closed)
 * - Must not have status/done
 * - Must either have no status label, status/backlog, or status/in-progress
 */
function isActionable(issueLabels: string[]): boolean {
  const status = getStatusFromLabels(issueLabels);

  // Exclude done
  if (status === DONE_STATUS) return false;

  // Include: no status, backlog, in-progress
  if (status === null || status === BACKLOG_STATUS || status === IN_PROGRESS_STATUS) {
    return true;
  }

  return false;
}

/**
 * Build the agent queue: filter, rank, and return issues for a given agent.
 * Optionally filters by execution lane (normal | escalated | backlog).
 * Optionally excludes decomposed audit parents.
 */
export function buildAgentQueue(
  issues: Array<{
    labels: string[];
    number: number;
    title: string;
    url: string;
    lane?: string;
    decomposed?: boolean;
  }>,
  agentName: string,
  options?: {
    lane?: "NORMAL" | "ESCALATED" | "BACKLOG";
    excludeDecomposed?: boolean;
  },
): RankedIssue[] {
  // Filter actionable issues (open, not done)
  let actionable = issues.filter((issue) => isActionable(issue.labels));

  // Exclude decomposed audit parents if requested
  if (options?.excludeDecomposed) {
    actionable = actionable.filter((issue) => !issue.decomposed);
  }

  // Lane filter: exclude BACKLOG lane items from normal agent queue
  const filtered = options?.lane
    ? actionable.filter((issue) => issue.lane === options.lane)
    : actionable.filter((issue) => issue.lane !== "BACKLOG");

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
    };
  });
}
