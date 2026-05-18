import { NextResponse } from "next/server";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { getTrackedRepos } from "@/lib/config";
import { processPrFollowupEvents, isAllowedBotAuthor } from "@/lib/pr-followup-ingestion";

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

interface GithubPR {
  id: number;
  number: number;
  url: string;
  title: string;
  body: string | null;
  state: string;
  user: { login: string };
  head: { ref: string };
  base: { ref: string };
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  draft: boolean;
  mergeable_state?: string;
}

/**
 * Extract linked issue numbers from a PR's title and body.
 * Matches patterns like "#42", "Fixes #42", "Closes #42", etc.
 */
function extractLinkedIssue(pr: GithubPR): number | null {
  const text = [pr.title, pr.body].filter(Boolean).join("\n");
  const match = text.match(/#(\d+)/);
  return match ? parseInt(match[1], 10) : null;
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

async function fetchWithGithub(url: string, token: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${url}: ${res.status} ${text}`);
  }
  return res.json();
}

export async function POST() {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return NextResponse.json({ error: "GITHUB_TOKEN not configured" }, { status: 500 });
    }

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
        const pageUrl = `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${owner}/${repo}/pulls?state=open&per_page=100`;
        allPrs = await fetchWithGithub(pageUrl, token);
      } catch (error) {
        console.error(`Failed to fetch PRs for ${repoFullName}:`, error);
        continue;
      }

      // Filter to bot-authored PRs only
      const botPrs = allPrs.filter((pr) => isAllowedBotAuthor(pr.user.login));
      prsScanned += botPrs.length;

      for (const pr of botPrs) {
        const linkedIssue = extractLinkedIssue(pr);

        // Fetch comments on this PR and collect events
        try {
          const commentsUrl = `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${owner}/${repo}/issues/${pr.number}/comments?per_page=100`;
          const comments: GithubComment[] = await fetchWithGithub(commentsUrl, token);

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
        } catch {
          // Best effort — don't fail on a single repo
        }

        // Fetch reviews on this PR and collect events
        try {
          const reviewsUrl = `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${owner}/${repo}/pulls/${pr.number}/reviews?per_page=100`;
          const reviews: GithubReview[] = await fetchWithGithub(reviewsUrl, token);

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
              });
            } else {
              totalSkipped++; // APPROVED/COMMENTED don't trigger PR-fix work
            }
          }
        } catch {
          // Best effort
        }

        // Fetch failing check runs for this PR's branch and collect events
        try {
          const checksUrl = `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${owner}/${repo}/commits/${pr.head.ref}/check-runs?status=end&per_page=100`;
          const checksData: any = await fetchWithGithub(checksUrl, token);

          for (const checkRun of (checksData.check_runs ?? [])) {
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
        } catch {
          // Best effort
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
          });
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
    return NextResponse.json({ error: "PR follow-up sync failed" }, { status: 500 });
  }
}
