export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  labels: { name: string; color: string }[];
  assignees: { login: string }[];
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: { url: string };
}

export interface Repository {
  id: string;
  name: string;
  owner: string;
  fullName: string;
  enabled: boolean;
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  url: string;
  labels: string[];
  assignees: string[];
  commentsCount: number;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  currentLane?: string | null;
  repository: {
    fullName: string;
  };

  // Escalated lane outcome tracking
  decomposed?: boolean;
  decomposedAt?: Date | null;
  decomposedBy?: string | null;
  decomposedNote?: string | null;
  followUpUrls?: string[];

  // Backlog grooming state
  groomedAt?: Date | null;
  groomedBy?: string | null;
  groomingSummary?: string | null;
  notReadyReason?: string | null;
  blockedReason?: string | null;
  needsInfoReason?: string | null;
  nextGroomingAction?: string | null;
}

export interface StoredIssueLane {
  id: string;
  issueId: string;
  lane: string;
  confidence: string;
  reason: string | null;
  model: string | null;
  judgedAt: Date;
}

export interface AgentRun {
  id: string;
  agentName: string;
  runType: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  summary: string | null;
  errorMessage: string | null;
  touchedIssueUrls: string[];
  outcome?: EscalatedOutcome | null;
}

export interface AuditLog {
  id: string;
  actor: string;
  action: string;
  repoFullName: string;
  issueNumber: number | null;
  beforeLabels: string[];
  afterLabels: string[];
  success: boolean;
  errorMessage: string | null;
  createdAt: Date;
}

export type StatusLabel = "status/backlog" | "status/ready" | "status/in-progress" | "status/in-review" | "status/done";
export type AgentLabel = `agent/${string}`;
export type OwnerLabel = `owner/${string}`;
export type PriorityLabel = "priority/p0" | "priority/p1" | "priority/p2" | "priority/p3";
export type TypeLabel = "type/bug" | "type/feature" | "type/chore" | "type/research" | "type/security";
export type ProjectLabel = `project/${string}`;

export const STATUS_LABELS: StatusLabel[] = ["status/backlog", "status/ready", "status/in-progress", "status/in-review", "status/done"];
export const PRIORITY_LABELS: PriorityLabel[] = ["priority/p0", "priority/p1", "priority/p2", "priority/p3"];
export const PROJECT_PREFIX = "project/";
export const AGENT_PREFIX = "agent/";
export const OWNER_PREFIX = "owner/";

// Lane classification types and constants
export type IssueLaneValue = "normal" | "escalated" | "backlog";
export type ConfidenceValue = "high" | "medium" | "low";

export const VALID_LANES: IssueLaneValue[] = ["normal", "escalated", "backlog"];
export const VALID_CONFIDENCE: ConfidenceValue[] = ["high", "medium", "low"];

export function isAgentLabel(label: string): label is AgentLabel {
  return label.startsWith(AGENT_PREFIX);
}

export function isOwnerLabel(label: string): label is OwnerLabel {
  return label.startsWith(OWNER_PREFIX);
}

export function getStatusFromLabels(labels: string[]): StatusLabel | null {
  return STATUS_LABELS.find((l) => labels.includes(l)) ?? null;
}

export function getProjectFromLabels(labels: string[]): string | null {
  const projectLabel = labels.find((l: string) => l.startsWith(PROJECT_PREFIX));
  return projectLabel?.replace(PROJECT_PREFIX, "") ?? null;
}

export function getAgentFromLabels(labels: string[]): AgentLabel | null {
  return labels.find(isAgentLabel) as AgentLabel | null;
}

export function getOwnerFromLabels(labels: string[]): OwnerLabel | null {
  return labels.find(isOwnerLabel) as OwnerLabel | null;
}

export function getPriorityFromLabels(labels: string[]): PriorityLabel | null {
  return PRIORITY_LABELS.find((l) => labels.includes(l)) ?? null;
}

