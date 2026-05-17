import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processPrFollowupEvents, PrFollowupEvent } from "@/lib/pr-followup-ingestion";

/**
 * GitHub Webhook Handler for PR Follow-up Events
 *
 * Receives push events for:
 * - pull_request_review (CHANGES_REQUESTED)
 * - pull_request_review_comment (review comments on PRs)
 * - issues (issue_comment on PRs — when a PR is linked to an issue)
 * - check_run (failing CI checks)
 * - pull_request (merge_state_status changes, etc.)
 */

export async function POST(request: Request) {
  try {
    const githubEvent = request.headers.get("x-github-event");
    if (!githubEvent) {
      return NextResponse.json({ error: "Missing x-github-event header" }, { status: 400 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const body = payload as Record<string, unknown>;
    const events: PrFollowupEvent[] = [];

    switch (githubEvent) {
      case "pull_request_review": {
        const prReview = body as Record<string, any>;
        const pr = prReview.pull_request;
        if (!pr) break;

        events.push({
          eventType: "review",
          repoFullName: pr.base?.repo?.full_name ?? null,
          prNumber: pr.number,
          branch: pr.head?.ref ?? null,
          url: pr.html_url,
          title: pr.title,
          author: pr.user?.login ?? null,
          body: prReview.review?.body ?? "",
          id: String(prReview.review?.id),
          state: prReview.review?.state,
        });
        break;
      }

      case "pull_request_review_comment": {
        const comment = body as Record<string, any>;
        const pr = comment.pull_request;
        if (!pr) break;

        events.push({
          eventType: "comment",
          repoFullName: pr.base?.repo?.full_name ?? null,
          prNumber: pr.number,
          branch: pr.head?.ref ?? null,
          url: pr.html_url,
          title: pr.title,
          author: pr.user?.login ?? null,
          body: comment.comment?.body ?? "",
          id: String(comment.comment?.id),
        });
        break;
      }

      case "issue_comment": {
        const issueComment = body as Record<string, any>;
        const issue = issueComment.issue;
        if (!issue || !issue.pull_request) break; // Only handle PR comments (not issue comments)

        events.push({
          eventType: "comment",
          repoFullName: issue.repository?.full_name ?? null,
          prNumber: issue.number,
          branch: issue.head?.ref ?? null,
          url: issue.html_url,
          title: issue.title,
          author: issue.user?.login ?? null,
          body: issueComment.comment?.body ?? "",
          id: String(issueComment.comment?.id),
        });
        break;
      }

      case "check_run": {
        const checkRun = body as Record<string, any>;
        const check = checkRun.check_run;
        if (!check) break;

        // Try to find the PR number from check details
        let prNumber: number | null = null;
        const issueUrls = check.pull_requests ?? [];
        if (Array.isArray(issueUrls) && issueUrls.length > 0) {
          const firstUrl = issueUrls[0]?.url as string | undefined;
          if (firstUrl) {
            const match = firstUrl.match(/\/pull\/(\d+)/);
            if (match) prNumber = parseInt(match[1], 10);
          }
        }

        events.push({
          eventType: "check_run",
          repoFullName: checkRun.repository?.full_name ?? null,
          prNumber: prNumber ?? null,
          branch: check.head_branch ?? null,
          url: check.html_url,
          title: check.name,
          author: checkRun.sender?.login ?? null,
          body: check.details ?? check.output?.summary ?? "",
          id: String(check.id),
          conclusion: check.conclusion,
          checkName: check.name,
        });
        break;
      }

      case "pull_request": {
        const pr = body.pull_request;
        if (!pr) break;

        events.push({
          eventType: "merge_state",
          repoFullName: pr.base?.repo?.full_name ?? null,
          prNumber: pr.number,
          branch: pr.head?.ref ?? null,
          url: pr.html_url,
          title: pr.title,
          author: pr.user?.login ?? null,
          mergeStateStatus: pr.mergeable_state,
        });
        break;
      }

      default:
        return NextResponse.json({ message: `Unhandled event type: ${githubEvent}` });
    }

    if (events.length === 0) {
      return NextResponse.json({ message: "No events to process" });
    }

    const result = await processPrFollowupEvents(prisma, events);

    return NextResponse.json({
      eventsReceived: events.length,
      enqueued: result.enqueued,
      skipped: result.skipped,
    });
  } catch (error) {
    console.error("PR follow-up webhook handler failed:", error);
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
