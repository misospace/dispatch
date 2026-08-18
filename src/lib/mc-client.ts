export interface McIssue {
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
  lastSyncedAt: Date;
  currentLane: string | null;
  repository: {
    fullName: string;
  };
}

export interface ResolveIssueResult {
  issueId: string;
  repoFullName: string;
  issueNumber: number;
  title: string;
  url: string;
  labels: string[];
  status: string | null;
  lane: string | null;
}

export interface ClaimIssueResult {
  success: boolean;
  labels: string[];
}

export interface UnclaimIssueResult {
  success: boolean;
  labels: string[];
}

export interface SetStatusResult {
  success: boolean;
  status: string;
  labels: string[];
}

export interface ClaimWorkResult {
  issueId: string;
  repoFullName: string;
  issueNumber: number;
  title: string;
  url: string;
  labels: string[];
  lane: string | null;
  status: string;
  taskContract: string;
  resolvedAgentName: string;
}

export interface RefreshIssueResult {
  success: boolean;
  repo: string;
  issueNumber: number;
  action: "created" | "updated";
  error: string | null;
}

export interface SyncRepoResult {
  success: boolean;
  repos: number;
  syncedCount: number;
  results: { repo: string; synced: number; error: string | null }[];
}

export class DispatchClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null = null,
  ) {
    super(message);
    this.name = "DispatchClientError";
  }
}

import { getDispatchUrl, getDispatchAgentToken, getDispatchAgentName } from "./dispatch-env";
import { getClaimableLanes } from "./lane-config";

export function getDispatchConfig(): { baseUrl: string; token: string } {
  const baseUrl = getDispatchUrl();
  const token = getDispatchAgentToken();

  if (!baseUrl) {
    throw new DispatchClientError(
      "DISPATCH_URL is not set. Set it to your Dispatch instance URL.",
    );
  }

  if (!token) {
    throw new DispatchClientError(
      "DISPATCH_AGENT_TOKEN is not set. Set it to your agent bearer token.",
    );
  }

  return {
    baseUrl,
    token,
  };
}

async function mcFetch(path: string, options: RequestInit): Promise<Response> {
  const { baseUrl, token } = getDispatchConfig();
  const url = `${baseUrl}${path}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> || {}),
  };

  // Bearer auth — never log the token
  if (!headers.Authorization) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  return response;
}

async function mcJson<T>(path: string, options: RequestInit): Promise<T> {
  const response = await mcFetch(path, options);
  const text = await response.text();

  if (!response.ok) {
    let errorMessage: string;
    try {
      const body = JSON.parse(text) as { error?: string };
      errorMessage = body.error || text;
    } catch {
      errorMessage = text || `HTTP ${response.status}`;
    }
    throw new DispatchClientError(errorMessage, response.status);
  }

  if (!text) {
    return {} as T;
  }

  return JSON.parse(text) as T;
}

/**
 * Resolve the effective agent name for a claim operation.
 *
 * Resolution order:
 * 1. Explicit `agentName` argument (if provided and non-empty)
 * 2. `DISPATCH_AGENT_NAME` environment variable
 *
 * Returns undefined when neither is available — callers should treat this as
 * a validation error rather than silently using a default like "Dispatch MCP".
 */
export function resolveAgentName(agentName: string | undefined): string | undefined {
  if (agentName && agentName.trim().length > 0) {
    return agentName.trim();
  }

  const envName = getDispatchAgentName();
  if (envName && envName.trim().length > 0) {
    return envName.trim();
  }

  return undefined;
}

export async function resolveIssue(
  repoFullName: string,
  issueNumber: number,
): Promise<ResolveIssueResult> {
  const issues = await mcJson<McIssue[]>(`/api/issues?repo=${encodeURIComponent(repoFullName)}`, {
    method: "GET",
  });

  const issue = issues.find((i) => i.number === issueNumber);

  if (!issue) {
    throw new DispatchClientError(
      `Issue #${issueNumber} not found in ${repoFullName}. Sync the repo first or verify the issue number.`,
      404,
    );
  }

  const status = issue.labels.find((l) => l.startsWith("status/")) ?? null;

  return {
    issueId: issue.id,
    repoFullName: issue.repository.fullName,
    issueNumber: issue.number,
    title: issue.title,
    url: issue.url,
    labels: issue.labels,
    status,
    lane: issue.currentLane ?? null,
  };
}

export async function claimIssue(
  repoFullName: string,
  issueNumber: number,
  agentName: string | undefined,
  force?: boolean,
): Promise<ClaimIssueResult> {
  const resolved = await resolveIssue(repoFullName, issueNumber);

  return mcJson<ClaimIssueResult>("/api/issues/claim", {
    method: "POST",
    body: JSON.stringify({
      issueId: resolved.issueId,
      repoFullName,
      issueNumber,
      agentName,
      force: force ?? false,
    }),
  });
}

export async function unclaimIssue(
  repoFullName: string,
  issueNumber: number,
  agentName: string,
): Promise<UnclaimIssueResult> {
  const resolved = await resolveIssue(repoFullName, issueNumber);

  return mcJson<UnclaimIssueResult>("/api/issues/unclaim", {
    method: "POST",
    body: JSON.stringify({
      issueId: resolved.issueId,
      repoFullName,
      issueNumber,
      agentName,
    }),
  });
}

export async function getQueue(
  agentName: string,
  options?: {
    lane?: string;
    excludeDecomposed?: boolean;
    includeClaimed?: boolean;
    includeRenovate?: boolean;
  },
): Promise<unknown[]> {
  const params = new URLSearchParams();
  if (options?.lane) params.set("lane", options.lane);
  if (options?.excludeDecomposed) params.set("exclude_decomposed", "true");
  if (options?.includeClaimed) params.set("includeClaimed", "true");
  if (options?.includeRenovate) params.set("includeRenovate", "true");
  const qs = params.toString();

  return mcJson<unknown[]>(
    `/api/agents/${encodeURIComponent(agentName)}/queue${qs ? `?${qs}` : ""}`,
    { method: "GET" },
  );
}

