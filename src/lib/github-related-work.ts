import { GITHUB_API, getHeadersAsync, fetchPaginated, fetchWithRetry } from "./github-auth";

export type RelatedWorkComment = {
  author: string;
  authorType: string;
  isBot: boolean;
  bodyExcerpt: string;
  htmlUrl: string;
  createdAt: string | null;
};

export type RelatedWorkIssue = {
  kind: "issue";
  repoFullName: string;
  number: number;
  title: string;
  state: "open" | "closed";
  merged: false;
  labels: string[];
  bodyExcerpt: string;
  htmlUrl: string;
  updatedAt: string | null;
  comments: RelatedWorkComment[];
  source: "github-issue";
  evidenceKey: string;
};

export type RelatedWorkPullRequest = {
  kind: "pull_request";
  repoFullName: string;
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  baseRef: string;
  headRef: string;
  headSha: string | null;
  bodyExcerpt: string;
  htmlUrl: string;
  updatedAt: string | null;
  source: "github-pull-request";
  evidenceKey: string;
};

export type RelatedWorkCommit = {
  kind: "commit";
  repoFullName: string;
  sha: string;
  message: string;
  htmlUrl: string;
  author: string | null;
  committedAt: string | null;
  source: "github-commit";
  evidenceKey: string;
};

export type RelatedWorkSearchHit = {
  kind: "issue" | "pull_request";
  repoFullName: string;
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  htmlUrl: string;
  evidenceKey: string;
};

export type RelatedWorkLimits = {
  maxComments?: number;
  maxBodyBytes?: number;
  maxResults?: number;
};

export class RelatedWorkNotFoundError extends Error {
  kind: "issue" | "pull_request" | "commit";
  ref: string;
  constructor(kind: "issue" | "pull_request" | "commit", ref: string) {
    super(`Related ${kind} not found: ${ref}`);
    this.name = "RelatedWorkNotFoundError";
    this.kind = kind;
    this.ref = ref;
  }
}

const DEFAULT_MAX_COMMENTS = 5;
const DEFAULT_MAX_BODY_BYTES = 4000;
const DEFAULT_MAX_RESULTS = 10;

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels?: Array<{ name: string }> | null;
  updated_at: string | null;
  pull_request?: unknown;
}

interface RawComment {
  user?: { login?: string } | null;
  author_association?: string | null;
  body?: string | null;
  html_url?: string | null;
  created_at?: string | null;
}

interface RawPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  updated_at: string | null;
  merged: boolean | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  base: { ref: string };
  head: { ref: string; sha?: string | null };
}

interface RawCommit {
  sha: string;
  html_url: string;
  author?: { login?: string } | null;
  commit: {
    message: string;
    author?: { name?: string; date?: string | null } | null;
    committer?: { name?: string; date?: string | null } | null;
  };
}

interface RawSearchItem {
  number: number;
  title: string;
  state: string;
  html_url: string;
  repository?: { full_name?: string } | null;
  pull_request?: { merged_at?: string | null } | null;
}

function capBody(body: string | null | undefined, maxBytes: number): string {
  if (!body) return "";
  const trimmed = body.trim();
  const bytes = Buffer.from(trimmed, "utf8");
  if (bytes.byteLength <= maxBytes) return trimmed;
  // Reserve room for the 3-byte ellipsis so the total stays within maxBytes,
  // and cut back to a character boundary so a multi-byte sequence is never
  // split (a raw byte slice would leave a U+FFFD right before the marker).
  const budget = Math.max(0, maxBytes - 3);
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  const prefix = decoder.decode(bytes.subarray(0, budget)).replace(/\uFFFD$/, "");
  return `${prefix}…`;
}

// Scope-broadening qualifiers a caller's free-text query must not carry in:
// multiple `repo:` terms OR together, and org:/owner:/user: leave the repo.
const SEARCH_SCOPE_KEYS = ["repo", "org", "owner", "user", "type", "is"];

function stripSearchQualifiers(query: string): string {
  return query
    .split(/\s+/)
    .filter((token) => {
      const colon = token.indexOf(":");
      if (colon <= 0) return true;
      return !SEARCH_SCOPE_KEYS.includes(token.slice(0, colon).toLowerCase());
    })
    .join(" ")
    .trim();
}

async function fetchRead(
  url: string,
  kind: "issue" | "pull_request" | "commit",
  ref: string,
): Promise<unknown> {
  const response = await fetchWithRetry(url, { headers: await getHeadersAsync() });
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 404) {
      throw new RelatedWorkNotFoundError(kind, ref);
    }
    throw new Error(`GitHub API error for ${ref}: ${response.status} ${text}`);
  }
  return response.json();
}

