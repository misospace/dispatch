import { prisma } from "@/lib/prisma";
import { AGENT_PREFIX, isAgentLabel } from "@/types";
import { applyRenovateIssueExclusion } from "@/lib/issue-filters";

/**
 * Agent directory for the Agents page (#1494): which identities are CURRENT,
 * how much open work each holds, and when Dispatch last observed each one.
 *
 * Activity policy — the default view shows an identity when ANY of these is
 * positively observed:
 *
 *  1. `assigned-open` — an OPEN issue in an enabled repository (Renovate
 *     issues excluded, the same filter the board uses) carries its
 *     `agent/<name>` label;
 *  2. `executing` — it holds a non-terminal AgentWork row (CLAIMED,
 *     IN_PROGRESS or BLOCKED): the work was never released, so the identity
 *     is current even if its last run report is old;
 *  3. `recent-report` — its most recent AgentRun row (tasks/report,
 *     heartbeat or legacy run ingestion) was recorded within the activity
 *     window, `getAgentActivityWindowMs()` (default 7 days).
 *
 * An identity matching none of these is INACTIVE: hidden from the default
 * view, never deleted. Inactivity is an evidence gap ("no recent report and
 * no open work"), NOT a proven-offline claim — an agent that stopped
 * heartbeating may simply be idle or running without reporting. Any later
 * report, assignment or work row makes it visible again. Hiding is
 * display-only: this module reads only. It never releases leases, mutates
 * claims, or removes AgentRun/audit/label history.
 */

export const DEFAULT_AGENT_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const MIN_AGENT_ACTIVITY_WINDOW_MS = 60_000;
const MAX_AGENT_ACTIVITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Recency window for the `recent-report` activity reason. Operators can tune
 * it with `DISPATCH_AGENT_ACTIVITY_WINDOW_MS` (clamped 1 minute – 30 days);
 * invalid or unset values fall back to the 7-day default.
 */
