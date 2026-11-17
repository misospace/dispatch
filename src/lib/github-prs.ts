import type { CheckFailure, PrHealthInput } from "./linked-pr-health";
import { GITHUB_API, getHeadersAsync, getNextLink, fetchPaginated, fetchWithRetry } from "./github-auth";

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

/**
 * Full detail read of one PR. Used by the /dispatch-fix comment command
 * (#1622), which needs eligibility facts the state/health helpers don't
 * carry: draft, author, title/body (for linked-issue extraction) and the
 * head ref alongside the head SHA.
 *
 * Returns null when GitHub is unreachable or the PR is gone — callers
 * refuse the command rather than guess.
 */
export interface PullRequestDetail {
  state: string | null;
  mergedAt: string | null;
  draft: boolean | null;
  headSha: string | null;
  headRef: string | null;
  /** The head branch's own repository (`head.repo.full_name`) — differs from
   * the base repo for fork PRs, which the /dispatch-fix command refuses
   * (#1622): a fix worker given the item would operate on the base repo,
   * not the fork where the branch lives. */
  headRepoFullName: string | null;
  author: string | null;
  title: string | null;
  body: string | null;
  htmlUrl: string | null;
}

export async function fetchPullRequestDetail(
  repoFullName: string,
  prNumber: number,
): Promise<PullRequestDetail | null> {
  try {
    const headers = await getHeadersAsync();
    const resp = await fetchWithRetry(`${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}`, { headers });
    if (resp.ok) {
      const detail = (await resp.json()) as {
        state?: string | null;
        merged_at?: string | null;
        draft?: boolean | null;
        head?: { sha?: string | null; ref?: string | null; repo?: { full_name?: string | null } | null };
        user?: { login?: string | null };
        title?: string | null;
        body?: string | null;
        html_url?: string | null;
      };
      return {
        state: detail.state ?? null,
        mergedAt: detail.merged_at ?? null,
        draft: detail.draft ?? null,
        headSha: detail.head?.sha ?? null,
        headRef: detail.head?.ref ?? null,
        headRepoFullName: detail.head?.repo?.full_name ?? null,
        author: detail.user?.login ?? null,
        title: detail.title ?? null,
        body: detail.body ?? null,
        htmlUrl: detail.html_url ?? null,
      };
    }
  } catch {
  }
  return null;
}

/** One review from `pulls/N/reviews`, projected to the fields the
 * /dispatch-fix command reads (#1622). `user` is the reviewer's login. */
export interface PullRequestReview {
  id: number | null;
  user: string | null;
  state: string | null;
  submittedAt: string | null;
  commitId: string | null;
  body: string | null;
}

