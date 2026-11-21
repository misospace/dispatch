import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { reconcileStalePrFixItems, reconcileForkPrFixItems, reconcileArchivedRepoPrFixItems, reconcileDeletedPrFixItems, reconcileExternalWaitTriggers } from "@/lib/pr-fix-queue";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { getTrackedRepos } from "@/lib/config";
import { getGitHubToken, fetchPaginated, fetchPullRequests, fetchPullRequestMergeState, fetchFailedJobLogExcerpt, fetchClosedPullRequests, jobIdFromCheckRunUrl, type GithubPR as GithubPRBase } from "@/lib/github";
import { fetchPullRequestCommitMessages } from "@/lib/github";
import { fetchPullRequestReviewThreadStates } from "@/lib/github-prs";
import { processPrFollowupEvents, extractLinkedIssue, isAllowedBotAuthor, ingestMergeConflict, clearResolvedConflictItems } from "@/lib/pr-followup-ingestion";
import { enforceRateLimit } from "@/lib/rate-limit";
import { acquireLock, releaseLock, type AcquiredLock, type LockConflict } from "@/lib/sync-lock";

/**
 * PR Follow-up Sync Endpoint (Pull-based)
 *
 * Periodically scans tracked repos for new PR follow-up events:
 * - New comments on bot-authored PRs
 * - New reviews (especially CHANGES_REQUESTED)
 * - Failing check runs
 * - Merge state changes
 *
 * This is the pull-based ingestion path. The webhook endpoint provides
 * real-time delivery for comparison.
 */

/** Open-PR shape from the list endpoint, extending the shared client's type
 * with the fields this route consumes that the shared type omits. */
interface GithubPR extends Omit<GithubPRBase, "head"> {
  id: number;
  mergeable_state?: string;
  mergeable?: string; // "CONFLICTING", "MERGEABLE", "UNKNOWN"
  /**
   * PR head ref + SHA from the list endpoint. `sha` is captured to populate
   * PrFixQueueItem.headSha at enqueue time so a later FIXED transition can
   * verify the workload actually pushed something (#940). `repo.full_name` is
   * the head repository identity — the ingestion gate refuses queue work whose
   * head repo is not the base repo (#1637). Both fields are optional here so
   * legacy fixtures still type-check.
   */
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
}

interface GithubComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

interface GithubReview {
  id: number;
  body: string;
  state: string;
  user: { login: string };
  submitted_at: string;
  commit_id: string;
}

/**
 * An inline review comment from `pulls/N/comments` — per-file feedback, distinct
 * from the conversation comments on `issues/N/comments`.
 *
 * `line` is null once a comment's anchor goes stale (the diff moved under it);
 * `original_line` still points at the line it was written against, so it is worth
 * falling back to for the coder's benefit.
 */
interface GithubReviewComment {
  id: number;
  body: string;
  user?: { login: string };
  path?: string;
  line?: number | null;
  original_line?: number | null;
  updated_at?: string;
  commit_id?: string;
}

/**
 * Best-effort deleted-PR reap (#1641): a failed pass must never fail the
 * sync — the next tick re-evaluates — but it IS a failed pass: the response
 * must report it, or an operator reads "0 errors" for a reap that never ran.
 * Shared by both exit paths, including the no-tracked-repos early return
 * (#1651): the reap is item-driven and needs no tracked-repo list.
 */
async function runDeletedPrFixReap(): Promise<{ checked: number; markedStale: number; errored: number }> {
  try {
    return await reconcileDeletedPrFixItems(asPrFixQueueClient(prisma));
  } catch (error) {
    console.warn(
      "[pr-followup] deleted-PR reap failed (best-effort):",
      error instanceof Error ? error.message : error,
    );
    return { checked: 0, markedStale: 0, errored: 1 };
  }
}

