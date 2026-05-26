/**
 * Server-side OIDC login endpoint.
 *
 * This route sits outside the Auth.js catch-all (/api/auth/*) so that
 * the browser can navigate directly to it without hitting the `[...nextauth]`
 * wildcard which may misroute in certain deployments.
 */

import { signIn } from "@/lib/auth-next";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const callbackUrl = url.searchParams.get("callbackUrl") || "/board";
  return signIn("oidc", { redirectTo: callbackUrl });
}