/** Read a PR's reviews (paginated). Null means GitHub was unavailable. */
export async function fetchPullRequestReviews(
  repoFullName: string,
  prNumber: number,
): Promise<PullRequestReview[] | null> {
  try {
    // Paginate to the end: GitHub returns reviews oldest-first, so a record
    // cap would truncate the NEWEST reviews — exactly the ones
    // `deriveBlockingReview` needs to find the latest review on the current
    // head (a PR with more reviews than the cap would read as having none).
    const reviews = await fetchPaginated<{
      id?: number;
      user?: { login?: string | null } | null;
      state?: string | null;
      submitted_at?: string | null;
      commit_id?: string | null;
      body?: string | null;
    }>(`${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}/reviews?per_page=100`);
    return reviews.map((review) => ({
      id: typeof review.id === "number" ? review.id : null,
      user: review.user?.login ?? null,
      state: review.state ?? null,
      submittedAt: review.submitted_at ?? null,
      commitId: review.commit_id ?? null,
      body: review.body ?? null,
    }));
  } catch (error) {
    console.warn(`[github-prs] reviews unavailable for ${repoFullName}#${prNumber}:`, error instanceof Error ? error.message : error);
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

/**
 * The PR's aggregate review decision, mirroring GitHub's own rule ("dismissed
 * reviews are ignored; remaining requests still count"): a DISMISSED review is
 * skipped entirely — it is neither a decision of its own nor a supersession
 * of that reviewer's other reviews — and each reviewer's newest remaining
 * review decides their state.
 *
 * The /dispatch-fix command's `deriveBlockingReview` follows the same rule
 * (#1636): the health signals and the command must not disagree about
 * dismissal semantics — a dismissed review is ignored by both, so a standing
 * CHANGES_REQUESTED exists for the same reviewers in both places.
 */
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

/**
 * Fetch the PR's HEAD repository full name from the per-PR detail endpoint
 * (#1638). The head repo is the queue's fork-eligibility proof: a fork PR's
 * head repo differs from the base repo, and the fix worker operates on the
 * base repo. Returns null when GitHub is unreachable, the response is not
 * 2xx, the shape is unknown, or `head.repo.full_name` is absent (deleted or
 * inaccessible fork) — callers treat null as *unverifiable* and fail closed,
 * never as "same repo".
 */
export async function fetchPullRequestHeadRepo(
  repoFullName: string,
  prNumber: number,
): Promise<string | null> {
  try {
    const headers = await getHeadersAsync();
    const resp = await fetchWithRetry(`${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}`, { headers });
    if (resp.ok) {
      const detail = (await resp.json()) as { head?: { repo?: { full_name?: string | null } | null } | null };
      const fullName = detail.head?.repo?.full_name;
      return typeof fullName === "string" && fullName.trim() !== "" ? fullName.trim() : null;
    }
  } catch {
    // Unverifiable: the caller's fail-closed posture decides, never a guess.
  }
  return null;
}

/**
 * Existence probe for a single PR (#1641). Tri-state by design:
 * "present" (2xx), "deleted" (404), and "unknown" (any other status or a
 * transport failure). Every other per-PR probe collapses 404 into its
 * null/unverifiable shape, which is right for deferrals but leaves the
 * queue unable to tell a deleted PR from an unreachable one. 404 is the
 * definitive gone signal at GitHub; the caller still owns the
 * "repo actually reachable" qualification before treating it as fact.
 */
export async function fetchPullRequestPresence(
  repoFullName: string,
  prNumber: number,
): Promise<"present" | "deleted" | "unknown"> {
  try {
    const headers = await getHeadersAsync();
    const resp = await fetchWithRetry(`${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}`, { headers });
    if (resp.ok) return "present";
    if (resp.status === 404) return "deleted";
    // Any other status is an unknown fact, but it is also the shape a
    // rate-limited or degraded forge answers with — log it so an outage is
    // distinguishable from a healthy deferral.
    console.warn(
      `[github-prs] presence probe for ${repoFullName}#${prNumber} answered ${resp.status}; treating the PR as unknown`,
    );
  } catch (error) {
    // Transport failure: the probe never reached the forge. Logged like the
    // sibling probes so a forge outage is visible instead of silent.
    console.warn(
      `[github-prs] presence probe for ${repoFullName}#${prNumber} failed:`,
      error instanceof Error ? error.message : error,
    );
  }
  return "unknown";
}

/**
 * The PR numbers a repository's PR listing shows (#1641).
 *
 * `complete` is the load-bearing field of a listing read to its END: it is
 * true only when the listing was read to its END. A missing number proves
 * the PR is absent from the listing only when the listing was complete AND
 * every record it showed carried a number (`numbersUsable`) — a truncated
 * listing makes a missing number merely unseen, and a caller must not
 * conclude "deleted" from it.
 *
 * `absentProvenFrom` is what lets a TRUNCATED listing prove an absence at
 * all (#1648): it names the lowest PR number whose absence the read can
 * still prove, so a repository with far more PRs than the record bound can
 * still prove a recent PR's absence.
 *
 * A caller may prove an absence from this evidence only when the listing was
 * complete or the candidate's number is at or above `absentProvenFrom` — and
 * never when `numbersUsable` is false.
 */
export interface PullRequestListingEvidence {
  /** PR numbers the listing shows. */
  numbers: Set<number>;
  /** True when the listing was read to its end. */
  complete: boolean;
  /**
   * True when every record the read consumed carried a usable PR number.
   * A record without one means the listing does not faithfully enumerate
   * the repository's PRs — the record could BE the candidate, with a number
   * the read never learned — so the read proves no absence at all, not even
   * from a listing it read to its end.
   */
  numbersUsable: boolean;
  /**
   * Lowest candidate PR number whose absence this read proves: every PR of
   * the repository with a number at or above this value was read, so a
   * candidate with a number at or above it that is missing from `numbers` is
   * proven absent. Null when the read proves nothing beyond `numbers` — a
   * listing cut short by the record bound that never crossed a created-at
   * group boundary, or one whose created-at order could not be trusted.
   */
  absentProvenFrom: number | null;
}

/**
 * Records read from one PR listing before the read counts as truncated.
 *
 * The listing read only runs for a queue row whose per-PR endpoint already
 * answered 404 — a rare, candidate-only path — so the bound is generous
 * enough for a busy repository and still finite. A read the bound cuts
 * short proves nothing about a candidate it never reached: the absence
 * stays unproven and the row defers (fail-closed), because a truncated
 * listing cannot distinguish "gone" from "older than the read window".
 *
 * The bound is a CEILING, not the stop condition (#1648): a read that is
 * given a candidate PR number stops as soon as it has passed that number,
 * so a repository with far more PRs than this still proves a recent PR's
 * absence.
 */
const PR_LISTING_MAX_RECORDS = 500;

/**
 * Read a repository's PR listing and report the PR numbers it shows.
 *
 * `state=all` covers every PR of the repository — open, closed and merged —
 * in ONE listing, so a number missing from it is missing from all of them.
 * That is what makes the listing usable as the third confirmation fact of a
 * deleted PR (#1641): the per-PR endpoint answers 404 for reasons other than
 * deletion (a renamed repository, a token that cannot see the PR, a
 * transient 404), and a listing that still shows the PR contradicts the
 * deletion. Absence from a COMPLETE listing proves an absence; a truncated
 * listing proves it only for a candidate the read has passed (#1648).
 *
 * The early stop (#1648). The listing is sorted newest-first, and GitHub
 * assigns PR numbers in creation order, so an earlier PR always carries a
 * smaller number. A read that is given a candidate number therefore only
 * has to read UNTIL IT HAS PASSED that number: everything still unread was
 * created strictly earlier and carries a strictly smaller number, so the
 * candidate cannot be hiding in the unread tail. Without this, a repository
 * with more than `PR_LISTING_MAX_RECORDS` PRs could never prove ANY
 * absence, and its deleted-PR rows deferred forever.
 *
 * The soundness rule: records that share a `created_at` second are ordered
 * arbitrarily by GitHub, so "the first record with a smaller number" does
 * NOT prove absence — the candidate can sit in the same second BEHIND that
 * record. The read therefore groups the records by their created-at instant
 * and only closes a group when a record with a DIFFERENT instant arrives:
 * a closed group was read in full, and everything after it was created
 * strictly earlier, hence carries a strictly smaller number. The group's
 * SMALLEST number is the anchor of that proof: PR numbers grow with
 * creation time, so a PR created at or after the group's creation instant
 * carries a number at or above that smallest number, and a PR created
 * before that instant carries a number below it. Every PR at or above the
 * anchor therefore sat at or after the group's instant, so it was read
 * with the group or before it.
 *
 * Fail-closed: a record without a usable `created_at`, or one that arrives
 * out of created-at order, means the order cannot be trusted — the read
 * then proves no absence beyond `numbers` (`absentProvenFrom` stays null).
 * A record without a usable PR number is worse: the listing then does not
 * faithfully enumerate the repository's PRs, so the read proves nothing at
 * all (`numbersUsable` goes false). `complete` stays truthful either way:
 * a listing read to its end proves absence without needing the order — as
 * long as every record carried a number.
 *
 * Returns null when the listing could not be read at all: the caller then
 * knows nothing and must defer.
 */
export async function fetchPullRequestListingEvidence(
  repoFullName: string,
  candidatePr: number | null,
  maxRecords = PR_LISTING_MAX_RECORDS,
): Promise<PullRequestListingEvidence | null> {
  const numbers = new Set<number>();
  // The absence proof the read accumulates: the lowest PR number whose
  // absence this read can still prove.
  let absentProvenFrom: number | null = null;
  // Whether every record the read consumed carried a usable PR number.
  let numbersUsable = true;
  // Whether the listing's created-at order can be trusted. A record without
  // a usable created_at, or one that arrives out of order, voids the proof.
  let orderTrusted = true;
  // The open created-at group and the smallest PR number seen in it.
  let currentGroupMin: number | null = null;
  let previousCreatedAt: number | null = null;
  let read = 0;
  let complete = false;

  try {
    let url: string | null = `${GITHUB_API}/repos/${repoFullName}/pulls?state=all&sort=created&direction=desc&per_page=100`;
    while (url !== null && read < maxRecords) {
      const response = await fetchWithRetry(url, { headers: await getHeadersAsync() });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`GitHub API error: ${response.status} ${text}`);
      }
      // The `rel="next"` link is the END-OF-LISTING signal: a response
      // without one is the last page. The record count of a page is not that
      // signal — a concurrent change can shorten a page that still has more
      // behind it.
      const nextUrl = getNextLink(response);
      const data = await response.json();
      if (!Array.isArray(data)) {
        throw new Error(`GitHub API error: expected array response from ${url}`);
      }
      const records = data as Array<{ number?: number; created_at?: string }>;
      // A page with no records makes no progress: following its link would
      // read the same nothing forever, so the read stops there.
      if (records.length === 0) break;
      const pageRecords = records.slice(0, maxRecords - read);
      let stopped = false;

      for (const record of pageRecords) {
        const number = typeof record.number === "number" ? record.number : null;
        if (number === null) {
          // A record without a usable number: the listing does not
          // faithfully enumerate the repository's PRs, and the record could
          // BE the candidate with a number the read never learned. The read
          // proves nothing at all — neither from the anchor nor from a
          // listing it read to its end. Nothing more can be proven, so the
          // read stops instead of spending the rest of the bound.
          numbersUsable = false;
          orderTrusted = false;
          absentProvenFrom = null;
          currentGroupMin = null;
          previousCreatedAt = null;
          stopped = true;
          break;
        }
        numbers.add(number);

        const createdAt = record.created_at ? Date.parse(record.created_at) : Number.NaN;
        if (!Number.isFinite(createdAt)) {
          // No usable created_at: the listing's order cannot be trusted, so
          // the read can no longer tell which PRs are older than which and
          // proves no absence beyond `numbers`.
          orderTrusted = false;
          absentProvenFrom = null;
          currentGroupMin = null;
          previousCreatedAt = null;
        } else if (orderTrusted) {
          if (previousCreatedAt === null) {
            // The first record opens the first group.
            currentGroupMin = number;
          } else if (createdAt === previousCreatedAt) {
            // The same instant: the record belongs to the open group. GitHub
            // orders records that share a second arbitrarily, so the group's
            // SMALLEST number is the anchor of the absence proof: PR numbers
            // grow with creation time, so a PR created at or after the
            // group's instant carries a number at or above that smallest
            // number, and such a PR was read with the group or before it.
            currentGroupMin = currentGroupMin === null ? number : Math.min(currentGroupMin, number);
          } else if (createdAt > previousCreatedAt) {
            // Out-of-order listing: the created-at order cannot be trusted.
            orderTrusted = false;
            absentProvenFrom = null;
            currentGroupMin = null;
          } else {
            // The open group closed: it was read in full, and everything
            // still unread was created strictly earlier, hence carries a
            // SMALLER number. So every PR with a number at or above this
            // group's smallest number was read, and a candidate at or above
            // it that the listing does not show is proven absent.
            if (currentGroupMin !== null) absentProvenFrom = currentGroupMin;
            currentGroupMin = number;
          }
          previousCreatedAt = createdAt;
        }

        if (candidatePr == null) continue;
        // The listing shows the candidate: the caller treats the row as
        // present, so there is nothing left to prove.
        if (numbers.has(candidatePr)) {
          stopped = true;
          break;
        }
        // The read has passed the candidate's number: everything still
        // unread carries a smaller number, so the candidate's absence is
        // proven.
        if (absentProvenFrom !== null && candidatePr >= absentProvenFrom) {
          stopped = true;
          break;
        }
      }

      read += pageRecords.length;
      if (stopped) break;
      // The record bound cut this page short: the listing was not read to
      // its end, so the read proves absence only for the numbers it reached.
      if (pageRecords.length < records.length) break;
      if (nextUrl === null) {
        complete = true;
        break;
      }
      url = nextUrl;
    }

    return { numbers, complete, numbersUsable, absentProvenFrom };
  } catch (error) {
    console.warn(
      `[github-prs] PR listing unavailable for ${repoFullName}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
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
