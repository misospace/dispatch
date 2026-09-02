import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { reconcileStalePrFixItems } from "@/lib/pr-fix-queue";
import { authorizeRequest } from "@/lib/auth";
import { getTrackedRepos } from "@/lib/config";
import { getGitHubToken, fetchPaginated, fetchPullRequests, fetchPullRequestMergeState, fetchFailedJobLogExcerpt, fetchClosedPullRequests, jobIdFromCheckRunUrl, type GithubPR as GithubPRBase } from "@/lib/github";
import { fetchPullRequestCommitMessages } from "@/lib/github";
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
interface GithubPR extends GithubPRBase {
  id: number;
  mergeable_state?: string;
  mergeable?: string; // "CONFLICTING", "MERGEABLE", "UNKNOWN"
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
}

interface GithubCheckRun {
  id: number;
  name: string;
  conclusion: string | null;
  head_branch: string;
  pull_requests: { url: string }[];
  html_url: string;
  details_url?: string;
  output?: { title?: string; summary?: string };
}

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const limited = enforceRateLimit(`pr-followup-sync:${auth.actor}`, { limit: 10, windowMs: 60_000 });
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
      return NextResponse.json({ message: "No tracked repos configured", enqueued: 0, skipped: 0 });
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

      // Filter to bot-authored PRs only
      const botPrs = allPrs.filter((pr) => isAllowedBotAuthor(pr.user.login));
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
        const checksUrl = `${githubApi}/repos/${owner}/${repo}/commits/${pr.head.ref}/check-runs?status=completed&per_page=100`;
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
          fetchPullRequestMergeState(repoFullName, pr.number),
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

        // Collect comment events
        for (const comment of comments) {
          // Ignore self-comments from the same bot identity
          if (comment.user.login === pr.user.login) continue;

          allEvents.push({
            eventType: "comment" as const,
            repoFullName,
            prNumber: pr.number,
            branch: pr.head.ref ?? null,
            url: pr.url,
            title: pr.title,
            author: pr.user.login,
            body: comment.body,
            id: String(comment.id),
            linkedIssue,
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
            branch: pr.head.ref ?? null,
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
          });
        }

        // Collect review events
        for (const review of reviews) {
          if (review.state === "CHANGES_REQUESTED") {
            allEvents.push({
              eventType: "review" as const,
              repoFullName,
              prNumber: pr.number,
              branch: pr.head.ref ?? null,
              url: pr.url,
              title: pr.title,
              author: pr.user.login,
              body: review.body,
              id: String(review.id),
              state: review.state,
              linkedIssue,
              prState: pr.state,
              prMergedAt: pr.merged_at,
            });
          } else {
            totalSkipped++; // APPROVED/COMMENTED don't trigger PR-fix work
          }
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
              branch: pr.head.ref ?? null,
              url: checkRun.html_url,
              title: checkRun.name,
              author: pr.user.login,
              body: excerpt || checkRun.output?.summary || "",
              id: String(checkRun.id),
              conclusion: checkRun.conclusion,
              checkName: checkRun.name,
              linkedIssue,
            });
          } else {
            totalSkipped++;
          }
        }

        // Track merge state
        if (pr.mergeable_state && pr.mergeable_state !== "clean") {
          allEvents.push({
            eventType: "merge_state" as const,
            repoFullName,
            prNumber: pr.number,
            branch: pr.head.ref ?? null,
            url: pr.url,
            title: pr.title,
            author: pr.user.login,
            mergeStateStatus: pr.mergeable_state,
            id: String(pr.id ?? Date.now()),
            linkedIssue,
            prState: pr.state,
            prMergedAt: pr.merged_at,
          });
        }

        // Detect merge conflicts (CONFLICTING mergeable status)
        if (pr.mergeable && pr.mergeable.toUpperCase() === "CONFLICTING") {
          const conflictKey = await ingestMergeConflict(asPrFixQueueClient(prisma), {
            repoFullName,
            prNumber: pr.number,
            branch: pr.head.ref ?? null,
            url: pr.url,
            title: pr.title,
            author: pr.user.login,
            mergeable: pr.mergeable,
            linkedIssue,
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
        const closedPrs = await fetchClosedPullRequests(repoFullName, 30);
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
