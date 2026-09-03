import { GITHUB_API, getHeadersAsync, fetchPaginated, fetchWithRetry } from "./github-auth";

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
  const response = await fetchWithRetry(`${GITHUB_API}/repos/${repoFullName}/actions/workflows`, {
    headers: await getHeadersAsync(),
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
  const url = `${GITHUB_API}/repos/${repoFullName}/actions/workflows/${workflowId}/runs?per_page=${perPage}`;
  return fetchPaginated<GithubWorkflowRun>(
    url,
    50,
    (data) => (data as { workflow_runs?: GithubWorkflowRun[] }).workflow_runs ?? [],
  );
}

export async function fetchRecentRunsAllWorkflows(repoFullName: string, perPage = 30): Promise<GithubWorkflowRun[]> {
  const url = `${GITHUB_API}/repos/${repoFullName}/actions/runs?per_page=${perPage}`;
  return fetchPaginated<GithubWorkflowRun>(
    url,
    100,
    (data) => (data as { workflow_runs?: GithubWorkflowRun[] }).workflow_runs ?? [],
  );
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
  const response = await fetchWithRetry(
    `${GITHUB_API}/repos/${repoFullName}/actions/runs/${runId}/jobs`,
    { headers: await getHeadersAsync() }
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
  const url = `${GITHUB_API}/repos/${repoFullName}/releases?per_page=${perPage}`;
  return fetchPaginated<GithubRelease>(url, 50);
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
  const url = `${GITHUB_API}/repos/${repoFullName}/packages?per_page=100`;
  try {
    return fetchPaginated<GithubPackageInfo>(url);
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) return [];
    throw error;
  }
}

export async function rerunWorkflow(repoFullName: string, runId: number): Promise<void> {
  const response = await fetchWithRetry(
    `${GITHUB_API}/repos/${repoFullName}/actions/runs/${runId}/rerun`,
    { method: "POST", headers: await getHeadersAsync() }
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
  const response = await fetchWithRetry(
    `${GITHUB_API}/repos/${repoFullName}/actions/workflows/${workflowId}/dispatches`,
    {
      method: "POST",
      headers: await getHeadersAsync(),
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
  const response = await fetchWithRetry(
    `${GITHUB_API}/repos/${repoFullName}/commits/${branch}?per_page=1`,
    { headers: await getHeadersAsync() }
  );
  if (!response.ok) {
    if (response.status === 404) return null;
    const text = await response.text();
    throw new Error(`Failed to fetch latest commit for ${repoFullName}/${branch}: ${response.status} ${text}`);
  }
  return response.json();
}

export function jobIdFromCheckRunUrl(url: string | undefined | null): string | null {
  const m = /\/job\/(\d+)/.exec(url ?? "");
  return m ? m[1] : null;
}

const TEST_FAILURE_RE = /(^|\s)(FAILED\s+\S|--- FAIL:|FAIL\s+\S+\s|short test summary info|=+ FAILURES =+|AssertionError|Traceback \(most recent call last\))/;

export function extractLogExcerpt(rawLog: string, maxChars = 6000): string {
  if (!rawLog.trim()) return "";
  const stripTs = (l: string) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, "");
  const lines = rawLog.split("\n").map(stripTs);
  const errReAnyCase = /##\[error\]|::error::|\berror:|SCRIPT ERROR|AssertionError|Traceback|exit code [1-9]/i;
  const errReUpperFail = /\bFAIL(ED|URE)?\b/;
  const errRe = { test: (l: string) => errReAnyCase.test(l) || errReUpperFail.test(l) };

  let anchor = -1;
  let trailing = 15;
  for (let i = 0; i < lines.length; i++) {
    if (TEST_FAILURE_RE.test(lines[i])) { anchor = i; break; }
  }
  const testAnchored = anchor >= 0;
  if (anchor >= 0) {
    trailing = 80;
    for (let i = anchor + 1; i < Math.min(lines.length, anchor + trailing); i++) {
      if (/##\[group\]/.test(lines[i])) { trailing = i - anchor; break; }
    }
  } else {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (errRe.test(lines[i])) { anchor = i; break; }
    }
  }

  let slice: string[];
  if (anchor >= 0) {
    slice = lines.slice(Math.max(0, anchor - 40), Math.min(lines.length, anchor + trailing));
  } else {
    const noiseRe = /^(Post |Cleaning up orphan|Complete job|Removing |\[command\])/;
    let end = lines.length;
    while (end > 0 && (!lines[end - 1].trim() || noiseRe.test(lines[end - 1]))) end--;
    slice = lines.slice(Math.max(0, end - 120), end);
  }

  let excerpt = slice.join("\n").trim();
  if (excerpt.length > maxChars) {
    if (testAnchored) {
      const head = Math.floor(maxChars * 0.4);
      const tail = maxChars - head;
      excerpt = excerpt.slice(0, head) + "\n…\n" + excerpt.slice(excerpt.length - tail);
    } else {
      excerpt = "…\n" + excerpt.slice(excerpt.length - maxChars);
    }
  }
  return excerpt;
}

export async function fetchFailedJobLogExcerpt(repoFullName: string, jobId: string | number): Promise<string> {
  const headers = await getHeadersAsync();
  try {
    const resp = await fetchWithRetry(`${GITHUB_API}/repos/${repoFullName}/actions/jobs/${jobId}/logs`, {
      headers,
      redirect: "manual",
    });
    let logText = "";
    if (resp.status === 301 || resp.status === 302) {
      const loc = resp.headers.get("location");
      if (loc) {
        const blob = await fetchWithRetry(loc, {}); // signed URL — must NOT carry the auth header
        if (blob.ok) logText = await blob.text();
      }
    } else if (resp.ok) {
      logText = await resp.text();
    }
    return extractLogExcerpt(logText);
  } catch {
    return "";
  }
}
