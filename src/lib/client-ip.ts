/**
 * Trusted client-IP derivation shared by the middleware Basic-auth limiter
 * and the unauthenticated logout limiter.
 *
 * Prefer the rightmost `X-Forwarded-For` entry because Envoy Gateway appends
 * the observed peer address to the right of the chain rather than replacing
 * the header. The leftmost entry is whatever the client sent, so an attacker
 * rotating it would evade a per-IP bucket — taking the last hop discards the
 * attacker-controlled portion. Fall back to `X-Real-IP` (which Envoy also
 * sets to the peer address) when the chain is absent, and finally the literal
 * string `"unknown"`. The `unknown` bucket is only reachable when no proxy
 * header arrives at all (e.g. in-cluster or port-forward in dev); under the
 * gateway every request has at least one of the two headers set, so it is a
 * coarse but safe last resort rather than an attacker-controllable bypass.
 */
export function trustedClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const last = forwarded.split(",").pop()?.trim();
    if (last) return last;
  }
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "unknown";
}
