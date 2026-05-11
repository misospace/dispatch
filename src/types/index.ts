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
export type AgentLabel = "agent/miso" | "agent/saffron" | "agent/maple" | "agent/sage";
export type OwnerLabel = "owner/vet";
export type PriorityLabel = "priority/p0" | "priority/p1" | "priority/p2" | "priority/p3";
export type TypeLabel = "type/bug" | "type/feature" | "type/chore" | "type/research" | "type/security";
export type ProjectLabel = `project/${string}`;

export const STATUS_LABELS: StatusLabel[] = ["status/backlog", "status/in-progress", "status/in-review", "status/done"];
export const AGENT_LABELS: AgentLabel[] = ["agent/miso", "agent/saffron", "agent/maple", "agent/sage"];
export const PRIORITY_LABELS: PriorityLabel[] = ["priority/p0", "priority/p1", "priority/p2", "priority/p3"];
export const PROJECT_PREFIX = "project/";

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

export function getStatusFromLabels(labels: string[]): StatusLabel | null {
  return STATUS_LABELS.find((l) => labels.includes(l)) ?? null;
}

export function getProjectFromLabels(labels: string[]): string | null {
  const projectLabel = labels.find((l) => l.startsWith(PROJECT_PREFIX));
  return projectLabel?.replace(PROJECT_PREFIX, "") ?? null;
}

export function getAgentFromLabels(labels: string[]): AgentLabel | null {
  return AGENT_LABELS.find((l) => labels.includes(l)) ?? null;
}

export function getPriorityFromLabels(labels: string[]): PriorityLabel | null {
  return PRIORITY_LABELS.find((l) => labels.includes(l)) ?? null;
}