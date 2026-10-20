import type { CheckFailure, PrHealthInput } from "./linked-pr-health";
import { GITHUB_API, getHeadersAsync, fetchPaginated, fetchWithRetry } from "./github-auth";

/**
 * GraphQL read of a PR's review threads: for each thread, whether it is
 * resolved and/or outdated, plus the `databaseId` of every inline comment it
 * holds. The REST API does not expose thread resolution, so this is the only
 * way to learn whether an inline review comment lives in an already-resolved
 * thread (dispatch#1249: a resolved/outdated comment is recorded, never
 * treated as new work).
 */
const REVIEW_THREAD_STATES_QUERY = `
query ReviewThreadStates($owner: String!, $repo: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          isResolved
          isOutdated
          comments(first: 100) {
            nodes {
              databaseId
            }
          }
        }
      }
    }
  }
}
`;

/** Bounded page limit for the review-thread connection (50 threads/page). */
const REVIEW_THREAD_PAGE_SIZE = 50;
const REVIEW_THREAD_MAX_PAGES = 10;

interface RawReviewThreadConnection {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
  nodes?: Array<{
    isResolved?: boolean | null;
    isOutdated?: boolean | null;
    comments?: { nodes?: Array<{ databaseId?: number | null } | null> } | null;
  } | null>;
}

interface RawGraphQLResponse {
  data?: {
    repository?: {
      pullRequest?: { reviewThreads?: RawReviewThreadConnection | null } | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string }>;
}

/**
 * Map a PR's inline review comments (by stringified `databaseId`) to their
 * review thread's resolved/outdated state.
 *
 * One read per PR, bounded to 10 pages. Fail-closed: any missing credential,
 * non-2xx response, GraphQL error, unknown shape, or a thread connection that
 * is still paginating when the bound runs out returns `null` so the caller
 * treats the thread state as *unknown* rather than silently resolved —
 * missing/unknown forge evidence is never deemed resolved (dispatch#1249).
 */
export async function fetchPullRequestReviewThreadStates(
  repoFullName: string,
  prNumber: number,
): Promise<Map<string, { resolved: boolean; outdated: boolean }> | null> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return null;

  try {
    const headers = await getHeadersAsync();
    const map = new Map<string, { resolved: boolean; outdated: boolean }>();
    let after: string | null = null;
    // A connection that still has pages when the bound runs out is NOT fully
    // read: threads past the cap would be absent from the map and their
    // comments would read as "unknown thread" instead of their real state.
    let truncated = false;

    for (let page = 0; page < REVIEW_THREAD_MAX_PAGES; page++) {
      const response = await fetchWithRetry(
        `${GITHUB_API}/graphql`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            query: REVIEW_THREAD_STATES_QUERY,
            variables: { owner, repo, number: prNumber, first: REVIEW_THREAD_PAGE_SIZE, after },
          }),
        },
      );

      if (!response.ok) {
        console.warn(
          `[github-prs] review-thread states unavailable for ${repoFullName}#${prNumber}: HTTP ${response.status}`,
        );
        return null;
      }

      const data = (await response.json()) as RawGraphQLResponse;
      if (data.errors && data.errors.length > 0) {
        const why = data.errors.map((e) => e.message).filter(Boolean).join("; ") || "GraphQL error";
        console.warn(`[github-prs] review-thread states for ${repoFullName}#${prNumber}: ${why}`);
        return null;
      }

      const connection = data.data?.repository?.pullRequest?.reviewThreads;
      if (!connection) {
        console.warn(
          `[github-prs] review-thread states unavailable for ${repoFullName}#${prNumber}: no reviewThreads data`,
        );
        return null;
      }

      for (const node of connection.nodes ?? []) {
        if (!node) continue;
        const state = { resolved: node.isResolved === true, outdated: node.isOutdated === true };
        for (const comment of node.comments?.nodes ?? []) {
          const id = comment?.databaseId;
          if (id == null) continue;
          map.set(String(id), state);
        }
      }

      const pageInfo = connection.pageInfo;
      if (!pageInfo?.hasNextPage) break;
      // Still paginating with no cursor to continue from is just as incomplete
      // as running out of pages: threads past this point were never read.
      if (!pageInfo.endCursor) {
        truncated = true;
        break;
      }
      after = pageInfo.endCursor;
      if (page === REVIEW_THREAD_MAX_PAGES - 1) truncated = true;
    }

    // Fail-closed at the bound: a partial thread map would silently classify
    // every unvisited comment's thread as unknown-but-not-resolved, which is
    // exactly the "missing evidence read as resolved" shape the null return
    // exists to prevent. Treat the whole read as unavailable instead (#1249).
    if (truncated) {
      console.warn(
        `[github-prs] review-thread states for ${repoFullName}#${prNumber}: more than ${REVIEW_THREAD_MAX_PAGES * REVIEW_THREAD_PAGE_SIZE} threads; treating thread state as unknown`,
      );
      return null;
    }

    return map;
  } catch (error) {
    console.warn(
      `[github-prs] review-thread states unavailable for ${repoFullName}#${prNumber}: ${
        error instanceof Error ? error.message : error
      }`,
    );
    return null;
  }
}

export interface GithubPR {
  number: number;
  url: string;
  /** Human-facing PR URL, present in the raw REST payload (#1203). */
  html_url?: string;
  title: string;
  body?: string | null;
  state: string;
  user: { login: string };
  // `head.sha` / `merge_commit_sha` / `closed_at` are present in the raw REST
  // payload and passed through by fetchPaginated; declared here so merge
  // evidence can carry authoritative head and merge-commit provenance (#1203).
  head: { ref: string; sha?: string };
  base: { ref: string };
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  merged_at: string | null;
  merge_commit_sha?: string | null;
  draft: boolean;
  reviewDecision?: string | null;
  mergeStateStatus?: string | null;
}

