/**
 * Server-side OIDC login endpoint.
 *
 * This route sits outside the Auth.js catch-all (/api/auth/*) so that
 * the browser can navigate directly to it without hitting the `[...nextauth]`
 * wildcard which may misroute in certain deployments.
 */

import { signIn } from "@/lib/auth-next";

const DEFAULT_CALLBACK_URL = "/board";

/**
 * Validate and sanitise a callbackUrl to prevent open redirects.
 *
 * Allowed:
 *  - missing / empty -> default
 *  - relative path starting with / (e.g. /board, /board/issues)
 *
 * Rejected:
 *  - protocol-relative URLs (//evil.com)
 *  - absolute URLs (https://evil.com)
 */
function safeCallbackUrl(raw: string | null): string {
  if (!raw || raw.trim() === "") return DEFAULT_CALLBACK_URL;
  // Reject anything that looks like an external redirect.
  if (raw.startsWith("//") || /^https?:\/\//i.test(raw)) return DEFAULT_CALLBACK_URL;
  // Only allow paths that start with a single /.
  if (raw.startsWith("/")) return raw;
  return DEFAULT_CALLBACK_URL;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const callbackUrl = safeCallbackUrl(url.searchParams.get("callbackUrl"));
  return signIn("oidc", { redirectTo: callbackUrl });
}