export async function listIssues(filters?: {
  repo?: string;
  status?: string;
  lane?: string;
  agent?: string;
  priority?: string;
  includeClosed?: boolean;
}): Promise<unknown[]> {
  const params = new URLSearchParams();
  if (filters?.repo) params.set("repo", filters.repo);
  if (filters?.status) params.set("status", filters.status);
  if (filters?.lane) params.set("lane", filters.lane);
  if (filters?.agent) params.set("agent", filters.agent);
  if (filters?.priority) params.set("priority", filters.priority);
  if (filters?.includeClosed) params.set("includeClosed", "true");
  const qs = params.toString();

  return mcJson<unknown[]>(`/api/issues${qs ? `?${qs}` : ""}`, { method: "GET" });
}

export async function listPrFixes(options?: {
  lane?: string;
  includeBlocked?: boolean;
}): Promise<unknown[]> {
  const params = new URLSearchParams();
  if (options?.lane) params.set("lane", options.lane);
  if (options?.includeBlocked) params.set("include_blocked", "true");
  const qs = params.toString();

  return mcJson<unknown[]>(`/api/pr-fix-queue/queued${qs ? `?${qs}` : ""}`, {
    method: "GET",
  });
}

export async function markPrFix(input: {
  repo: string;
  pr: number;
  status: string;
  note?: string;
}): Promise<unknown> {
  return mcJson<unknown>("/api/pr-fix-queue/mark", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function requeuePrFix(input: {
  repo: string;
  pr: number;
  isPrMergedOrClosed?: boolean;
  note?: string | null;
}): Promise<unknown> {
  return mcJson<unknown>("/api/pr-fix-queue/requeue", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function runGroomer(target?: {
  repoFullName?: string;
  issueNumber?: number;
}): Promise<unknown> {
  return mcJson<unknown>("/api/groomer/run", {
    method: "POST",
    body: JSON.stringify(target ?? {}),
  });
}

export async function setIssueStatus(
  repoFullName: string,
  issueNumber: number,
  status: string,
  agentName?: string,
): Promise<SetStatusResult> {
  const resolved = await resolveIssue(repoFullName, issueNumber);

  return mcJson<SetStatusResult>("/api/issues/status", {
    method: "POST",
    body: JSON.stringify({
      issueId: resolved.issueId,
      repoFullName,
      issueNumber,
      status,
      agentName,
    }),
  });
}

export async function claimWork(
  repoFullName: string,
  issueNumber: number,
  agentName: string | undefined,
  options?: { status?: string; force?: boolean; refreshBeforeClaim?: boolean },
): Promise<ClaimWorkResult> {
  const resolvedAgent = resolveAgentName(agentName);
  if (!resolvedAgent) {
    throw new DispatchClientError(
      "agentName is required. Either pass an explicit agentName argument or set the DISPATCH_AGENT_NAME environment variable. Do not use generic identities like 'Dispatch MCP'.",
    );
  }

  const refreshEnabled = options?.refreshBeforeClaim ?? true;
  const status = options?.status ?? "in-progress";

  let resolved: ResolveIssueResult;
  let refreshSucceeded = false;

  try {
    resolved = await resolveIssue(repoFullName, issueNumber);
  } catch (error) {
    if (!refreshEnabled || !(error instanceof DispatchClientError)) {
      throw error;
    }

    try {
      await refreshIssue(repoFullName, issueNumber);
      refreshSucceeded = true;
      resolved = await resolveIssue(repoFullName, issueNumber);
    } catch {
      throw new DispatchClientError(
        `Issue #${issueNumber} not found in ${repoFullName} after refresh. The issue may not exist or the repo may not be tracked.`,
        404,
      );
    }
  }

  await claimIssue(repoFullName, issueNumber, resolvedAgent, options?.force);
  await setIssueStatus(repoFullName, issueNumber, status, resolvedAgent);

  const taskContract = `[Task Contract] Work on issue #${issueNumber} in ${repoFullName}.

Issue: ${resolved.title}
URL: ${resolved.url}
Lane: ${resolved.lane || getClaimableLanes()[0]?.id || "local"}
Status: ${status}
Labels: ${resolved.labels.join(", ") || "none"}
Agent: ${resolvedAgent}
${refreshSucceeded ? "\nNote: Issue was refreshed from GitHub before claiming (was not in cache).\n" : ""}

Scope of work:
- Only work on this specific issue. Do not pick up other issues.
- Update the issue status as you progress (backlog -> ready -> in-progress -> in-review -> done).
- Push commits and PRs referencing the issue number (${issueNumber}).
- When complete, set status to done.`;

  return {
    issueId: resolved.issueId,
    repoFullName: resolved.repoFullName,
    issueNumber: resolved.issueNumber,
    title: resolved.title,
    url: resolved.url,
    labels: resolved.labels,
    lane: resolved.lane,
    status,
    taskContract,
    resolvedAgentName: resolvedAgent,
  };
}

export async function refreshIssue(
  repoFullName: string,
  issueNumber: number,
): Promise<RefreshIssueResult> {
  return mcJson<RefreshIssueResult>("/api/issues/refresh", {
    method: "POST",
    body: JSON.stringify({ repoFullName, issueNumber }),
  });
}

export async function syncRepo(
  repoFullName: string,
): Promise<SyncRepoResult> {
  return mcJson<SyncRepoResult>("/api/sync", {
    method: "POST",
    body: JSON.stringify({ repoFullName }),
  });
}
