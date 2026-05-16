import { Prisma } from "@prisma/client";

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
  repository: {
    fullName: string;
  };
  lane?: string;
  laneConfidence?: number | Prisma.Decimal | null;
  laneReason?: string | null;
  laneModel?: string | null;
  laneJudgedAt?: Date | null;

  // Escalated lane outcome tracking
  decomposed?: boolean;
  decomposedAt?: Date | null;
  decomposedBy?: string | null;
  decomposedNote?: string | null;
  followUpUrls?: string[];
}

export interface IssueLaneClassification {
  lane: "NORMAL" | "ESCALATED" | "BACKLOG";
  confidence: number | null;
  reason: string;
  model: string;
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

export type StatusLabel = "status/backlog" | "status/in-progress" | "status/in-review" | "status/done";
export type AgentLabel = `agent/${string}`;
export type OwnerLabel = `owner/${string}`;
export type PriorityLabel = "priority/p0" | "priority/p1" | "priority/p2" | "priority/p3";
export type TypeLabel = "type/bug" | "type/feature" | "type/chore" | "type/research" | "type/security";
export type ProjectLabel = `project/${string}`;
export type IssueLane = "NORMAL" | "ESCALATED" | "BACKLOG";

export const STATUS_LABELS: StatusLabel[] = ["status/backlog", "status/in-progress", "status/in-review", "status/done"];
export const PRIORITY_LABELS: PriorityLabel[] = ["priority/p0", "priority/p1", "priority/p2", "priority/p3"];
export const PROJECT_PREFIX = "project/";
export const AGENT_PREFIX = "agent/";
export const OWNER_PREFIX = "owner/";

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
  "status/in-progress": "3b82f6",
  "status/in-review": "a855f7",
  "status/done": "22c55e",
  "priority/p0": "ef4444",
  "priority/p1": "f97316",
  "priority/p2": "eab308",
  "priority/p3": "22c55e",
};

// Lane classification constants and helpers
export const VALID_LANES: IssueLane[] = ["NORMAL", "ESCALATED", "BACKLOG"];

export function isValidLane(lane: string): lane is IssueLane {
  return VALID_LANES.includes(lane as IssueLane);
}

export const LANE_LABELS: Record<IssueLane, string> = {
  NORMAL: "normal",
  ESCALATED: "escalated",
  BACKLOG: "backlog",
};

export const LANE_COLORS: Record<IssueLane, string> = {
  NORMAL: "22c55e",
  ESCALATED: "a855f7",
  BACKLOG: "6b7280",
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
