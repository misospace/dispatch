import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getAuthMode, isAuthorizedBasicAuth, getBasicAuthCredentials } from "@/lib/auth";

/**
 * Next.js middleware that enforces Basic Auth when DISPATCH_AUTH_MODE="basic".
 *
 * - API routes (`/api/*`) return 401 JSON for unauthenticated requests.
 * - UI pages (`/board`, `/projects`, `/agents`, `/automation`) trigger the
 *   browser's native Basic Auth dialog via a 401 response with
 *   `WWW-Authenticate` header.
 */
export function middleware(request: NextRequest) {
  const authMode = getAuthMode();

  // "disabled" mode — no enforcement
  if (authMode === "disabled") {
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
     * - api/health (health check, always public)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    "/((?!api/health|_next/static|_next/image|favicon\\.ico).*)",
  ],
};