export const LABEL_COLORS: Record<string, string> = {
  "status/backlog": "6b7280",
  "status/ready": "f59e0b",
  "status/in-progress": "3b82f6",
  "status/in-review": "a855f7",
  "status/done": "22c55e",
  "priority/p0": "ef4444",
  "priority/p1": "f97316",
  "priority/p2": "eab308",
  "priority/p3": "22c55e",
};

// ─── Escalated-Lane Outcome Constants ────────────────────────────────────────

export type EscalatedOutcome =
  | "PR_OPENED"
  | "PR_UPDATED"
  | "FOLLOW_UP_CREATED"
  | "DESIGN_COMMENT_POSTED"
  | "DECOMPOSED_SKIPPED"
  | "STUCK";

export const VALID_ESCALATED_OUTCOMES: EscalatedOutcome[] = [
  "PR_OPENED",
  "PR_UPDATED",
  "FOLLOW_UP_CREATED",
  "DESIGN_COMMENT_POSTED",
  "DECOMPOSED_SKIPPED",
  "STUCK",
];

/**
 * Returns true if the given outcome is a valid escalated-lane outcome.
 * No hardcoded agent or repo names — this applies to all agents and repos uniformly.
 */
export function isValidEscalatedOutcome(outcome: string): outcome is EscalatedOutcome {
  return VALID_ESCALATED_OUTCOMES.includes(outcome as EscalatedOutcome);
}

/**
 * Human-readable label for an escalated-lane outcome.
 */
export const ESCALATED_OUTCOME_LABELS: Record<EscalatedOutcome, string> = {
  PR_OPENED: "PR opened",
  PR_UPDATED: "PR updated",
  FOLLOW_UP_CREATED: "Follow-up issues created",
  DESIGN_COMMENT_POSTED: "Design/RFC comment posted",
  DECOMPOSED_SKIPPED: "Decomposed/skipped",
  STUCK: "Stuck",
};

// ─── PR Review-Fix Queue Constants and Helpers ───────────────────────────────

export type PrFixLane = "NORMAL" | "ESCALATED" | "NEEDS_HUMAN";
export type PrFixStatus = "QUEUED" | "FIXED" | "BLOCKED" | "STALE" | "IGNORED";

export const VALID_PR_FIX_LANES: PrFixLane[] = ["NORMAL", "ESCALATED", "NEEDS_HUMAN"];
export const VALID_PR_FIX_STATUSES: PrFixStatus[] = ["QUEUED", "FIXED", "BLOCKED", "STALE", "IGNORED"];

export function isValidPrFixLane(lane: string): lane is PrFixLane {
  return VALID_PR_FIX_LANES.includes(lane as PrFixLane);
}

export function isValidPrFixStatus(status: string): status is PrFixStatus {
  return VALID_PR_FIX_STATUSES.includes(status as PrFixStatus);
}

export function normalizePrFixLane(lane?: string | null): PrFixLane {
  if (!lane) return "NORMAL";
  const normalized = lane.trim().toUpperCase().replace(/-/g, "_");
  if (normalized === "GPT") return "ESCALATED";
  if (normalized === "NEEDS_HUMAN" || normalized === "NEEDS-HUMAN") return "NEEDS_HUMAN";
  return isValidPrFixLane(normalized) ? normalized : "NEEDS_HUMAN";
}

export function normalizePrFixStatus(status: string): PrFixStatus | null {
  const normalized = status.trim().toUpperCase();
  return isValidPrFixStatus(normalized) ? normalized : null;
}

// ─── Agent Work Lease / Checkpoint Constants and Helpers ─────────────────────

export type AgentWorkState = "CLAIMED" | "IN_PROGRESS" | "BLOCKED" | "DONE" | "RELEASED" | "STALE";
export type AgentWorkCheckpoint = "CLAIMED" | "REPO_PREPARED" | "BRANCH_CREATED" | "CHANGES_MADE" | "TESTS_RUNNING" | "PR_OPENED" | "DONE" | "BLOCKED";

