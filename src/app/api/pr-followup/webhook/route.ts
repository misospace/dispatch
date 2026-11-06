import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { processPrFollowupEvents, extractLinkedIssue, PrFollowupEvent } from "@/lib/pr-followup-ingestion";
import { authenticateWebhookDelivery } from "@/lib/webhook-signature";

/**
 * GitHub Webhook Handler for PR Follow-up Events
 *
 * Receives push events for:
 * - pull_request_review (CHANGES_REQUESTED)
 * - pull_request_review_comment (review comments on PRs)
 * - issues (issue_comment on PRs — when a PR is linked to an issue)
 * - check_run (failing CI checks)
 * - pull_request (merge_state_status changes, etc.)
 *
 * Signature verification: validates X-Hub-Signature-256 using HMAC-SHA256
 * with the WEBHOOK_SECRET environment variable.
 *
 * Default behavior is fail-closed: if WEBHOOK_SECRET is not configured,
 * requests are rejected (503) unless WEBHOOK_GATEWAY_MODE is explicitly set to "true",
 * which indicates the endpoint is behind a gateway that performs its own
 * authentication and signature verification.
 */

function parseWebhookEvent(githubEvent: string, body: Record<string, unknown>): PrFollowupEvent[] {
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
        linkedIssue: extractLinkedIssue(pr),
        prState: pr.state,
        prMergedAt: pr.merged_at,
        headSha: pr.head?.sha ?? null,
        actorLogin: prReview.review?.user?.login ?? null,
        commitId: prReview.review?.commit_id,
        submittedAt: prReview.review?.submitted_at,
        source: "webhook",
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
        linkedIssue: extractLinkedIssue(pr),
        headSha: pr.head?.sha ?? null,
        actorLogin: comment.comment?.user?.login ?? null,
        // #1249: same-commit anchoring for the anti-repetition signature.
        commitId: comment.comment?.commit_id ?? null,
        updatedAt: comment.comment?.updated_at,
        source: "webhook",
      });
      break;
    }

    case "issue_comment": {
      const issueComment = body as Record<string, any>;
      const issue = issueComment.issue;
      if (!issue || !issue.pull_request) break; // Only handle PR comments (not issue comments)

      // The issue object carries no repository or head ref; the repo is the
      // top-level `repository`, and the PR's branch/head are not in this payload.
      events.push({
        eventType: "comment",
        repoFullName: issueComment.repository?.full_name ?? null,
        prNumber: issue.number,
        branch: null,
        url: issue.html_url,
        title: issue.title,
        author: issue.user?.login ?? null,
        body: issueComment.comment?.body ?? "",
        id: String(issueComment.comment?.id),
        linkedIssue: extractLinkedIssue(issue),
        headSha: null,
        actorLogin: issueComment.comment?.user?.login ?? null,
        updatedAt: issueComment.comment?.updated_at,
        source: "webhook",
      });
      break;
    }

    case "check_run": {
      const checkRun = body as Record<string, any>;
      const check = checkRun.check_run;
      if (!check) break;

      // check_run.pull_requests[] items are pull-request-minimal objects
      // ({ id, number, url, head, base }): the number is given directly (url is
      // the API URL, /repos/o/r/pulls/N) and there is no author, title or body.
      // A webhook check_run therefore has author null and does not pass the
      // bot-author gate; the sync route covers failing checks with the real PR
      // author.
      const prList = Array.isArray(check.pull_requests) ? check.pull_requests : [];
      const firstPr = prList[0] as Record<string, any> | undefined;
      const prNumber = typeof firstPr?.number === "number" ? firstPr.number : undefined;

      // Skip check runs that cannot be associated with a PR
      if (prNumber === undefined || prNumber === 0) break;

      events.push({
        eventType: "check_run",
        repoFullName: checkRun.repository?.full_name ?? null,
        prNumber,
        branch: firstPr?.head?.ref ?? check.check_suite?.head_branch ?? null,
        // #1098: `url` is the item's identity and the queue guard is
        // write-once — a job-URL fallback would freeze it in place. The empty
        // string stays falsy, so the next sync enqueue backfills the real PR URL.
        url: typeof firstPr?.url === "string" ? firstPr.url : "",
        checkRunUrl: check.html_url,
        title: check.name,
        author: null,
        body: check.output?.summary ?? "",
        id: String(check.id),
        conclusion: check.conclusion,
        checkName: check.name,
        linkedIssue: null,
        headSha: firstPr?.head?.sha ?? check.head_sha ?? null,
        checkStatus: check.status,
        completedAt: check.completed_at,
        source: "webhook",
      });
      break;
    }

    case "pull_request": {
      const pr = body.pull_request as Record<string, any> | undefined;
      if (!pr) break;

      events.push({
        eventType: "merge_state",
        repoFullName: pr.base?.repo?.full_name ?? null,
        prNumber: pr.number ?? 0,
        branch: pr.head?.ref ?? null,
        url: pr.html_url,
        title: pr.title,
        author: pr.user?.login ?? null,
        mergeStateStatus: pr.mergeable_state,
        id: String(pr.id ?? Date.now()),
        linkedIssue: extractLinkedIssue(pr),
        prState: pr.state,
        prMergedAt: pr.merged_at,
        headSha: pr.head?.sha ?? null,
        source: "webhook",
      });
      break;
    }

    default:
      return []; // Handled below with 400 response
  }

  return events;
}

export async function POST(request: Request) {
  try {
    const githubEvent = request.headers.get("x-github-event");
    if (!githubEvent) {
      return errorResponse("Missing x-github-event header", 400);
    }

    // Read raw body before authorization so that if authorizeRequest ever
    // consumes the body stream, HMAC verification still operates on the real payload.
    const rawBody = await request.arrayBuffer();
    const payload = Buffer.from(rawBody);

    // Webhook authentication: mode selection, HMAC verification, the
    // authorizeRequest fallback, actor resolution, and the rate-limit bucket
    // are owned by the shared helper so this route and the issues route
    // cannot drift apart.
    const deliveryAuth = await authenticateWebhookDelivery(request, payload, "pr-followup-webhook");
    if (!deliveryAuth.authenticated) return deliveryAuth.response;

    // Parse JSON payload from the already-read buffer
    let jsonPayload: unknown;
    try {
      jsonPayload = JSON.parse(payload.toString());
    } catch {
      return errorResponse("Invalid JSON body", 400);
    }

    if (!jsonPayload || typeof jsonPayload !== "object") {
      return errorResponse("Invalid payload", 400);
    }

    const body = jsonPayload as Record<string, unknown>;
    const events = parseWebhookEvent(githubEvent, body);

    if (events.length === 0) {
      // Check if it was an unhandled event type vs. no events parsed
      const knownEvents = ["pull_request_review", "pull_request_review_comment", "issue_comment", "check_run", "pull_request"];
      if (!knownEvents.includes(githubEvent)) {
        return NextResponse.json({ message: `Unhandled event type: ${githubEvent}` });
      }
      return NextResponse.json({ message: "No events to process" });
    }

    const result = await processPrFollowupEvents(asPrFixQueueClient(prisma), events);

    return NextResponse.json({
      eventsReceived: events.length,
      enqueued: result.enqueued,
      skipped: result.skipped,
    });
  } catch (error) {
    console.error("PR follow-up webhook handler failed:", error);
    return errorResponse("Webhook processing failed", 500);
  }
}
