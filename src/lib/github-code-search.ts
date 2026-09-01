import { GITHUB_API, getHeadersAsync, fetchPaginated } from "./github-auth";

export interface GithubRepo {
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  pushed_at: string;
}

async function fetchRepoJson(repoFullName: string, errorPrefix: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${GITHUB_API}/repos/${repoFullName}`, {
    headers: await getHeadersAsync(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${errorPrefix}: ${response.status} ${text}`);
  }
  return response.json();
}

export async function fetchRepo(repoFullName: string): Promise<GithubRepo> {
  return (await fetchRepoJson(repoFullName, `Failed to fetch repo ${repoFullName}`)) as unknown as GithubRepo;
}

export interface GitHubRepoMetadata {
  fullName: string;
  defaultBranch: string;
  description: string | null;
}

export async function fetchRepositoryMetadata(repoFullName: string): Promise<GitHubRepoMetadata> {
  const data = await fetchRepoJson(repoFullName, `Failed to fetch repo metadata for ${repoFullName}`);
  return {
    fullName: typeof data.full_name === "string" ? data.full_name : repoFullName,
    defaultBranch: typeof data.default_branch === "string" ? data.default_branch : "main",
    description: typeof data.description === "string" ? data.description : null,
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
 * Upstream error bodies reach the model and the GroomingRun record. Collapse
 * them to a single short line so an HTML error page cannot inject newlines or
 * bulk into either.
 */
function summarizeErrorBody(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

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

export interface GitHubDirectoryEntry {
  path: string;
  name: string;
  type: "file" | "dir";
  size: number | null;
}

/**
 * List one directory in a repo. `path` may be "" for the repository root.
 * Returns [] when the path is a file rather than a directory, so callers can
 * treat "wrong kind of path" as an empty result instead of an exception.
 */
export async function listRepositoryDirectory(
  repoFullName: string,
  path: string,
  ref?: string,
): Promise<GitHubDirectoryEntry[]> {
  const encodedPath = path ? encodePathForContentsApi(path) : "";
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const response = await fetch(
    `${GITHUB_API}/repos/${repoFullName}/contents/${encodedPath}${query}`,
    { headers: await getHeadersAsync() },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to list directory ${path || "/"} in ${repoFullName}: ${response.status} ${summarizeErrorBody(text)}`,
    );
  }
  const data = await response.json();
  if (!Array.isArray(data)) return [];
  return data.map((entry: { path?: string; name?: string; type?: string; size?: number }) => ({
    path: entry.path ?? "",
    name: entry.name ?? "",
    type: entry.type === "dir" ? "dir" : "file",
    size: typeof entry.size === "number" ? entry.size : null,
  }));
}
