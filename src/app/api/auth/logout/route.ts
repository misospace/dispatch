/**
 * Logout API route for OIDC authentication.
 *
 * Clears the NextAuth session and redirects to the login page.
 */

import { signOut } from "@/lib/auth-next";
import { trustedClientIp } from "@/lib/client-ip";
import { enforceRateLimit } from "@/lib/rate-limit";
import { NextResponse } from "next/server";

// Logout is a rare, user-initiated action, so 10 per minute per client IP is
// far above real cadence. The route is intentionally unauthenticated — an
// expired session must still be able to clear its cookie — so there is no
// credential to key the window on and the limiter falls back to the client IP;
// signOut only clears the caller's own session, so an unauthenticated logout
// grants nothing. The IP comes from the shared trusted derivation (rightmost
// `X-Forwarded-For`, then `X-Real-IP`): the leftmost XFF entry is
// client-controlled, so trusting it would let an attacker rotate the bucket.
const LOGOUT_RATE_LIMIT = { limit: 10, windowMs: 60_000 } as const;

export async function POST(request: Request) {
  const limited = enforceRateLimit(
    `logout:${trustedClientIp(request.headers)}`,
    LOGOUT_RATE_LIMIT
  );
  if (limited) return limited;

  await signOut({ redirect: false });
  return NextResponse.json({ success: true });
}
