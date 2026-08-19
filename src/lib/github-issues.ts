import { GitHubIssue } from "@/types";
import { GITHUB_API, getHeadersAsync, fetchPaginated } from "./github-auth";

export async function fetchIssues(
  repoFullName: string,
  options?: { includeClosed?: boolean; since?: Date },
): Promise<GitHubIssue[]> {
  const [owner, repo] = repoFullName.split("/");
  const state = options?.includeClosed ? "all" : "open";
  let url = `${GITHUB_API}/repos/${owner}/${repo}/issues?state=${state}&per_page=100`;
  if (options?.since) {
    url += `&since=${options.since.toISOString()}`;
  }

  const all = await fetchPaginated<GitHubIssue>(url);
  return all.filter((issue: GitHubIssue) => !issue.pull_request);
}

export async function fetchIssue(repoFullName: string, issueNumber: number): Promise<GitHubIssue> {
  const [owner, repo] = repoFullName.split("/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}`;
  const response = await fetch(url, { headers: await getHeadersAsync() });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error for ${repoFullName}#${issueNumber}: ${response.status} ${text}`);
  }

  const data: GitHubIssue = await response.json();

  if (data.pull_request) {
    throw new Error(`#${issueNumber} is a pull request, not an issue`);
  }

  return data;
}

export async function updateIssueLabels(
  repoFullName: string,
  issueNumber: number,
  labels: string[]
): Promise<void> {
  const [owner, repo] = repoFullName.split("/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/labels`;

  const response = await fetch(url, {
    method: "PUT",
    headers: await getHeadersAsync(),
    body: JSON.stringify({ labels }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${text}`);
  }
}

export interface GitHubIssueComment {
  id?: number;
  user?: { login?: string };
  body?: string | null;
  created_at?: string;
}

export async function fetchIssueComments(
  repoFullName: string,
  issueNumber: number,
  maxComments = 5,
  direction: "asc" | "desc" = "asc",
): Promise<GitHubIssueComment[]> {
  const [owner, repo] = repoFullName.split("/");
  const perPage = Math.max(1, Math.min(maxComments, 100));
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${perPage}&sort=created&direction=${direction}`;

  const response = await fetch(url, { headers: await getHeadersAsync() });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error for ${repoFullName}#${issueNumber} comments: ${response.status} ${text}`);
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error(`GitHub API error: expected comments array for ${repoFullName}#${issueNumber}`);
  }

  return data.slice(0, maxComments) as GitHubIssueComment[];
}

export async function addIssueComment(
  repoFullName: string,
  issueNumber: number,
  body: string,
): Promise<{ url: string | null }> {
  const [owner, repo] = repoFullName.split("/");
  const apiPath = `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/comments`;

  const response = await fetch(apiPath, {
    method: "POST",
    headers: await getHeadersAsync(),
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error adding comment: ${response.status} ${text}`);
  }

  try {
    const data = (await response.json()) as { html_url?: string };
    return { url: data.html_url ?? null };
  } catch {
    return { url: null };
  }
}

export async function updateIssueComment(
  repoFullName: string,
  commentId: number,
  body: string,
): Promise<void> {
  const [owner, repo] = repoFullName.split("/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/comments/${commentId}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: await getHeadersAsync(),
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error updating comment ${commentId}: ${response.status} ${text}`);
  }
}

export async function addIssueLabel(
  repoFullName: string,
  issueNumber: number,
  label: string
): Promise<void> {
  const [owner, repo] = repoFullName.split("/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/labels`;

  const response = await fetch(url, {
    method: "POST",
    headers: await getHeadersAsync(),
    body: JSON.stringify({ labels: [label] }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${text}`);
  }
}

export interface UpdateIssueFields {
  title?: string;
  body?: string | null;
}

export async function updateIssueTitleAndBody(
  repoFullName: string,
  issueNumber: number,
  fields: UpdateIssueFields,
): Promise<void> {
  const [owner, repo] = repoFullName.split("/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: await getHeadersAsync(),
    body: JSON.stringify(fields),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error updating issue #${issueNumber}: ${response.status} ${text}`);
  }
}

export async function removeIssueLabel(
  repoFullName: string,
  issueNumber: number,
  label: string
): Promise<void> {
  const [owner, repo] = repoFullName.split("/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`;

  const response = await fetch(url, {
    method: "DELETE",
    headers: await getHeadersAsync(),
  });

  if (!response.ok && response.status !== 404) {
    const text = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${text}`);
  }
}

export async function syncStatusLabels(
  repoFullName: string,
  issueNumber: number,
  add: string[],
  remove: string[],
): Promise<void> {
  for (const label of remove) {
    await removeIssueLabel(repoFullName, issueNumber, label);
  }
  for (const label of add) {
    await addIssueLabel(repoFullName, issueNumber, label);
  }
}

export async function closeIssue(
  repoFullName: string,
  issueNumber: number
): Promise<void> {
  const [owner, repo] = repoFullName.split("/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: await getHeadersAsync(),
    body: JSON.stringify({ state: "closed" }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${text}`);
  }
}