export const VALID_AGENT_WORK_STATES: AgentWorkState[] = ["CLAIMED", "IN_PROGRESS", "BLOCKED", "DONE", "RELEASED", "STALE"];
export const VALID_AGENT_WORK_CHECKPOINTS: AgentWorkCheckpoint[] = ["CLAIMED", "REPO_PREPARED", "BRANCH_CREATED", "CHANGES_MADE", "TESTS_RUNNING", "PR_OPENED", "DONE", "BLOCKED"];

export function isValidAgentWorkState(state: string): state is AgentWorkState {
  return VALID_AGENT_WORK_STATES.includes(state as AgentWorkState);
}

export function isValidAgentWorkCheckpoint(checkpoint: string): checkpoint is AgentWorkCheckpoint {
  return VALID_AGENT_WORK_CHECKPOINTS.includes(checkpoint as AgentWorkCheckpoint);
}

export function normalizeAgentWorkState(state: string): AgentWorkState | null {
  const normalized = state.trim().toUpperCase().replace(/-/g, "_");
  if (normalized === "INPROGRESS" || normalized === "IN_PROGRESS") return "IN_PROGRESS";
  if (normalized === "DONE" || normalized === "COMPLETED" || normalized === "COMPLETE") return "DONE";
  if (normalized === "BLOCKED" || normalized === "STUCK") return "BLOCKED";
  if (normalized === "RELEASED" || normalized === "RELEASE") return "RELEASED";
  if (normalized === "STALE" || normalized === "EXPIRED") return "STALE";
  if (normalized === "CLAIMED" || normalized === "CLAIM") return "CLAIMED";
  return null;
}

export function normalizeAgentWorkCheckpoint(checkpoint: string): AgentWorkCheckpoint | null {
  const normalized = checkpoint.trim().toUpperCase().replace(/-/g, "_");
  if (normalized === "INPROGRESS" || normalized === "IN_PROGRESS") return "CLAIMED"; // map to first active checkpoint
  if (normalized === "DONE" || normalized === "COMPLETED" || normalized === "COMPLETE") return "DONE";
  if (normalized === "BLOCKED" || normalized === "STUCK") return "BLOCKED";
  return isValidAgentWorkCheckpoint(normalized) ? normalized : null;
}

// ─── Backlog Grooming Constants and Helpers ──────────────────────────────────

export type GroomAction = "promote_to_ready" | "escalate" | "mark_not_ready" | "mark_needs_info" | "mark_blocked";

export const VALID_GROOM_ACTIONS: GroomAction[] = ["promote_to_ready", "escalate", "mark_not_ready", "mark_needs_info", "mark_blocked"];

export function isValidGroomAction(action: string): action is GroomAction {
  return VALID_GROOM_ACTIONS.includes(action as GroomAction);
}

export function normalizeGroomAction(action: string): GroomAction | null {
  const normalized = action.trim().toLowerCase().replace(/_/g, "_");
  if (normalized === "promote" || normalized === "ready" || normalized === "promote_to_ready") return "promote_to_ready";
  if (normalized === "escalate" || normalized === "escalated") return "escalate";
  if (normalized === "not_ready" || normalized === "notready" || normalized === "keep_backlog") return "mark_not_ready";
  if (normalized === "needs_info" || normalized === "needsinfo" || normalized === "needs_info") return "mark_needs_info";
  if (normalized === "blocked" || normalized === "stuck") return "mark_blocked";
  return isValidGroomAction(normalized) ? normalized : null;
}

export const GROOM_ACTION_LABELS: Record<GroomAction, string> = {
  promote_to_ready: "Promote to Ready",
  escalate: "Escalate",
  mark_not_ready: "Keep in Backlog (not ready)",
  mark_needs_info: "Mark Needs Info",
  mark_blocked: "Mark Blocked",
};
