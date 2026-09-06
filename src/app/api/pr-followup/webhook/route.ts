import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { createHmac, timingSafeEqual } from "node:crypto";
import { authorizeRequest } from "@/lib/auth";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { processPrFollowupEvents, extractLinkedIssue, PrFollowupEvent } from "@/lib/pr-followup-ingestion";
import { enforceRateLimit } from "@/lib/rate-limit";

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

/**
 * Determine signature verification mode.
 *
 * - "verify": WEBHOOK_SECRET is set — verify HMAC-SHA256 signature
 * - "skip": WEBHOOK_GATEWAY_MODE is "true" — skip verification (behind API gateway)
 * - "reject": neither configured — fail-closed, reject all requests
 */
function getSignatureVerificationMode(): "verify" | "skip" | "reject" {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) return "verify";
  if (process.env.WEBHOOK_GATEWAY_MODE === "true") return "skip";
  // Fail-closed: reject requests when neither WEBHOOK_SECRET nor WEBHOOK_GATEWAY_MODE is configured
  return "reject";
}

function verifyWebhookSignature(secret: string, payload: Buffer, signature: string): boolean {
  if (!signature.startsWith("sha256=")) return false;
  const expected = signature.slice(7);
  const hmac = createHmac("sha256", secret);
  hmac.update(payload);
  const computed = hmac.digest("hex");

  // Constant-time comparison; timingSafeEqual requires equal-length buffers
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(computed), Buffer.from(expected));
}

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
        linkedIssue: extractLinkedIssue(issue),
        headSha: issue.head?.sha ?? null,
      });
      break;
    }

    case "check_run": {
      const checkRun = body as Record<string, any>;
      const check = checkRun.check_run;
      if (!check) break;

      // Derive PR association from check.pull_requests (not checkRun.sender)
      let prNumber: number | undefined = undefined;
      let prAuthor: string | null = null;
      let prLinkedIssue: number | null = null;
      const prList = check.pull_requests ?? [];
      if (Array.isArray(prList) && prList.length > 0) {
        const firstPr = prList[0] as Record<string, any> | undefined;
        if (firstPr?.url) {
          const match = firstPr.url.match(/\/pull\/(\d+)/);
          if (match) {
            prNumber = parseInt(match[1], 10);
            prAuthor = firstPr.user?.login ?? null;
            prLinkedIssue = extractLinkedIssue(firstPr);
          }
        }
      }

      // Skip check runs that cannot be associated with a PR
      if (prNumber === undefined || prNumber === 0) break;

      events.push({
        eventType: "check_run",
        repoFullName: check.repository?.full_name ?? null,
        prNumber,
        branch: check.head_branch ?? null,
        url: check.html_url,
        title: check.name,
        author: prAuthor,
        body: check.details ?? check.output?.summary ?? "",
        id: String(check.id),
        conclusion: check.conclusion,
        checkName: check.name,
        linkedIssue: prLinkedIssue,
        // GitHub does not include `head.sha` directly on the check_run payload;
        // fall back to `head_branch` only. The PR detail fetcher in the sync
        // route still has it; webhooks degrade to "no head sha recorded" and
        // skip the FIXED head-SHA guard for that path.
        headSha: null,
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

    // Webhook signature verification: fail-closed by default.
    // If WEBHOOK_SECRET is set, always verify. If not set, only skip when
    // WEBHOOK_GATEWAY_MODE=true (explicit opt-out for gateway deployments).
    //
    // When WEBHOOK_SECRET is configured, a valid HMAC signature is treated as
    // sufficient authentication for the webhook (matches GitHub's delivery
    // shape, which carries no Authorization header). authorizeRequest is then
    // skipped so direct GitHub deliveries work in oidc/legacy/basic auth modes.
    // Invalid signatures are still rejected with 401.
    const sigMode = getSignatureVerificationMode();
    if (sigMode === "reject") {
      return errorResponse(
        "Webhook signature verification is not configured. Set WEBHOOK_SECRET or enable WEBHOOK_GATEWAY_MODE.",
        503,
      );
    }
    if (sigMode === "verify") {
      const webhookSecret = process.env.WEBHOOK_SECRET!;
      const signature = request.headers.get("x-hub-signature-256");
      if (!signature) {
        return errorResponse("Missing x-hub-signature-256 header", 401);
      }
      if (!verifyWebhookSignature(webhookSecret, payload, signature)) {
        return errorResponse("Invalid webhook signature", 401);
      }
    }

    // Authenticate the request (Bearer token, Basic Auth, or OIDC session).
    // When sigMode === "verify" the HMAC check above is the authentication
    // gate, so we skip authorizeRequest to let signature-only GitHub deliveries
    // through. In all other modes we still require the normal auth layer.
    let actor = "webhook";
    if (sigMode !== "verify") {
      const auth = await authorizeRequest(request);
      if (!auth.authorized) {
        return errorResponse("Unauthorized", 401);
      }
      actor = auth.actor ?? "webhook";
    }

    const limited = enforceRateLimit(`pr-followup-webhook:${actor}`, { limit: 30, windowMs: 10_000 });
    if (limited) return limited;

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
