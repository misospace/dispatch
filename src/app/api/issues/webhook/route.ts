import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { authorizeRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSignatureVerificationMode, verifyWebhookSignature } from "@/lib/webhook-signature";
import { enforceRateLimit } from "@/lib/rate-limit";

/**
 * GitHub Webhook Handler for Issue Label Events
 *
 * Receives `issues` events with action `labeled` / `unlabeled` and applies
 * the label change directly to the local issue cache, shrinking the
 * staleness window for queue/list/board reads between full syncs.
 *
 * Signature verification: validates X-Hub-Signature-256 using HMAC-SHA256
 * with the WEBHOOK_SECRET environment variable (same fail-closed model as
 * the pr-followup webhook).
 *
 * Only the Prisma cache is updated. GitHub is the source of truth and the
 * event already came from GitHub, so no outbound GitHub calls are made.
 */

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

    const limited = enforceRateLimit(`issues-webhook:${actor}`, { limit: 30, windowMs: 10_000 });
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

    if (githubEvent !== "issues") {
      return NextResponse.json({ message: `Unhandled event type: ${githubEvent}` });
    }

    const body = jsonPayload as Record<string, any>;
    const action = body.action;
    if (action !== "labeled" && action !== "unlabeled") {
      return NextResponse.json({
        message: `Unhandled issues action: ${action ?? "unknown"}. Only labeled/unlabeled are processed.`,
      });
    }

    // GitHub fires `issues` labeled/unlabeled events for pull requests too
    // (PR payloads carry a `pull_request` key on the issue). Dispatch's issue
    // cache only holds real issues, so skip PR deliveries explicitly instead
    // of relying on the repositoryId_number lookup to miss.
    if (body.issue?.pull_request) {
      return NextResponse.json({ message: "Pull request event, ignored" });
    }

    const repoFullName = body.repository?.full_name;
    if (typeof repoFullName !== "string" || !repoFullName) {
      return errorResponse("Missing repository.full_name in payload", 400);
    }

    const repo = await prisma.repository.findUnique({
      where: { fullName: repoFullName },
    });
    if (!repo) {
      // Not an error: the repo is simply outside Dispatch's tracking scope.
      // A 200 tells GitHub not to retry the delivery.
      return NextResponse.json({ message: "Repo not tracked, ignored" });
    }

    const issueNumber = body.issue?.number;
    if (typeof issueNumber !== "number") {
      return errorResponse("Missing issue.number in payload", 400);
    }

    const cachedIssue = await prisma.issue.findUnique({
      where: { repositoryId_number: { repositoryId: repo.id, number: issueNumber } },
    });
    if (!cachedIssue) {
      // Not an error: the issue is simply not in the local cache yet.
      return NextResponse.json({ message: "Issue not cached, ignored" });
    }

    const labelName = body.label?.name;
    if (typeof labelName !== "string" || !labelName) {
      return errorResponse("Missing label.name in payload", 400);
    }

    // Idempotent: adding a label that is already present (or removing one
    // that is absent) leaves the label set unchanged.
    const currentLabels = cachedIssue.labels;
    const nextLabels =
      action === "labeled"
        ? currentLabels.includes(labelName)
          ? currentLabels
          : [...currentLabels, labelName]
        : currentLabels.filter((label) => label !== labelName);

    await prisma.issue.update({
      where: { repositoryId_number: { repositoryId: repo.id, number: issueNumber } },
      data: { labels: nextLabels, lastSyncedAt: new Date() },
    });

    return NextResponse.json({
      message: `Issue label cache updated: ${repoFullName}#${issueNumber}`,
      action,
      label: labelName,
      labels: nextLabels,
    });
  } catch (error) {
    console.error("Issues webhook handler failed:", error);
    return errorResponse("Webhook processing failed", 500);
  }
}
