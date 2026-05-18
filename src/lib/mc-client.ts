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

export function getDispatchConfig(): { baseUrl: string; token: string } {
  const baseUrl = process.env.DISPATCH_URL;
  const token = process.env.DISPATCH_AGENT_TOKEN;

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
    baseUrl: baseUrl.replace(/\/+$/, ""),
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
  agentName: string,
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
  agentName: string,
  options?: { status?: string; force?: boolean },
): Promise<ClaimWorkResult> {
  const resolved = await resolveIssue(repoFullName, issueNumber);
  const status = options?.status ?? "in-progress";

  await claimIssue(repoFullName, issueNumber, agentName, options?.force);
  await setIssueStatus(repoFullName, issueNumber, status, agentName);

  const taskContract = `[Task Contract] Work on issue #${issueNumber} in ${repoFullName}.

Issue: ${resolved.title}
URL: ${resolved.url}
Lane: ${resolved.lane || "normal"}
Status: ${status}
Labels: ${resolved.labels.join(", ") || "none"}

Scope of work:
- Only work on this specific issue. Do not pick up other issues.
- Update the issue status as you progress (backlog -> in-progress -> in-review -> done).
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
  };
}
