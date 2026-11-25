import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextResponse } from "next/server";
import { errorResponse } from "./api-errors";
import { authorizeRequest, authErrorResponse } from "./auth";
import { enforceRateLimit } from "./rate-limit";

/**
 * Shared GitHub webhook signature verification.
 *
 * Used by the inbound webhook routes (pr-followup, issues) to decide how to
 * authenticate a delivery and to validate its X-Hub-Signature-256 header.
 *
 * Signature verification: validates X-Hub-Signature-256 using HMAC-SHA256
 * with the WEBHOOK_SECRET environment variable.
 *
 * Default behavior is fail-closed: if WEBHOOK_SECRET is not configured,
 * requests are rejected (503) unless WEBHOOK_GATEWAY_MODE is explicitly set to "true",
 * which indicates the endpoint is behind a gateway that performs its own
 * authentication and signature verification.
 *
 * `authenticateWebhookDelivery` below owns the whole route-level wiring
 * (mode selection, HMAC verification, the authorizeRequest fallback, actor
 * resolution, and the rate-limit bucket) so the two inbound webhook routes
 * cannot drift apart: a change to webhook auth is made in one place.
 */

/**
 * Resolve the signature verification mode and the secret it needs.
 *
 * The secret is read exactly once here, so the mode and the HMAC key can
 * never disagree (a mid-request environment change can no longer leave the
 * caller hashing with an undefined key).
 *
 * - "verify": WEBHOOK_SECRET is set — verify HMAC-SHA256 signature
 * - "skip": WEBHOOK_GATEWAY_MODE is "true" — skip verification (behind API gateway)
 * - "reject": neither configured — fail-closed, reject all requests
 */
function resolveSignatureVerification():
  | { mode: "verify"; secret: string }
  | { mode: "skip" }
  | { mode: "reject" } {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) return { mode: "verify", secret };
  if (process.env.WEBHOOK_GATEWAY_MODE === "true") return { mode: "skip" };
  // Fail-closed: reject requests when neither WEBHOOK_SECRET nor WEBHOOK_GATEWAY_MODE is configured
  return { mode: "reject" };
}

/**
 * Determine signature verification mode.
 *
 * - "verify": WEBHOOK_SECRET is set — verify HMAC-SHA256 signature
 * - "skip": WEBHOOK_GATEWAY_MODE is "true" — skip verification (behind API gateway)
 * - "reject": neither configured — fail-closed, reject all requests
 */
export function getSignatureVerificationMode(): "verify" | "skip" | "reject" {
  return resolveSignatureVerification().mode;
}

/**
 * Verify an X-Hub-Signature-256 header value against the raw request payload.
 * Returns false for any malformed signature prefix.
 */
export function verifyWebhookSignature(secret: string, payload: Buffer, signature: string): boolean {
  if (!signature.startsWith("sha256=")) return false;
  const expected = signature.slice(7);
  const hmac = createHmac("sha256", secret);
  hmac.update(payload);
  const computed = hmac.digest("hex");

  // Constant-time comparison; timingSafeEqual requires equal-length buffers
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(computed), Buffer.from(expected));
}

/** Rate-limit policy shared by every inbound webhook route. */
const WEBHOOK_RATE_LIMIT = { limit: 30, windowMs: 10_000 } as const;

/**
 * Upper bound on the delivery-GUID segment of a rate-limit key (#1698).
 * GitHub sends a UUID; the cap only stops a secret-holding client from
 * inflating limiter memory with oversized header values.
 */
const DELIVERY_GUID_MAX_LENGTH = 128;

/**
 * Result of authenticating an inbound webhook delivery.
 *
 * On success the resolved `actor` keys the delivery's rate-limit bucket: in
 * verify mode it is the GitHub delivery GUID (`delivery:<guid>`) or the
 * shared `webhook` fallback when no usable GUID header is present; in
 * gateway mode it is the credential-derived throttle key. On failure
 * `response` is the ready-to-send error response the route should return
 * verbatim.
 */
export type WebhookDeliveryAuthentication =
  | { authenticated: true; actor: string }
  | { authenticated: false; response: NextResponse<{ error: string }> };

