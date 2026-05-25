import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getAuthMode, isAuthorizedBasicAuth } from "@/lib/auth";

/**
 * Next.js middleware that enforces Basic Auth when DISPATCH_AUTH_MODE="basic".
 *
 * Auth mode behavior:
 * - "basic"    : HTTP Basic Auth required for all routes. API routes return 401 JSON;
 *                UI pages trigger the browser's native auth dialog via WWW-Authenticate.
 * - "oidc"     : No middleware enforcement. OIDC sessions are handled by NextAuth.
 *                Route handlers use requireSession() to gate access.
 * - "disabled" : No auth enforcement at all.
 * - undefined  : Legacy mode — no middleware enforcement; routes handle their own auth.
 */
export function middleware(request: NextRequest) {
  const authMode = getAuthMode();

  // "disabled" mode — no enforcement
  if (authMode === "disabled") {
    return NextResponse.next();
  }

  // OIDC mode — no middleware enforcement; NextAuth handles session checks via requireSession()
  if (authMode === "oidc") {
    return NextResponse.next();
  }

  // No auth mode set (legacy) — no middleware enforcement; routes handle their own auth
  if (!authMode) {
    return NextResponse.next();
  }

  // "basic" mode — enforce Basic Auth on all routes
  const authHeader = request.headers.get("authorization");
  const isBasicAuth = authHeader && /^Basic\s+/i.test(authHeader);

  if (isBasicAuth) {
    try {
      const decoded = Buffer.from(authHeader!.replace(/^Basic\s+/i, ""), "base64").toString("utf-8");
      const colonIndex = decoded.indexOf(":");
      if (colonIndex === -1) {
        return unauthorizedResponse(request);
      }
      const username = decoded.slice(0, colonIndex);
      const password = decoded.slice(colonIndex + 1);

      if (!isAuthorizedBasicAuth(username, password)) {
        return unauthorizedResponse(request);
      }
    } catch {
      return unauthorizedResponse(request);
    }

    return NextResponse.next();
  }

  // No valid Basic Auth header — reject
  return unauthorizedResponse(request);
}

/**
 * Build a 401 Unauthorized response.
 * For API routes, returns JSON. For UI pages, triggers the browser auth dialog.
 */
function unauthorizedResponse(_request: NextRequest): NextResponse {
  const response = new NextResponse(null, { status: 401 });
  response.headers.set("WWW-Authenticate", 'Basic realm="Dispatch", charset="UTF-8"');
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api/auth/* (NextAuth OIDC routes)
     * - api/health (health check, always public)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - /login (public login page)
     */
    "/((?!api/auth|api/health|_next/static|_next/image|favicon\\.ico|login).*)",
  ],
};