export async function fetchPullRequests(repoFullName: string, perPage = 100): Promise<GithubPR[]> {
  const url = `${GITHUB_API}/repos/${repoFullName}/pulls?state=open&per_page=${perPage}`;
  return fetchPaginated<GithubPR>(url, 200);
}

/** Read labels from the PR's issue endpoint; null means GitHub state was unavailable. */
export async function fetchPullRequestLabels(repoFullName: string, prNumber: number): Promise<string[] | null> {
  try {
    const labels = await fetchPaginated<{ name?: string }>(
      `${GITHUB_API}/repos/${repoFullName}/issues/${prNumber}/labels?per_page=100`,
    );
    return labels.flatMap((label) => typeof label.name === "string" ? [label.name] : []);
  } catch (error) {
    console.warn(`[github-prs] labels unavailable for ${repoFullName}#${prNumber}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export async function fetchClosedPullRequests(repoFullName: string, maxItems = 100): Promise<GithubPR[]> {
  const url = `${GITHUB_API}/repos/${repoFullName}/pulls?state=closed&sort=updated&direction=desc&per_page=100`;
  return fetchPaginated<GithubPR>(url, maxItems);
}

export interface PrHealthSignals {
  reviewDecision: string | null;
  mergeStateStatus: string | null;
}

function deriveReviewDecision(
  reviews: Array<{ user?: { login?: string } | null; state?: string; submitted_at?: string }>,
): string | null {
  const latestByUser = new Map<string, { state: string; submittedAt: number }>();
  for (const review of reviews) {
    const login = review.user?.login;
    const state = review.state?.toUpperCase();
    if (!login || !state) continue;
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

export async function fetchPullRequestHealthSignals(
  repoFullName: string,
  prNumber: number,
): Promise<PrHealthSignals> {
  const headers = await getHeadersAsync();

  const [mergeStateStatus, reviewDecision] = await Promise.all([
    (async (): Promise<string | null> => {
      try {
        const detailResp = await fetchWithRetry(`${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}`, { headers });
        if (detailResp.ok) {
          const detail = (await detailResp.json()) as { mergeable_state?: string | null };
          return detail.mergeable_state ?? null;
        }
      } catch {
      }
      return null;
    })(),
    (async (): Promise<string | null> => {
      try {
        const reviews = await fetchPaginated<{ user?: { login?: string } | null; state?: string; submitted_at?: string }>(
          `${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}/reviews?per_page=100`,
        );
        return deriveReviewDecision(reviews);
      } catch {
      }
      return null;
    })(),
  ]);

  return { reviewDecision, mergeStateStatus };
}

export async function fetchPullRequestState(
  repoFullName: string,
  prNumber: number,
): Promise<{ state: string | null; mergedAt: string | null }> {
  try {
    const headers = await getHeadersAsync();
    const resp = await fetchWithRetry(`${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}`, { headers });
    if (resp.ok) {
      const detail = (await resp.json()) as { state?: string | null; merged_at?: string | null };
      return { state: detail.state ?? null, mergedAt: detail.merged_at ?? null };
    }
  } catch {
  }
  return { state: null, mergedAt: null };
}

export async function fetchPullRequestMergeState(
  repoFullName: string,
  prNumber: number,
): Promise<{ mergeableState: string | null; mergeable: boolean | null }> {
  const headers = await getHeadersAsync();
  try {
    const resp = await fetchWithRetry(`${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}`, { headers });
    if (resp.ok) {
      const detail = (await resp.json()) as { mergeable_state?: string | null; mergeable?: boolean | null };
      return { mergeableState: detail.mergeable_state ?? null, mergeable: detail.mergeable ?? null };
    }
  } catch {
  }
  return { mergeableState: null, mergeable: null };
}

/**
 * Fetch the current PR head SHA from the per-PR detail endpoint.
 *
 * Used by the pr-fix-queue to compare the head at enqueue time against the
 * head when a workload reports `done` (#940): if the SHA has not moved, the
 * workload did not push a fix and the item must not transition to FIXED.
 * Returns null when GitHub is unreachable, the response shape is unknown, or
 * `head.sha` is absent (older fixtures, hard-deleted PRs).
 */
export async function fetchPullRequestHeadSha(
  repoFullName: string,
  prNumber: number,
): Promise<string | null> {
  const headers = await getHeadersAsync();
  try {
    const resp = await fetchWithRetry(`${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}`, { headers });
    if (resp.ok) {
      const detail = (await resp.json()) as { head?: { sha?: string | null } };
      return detail.head?.sha ?? null;
    }
  } catch {
  }
  return null;
}

export async function fetchPullRequestCheckFailures(repoFullName: string, ref: string): Promise<CheckFailure[]> {
  const FAILURE_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);
  try {
    const response = await fetchWithRetry(
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

/**
 * Commit messages on a pull request, newest last. Used only as a fallback when
 * a PR's title and body carry no issue reference — the commit that did the work
 * often still names the issue.
 */
export async function fetchPullRequestCommitMessages(
  repoFullName: string,
  prNumber: number,
): Promise<string[]> {
  const commits = await fetchPaginated<{ commit?: { message?: string } }>(
    `${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}/commits`,
  );
  return commits.map((c) => c.commit?.message ?? "").filter(Boolean);
}