/**
 * Authenticate an inbound webhook delivery.
 *
 * This is the single owner of the webhook authentication path:
 *
 * - Signature-mode selection, fail-closed by default: when neither
 *   WEBHOOK_SECRET nor WEBHOOK_GATEWAY_MODE is configured the delivery is
 *   rejected with 503.
 * - HMAC verification of the `x-hub-signature-256` header against the raw
 *   payload, rejected with 401 when the header is missing or invalid.
 * - The `authorizeRequest` fallback: when WEBHOOK_SECRET is configured a
 *   valid HMAC signature is treated as sufficient authentication for the
 *   webhook (it matches GitHub's delivery shape, which carries no
 *   Authorization header), so `authorizeRequest` is skipped to let
 *   signature-only GitHub deliveries through in oidc/legacy/basic auth
 *   modes. In every other mode the normal auth layer still applies.
 * - Actor resolution and the per-route rate-limit bucket. In verify mode
 *   the bucket is keyed per delivery (see `verifiedDeliveryActor`, #1698):
 *   every HMAC-verified delivery sharing one bucket throttled legitimate
 *   GitHub delivery bursts at 30/10s. Gateway mode keeps the per-credential
 *   bucket.
 *
 * `payload` must be the raw request body bytes, read before this call:
 * `authorizeRequest` may consume the body stream, so the HMAC check has to
 * operate on a payload the route already buffered.
 *
 * `rateLimitKeyPrefix` is the route's bucket name (for example
 * "issues-webhook"); the resolved actor is appended to it.
 */
export async function authenticateWebhookDelivery(
  request: Request,
  payload: Buffer,
  rateLimitKeyPrefix: string,
): Promise<WebhookDeliveryAuthentication> {
  const verification = resolveSignatureVerification();
  if (verification.mode === "reject") {
    return {
      authenticated: false,
      response: errorResponse(
        "Webhook signature verification is not configured. Set WEBHOOK_SECRET or enable WEBHOOK_GATEWAY_MODE.",
        503,
      ),
    };
  }

  if (verification.mode === "verify") {
    const signature = request.headers.get("x-hub-signature-256");
    if (!signature) {
      return {
        authenticated: false,
        response: errorResponse("Missing x-hub-signature-256 header", 401),
      };
    }
    if (!verifyWebhookSignature(verification.secret, payload, signature)) {
      return {
        authenticated: false,
        response: errorResponse("Invalid webhook signature", 401),
      };
    }
  }

  // In verify mode the HMAC check above is the authentication gate, so
  // authorizeRequest is skipped and the bucket is keyed per delivery
  // (#1698). Otherwise the normal auth layer decides the throttle key.
  let actor: string;
  if (verification.mode === "verify") {
    actor = verifiedDeliveryActor(request);
  } else {
    const auth = await authorizeRequest(request);
    if (!auth.authorized) {
      return { authenticated: false, response: authErrorResponse(auth) };
    }
    actor = auth.throttleKey;
  }

  const limited = enforceRateLimit(`${rateLimitKeyPrefix}:${actor}`, { ...WEBHOOK_RATE_LIMIT });
  if (limited) return { authenticated: false, response: limited };

  return { authenticated: true, actor };
}

/**
 * Rate-limit actor for an HMAC-verified delivery (#1698).
 *
 * Keying every verified delivery on the constant "webhook" put them all in
 * one 30/10s bucket, so a legitimate GitHub burst — one delivery per event
 * during an automation storm across many issues on a tracked repo — was
 * throttled. Key the bucket on the `x-github-delivery` GUID instead: GitHub
 * sends one GUID per delivery and reuses it for redeliveries, so distinct
 * deliveries each get room while a same-GUID replay flood stays throttled
 * together. Downstream idempotency (#1220/#1202 delivery identity) already
 * dedupes replays, so per-GUID capacity is safe to spend.
 *
 * The GUID header is not covered by the HMAC (GitHub signs only the body),
 * but reaching this limiter in verify mode already required the secret, so
 * per-GUID capacity only widens a sender that is trusted by construction.
 * A verified delivery without a usable GUID is not shaped like a real
 * GitHub delivery: it keeps the old shared "webhook" bucket, so GUID-less
 * senders stay throttled together.
 */
function verifiedDeliveryActor(request: Request): string {
  const guid = request.headers.get("x-github-delivery")?.trim() ?? "";
  if (!guid || guid.length > DELIVERY_GUID_MAX_LENGTH) return "webhook";
  return `delivery:${guid}`;
}
