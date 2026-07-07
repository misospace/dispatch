import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";
import { getTrackedRepos } from "@/lib/config";
import { getGitHubToken, fetchPaginated, fetchPullRequests, type GithubPR as GithubPRBase } from "@/lib/github";
import { processPrFollowupEvents, extractLinkedIssue, isAllowedBotAuthor, ingestMergeConflict, clearResolvedConflictItems } from "@/lib/pr-followup-ingestion";

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

  try {
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
    const allEvents: any[] = [];

    for (const repoFullName of repoFullNames) {
      const [owner, repo] = repoFullName.split("/");

      // Fetch open PRs
      let allPrs: GithubPR[] = [];
      try {
        allPrs = (await fetchPullRequests(repoFullName)) as GithubPR[];
      } catch (error) {
        console.error(`Failed to fetch PRs for ${repoFullName}:`, error);
        continue;
      }

      // Filter to bot-authored PRs only
      const botPrs = allPrs.filter((pr) => isAllowedBotAuthor(pr.user.login));
      prsScanned += botPrs.length;

      for (const pr of botPrs) {
        const linkedIssue = extractLinkedIssue(pr);

        // Comments, reviews, and check runs are independent — fetch them in
        // parallel, best effort per source (a failed fetch yields no events).
        const commentsUrl = `${githubApi}/repos/${owner}/${repo}/issues/${pr.number}/comments?per_page=100`;
        const reviewsUrl = `${githubApi}/repos/${owner}/${repo}/pulls/${pr.number}/reviews?per_page=100`;
        const checksUrl = `${githubApi}/repos/${owner}/${repo}/commits/${pr.head.ref}/check-runs?status=completed&per_page=100`;
        const [comments, reviews, checkRuns] = await Promise.all([
          fetchPaginated<GithubComment>(commentsUrl, 100).catch(() => [] as GithubComment[]),
          fetchPaginated<GithubReview>(reviewsUrl, 100).catch(() => [] as GithubReview[]),
          fetchPaginated<GithubCheckRun>(
            checksUrl,
            100,
            (data) => (data as { check_runs?: GithubCheckRun[] }).check_runs ?? [],
          ).catch(() => [] as GithubCheckRun[]),
        ]);

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
            allEvents.push({
              eventType: "check_run" as const,
              repoFullName,
              prNumber: pr.number,
              branch: pr.head.ref ?? null,
              url: checkRun.html_url,
              title: checkRun.name,
              author: pr.user.login,
              body: checkRun.output?.summary ?? "",
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

    return NextResponse.json({
      message: "PR follow-up sync complete",
      reposScanned: repoFullNames.length,
      prsScanned,
      enqueued: result.enqueued,
      skipped: totalSkipped + result.skipped,
    });
  } catch (error) {
    console.error("PR follow-up sync failed:", error);
    return errorResponse("PR follow-up sync failed", 500);
  }
}
