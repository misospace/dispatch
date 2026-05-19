import { GitHubIssue } from "@/types";

const GITHUB_API = "https://api.github.com";

function getHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is not set");
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function fetchIssues(repoFullName: string, options?: { includeClosed?: boolean }): Promise<GitHubIssue[]> {
  const [owner, repo] = repoFullName.split("/");
  const state = options?.includeClosed ? "all" : "open";
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues?state=${state}&per_page=100`;
  const response = await fetch(url, { headers: getHeaders() });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error for ${repoFullName}: ${response.status} ${text}`);
  }

  const data = await response.json();
  return data.filter((issue: GitHubIssue) => !issue.pull_request);
}

export async function fetchIssue(repoFullName: string, issueNumber: number): Promise<GitHubIssue> {
  const [owner, repo] = repoFullName.split("/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}`;
  const response = await fetch(url, { headers: getHeaders() });

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
    headers: getHeaders(),
    body: JSON.stringify({ labels }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${text}`);
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
    headers: getHeaders(),
    body: JSON.stringify({ labels: [label] }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${text}`);
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
    headers: getHeaders(),
  });

  if (!response.ok && response.status !== 404) {
    const text = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${text}`);
  }
}

export async function validateGitHubToken(): Promise<boolean> {
  try {
    const response = await fetch(`${GITHUB_API}/user`, {
      headers: getHeaders(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface GithubRepo {
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  pushed_at: string;
}

export async function fetchRepo(repoFullName: string): Promise<GithubRepo> {
  const response = await fetch(`${GITHUB_API}/repos/${repoFullName}`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch repo ${repoFullName}: ${response.status} ${text}`);
  }
  return response.json();
}

export interface GithubWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
  created_at: string;
  updated_at: string;
  last_run?: { created_at: string };
}

export async function fetchWorkflows(repoFullName: string): Promise<GithubWorkflow[]> {
  const response = await fetch(`${GITHUB_API}/repos/${repoFullName}/actions/workflows`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch workflows for ${repoFullName}: ${response.status} ${text}`);
  }
  const data = await response.json();
  return data.workflows;
}

export interface GithubWorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_branch: string;
  head_sha: string;
  actor: { login: string };
  run_started_at: string;
  updated_at: string;
  html_url: string;
  pull_requests: { url: string; number: number }[];
}

export async function fetchWorkflowRuns(repoFullName: string, workflowId: number, perPage = 20): Promise<GithubWorkflowRun[]> {
  const response = await fetch(
    `${GITHUB_API}/repos/${repoFullName}/actions/workflows/${workflowId}/runs?per_page=${perPage}`,
    { headers: getHeaders() }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch workflow runs for ${repoFullName}: ${response.status} ${text}`);
  }
  const data = await response.json();
  return data.workflow_runs;
}

export async function fetchRecentRunsAllWorkflows(repoFullName: string, perPage = 30): Promise<GithubWorkflowRun[]> {
  const response = await fetch(
    `${GITHUB_API}/repos/${repoFullName}/actions/runs?per_page=${perPage}`,
    { headers: getHeaders() }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch recent runs for ${repoFullName}: ${response.status} ${text}`);
  }
  const data = await response.json();
  return data.workflow_runs;
}

export interface GithubJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export async function fetchRunJobs(repoFullName: string, runId: number): Promise<GithubJob[]> {
  const response = await fetch(
    `${GITHUB_API}/repos/${repoFullName}/actions/runs/${runId}/jobs`,
    { headers: getHeaders() }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch jobs for run ${runId}: ${response.status} ${text}`);
  }
  const data = await response.json();
  return data.jobs;
}

export interface GithubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  target_commitish: string | null;
  html_url: string;
  published_at: string;
}

export async function fetchReleases(repoFullName: string, perPage = 10): Promise<GithubRelease[]> {
  const response = await fetch(
    `${GITHUB_API}/repos/${repoFullName}/releases?per_page=${perPage}`,
    { headers: getHeaders() }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch releases for ${repoFullName}: ${response.status} ${text}`);
  }
  return response.json();
}

export interface GithubPR {
  number: number;
  url: string;
  title: string;
  state: string;
  user: { login: string };
  head: { ref: string };
  base: { ref: string };
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  draft: boolean;
}

export async function fetchPullRequests(repoFullName: string, perPage = 20): Promise<GithubPR[]> {
  const response = await fetch(
    `${GITHUB_API}/repos/${repoFullName}/pulls?state=all&per_page=${perPage}`,
    { headers: getHeaders() }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch PRs for ${repoFullName}: ${response.status} ${text}`);
  }
  return response.json();
}

export interface GithubPackageInfo {
  name: string;
  package_type: string;
  visibility: string;
  html_url: string;
  updated_at: string;
  metadata?: { container?: { tags: string[] } };
}

export async function fetchPackages(repoFullName: string): Promise<GithubPackageInfo[]> {
  const response = await fetch(
    `${GITHUB_API}/repos/${repoFullName}/packages?per_page=100`,
    { headers: getHeaders() }
  );
  if (!response.ok) {
    if (response.status === 404) return [];
    const text = await response.text();
    throw new Error(`Failed to fetch packages for ${repoFullName}: ${response.status} ${text}`);
  }
  return response.json();
}

export async function rerunWorkflow(repoFullName: string, runId: number): Promise<void> {
  const response = await fetch(
    `${GITHUB_API}/repos/${repoFullName}/actions/runs/${runId}/rerun`,
    { method: "POST", headers: getHeaders() }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to rerun workflow ${runId}: ${response.status} ${text}`);
  }
}

export async function triggerWorkflowDispatch(
  repoFullName: string,
  workflowId: number,
  ref: string
): Promise<void> {
  const response = await fetch(
    `${GITHUB_API}/repos/${repoFullName}/actions/workflows/${workflowId}/dispatches`,
    {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ ref }),
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to trigger workflow ${workflowId}: ${response.status} ${text}`);
  }
}

export interface GithubCommit {
  sha: string;
  commit: { message: string; author: { name: string; date: string } };
  html_url: string;
}

export async function fetchLatestCommit(repoFullName: string, branch: string): Promise<GithubCommit | null> {
  const response = await fetch(
    `${GITHUB_API}/repos/${repoFullName}/commits/${branch}?per_page=1`,
    { headers: getHeaders() }
  );
  if (!response.ok) {
    if (response.status === 404) return null;
    const text = await response.text();
    throw new Error(`Failed to fetch latest commit for ${repoFullName}/${branch}: ${response.status} ${text}`);
  }
  return response.json();
}