export async function fetchRelatedIssue(
  repoFullName: string,
  issueNumber: number,
  limits?: RelatedWorkLimits,
): Promise<RelatedWorkIssue | RelatedWorkPullRequest> {
  const [owner, repo] = repoFullName.split("/");
  const maxComments = limits?.maxComments ?? DEFAULT_MAX_COMMENTS;
  const maxBodyBytes = limits?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const ref = `${repoFullName}#${issueNumber}`;

  const data = (await fetchRead(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}`,
    "issue",
    ref,
  )) as RawIssue;

  // /issues/{n} also returns pull requests (with a `pull_request` sub-object).
  // Delegate to the authoritative PR fetch so state/merged are correct rather
  // than misclassifying a PR as a plain open/closed issue.
  if (data.pull_request && typeof data.pull_request === "object") {
    return fetchRelatedPullRequest(repoFullName, issueNumber, limits);
  }

  const perPage = Math.max(1, Math.min(maxComments, 100));
  const commentsResp = await fetchWithRetry(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${perPage}&sort=created&direction=desc`,
    { headers: await getHeadersAsync() },
  );
  if (!commentsResp.ok) {
    const text = await commentsResp.text();
    throw new Error(`GitHub API error for ${ref} comments: ${commentsResp.status} ${text}`);
  }
  const rawComments = (await commentsResp.json()) as RawComment[];
  if (!Array.isArray(rawComments)) {
    throw new Error(`Expected comments array for ${ref}`);
  }

  // Newest first off the wire: keep the most recent `maxComments`, then
  // restore ascending chronological order for stable display.
  const comments: RelatedWorkComment[] = rawComments
    .slice(0, maxComments)
    .map((c) => {
      const author = c.user?.login ?? "";
      const authorType = c.author_association ?? "";
      return {
        author,
        authorType,
        isBot: authorType === "BOT" || author.endsWith("[bot]"),
        bodyExcerpt: capBody(c.body, maxBodyBytes),
        htmlUrl: c.html_url ?? "",
        createdAt: c.created_at ?? null,
      };
    })
    .sort(
      (a, b) =>
        (a.createdAt ? Date.parse(a.createdAt) : 0) -
        (b.createdAt ? Date.parse(b.createdAt) : 0),
    );

  return {
    kind: "issue",
    repoFullName,
    number: data.number,
    title: data.title,
    state: data.state === "closed" ? "closed" : "open",
    merged: false,
    labels: (data.labels ?? []).map((l) => l.name),
    bodyExcerpt: capBody(data.body, maxBodyBytes),
    htmlUrl: data.html_url,
    updatedAt: data.updated_at ?? null,
    comments,
    source: "github-issue",
    evidenceKey: `github:issue:${repoFullName}#${issueNumber}`,
  };
}

export async function fetchRelatedPullRequest(
  repoFullName: string,
  prNumber: number,
  limits?: RelatedWorkLimits,
): Promise<RelatedWorkPullRequest> {
  const [owner, repo] = repoFullName.split("/");
  const maxBodyBytes = limits?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const ref = `${repoFullName}#${prNumber}`;

  const data = (await fetchRead(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`,
    "pull_request",
    ref,
  )) as RawPullRequest;

  const merged = data.merged === true || data.merged_at != null;
  const state: "open" | "closed" | "merged" = merged
    ? "merged"
    : data.state === "closed"
      ? "closed"
      : "open";

  return {
    kind: "pull_request",
    repoFullName,
    number: data.number,
    title: data.title,
    state,
    merged,
    mergeCommitSha: data.merge_commit_sha ?? null,
    mergedAt: data.merged_at ?? null,
    baseRef: data.base.ref,
    headRef: data.head.ref,
    headSha: data.head.sha ?? null,
    bodyExcerpt: capBody(data.body, maxBodyBytes),
    htmlUrl: data.html_url,
    updatedAt: data.updated_at ?? null,
    source: "github-pull-request",
    evidenceKey: `github:pr:${repoFullName}#${prNumber}`,
  };
}

export async function fetchRelatedCommit(
  repoFullName: string,
  ref: string,
  limits?: RelatedWorkLimits,
): Promise<RelatedWorkCommit> {
  const [owner, repo] = repoFullName.split("/");
  const maxBodyBytes = limits?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const data = (await fetchRead(
    `${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
    "commit",
    `${repoFullName}@${ref}`,
  )) as RawCommit;

  const committedAt = data.commit?.committer?.date ?? data.commit?.author?.date ?? null;

  return {
    kind: "commit",
    repoFullName,
    sha: data.sha,
    message: capBody(data.commit?.message, maxBodyBytes),
    htmlUrl: data.html_url,
    author: data.author?.login ?? null,
    committedAt,
    source: "github-commit",
    evidenceKey: `github:commit:${repoFullName}@${data.sha}`,
  };
}

export async function searchRelatedWork(
  repoFullName: string,
  query: string,
  options?: { type?: "issue" | "pr" | "all"; state?: "open" | "closed" | "all"; maxResults?: number },
): Promise<RelatedWorkSearchHit[]> {
  const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;

  const qualifiers: string[] = [`repo:${repoFullName}`];
  if (options?.type === "issue") qualifiers.push("is:issue");
  else if (options?.type === "pr") qualifiers.push("is:pr");
  if (options?.state === "open") qualifiers.push("is:open");
  else if (options?.state === "closed") qualifiers.push("is:closed");

  // Drop any qualifier tokens the caller's free text carries so the composed
  // query is scoped to exactly this repo and nothing else.
  const terms = stripSearchQualifiers(query);
  const q = `${terms} ${qualifiers.join(" ")}`.trim();
  const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&per_page=${Math.max(1, maxResults)}`;

  const items = (
    await fetchPaginated<RawSearchItem>(
      url,
      maxResults,
      (data) => (data as { items?: RawSearchItem[] }).items ?? [],
    )
  ).filter((item) => item.repository?.full_name === repoFullName);

  return items.map((item) => {
    const isPr = item.pull_request != null;
    const state: "open" | "closed" | "merged" =
      isPr && item.pull_request?.merged_at
        ? "merged"
        : item.state === "closed"
          ? "closed"
          : "open";
    return {
      kind: isPr ? ("pull_request" as const) : ("issue" as const),
      repoFullName,
      number: item.number,
      title: item.title,
      state,
      htmlUrl: item.html_url,
      evidenceKey: isPr
        ? `github:pr:${repoFullName}#${item.number}`
        : `github:issue:${repoFullName}#${item.number}`,
    };
  });
}