interface GithubCheckRun {
  id: number;
  name: string;
  conclusion: string | null;
  head_branch: string;
  pull_requests: { url: string }[];
  html_url: string;
  details_url?: string;
  status?: string;
  completed_at?: string;
  output?: { title?: string; summary?: string };
}

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`pr-followup-sync:${auth.throttleKey}`, { limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  let lock: AcquiredLock | LockConflict | undefined;
  try {
    lock = await acquireLock("pr-followup");
    if (!lock?.locked) {
      return NextResponse.json({ error: "PR follow-up sync is already running", locked: true }, { status: 409 });
    }
    // Fail fast when no GitHub credentials are available. getGitHubToken
    // supports both GitHub App installation tokens and the legacy PAT.
    try {
      await getGitHubToken();
    } catch {
      return errorResponse("GITHUB_TOKEN not configured", 500);
    }

    const githubApi = "https://api.github.com";
    const repoFullNames = await getTrackedRepos();

    if (repoFullNames.length === 0) {
      // #1651: the deleted-PR reap reads queue rows and names each row's own
      // repository directly, so it never needed the tracked-repo list. An
      // instance tracking no repos must still reap rows whose PR was deleted
      // upstream, or they stay dispatchable forever. Everything else in this
      // route is repo-list driven and stays skipped.
      const deletedResult = await runDeletedPrFixReap();
      if (deletedResult.errored > 0) {
        console.warn(`[pr-followup] deleted-PR reap errored on ${deletedResult.errored} item(s) (#1641)`);
      }
      return NextResponse.json({
        message: "No tracked repos configured",
        enqueued: 0,
        skipped: 0,
        deletedReapChecked: deletedResult.checked,
        deletedReaped: deletedResult.markedStale,
        deletedReapErrored: deletedResult.errored,
      });
    }

    let totalEnqueued = 0;
    let totalSkipped = 0;
    let prsScanned = 0;
    let reposFailed = 0;
    let rateLimited = false;
    const allEvents: any[] = [];

    for (const repoFullName of repoFullNames) {
      const [owner, repo] = repoFullName.split("/");

      // Fetch open PRs
      let allPrs: GithubPR[] = [];
      try {
        allPrs = (await fetchPullRequests(repoFullName)) as GithubPR[];
      } catch (error: any) {
        reposFailed++;
        const isRateLimit = error.response?.status === 403 || (error.message ?? "").includes("Rate limit");
        if (isRateLimit) {
          console.warn(`[pr-followup] Rate limited on ${repoFullName}. Skipping remaining repos.`);
          rateLimited = true;
          break;
        }
        console.error(`Failed to fetch PRs for ${repoFullName}:`, error);
        continue;
      }

      // Filter to bot-authored PRs only. #1665: a scoped identity is also
      // narrowed here — by its head repository + head branch rule — so a PR
      // the scope excludes is never scanned at all. The head fields are the
      // same ones the #1637 ingestion gate reads from the list endpoint.
      const botPrs = allPrs.filter((pr) =>
        isAllowedBotAuthor(pr.user.login, {
          baseRepoFullName: repoFullName,
          headRepoFullName: pr.head?.repo?.full_name ?? null,
          headBranch: pr.head?.ref ?? null,
        }),
      );
      prsScanned += botPrs.length;

      for (const pr of botPrs) {
        // Fall back to the commit messages when the PR carries no reference.
        // An unlinked PR never reaches follow-up, so a review requesting
        // changes on it is never queued for a fix.
        let linkedIssue = extractLinkedIssue(pr);
        if (linkedIssue === null) {
          try {
            const commitMessages = await fetchPullRequestCommitMessages(
              `${owner}/${repo}`,
              pr.number,
            );
            linkedIssue = extractLinkedIssue({ ...pr, commitMessages });
          } catch {
            // Best effort: an unlinked PR is the status quo, not a failure.
          }
        }

        // Comments, reviews, and check runs are independent — fetch them in
        // parallel, best effort per source (a failed fetch yields no events).
        const commentsUrl = `${githubApi}/repos/${owner}/${repo}/issues/${pr.number}/comments?per_page=100`;
        const reviewsUrl = `${githubApi}/repos/${owner}/${repo}/pulls/${pr.number}/reviews?per_page=100`;
        // Inline review comments. Distinct from issues/N/comments above: that is the
        // conversation timeline, this is per-file review feedback, and only this one
        // carries a reviewer's anchored findings. Never fetched before, which is why
        // an APPROVED review's nits vanished entirely.
        const reviewCommentsUrl = `${githubApi}/repos/${owner}/${repo}/pulls/${pr.number}/comments?per_page=100`;
        const checksUrl = `${githubApi}/repos/${owner}/${repo}/commits/${pr.head?.ref ?? ""}/check-runs?status=completed&per_page=100`;
        const [comments, reviews, reviewComments, checkRuns, mergeState] = await Promise.all([
          fetchPaginated<GithubComment>(commentsUrl, 100).catch(() => [] as GithubComment[]),
          fetchPaginated<GithubReview>(reviewsUrl, 100).catch(() => [] as GithubReview[]),
          fetchPaginated<GithubReviewComment>(reviewCommentsUrl, 100).catch(() => [] as GithubReviewComment[]),
          fetchPaginated<GithubCheckRun>(
            checksUrl,
            100,
            (data) => (data as { check_runs?: GithubCheckRun[] }).check_runs ?? [],
          ).catch(() => [] as GithubCheckRun[]),
          // The list endpoint omits mergeability; the per-PR GET carries it. Without
          // this, pr.mergeable is always undefined and merge conflicts are invisible
          // to the ingestion below.
          fetchPullRequestMergeState(repoFullName, pr.number).catch(() => ({
            mergeableState: null,
            mergeable: null,
          })),
        ]);

        // Map the REST merge_state to the enum the conflict ingestion expects.
        // "dirty" is GitHub's conflict signal. Leave pr.mergeable unset when the
        // state is "unknown"/null (GitHub still computing) so the block below
        // neither enqueues a conflict nor prematurely clears a real one — it
        // resolves on a later sync once GitHub finishes computing.
        const mergeableState = (mergeState.mergeableState ?? "").toLowerCase();
        pr.mergeable =
          mergeableState === "dirty"
            ? "CONFLICTING"
            : mergeableState && mergeableState !== "unknown"
              ? "MERGEABLE"
              : undefined;
        // #1575 observability: when the per-PR mergeability read fails outright
        // (auth gap, error swallowed to null — NOT GitHub's documented
        // still-computing `unknown`), the PR is neither enqueued nor cleared
        // this cycle and previously left no trace: a conflicted PR stayed
        // invisible to the rebase lane while the job still reported ok. Make
        // the skip visible so an operator can tell "no signal" from "no work".
        if (mergeState.mergeableState === null && mergeState.mergeable === null) {
          console.warn(
            `[pr-followup] merge state unavailable for ${repoFullName}#${pr.number}; conflict detection deferred this cycle`,
          );
        }

        // PR head SHA captured at sync time. Stored on PrFixQueueItem.headSha so a
        // later FIXED transition can verify the workload actually pushed something
        // (#940). GitHub's `pulls?state=open` returns `head.sha` on every entry;
        // an empty/missing value here means we have nothing to compare against
        // and the FIXED guard degrades to the legacy behaviour (accept).
        const prHeadSha = pr.head?.sha ?? null;

        // #1249: REST doesn't expose whether an inline review comment's thread
        // is resolved/outdated. One GraphQL read per PR (only when there are
        // inline comments); fail-closed null leaves every comment's thread
        // flags undefined.
        const reviewThreadStates =
          reviewComments.length > 0
            ? await fetchPullRequestReviewThreadStates(repoFullName, pr.number)
            : null;

        // Collect comment events
        for (const comment of comments) {
          // Ignore self-comments from the same bot identity
          if (comment.user.login === pr.user.login) continue;

          allEvents.push({
            eventType: "comment" as const,
            repoFullName,
            prNumber: pr.number,
            branch: pr.head?.ref ?? null,
            // #1637: head-repo proof for the ingestion gate on every event this
            // scan produces — the list endpoint carries head.repo on every PR.
            headRepoFullName: pr.head?.repo?.full_name ?? null,
            url: pr.url,
            title: pr.title,
            author: pr.user.login,
            body: comment.body,
            id: String(comment.id),
            linkedIssue,
            headSha: prHeadSha,
            actorLogin: comment.user.login,
            updatedAt: comment.updated_at,
            source: "sync",
          });
        }

        // Collect inline review-comment events. Independent of the review verdict:
        // an APPROVED review still carries findings, and dropping them on state
        // alone loses real feedback.
        for (const rc of reviewComments) {
          if (rc.user?.login === pr.user.login) continue; // ignore self-comments
          allEvents.push({
            eventType: "review_comment" as const,
            repoFullName,
            prNumber: pr.number,
            branch: pr.head?.ref ?? null,
            // #1637: head-repo proof for the ingestion gate (#1637).
            headRepoFullName: pr.head?.repo?.full_name ?? null,
            url: pr.url,
            title: pr.title,
            author: pr.user.login,
            body: rc.body,
            id: String(rc.id),
            path: rc.path ?? null,
            line: rc.line ?? rc.original_line ?? null,
            linkedIssue,
            prState: pr.state,
            prMergedAt: pr.merged_at,
            headSha: prHeadSha,
            actorLogin: rc.user?.login ?? null,
            // #1249: the comment's own commit anchors the version/signature so
            // "same body at the same commit" stays the anti-repetition rule and
            // a re-paste against a NEWER commit remains fresh.
            commitId: rc.commit_id ?? null,
            updatedAt: rc.updated_at,
            threadResolved: reviewThreadStates?.get(String(rc.id))?.resolved,
            threadOutdated: reviewThreadStates?.get(String(rc.id))?.outdated,
            source: "sync",
          });
        }

        // Collect review events. EVERY state present in the API response is
        // pushed (#1276): a review that left CHANGES_REQUESTED (APPROVED,
        // DISMISSED, COMMENTED) is a real state transition, and ingestion
        // records it on the durable evidence ledger for the existing item
        // WITHOUT enqueueing work. Dropping them here was what kept the
        // ledger's actionable baseline stale forever.
        for (const review of reviews) {
          allEvents.push({
            eventType: "review" as const,
            repoFullName,
            prNumber: pr.number,
            branch: pr.head?.ref ?? null,
            // #1637: head-repo proof for the ingestion gate (#1637).
            headRepoFullName: pr.head?.repo?.full_name ?? null,
            url: pr.url,
            title: pr.title,
            author: pr.user.login,
            body: review.body,
            id: String(review.id),
            state: review.state,
            linkedIssue,
            prState: pr.state,
            prMergedAt: pr.merged_at,
            headSha: prHeadSha,
            actorLogin: review.user.login,
            commitId: review.commit_id,
            submittedAt: review.submitted_at,
            source: "sync",
          });
          // No `totalSkipped++` here: the event IS delivered, and ingestion
          // reports it as not-enqueued (it enqueues no work — it only records
          // the transition). Counting it on both sides would double it.
        }

        // Collect failing check run events
        for (const checkRun of checkRuns) {
          if (["failure", "cancelled", "timed_out", "action_required"].includes(checkRun.conclusion ?? "")) {
            // These CI jobs rarely populate output.summary, so the actual error
            // lives only in the job log. Fetch a bounded excerpt server-side (with
            // dispatch's own credential) so the coder's feedback carries the real
            // failure instead of a contentless "check failed" stub. Degrades to the
            // summary/"" when the log can't be read (e.g. no Actions:read).
            const jobId = jobIdFromCheckRunUrl(checkRun.html_url);
            const excerpt = jobId ? await fetchFailedJobLogExcerpt(repoFullName, jobId) : "";
              allEvents.push({
                eventType: "check_run" as const,
                repoFullName,
                prNumber: pr.number,
                branch: pr.head?.ref ?? null,
                // #1637: head-repo proof for the ingestion gate.
                headRepoFullName: pr.head?.repo?.full_name ?? null,
                url: pr.url,
                checkRunUrl: checkRun.html_url,
                title: checkRun.name,
                author: pr.user.login,
                body: excerpt || checkRun.output?.summary || "",
                id: String(checkRun.id),
                conclusion: checkRun.conclusion,
                checkName: checkRun.name,
                linkedIssue,
                headSha: prHeadSha,
                checkStatus: checkRun.status,
                completedAt: checkRun.completed_at,
                source: "sync",
              });
          } else {
            totalSkipped++;
          }
        }

        // Track merge state — every reported state, `clean` included (#1276
        // review). The descriptor decides what each state means: a problematic
        // one enqueues work, a definite non-problematic one records the cleared
        // baseline on the durable `merge_state:<repo>#<pr>` ledger row, and
        // `unknown` (GitHub still computing) is dropped by both — the same
        // defer rule the conflict block above documents. The `clean` exclusion
        // this replaces made the record-only branch unreachable from the only
        // timer-driven producer, so a cleared condition could never retire its
        // actionable baseline and the row stayed actionable until something else
        // overwrote it.
        if (pr.mergeable_state) {
            allEvents.push({
              eventType: "merge_state" as const,
              repoFullName,
              prNumber: pr.number,
              branch: pr.head?.ref ?? null,
              // #1637: head-repo proof for the ingestion gate.
              headRepoFullName: pr.head?.repo?.full_name ?? null,
              url: pr.url,
              title: pr.title,
              author: pr.user.login,
              mergeStateStatus: pr.mergeable_state,
              id: String(pr.id ?? Date.now()),
              linkedIssue,
              prState: pr.state,
              prMergedAt: pr.merged_at,
              headSha: prHeadSha,
              source: "sync",
            });
        }

        // Detect merge conflicts (CONFLICTING mergeable status)
        if (pr.mergeable && pr.mergeable.toUpperCase() === "CONFLICTING") {
            const conflictKey = await ingestMergeConflict(asPrFixQueueClient(prisma), {
              repoFullName,
              prNumber: pr.number,
              branch: pr.head?.ref ?? null,
              // #1637: the REBASE lane gate also needs head-repo proof.
              headRepoFullName: pr.head?.repo?.full_name ?? null,
              url: pr.url,
              title: pr.title,
              author: pr.user.login,
              mergeable: pr.mergeable,
              linkedIssue,
              headSha: prHeadSha,
              source: "sync",
            });
          if (conflictKey) {
            totalEnqueued++;
          }
        } else {
          // Clear resolved conflict items if PR is no longer conflicting
          if (pr.mergeable) {
            await clearResolvedConflictItems(asPrFixQueueClient(prisma), {
              repoFullName,
              prNumber: pr.number,
              mergeable: pr.mergeable,
              // #1276 review: the cleared `merge_conflict` ledger version names
              // the head the clearing was observed at, so a re-conflict at this
              // head still reads as a transition rather than a replay.
              headSha: prHeadSha,
            });
          }
        }
      }
    }

    // Process all collected events through the ingestion pipeline
    let result = { enqueued: 0, skipped: 0 };
    if (allEvents.length > 0) {
      result = await processPrFollowupEvents(asPrFixQueueClient(prisma), allEvents);
    }

    // Reap stale PR-fix queue items: any QUEUED/BLOCKED item whose PR has since
    // merged or closed is marked `stale` so the transition is auditable. This
    // runs once per sync cycle after event processing, using the same per-repo
    // closed-PR fetch pattern as the reconcile endpoint.
    const mergedOrClosedPrsByRepo = new Map<string, Set<number>>();
    const prStatesByRepo = new Map<string, Map<number, "merged" | "closed">>();
    for (const repoFullName of repoFullNames) {
      if (rateLimited) break;
      try {
        const closedPrs = await fetchClosedPullRequests(repoFullName, 100);
        if (closedPrs.length > 0) {
          mergedOrClosedPrsByRepo.set(repoFullName, new Set(closedPrs.map((pr) => pr.number)));
          const statesMap = new Map<number, "merged" | "closed">();
          for (const pr of closedPrs) {
            statesMap.set(pr.number, pr.merged_at != null ? "merged" : "closed");
          }
          prStatesByRepo.set(repoFullName, statesMap);
        }
      } catch (error: any) {
        const isRateLimit = error.response?.status === 403 || (error.message ?? "").includes("Rate limit");
        if (isRateLimit && !rateLimited) {
          console.warn(`[pr-followup] Rate limited while fetching closed PRs for ${repoFullName}. Skipping remaining.`);
          rateLimited = true;
          break;
        }
        console.error(`Failed to fetch closed PRs for ${repoFullName}:`, error);
      }
    }
    const staleResult = await reconcileStalePrFixItems(
      asPrFixQueueClient(prisma),
      mergedOrClosedPrsByRepo,
      prStatesByRepo,
    );
    // Archived repos can't take a push, so their items are dead too (#1106).
    const archivedResult = rateLimited
      ? { markedStale: 0 }
      : await reconcileArchivedRepoPrFixItems(asPrFixQueueClient(prisma));
    // #1641: a hard-deleted PR vanished from every listing, so the
    // merged/closed reap above can never see its rows. Probe the per-PR
    // endpoint for the rows the reap reaches: a 404 at a reachable repo
    // whose PR listing does not show the PR is a confirmed deletion;
    // present/transport-failure/unreadable-repo/unreadable-listing defer.
    // The pass is bounded (rows read + per-PR probes) and rotates through the
    // queue, so a healthy queue of present PRs never turns into one GitHub
    // request per row on every sync. A rate-limited cycle skips it, same as
    // the archived-repo reap above.
    const deletedResult = rateLimited
      ? { checked: 0, markedStale: 0, errored: 0 }
      : await runDeletedPrFixReap();
    if (deletedResult.errored > 0) {
      console.warn(`[pr-followup] deleted-PR reap errored on ${deletedResult.errored} item(s) (#1641)`);
    }

    // #1253: bounded trigger reconciliation for structured external waits —
    // a recorded dependency that now satisfies its predicate reactivates the
    // wait (uncharged recheck). Best-effort: a failed pass must never fail
    // the sync; the next tick re-evaluates.
    let waitTriggerResult = { evaluated: 0, reactivated: 0 };
    try {
      waitTriggerResult = await reconcileExternalWaitTriggers(asPrFixQueueClient(prisma));
    } catch (error) {
      console.warn(
        "[pr-followup] external-wait trigger reconciliation failed (best-effort):",
        error instanceof Error ? error.message : error,
      );
    }

    // #1638: fork rows drain here — one probe per unproven row within a
    // bounded page budget (a confirmed same-repo match earns a durable stamp
    // and leaves the probe set), a confirmed fork retires to STALE, and an
    // unverifiable probe defers to the next cycle. Runs AFTER the external-wait recheck so
    // a row reactivated this pass is still seen this cycle. Producers gated
    // in this change: the direct enqueue writer and linked-PR materialization
    // at next-task. Producers whose gates land in sibling PRs — ingestion
    // (#1637) and the `/dispatch-fix` command (#1622/#1634) — are covered
    // here until those merges land: their fork rows (including legacy rows)
    // drain on a later cycle.
    const forkResult = rateLimited
      ? { markedStale: 0 }
      : await reconcileForkPrFixItems(asPrFixQueueClient(prisma));

    if (reposFailed > 0) {
      console.warn(
        `[pr-followup] Sync completed with ${reposFailed} repo failure(s). ` +
        `${rateLimited ? "Rate limited — some repos were skipped." : ""}`,
      );
    }

    return NextResponse.json({
      message: "PR follow-up sync complete",
      reposScanned: repoFullNames.length - reposFailed,
      reposFailed,
      prsScanned,
      enqueued: result.enqueued,
      skipped: totalSkipped + result.skipped,
      staleReaped: staleResult.markedStale,
      archivedReaped: archivedResult.markedStale,
      forkReaped: forkResult.markedStale,
      deletedReapChecked: deletedResult.checked,
      deletedReaped: deletedResult.markedStale,
      deletedReapErrored: deletedResult.errored,
      externalWaitRechecked: waitTriggerResult.reactivated,
      rateLimited,
    });
  } catch (error) {
    console.error("PR follow-up sync failed:", error);
    return errorResponse("PR follow-up sync failed", 500);
  } finally {
    if (lock && lock.locked) {
      await releaseLock(lock.runId);
    }
  }
}
