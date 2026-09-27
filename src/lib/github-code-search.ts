import { GITHUB_API, getHeadersAsync, fetchPaginated, fetchWithRetry } from "./github-auth";

export interface GithubRepo {
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  pushed_at: string;
}

async function fetchRepoJson(repoFullName: string, errorPrefix: string): Promise<Record<string, unknown>> {
  const response = await fetchWithRetry(`${GITHUB_API}/repos/${repoFullName}`, {
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
  archived?: boolean;
}

export async function fetchRepositoryMetadata(repoFullName: string): Promise<GitHubRepoMetadata> {
  const data = await fetchRepoJson(repoFullName, `Failed to fetch repo metadata for ${repoFullName}`);
  return {
    fullName: typeof data.full_name === "string" ? data.full_name : repoFullName,
    defaultBranch: typeof data.default_branch === "string" ? data.default_branch : "main",
    description: typeof data.description === "string" ? data.description : null,
    archived: data.archived === true,
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
  const searchQuery = `${query} repo:${repoFullName}`;
  const url = `${GITHUB_API}/search/code?q=${encodeURIComponent(searchQuery)}`;
  try {
    // Follow the `Link: rel="next"` header across pages (up to `limit` results)
    // so a search with more matches than fit on one page is not silently
    // truncated at the first page. Each page is fetched through fetchWithRetry,
    // so transient 429/5xx responses are retried here as well.
    const items = await fetchPaginated<{ path?: string; html_url?: string }>(
      url,
      limit,
      (data) => (data as { items?: { path?: string; html_url?: string }[] }).items ?? [],
    );
    return items.map((item) => ({
      path: item.path ?? "",
      url: item.html_url ?? "",
    }));
  } catch (err) {
    // Preserve the caller-facing "Code search failed for <repo>:" prefix the
    // groomer's tool layer keys off, while still surfacing the upstream status
    // and body carried in fetchPaginated's error.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Code search failed for ${repoFullName}: ${message}`);
  }
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
  const response = await fetchWithRetry(
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
  const response = await fetchWithRetry(
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

/** GitHub caps a compare's file list at this many entries. */
export const COMPARE_MAX_FILES = 300;

export type CommitComparison =
  | {
      ok: true;
      /** ahead | identical | behind | diverged, as GitHub reports it. */
      status: string;
      /** Changed paths, including the old path of a rename. */
      files: string[];
      /** True when GitHub's file cap was reached, so `files` may be incomplete. */
      truncated: boolean;
      /**
       * Committer timestamp of the first (oldest) commit in base...head, when
       * the response carried one. Lets callers bound how long a recheck may
       * stay deferred on an unverified range (#1091).
       */
      firstCommitDate?: string | null;
    }
  | {
      ok: false;
      /** HTTP status, or null for a network/parse failure. */
      httpStatus: number | null;
      /** True when retrying cannot help (unknown SHA, unrelated histories). */
      definitive: boolean;
      message: string;
    };

/**
 * Compare two commits and return the paths changed between them. One request:
 * the file list is only on the first page, so commits are paged at 1 to keep
 * the payload small. Never throws.
 */
export async function compareCommits(
  repoFullName: string,
  base: string,
  head: string,
): Promise<CommitComparison> {
  const url = `${GITHUB_API}/repos/${repoFullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`;
  try {
    const response = await fetchWithRetry(url, { headers: await getHeadersAsync() });
    if (!response.ok) {
      const text = await response.text();
      return {
        ok: false,
        httpStatus: response.status,
        definitive: response.status === 404 || response.status === 422,
        message: `compare ${base}...${head} failed: ${response.status} ${text.slice(0, 200)}`,
      };
    }
    const data = (await response.json()) as {
      status?: string;
      files?: Array<{ filename?: string; previous_filename?: string }>;
      commits?: Array<{ commit?: { committer?: { date?: string } } }>;
    };
    const rawFiles = Array.isArray(data.files) ? data.files : [];
    const files = new Set<string>();
    for (const file of rawFiles) {
      if (typeof file.filename === "string" && file.filename) files.add(file.filename);
      if (typeof file.previous_filename === "string" && file.previous_filename) files.add(file.previous_filename);
    }
    // per_page=1 still returns the first (oldest) commit of the range.
    const firstCommitDate = Array.isArray(data.commits) ? data.commits[0]?.commit?.committer?.date ?? null : null;
    return {
      ok: true,
      status: typeof data.status === "string" ? data.status : "unknown",
      files: [...files],
      truncated: rawFiles.length >= COMPARE_MAX_FILES,
      firstCommitDate,
    };
  } catch (err) {
    return {
      ok: false,
      httpStatus: null,
      definitive: false,
      message: `compare ${base}...${head} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
