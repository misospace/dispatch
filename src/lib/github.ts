import { GitHubIssue } from "@/types";

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

  const jwt = generateAppJwt(privateKey);

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

  const data = (await response.json()) as { token: string; expires_at: number };

  // Cache with a safety buffer before the actual GitHub expiry.
  // GitHub defaults to 1 hour but allows 10min–1h; use whichever is smaller.
  const githubExpiresAt = data.expires_at;
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
 * @returns All collected items across pages.
 */
export async function fetchPaginated<T>(url: string, maxItems = Infinity): Promise<T[]> {
  const all: T[] = [];
  let currentUrl: string | null = url;

  while (currentUrl && all.length < maxItems) {
    const response = await fetch(currentUrl, { headers: await getHeadersAsync() });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API error: ${response.status} ${text}`);
    }

    const page = (await response.json()) as T[];
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
  return fetchPaginated<GithubWorkflowRun>(url, 50);
}

export async function fetchRecentRunsAllWorkflows(repoFullName: string, perPage = 30): Promise<GithubWorkflowRun[]> {
  // Bounded to 100 runs across all workflows — recent history cap.
  const url = `${GITHUB_API}/repos/${repoFullName}/actions/runs?per_page=${perPage}`;
  return fetchPaginated<GithubWorkflowRun>(url, 100);
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
  state: string;
  user: { login: string };
  head: { ref: string };
  base: { ref: string };
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  draft: boolean;
}

export async function fetchPullRequests(repoFullName: string, perPage = 100): Promise<GithubPR[]> {
  // Fetch open PRs across all pages — these are the ones that affect current board state.
  // Closed/merged PRs are history and bounded separately by the sync pipeline.
  const url = `${GITHUB_API}/repos/${repoFullName}/pulls?state=open&per_page=${perPage}`;
  return fetchPaginated<GithubPR>(url, 200);
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
