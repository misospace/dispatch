import { createHmac, timingSafeEqual } from "node:crypto";

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
 */

/**
 * Determine signature verification mode.
 *
 * - "verify": WEBHOOK_SECRET is set — verify HMAC-SHA256 signature
 * - "skip": WEBHOOK_GATEWAY_MODE is "true" — skip verification (behind API gateway)
 * - "reject": neither configured — fail-closed, reject all requests
 */
export function getSignatureVerificationMode(): "verify" | "skip" | "reject" {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) return "verify";
  if (process.env.WEBHOOK_GATEWAY_MODE === "true") return "skip";
  // Fail-closed: reject requests when neither WEBHOOK_SECRET nor WEBHOOK_GATEWAY_MODE is configured
  return "reject";
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
