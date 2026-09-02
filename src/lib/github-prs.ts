import type { CheckFailure, PrHealthInput } from "./linked-pr-health";
import { GITHUB_API, getHeadersAsync, fetchPaginated, fetchWithRetry } from "./github-auth";

export interface GithubPR {
  number: number;
  url: string;
  title: string;
  body?: string | null;
  state: string;
  user: { login: string };
  head: { ref: string };
  base: { ref: string };
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  draft: boolean;
  reviewDecision?: string | null;
  mergeStateStatus?: string | null;
}

export async function fetchPullRequests(repoFullName: string, perPage = 100): Promise<GithubPR[]> {
  const url = `${GITHUB_API}/repos/${repoFullName}/pulls?state=open&per_page=${perPage}`;
  return fetchPaginated<GithubPR>(url, 200);
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
