import { GitHubIssue } from "@/types";
import { GITHUB_API, getHeadersAsync, fetchPaginated, fetchWithRetry } from "./github-auth";
import { dependencyKey } from "./issue-dependencies";

interface BlockedByItem {
  number?: number;
  repository_url?: string;
  html_url?: string;
  pull_request?: { url?: string };
}

function repoFromBlockedByItem(item: BlockedByItem): string | null {
  // Prefer html_url — always slug form: https://github.com/{owner}/{repo}/issues/{n}.
  const html = /github\.com\/([^/]+\/[^/]+)\/issues\/\d+/i.exec(item.html_url ?? "");
  if (html) return html[1];
  // Fallback: slug-form repository_url. Many payloads use the id form
  // (https://api.github.com/repositories/{id}) which has no slug here (#1086).
  const repo = /\/repos\/([^/]+\/[^/]+)/.exec(item.repository_url ?? "");
  return repo ? repo[1] : null;
}

export async function fetchIssues(
  repoFullName: string,
  options?: {
    includeClosed?: boolean;
    state?: "open" | "closed" | "all";
    since?: Date;
    includeNativeBlockers?: boolean;
  },
): Promise<GitHubIssue[]> {
  const [owner, repo] = repoFullName.split("/");
  // `state` wins when given (lets callers fetch only the closed tail);
  // otherwise the legacy includeClosed flag maps to all/open.
  const state = options?.state ?? (options?.includeClosed ? "all" : "open");
  let url = `${GITHUB_API}/repos/${owner}/${repo}/issues?state=${state}&per_page=100`;
  if (options?.since) {
    url += `&since=${options.since.toISOString()}`;
  }

  const all = await fetchPaginated<GitHubIssue>(url);
  const issues = all.filter((issue: GitHubIssue) => !issue.pull_request);
  return options?.includeNativeBlockers ? enrichNativeBlockers(repoFullName, issues) : issues;
}

async function enrichNativeBlockers(repoFullName: string, issues: GitHubIssue[]): Promise<GitHubIssue[]> {
  const out: GitHubIssue[] = [];
  for (const issue of issues) {
    // Absent/null issue_dependencies_summary means the count is unknown, not
    // zero: leave nativeBlockedBy unset (no fetch) so sync preserves
    // last-known keys (#1086).
    const summary = issue.issue_dependencies_summary;
    if (summary === null || summary === undefined) {
      out.push(issue);
      continue;
    }
    const blocked = summary.blocked_by ?? 0;
    if (blocked <= 0) {
      out.push({ ...issue, nativeBlockedBy: [] });
      continue;
    }
    const fetched = await fetchIssueNativeBlockers(repoFullName, issue.number);
    // null (fetch failed) → leave nativeBlockedBy unset so sync preserves last-known keys (#1086).
    out.push(fetched === null ? issue : { ...issue, nativeBlockedBy: fetched });
  }
  return out;
}

export async function fetchIssue(
  repoFullName: string,
  issueNumber: number,
  options?: { includeNativeBlockedBy?: boolean },
): Promise<GitHubIssue> {
  const [owner, repo] = repoFullName.split("/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}`;
  const response = await fetchWithRetry(url, { headers: await getHeadersAsync() });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error for ${repoFullName}#${issueNumber}: ${response.status} ${text}`);
  }

  const data: GitHubIssue = await response.json();

  if (data.pull_request) {
    throw new Error(`#${issueNumber} is a pull request, not an issue`);
  }

  if (options?.includeNativeBlockedBy) {
    const fetched = await fetchIssueNativeBlockers(repoFullName, issueNumber);
    return fetched === null ? data : { ...data, nativeBlockedBy: fetched };
  }
  return data;
}

/**
 * Fetch native `blocked_by` links for one issue as canonical `owner/repo#N`
 * keys (repo lowercased via dependencyKey). Returns `string[] | null`: null =
 * fetch failed (caller must preserve last-known keys); [] = authoritatively
 * known-none. Best-effort, never throws; pull-request blockers (GitHub allows
 * PR dependencies) are skipped, and items whose repo cannot be derived are
 * skipped rather than mis-attributed to the caller's repo. Results are
 * deduped.
 */
export async function fetchIssueNativeBlockers(
  repoFullName: string,
  issueNumber: number,
): Promise<string[] | null> {
  const [owner, repo] = repoFullName.split("/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/dependencies/blocked_by?per_page=100`;
  try {
    const response = await fetchWithRetry(url, { headers: await getHeadersAsync() });
    if (!response.ok) {
      console.warn(`[dispatch] native blocked_by fetch failed for ${repoFullName}#${issueNumber}: HTTP ${response.status}`);
      return null;
    }
    const data = await response.json();
    if (!Array.isArray(data)) {
      console.warn(`[dispatch] native blocked_by unexpected payload for ${repoFullName}#${issueNumber}`);
      return null;
    }
    const keys = new Set<string>();
    for (const item of data as BlockedByItem[]) {
      if (!item || typeof item.number !== "number" || item.number <= 0 || item.pull_request) continue;
      const depRepo = repoFromBlockedByItem(item);
      if (!depRepo) {
        console.warn(`[dispatch] native blocked_by item with unparseable repo for ${repoFullName}#${issueNumber}`);
        continue;
      }
      keys.add(dependencyKey(depRepo, item.number));
    }
    return Array.from(keys);
  } catch (error) {
    console.warn(
      `[dispatch] native blocked_by fetch errored for ${repoFullName}#${issueNumber}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

export async function updateIssueLabels(
  repoFullName: string,
  issueNumber: number,
  labels: string[]
): Promise<void> {
  const [owner, repo] = repoFullName.split("/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/labels`;

  const response = await fetchWithRetry(url, {
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
  html_url?: string;
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

  const response = await fetchWithRetry(url, { headers: await getHeadersAsync() });
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

  const response = await fetchWithRetry(apiPath, {
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

  const response = await fetchWithRetry(url, {
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

  const response = await fetchWithRetry(url, {
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

  const response = await fetchWithRetry(url, {
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

  const response = await fetchWithRetry(url, {
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

  const response = await fetchWithRetry(url, {
    method: "PATCH",
    headers: await getHeadersAsync(),
    body: JSON.stringify({ state: "closed" }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${text}`);
  }
}

/**
 * Open a new issue. Used by the CI-failure ingester and the hosted groomer's
 * decomposition children (dispatch#1066); every other issue in Dispatch arrives
 * from GitHub rather than being created by it.
 */
export async function createIssue(
  repoFullName: string,
  input: { title: string; body: string; labels?: string[] },
): Promise<{ number: number; html_url: string }> {
  const response = await fetchWithRetry(`${GITHUB_API}/repos/${repoFullName}/issues`, {
    method: "POST",
    headers: { ...(await getHeadersAsync()), "Content-Type": "application/json" },
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      ...(input.labels?.length ? { labels: input.labels } : {}),
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create issue in ${repoFullName}: ${response.status} ${text}`);
  }
  const data = await response.json();
  return { number: data.number, html_url: data.html_url };
}
