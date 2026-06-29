import { GitHubIssue } from "@/types";
import type { CheckFailure, PrHealthInput } from "./linked-pr-health";

const GITHUB_API = "https://api.github.com";

// Token cache for GitHub App installation tokens
interface CachedToken {
  token: string;
  expiresAt: number;
}

let installationTokenCache: CachedToken | null = null;
let useGitHubApp = false;

/**
 * Base64url-encode an ArrayBuffer (no padding).
 */
function base64urlEncodeArrayBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return Buffer.from(binary, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Base64url-encode a string (no padding).
 */
function base64urlEncode(data: string): string {
  return Buffer.from(data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Convert a PEM private key string to an ArrayBuffer suitable for crypto.subtle.importKey.
 */
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const lines = pem.split("\n").filter((line) => !line.startsWith("-----"));
  const base64 = lines.join("");
  const bytes = Buffer.from(base64, "base64");
  // Create a clean copy to avoid shared buffer issues
  const copy = Buffer.alloc(bytes.length);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

/**
 * Generate a JWT signed with the GitHub App private key using RS256 (RSA-SHA256).
 */
async function generateAppJwt(privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64urlEncode(JSON.stringify({
    iat: now,
    exp: now + 600, // 10 minutes
    iss: process.env.GITHUB_APP_ID,
  }));
  const signingInput = `${header}.${payload}`;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const signature = base64urlEncodeArrayBuffer(signatureBuffer);

  return `${signingInput}.${signature}`;
}

/**
 * Fetch an installation access token from GitHub App auth.
 */
async function getInstallationToken(): Promise<string> {
  const result = await getInstallationTokenWithExpiry();
  return result.token;
}

/**
 * Fetch an installation access token with its expiry timestamp.
 */
async function getInstallationTokenWithExpiry(): Promise<CachedToken> {
  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  let privateKey = process.env.GITHUB_APP_PRIVATE_KEY || "";

  if (!appId || !installationId || !privateKey) {
    throw new Error("GitHub App authentication is misconfigured — missing required env vars");
  }

  // Support escaped newlines from Kubernetes/ExternalSecrets-style env injection
  privateKey = privateKey.replace(/\\n/g, "\n");

  const jwt = await generateAppJwt(privateKey);

  const response = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get GitHub App installation token: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { token: string; expires_at: string };

  // Cache with a safety buffer before the actual GitHub expiry.
  // GitHub returns expires_at as an ISO-8601 string (e.g. "2026-05-29T18:00:00Z").
  // GitHub defaults to 1 hour but allows 10min–1h; use whichever is smaller.
  const githubExpiresAt = Math.floor(Date.parse(data.expires_at) / 1000);
  const safeTtl = Math.min(3300, githubExpiresAt - Math.floor(Date.now() / 1000) - 60);

  return { token: data.token, expiresAt: Date.now() / 1000 + safeTtl };
}

/**
 * Initialize GitHub App token cache if all required env vars are present.
 * Called lazily on first use of getGitHubToken().
 */
async function ensureInit(): Promise<void> {
  if (useGitHubApp) return; // already initialized

  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || !installationId || !privateKey) {
    return; // not configured — will fall back to PAT
  }

  useGitHubApp = true;
  try {
    const cached = await getInstallationTokenWithExpiry();
    installationTokenCache = cached;
  } catch {
    // If token fetch fails, mark as failed so we don't retry endlessly
    useGitHubApp = false;
  }
}

/**
 * Refresh the GitHub App installation token if needed.
 */
async function refreshIfNeeded(): Promise<void> {
  if (!useGitHubApp || !installationTokenCache) return;

  // Refresh token 60 seconds before expiry
  if (installationTokenCache.expiresAt <= Date.now() / 1000 + 60) {
    const cached = await getInstallationTokenWithExpiry();
    installationTokenCache = cached;
  }
}

/**
 * Get a valid GitHub token, choosing between GitHub App installation auth
 * and the legacy PAT-based auth.
 *
 * Returns the token string to use for API requests.
 */
export async function getGitHubToken(): Promise<string> {
  // Ensure GitHub App is initialized (lazy init on first call)
  await ensureInit();

  // Ensure token cache is fresh
  await refreshIfNeeded();

  if (useGitHubApp && installationTokenCache) {
    return installationTokenCache.token;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is not set");
  }
  return token;
}

/**
 * Get headers for GitHub API requests — ensures token freshness via async refresh.
 */
async function getHeadersAsync(): Promise<HeadersInit> {
  await refreshIfNeeded();

  if (useGitHubApp && installationTokenCache) {
    return {
      Authorization: `Bearer ${installationTokenCache.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  const token = await getGitHubToken();
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Reset internal GitHub App auth state. Exposed for testing only.
 */
export function __resetGitHubAppState(): void {
  installationTokenCache = null;
  useGitHubApp = false;
}

/**
 * Parse the Link header from a GitHub API response to extract pagination URLs.
 * Returns the "next" URL if available, otherwise null.
 */
function getNextLink(response: Response): string | null {
  const link = response.headers.get("Link");
  if (!link) return null;
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  return match?.[1] ?? null;
}

/**
 * Fetch a paginated GitHub REST endpoint, following Link headers until exhausted
 * or until `maxItems` items have been collected.
 *
 * @param url       - Initial API URL (must include per_page query param).
 * @param maxItems  - Hard cap on total items returned. Defaults to Infinity (exhaust all pages).
 * @param extractPageItems - Optional extractor for GitHub endpoints that wrap arrays
 *                           in an object, such as Actions runs.
 * @returns All collected items across pages.
 */
export async function fetchPaginated<T>(
  url: string,
  maxItems = Infinity,
  extractPageItems?: (data: unknown) => T[],
): Promise<T[]> {
  const all: T[] = [];
  let currentUrl: string | null = url;

  while (currentUrl && all.length < maxItems) {
    const response = await fetch(currentUrl, { headers: await getHeadersAsync() });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API error: ${response.status} ${text}`);
    }

    const data = await response.json();
    const page = extractPageItems ? extractPageItems(data) : data;
    if (!Array.isArray(page)) {
      throw new Error(`GitHub API error: expected array response from ${currentUrl}`);
    }
    const remaining = maxItems - all.length;
    all.push(...page.slice(0, remaining));

    if (all.length >= maxItems) break;

    currentUrl = getNextLink(response);
  }

  return all;
}

export async function fetchIssues(repoFullName: string, options?: { includeClosed?: boolean }): Promise<GitHubIssue[]> {
  const [owner, repo] = repoFullName.split("/");
  const state = options?.includeClosed ? "all" : "open";
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues?state=${state}&per_page=100`;

  // Fetch all pages of issues, then filter out PRs (GitHub returns PRs as issues)
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
  user?: { login?: string };
  body?: string | null;
  created_at?: string;
}

export async function fetchIssueComments(
  repoFullName: string,
  issueNumber: number,
  maxComments = 5,
): Promise<GitHubIssueComment[]> {
  const [owner, repo] = repoFullName.split("/");
  const perPage = Math.max(1, Math.min(maxComments, 100));
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${perPage}&sort=created&direction=asc`;

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

/**
 * Update issue title and/or body via GitHub API.
 */
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

export async function validateGitHubToken(): Promise<boolean> {
  try {
    const response = await fetch(`${GITHUB_API}/user`, {
      headers: await getHeadersAsync(),
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
    headers: await getHeadersAsync(),
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
  // Bounded to 50 runs — enough to see recent history without excessive API usage.
  const url = `${GITHUB_API}/repos/${repoFullName}/actions/workflows/${workflowId}/runs?per_page=${perPage}`;
  return fetchPaginated<GithubWorkflowRun>(
    url,
    50,
    (data) => (data as { workflow_runs?: GithubWorkflowRun[] }).workflow_runs ?? [],
  );
}

export async function fetchRecentRunsAllWorkflows(repoFullName: string, perPage = 30): Promise<GithubWorkflowRun[]> {
  // Bounded to 100 runs across all workflows — recent history cap.
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
  const response = await fetch(
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
  // Bounded to 50 releases — enough for recent release history.
  const url = `${GITHUB_API}/repos/${repoFullName}/releases?per_page=${perPage}`;
  return fetchPaginated<GithubRelease>(url, 50);
}

export interface GithubPR {
  number: number;
  url: string;
  title: string;
  /** PR body text (available when fetched from closed PRs endpoint) */
  body?: string | null;
  state: string;
  user: { login: string };
  head: { ref: string };
  base: { ref: string };
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  draft: boolean;
  /** GitHub review decision: APPROVED, CHANGES_REQUESTED, COMMENTED, or null */
  reviewDecision?: string | null;
  /** GitHub merge state status: clean, dirty, behind, blocked, unknown, or null */
  mergeStateStatus?: string | null;
}

export async function fetchPullRequests(repoFullName: string, perPage = 100): Promise<GithubPR[]> {
  // Fetch open PRs across all pages — these are the ones that affect current board state.
  // Use fetchClosedPullRequests for merged/closed history.
  const url = `${GITHUB_API}/repos/${repoFullName}/pulls?state=open&per_page=${perPage}`;
  return fetchPaginated<GithubPR>(url, 200);
}

/**
 * Fetch recently-updated closed PRs (merged and closed-unmerged), most recent first.
 *
 * The open-only fetchPullRequests never returns merged PRs (their merged_at is
 * always null), so reconciliation uses this to detect merged PRs that should
 * close their fixing issue. Bounded to the most recently updated PRs so old
 * repos don't pull unbounded history.
 */
export async function fetchClosedPullRequests(repoFullName: string, maxItems = 100): Promise<GithubPR[]> {
  const url = `${GITHUB_API}/repos/${repoFullName}/pulls?state=closed&sort=updated&direction=desc&per_page=100`;
  return fetchPaginated<GithubPR>(url, maxItems);
}

export interface PrHealthSignals {
  reviewDecision: string | null;
  mergeStateStatus: string | null;
}

/**
 * Derive an aggregate review decision from a PR's review list.
 *
 * Mirrors GitHub's own aggregation: the latest non-comment review per reviewer
 * wins; any outstanding CHANGES_REQUESTED takes precedence over APPROVED.
 * Returns null when there are no actionable reviews.
 */
function deriveReviewDecision(
  reviews: Array<{ user?: { login?: string } | null; state?: string; submitted_at?: string }>,
): string | null {
  const latestByUser = new Map<string, { state: string; submittedAt: number }>();
  for (const review of reviews) {
    const login = review.user?.login;
    const state = review.state?.toUpperCase();
    if (!login || !state) continue;
    // COMMENTED / DISMISSED / PENDING don't carry an approval signal.
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED") continue;
    const submittedAt = review.submitted_at ? Date.parse(review.submitted_at) : 0;
    const prev = latestByUser.get(login);
    if (!prev || submittedAt >= prev.submittedAt) {
      latestByUser.set(login, { state, submittedAt });
    }
  }

  const states = Array.from(latestByUser.values()).map((r) => r.state);
  if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  if (states.includes("APPROVED")) return "APPROVED";
  return null;
}

/**
 * Fetch the health signals (review decision + merge state) for a single PR.
 *
 * The list endpoint used by fetchPullRequests does not return `mergeable_state`
 * or any review decision, so these require a per-PR detail GET plus the reviews
 * endpoint. Failures are tolerated and surface as null signals.
 */
export async function fetchPullRequestHealthSignals(
  repoFullName: string,
  prNumber: number,
): Promise<PrHealthSignals> {
  const headers = await getHeadersAsync();

  let mergeStateStatus: string | null = null;
  let reviewDecision: string | null = null;

  try {
    const detailResp = await fetch(`${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}`, { headers });
    if (detailResp.ok) {
      const detail = (await detailResp.json()) as { mergeable_state?: string | null };
      mergeStateStatus = detail.mergeable_state ?? null;
    }
  } catch {
    // Leave mergeStateStatus null on transient failure.
  }

  try {
    const reviews = await fetchPaginated<{ user?: { login?: string } | null; state?: string; submitted_at?: string }>(
      `${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}/reviews?per_page=100`,
    );
    reviewDecision = deriveReviewDecision(reviews);
  } catch {
    // Leave reviewDecision null on transient failure.
  }

  return { reviewDecision, mergeStateStatus };
}

/**
 * Fetch failing CI check runs for a PR's head ref.
 *
 * Uses the check-runs endpoint for the head branch. Only completed runs with a
 * failure-type conclusion are returned. Transient failures yield an empty list
 * rather than throwing, so health computation degrades gracefully.
 */
export async function fetchPullRequestCheckFailures(repoFullName: string, ref: string): Promise<CheckFailure[]> {
  const FAILURE_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);
  try {
    const response = await fetch(
      `${GITHUB_API}/repos/${repoFullName}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
      { headers: await getHeadersAsync() },
    );
    if (!response.ok) return [];
    const data = (await response.json()) as { check_runs?: Array<{ name?: string; conclusion?: string | null }> };
    return (data.check_runs ?? [])
      .filter((run) => run.conclusion && FAILURE_CONCLUSIONS.has(run.conclusion.toLowerCase()))
      .map((run) => ({ name: run.name ?? "unknown", conclusion: run.conclusion as string }));
  } catch {
    return [];
  }
}

/**
 * Assemble a full PrHealthInput for a PR by combining review decision + merge
 * state (fetchPullRequestHealthSignals) with failing check runs. This is the
 * single source the linked-PR-health feature uses to compute a snapshot, from
 * both the reconcile job and the on-demand refresh endpoint.
 */
export async function fetchLinkedPrHealthInput(repoFullName: string, pr: GithubPR): Promise<PrHealthInput> {
  const [signals, checkFailures] = await Promise.all([
    fetchPullRequestHealthSignals(repoFullName, pr.number),
    fetchPullRequestCheckFailures(repoFullName, pr.head?.ref ?? ""),
  ]);

  const state: PrHealthInput["state"] = pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "open";

  return {
    url: pr.url,
    number: pr.number,
    state,
    draft: pr.draft,
    mergedAt: pr.merged_at,
    mergeStateStatus: signals.mergeStateStatus,
    reviewDecision: signals.reviewDecision,
    checkFailures,
  };
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
  // Fetch all pages — we need complete package inventory.
  const url = `${GITHUB_API}/repos/${repoFullName}/packages?per_page=100`;
  try {
    return fetchPaginated<GithubPackageInfo>(url);
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) return [];
    throw error;
  }
}

export async function rerunWorkflow(repoFullName: string, runId: number): Promise<void> {
  const response = await fetch(
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
  const response = await fetch(
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
  const response = await fetch(
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

export interface GitHubRepoMetadata {
  fullName: string;
  defaultBranch: string;
  description: string | null;
}

export async function fetchRepositoryMetadata(repoFullName: string): Promise<GitHubRepoMetadata> {
  const response = await fetch(`${GITHUB_API}/repos/${repoFullName}`, {
    headers: await getHeadersAsync(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch repo metadata for ${repoFullName}: ${response.status} ${text}`);
  }
  const data = await response.json();
  return {
    fullName: data.full_name ?? repoFullName,
    defaultBranch: data.default_branch ?? "main",
    description: data.description ?? null,
  };
}

export interface GitHubCodeSearchResult {
  path: string;
  url: string;
}

export async function searchRepositoryCode(
  repoFullName: string,
  query: string,
  limit: number,
): Promise<GitHubCodeSearchResult[]> {
  const perPage = Math.min(Math.max(1, limit), 100);
  const searchQuery = `${query} repo:${repoFullName}`;
  const url = `${GITHUB_API}/search/code?q=${encodeURIComponent(searchQuery)}&per_page=${perPage}`;
  const response = await fetch(url, { headers: await getHeadersAsync() });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Code search failed for ${repoFullName}: ${response.status} ${text}`);
  }
  const data = await response.json();
  const items = (data.items ?? []).slice(0, limit);
  return items.map((item: { path?: string; html_url?: string }) => ({
    path: item.path ?? "",
    url: item.html_url ?? "",
  }));
}

/**
 * Encode each segment of a file path individually for the GitHub Contents API.
 */
function encodePathForContentsApi(path: string): string {
  return path.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

export async function fetchRepositoryFileText(
  repoFullName: string,
  path: string,
  ref?: string,
): Promise<string> {
  const encodedPath = encodePathForContentsApi(path);
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const response = await fetch(
    `${GITHUB_API}/repos/${repoFullName}/contents/${encodedPath}${query}`,
    { headers: await getHeadersAsync() },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch file ${path} in ${repoFullName}: ${response.status} ${text}`);
  }
  const data = await response.json();
  if (!data.content || data.type !== "file") {
    return "";
  }
  return Buffer.from(data.content, "base64").toString("utf8");
}