export function getAgentActivityWindowMs(): number {
  const parsed = parseInt(process.env.DISPATCH_AGENT_ACTIVITY_WINDOW_MS ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_AGENT_ACTIVITY_WINDOW_MS;
  return Math.min(Math.max(parsed, MIN_AGENT_ACTIVITY_WINDOW_MS), MAX_AGENT_ACTIVITY_WINDOW_MS);
}

/** AgentWork states that mean the agent is actually executing right now. */
export const AGENT_EXECUTING_WORK_STATES = ["CLAIMED", "IN_PROGRESS"] as const;

/**
 * Non-terminal AgentWork states. A BLOCKED row is a parked live claim — not
 * executing, but never released, so it still marks the identity as current.
 */
export const AGENT_LIVE_WORK_STATES = [...AGENT_EXECUTING_WORK_STATES, "BLOCKED"] as const;

export type AgentActivityReason = "assigned-open" | "executing" | "recent-report";

export interface AgentDirectoryEntry {
  /** Bare identity name (no `agent/` label prefix). */
  agentName: string;
  active: boolean;
  reasons: AgentActivityReason[];
  /**
   * When Dispatch last recorded ANY AgentRun row (report/heartbeat/ingestion)
   * for this identity, or null when it has never reported. Provenance is
   * server-observed ledger time — it is not inferred execution liveness.
   */
  lastSeenAt: Date | null;
  /** OPEN issues carrying this identity's `agent/<name>` label. */
  assignedOpen: number;
  ready: number;
  inProgress: number;
  inReview: number;
  /** Non-terminal AgentWork rows actually executing (CLAIMED/IN_PROGRESS). */
  executing: number;
}

export interface AgentDirectory {
  /** Entries after the default-view filter. Sorted by name (case-insensitive). */
  agents: AgentDirectoryEntry[];
  /** Active-only view: identities hidden because they are inactive. */
  inactiveHidden: number;
  /** Every discovered identity, active or not. Never mutated by hiding. */
  totalIdentities: number;
}

export interface AgentActivityInput {
  hasOpenAssignment: boolean;
  liveWorkCount: number;
  lastSeenAt: Date | null;
  windowMs: number;
  now: Date;
}

/** Pure activity classification per the documented policy above. */
export function classifyAgentActivity(
  input: AgentActivityInput,
): { active: boolean; reasons: AgentActivityReason[] } {
  const reasons: AgentActivityReason[] = [];
  if (input.hasOpenAssignment) reasons.push("assigned-open");
  if (input.liveWorkCount > 0) reasons.push("executing");
  if (input.lastSeenAt && input.lastSeenAt.getTime() > input.now.getTime() - input.windowMs) {
    reasons.push("recent-report");
  }
  return { active: reasons.length > 0, reasons };
}

export interface AgentDirectoryOptions {
  /** Include inactive identities (the Show inactive/history view). */
  includeInactive?: boolean;
  /** Injectable clock for tests. */
  now?: Date;
  /** Override the recent-report window for tests; defaults to the env policy. */
  windowMs?: number;
}

export async function getAgentDirectory(options: AgentDirectoryOptions = {}): Promise<AgentDirectory> {
  const { includeInactive = false, now = new Date(), windowMs = getAgentActivityWindowMs() } = options;

  const where: Record<string, unknown> = { repository: { enabled: true }, state: "open" };
  applyRenovateIssueExclusion(where);

  const [issues, workGroups, runGroups] = await Promise.all([
    prisma.issue.findMany({ where, select: { labels: true } }),
    prisma.agentWork.groupBy({
      by: ["agentName", "state"],
      where: { state: { in: [...AGENT_LIVE_WORK_STATES] } },
      _count: { _all: true },
    }),
    prisma.agentRun.groupBy({
      by: ["agentName"],
      _max: { createdAt: true },
    }),
  ]);

  interface Stats {
    assignedOpen: number;
    ready: number;
    inProgress: number;
    inReview: number;
    executing: number;
    liveWork: number;
    lastSeenAt: Date | null;
  }
  const byAgent = new Map<string, Stats>();
  const statsFor = (agentName: string): Stats => {
    let stats = byAgent.get(agentName);
    if (!stats) {
      stats = { assignedOpen: 0, ready: 0, inProgress: 0, inReview: 0, executing: 0, liveWork: 0, lastSeenAt: null };
      byAgent.set(agentName, stats);
    }
    return stats;
  };

  for (const issue of issues) {
    for (const label of issue.labels) {
      if (!isAgentLabel(label)) continue;
      const agentName = label.slice(AGENT_PREFIX.length);
      if (!agentName) continue;
      const stats = statsFor(agentName);
      stats.assignedOpen++;
      if (issue.labels.includes("status/ready")) stats.ready++;
      if (issue.labels.includes("status/in-progress")) stats.inProgress++;
      if (issue.labels.includes("status/in-review")) stats.inReview++;
    }
  }

  for (const group of workGroups) {
    if (!group.agentName) continue;
    const stats = statsFor(group.agentName);
    stats.liveWork += group._count._all;
    if ((AGENT_EXECUTING_WORK_STATES as readonly string[]).includes(group.state)) {
      stats.executing += group._count._all;
    }
  }

  for (const group of runGroups) {
    if (!group.agentName) continue;
    const stats = statsFor(group.agentName);
    const lastSeen = group._max.createdAt;
    if (lastSeen && (!stats.lastSeenAt || lastSeen > stats.lastSeenAt)) stats.lastSeenAt = lastSeen;
  }

  const entries: AgentDirectoryEntry[] = [...byAgent.entries()]
    .map(([agentName, stats]) => {
      const { active, reasons } = classifyAgentActivity({
        hasOpenAssignment: stats.assignedOpen > 0,
        liveWorkCount: stats.liveWork,
        lastSeenAt: stats.lastSeenAt,
        windowMs,
        now,
      });
      return {
        agentName,
        active,
        reasons,
        lastSeenAt: stats.lastSeenAt,
        assignedOpen: stats.assignedOpen,
        ready: stats.ready,
        inProgress: stats.inProgress,
        inReview: stats.inReview,
        executing: stats.executing,
      };
    })
    .sort((a, b) => a.agentName.localeCompare(b.agentName, undefined, { sensitivity: "base" }));

  const activeCount = entries.filter((entry) => entry.active).length;

  return {
    agents: includeInactive ? entries : entries.filter((entry) => entry.active),
    inactiveHidden: entries.length - activeCount,
    totalIdentities: entries.length,
  };
}
