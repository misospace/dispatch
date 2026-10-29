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

/**
 * Resolve the authoritative stable-release baseline for the release delta
 * (#1480): GitHub's own "latest release" endpoint (`GET /releases/latest`),
 * defined upstream as the most recent non-prerelease, non-draft release —
 * the same release GitHub surfaces as "Latest".
 *
 * Baking the contract into a single forge read keeps the selection
 * authoritative without trusting any locally persisted window: the release
 * listing is ordered by release creation, not `published_at`, and a
 * long-lived draft keeps its old position in that order when it is finally
 * published later. A window that already holds a stable release therefore
 * cannot prove which stable release is newest by publication time — only
 * GitHub's own latest-release designation can. A 404 is GitHub's own
 * verified absence ("no non-prerelease, non-draft release exists") and
 * yields null; any other failure throws so the caller fails closed to
 * `unknown`. The response is defensively rejected if it ever carries
 * draft/prerelease flags, so a draft or prerelease can never become the
 * baseline even if upstream semantics drift.
 */
export async function fetchStableBaselineRelease(
  repoFullName: string
): Promise<GithubRelease | null> {
  const response = await fetchWithRetry(`${GITHUB_API}/repos/${repoFullName}/releases/latest`, {
    headers: await getHeadersAsync(),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch latest release for ${repoFullName}: ${response.status} ${text}`);
  }
  const data = (await response.json()) as GithubRelease;
  if (!data?.tag_name || !data?.published_at || data.draft || data.prerelease) {
    throw new Error(`Latest release for ${repoFullName} is not a stable published release`);
  }
  return data;
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

/**
 * Result of GitHub's compare semantics (`base...head`, three-dot: from the
 * merge base). `aheadBy`/`behindBy` are exact commit counts — GitHub only
 * bounds the detailed `commits` identity list, never these counts — so a
 * large delta keeps its correct total even though no commit list is kept.
 */
export interface GithubCompare {
  status: "ahead" | "behind" | "identical" | "diverged";
  aheadBy: number;
  behindBy: number;
  mergeBaseCommitSha: string | null;
}

const COMPARE_STATUSES = new Set(["ahead", "behind", "identical", "diverged"]);

/**
 * Compare two refs (branch, tag, or SHA). Returns null when the comparison
 * is impossible — a missing ref (404), an empty/conflicted repo (409), or an
 * unrecognized status — so callers fail closed to "unknown" instead of
 * manufacturing a count. Other failures (rate limit, outage) throw.
 */
export async function fetchCompare(
  repoFullName: string,
  baseRef: string,
  headRef: string
): Promise<GithubCompare | null> {
  const basehead = `${baseRef}...${headRef}`;
  // per_page=1: only the counts matter; keep the commit-identity payload bounded.
  const response = await fetchWithRetry(
    `${GITHUB_API}/repos/${repoFullName}/compare/${encodeURIComponent(basehead)}?per_page=1`,
    { headers: await getHeadersAsync() }
  );
  if (!response.ok) {
    if (response.status === 404 || response.status === 409) return null;
    const text = await response.text();
    throw new Error(`Failed to compare ${basehead} for ${repoFullName}: ${response.status} ${text}`);
  }
  // GitHub answers incomparable refs with 204 No Content — an OK status
  // carrying no body. Treat it like the other not-comparable outcomes.
  if (response.status === 204) return null;
  const data = (await response.json()) as {
    status?: unknown;
    ahead_by?: unknown;
    behind_by?: unknown;
    merge_base_commit?: { sha?: unknown };
  };
  if (
    typeof data.status !== "string" ||
    !COMPARE_STATUSES.has(data.status) ||
    typeof data.ahead_by !== "number" ||
    typeof data.behind_by !== "number"
  ) {
    return null;
  }
  return {
    status: data.status as GithubCompare["status"],
    aheadBy: data.ahead_by,
    behindBy: data.behind_by,
    mergeBaseCommitSha:
      typeof data.merge_base_commit?.sha === "string" ? data.merge_base_commit.sha : null,
  };
}

export async function fetchLatestCommit(repoFullName: string, branch: string): Promise<GithubCommit | null> {
  const response = await fetchWithRetry(
    `${GITHUB_API}/repos/${repoFullName}/commits/${encodeURIComponent(branch)}?per_page=1`,
    { headers: await getHeadersAsync() }
  );
  if (!response.ok) {
    if (response.status === 404) return null;
    const text = await response.text();
    throw new Error(`Failed to fetch latest commit for ${repoFullName}/${branch}: ${response.status} ${text}`);
  }
  return response.json();
}

/**
 * Committer timestamp (ISO string) for an existing commit sha, or null when
 * the ref does not resolve. Used by the grooming freshness pass to judge
 * whether the code-search index has had time to catch up with a new head.
 * GitHub always returns a committer date for a commit; the author date is
 * deliberately not used as a fallback (it can make a rebased head look
 * older than it is).
 */
export async function fetchCommitDate(repoFullName: string, ref: string): Promise<string | null> {
  const response = await fetchWithRetry(`${GITHUB_API}/repos/${repoFullName}/commits/${encodeURIComponent(ref)}`, {
    headers: await getHeadersAsync(),
  });
  if (!response.ok) {
    if (response.status === 404) return null;
    const text = await response.text();
    throw new Error(`Failed to fetch commit ${ref} for ${repoFullName}: ${response.status} ${text}`);
  }
  const data = (await response.json()) as { commit?: { committer?: { date?: string } } };
  return data.commit?.committer?.date ?? null;
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
