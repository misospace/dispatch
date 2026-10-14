import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSignatureVerificationMode, verifyWebhookSignature } from "@/lib/webhook-signature";
import { enforceRateLimit } from "@/lib/rate-limit";
import { invalidateGroomingForComment } from "@/lib/groomer/freshness-invalidation";
import {
  lifecycleDedupeKey,
  lifecycleStatusLabel,
  recordLifecycleEventQuietly,
} from "@/lib/issue-lifecycle";

/** Parse a GitHub ISO timestamp, ignoring absent or unparseable values. */
function parseGithubTimestamp(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Who GitHub says caused the change — the sender, not the authenticated caller. */
function deliveryActor(body: Record<string, any>): string {
  const sender = body.sender?.login;
  return typeof sender === "string" && sender ? sender : "github";
}

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
 * Also receives `issue_comment` events with action `created`: a new human
 * comment marks the issue's grooming result stale (#1064) so the groomer
 * revisits it without waiting for the next sync's comment check. Automation
 * comments are ignored.
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

    // GitHub's own identity for this delivery. Present on every real
    // delivery and absent only from hand-rolled replays, which is exactly the
    // distinction the lifecycle event's dedupe key needs (#1202).
    const deliveryId = request.headers.get("x-github-delivery")?.trim() || null;

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
        return authErrorResponse(auth);
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

    if (githubEvent === "issue_comment") {
      return handleIssueComment(jsonPayload as Record<string, any>);
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
    // that is absent) leaves the label set unchanged — returned as the same
    // array reference, which is what makes the identity check below exact
    // rather than a "new array means a change" test.
    const currentLabels = cachedIssue.labels;
    const nextLabels =
      action === "labeled"
        ? currentLabels.includes(labelName)
          ? currentLabels
          : [...currentLabels, labelName]
        : currentLabels.includes(labelName)
          ? currentLabels.filter((label) => label !== labelName)
          : currentLabels;

    await prisma.issue.update({
      where: { repositoryId_number: { repositoryId: repo.id, number: issueNumber } },
      data: { labels: nextLabels, lastSyncedAt: new Date() },
    });

    // A status label moving on GitHub is a transition in the lifecycle stream
    // with GitHub, not Dispatch, as its source (#1202).
    //
    // The from/to values come from the delivery's own label rather than from
    // diffing the cached label sets: GitHub fires one event per label, so a
    // status swap reaches the cache as "labeled new" while the old label is
    // still on it, and a set diff would read that as no transition at all.
    // The route's own no-op handling (adding a label that is already present,
    // removing one that is absent leaves `nextLabels` equal to `currentLabels`)
    // is what makes a repeat delivery a no-op here. The delivery id is GitHub's
    // identity for the event, so a redelivery upserts the row it already wrote
    // instead of counting as a second move.
    //
    // GitHub sends no per-label timestamp, so the issue's own updated_at
    // stands in as the occurrence time and is labelled as such in metadata —
    // the observation time is never backdated to it.
    if (labelName.startsWith("status/") && nextLabels !== currentLabels) {
      const statusUpdatedAt = parseGithubTimestamp(body.issue?.updated_at);
      const added = action === "labeled";
      await recordLifecycleEventQuietly(
        prisma,
        {
          issueId: cachedIssue.id,
          repoFullName,
          issueNumber,
          kind: "status_changed",
          source: "webhook",
          actor: deliveryActor(body),
          fromStatus: added ? lifecycleStatusLabel(currentLabels) : labelName,
          toStatus: added ? labelName : lifecycleStatusLabel(nextLabels),
          sourceEventId: deliveryId,
          dedupeKey: deliveryId
            ? lifecycleDedupeKey("webhook", repoFullName, issueNumber, deliveryId, labelName)
            : null,
          occurredAt: statusUpdatedAt,
          metadata: {
            action,
            label: labelName,
            ...(statusUpdatedAt ? { occurredAtSource: "issue.updated_at" } : {}),
          },
        },
        "issues webhook",
      );
    }

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

async function handleIssueComment(body: Record<string, any>) {
  if (body.action !== "created") {
    return NextResponse.json({ message: `Unhandled issue_comment action: ${body.action ?? "unknown"}` });
  }
  if (body.issue?.pull_request) {
    return NextResponse.json({ message: "Pull request comment, ignored" });
  }
  const repoFullName = body.repository?.full_name;
  const issueNumber = body.issue?.number;
  const author = body.comment?.user?.login;
  const createdAt = body.comment?.created_at;
  if (typeof repoFullName !== "string" || !repoFullName || typeof issueNumber !== "number") {
    return errorResponse("Missing repository.full_name or issue.number in payload", 400);
  }
  if (typeof author !== "string" || typeof createdAt !== "string") {
    return errorResponse("Missing comment.user.login or comment.created_at in payload", 400);
  }

  const repo = await prisma.repository.findUnique({ where: { fullName: repoFullName } });
  if (!repo) return NextResponse.json({ message: "Repo not tracked, ignored" });
  const cachedIssue = await prisma.issue.findUnique({
    where: { repositoryId_number: { repositoryId: repo.id, number: issueNumber } },
    select: { id: true },
  });
  if (!cachedIssue) return NextResponse.json({ message: "Issue not cached, ignored" });

  const staled = await invalidateGroomingForComment({
    issueId: cachedIssue.id,
    repoFullName,
    issueNumber,
    author,
    createdAt,
  });
  return NextResponse.json({
    message: staled
      ? `Grooming result marked stale: ${repoFullName}#${issueNumber}`
      : `Comment does not invalidate grooming: ${repoFullName}#${issueNumber}`,
    groomingStale: staled,
  });
}
