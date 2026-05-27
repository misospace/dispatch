import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

type AuthMode = "basic" | "oidc" | "disabled" | undefined;

function getAuthMode(): AuthMode {
  const mode = process.env.DISPATCH_AUTH_MODE;
  if (mode === "basic" || mode === "oidc" || mode === "disabled") return mode;
  return undefined;
}

function shouldUseSecureAuthCookie(request: NextRequest): boolean {
  const authUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  if (authUrl) {
    try {
      return new URL(authUrl).protocol === "https:";
    } catch {
      return false;
    }
  }

  return request.nextUrl.protocol === "https:";
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function isBearerAuthorized(authHeader: string | null): boolean {
  const token = process.env.DISPATCH_AGENT_TOKEN;
  if (!token) return false;

  const match = /^Bearer\s+(.+)$/i.exec(authHeader ?? "");
  return match ? safeEqual(match[1].trim(), token) : false;
}

function parseBasicCredentials(authHeader: string | null): { username: string; password: string } | null {
  const match = /^Basic\s+(.+)$/i.exec(authHeader ?? "");
  if (!match) return null;

  try {
    const decoded = atob(match[1]);
    const colonIndex = decoded.indexOf(":");
    if (colonIndex === -1) return null;
    return {
      username: decoded.slice(0, colonIndex),
      password: decoded.slice(colonIndex + 1),
    };
  } catch {
    return null;
  }
}

function isBasicAuthorized(authHeader: string | null): boolean {
  const expectedUsername = process.env.DISPATCH_AUTH_USERNAME;
  const expectedPassword = process.env.DISPATCH_AUTH_PASSWORD;
  if (!expectedUsername || !expectedPassword) return false;

  const credentials = parseBasicCredentials(authHeader);
  return Boolean(
    credentials &&
    safeEqual(credentials.username, expectedUsername) &&
    safeEqual(credentials.password, expectedPassword)
  );
}

/**
 * Next.js middleware that enforces Basic Auth when DISPATCH_AUTH_MODE="basic".
 *
 * Auth mode behavior:
 * - "basic"    : HTTP Basic Auth required for UI routes. API routes also allow
 *                DISPATCH_AGENT_TOKEN Bearer auth for agents and workers.
 * - "oidc"     : OIDC session required for UI routes. API routes authorize via
 *                route handlers so Bearer auth and session cookies both work.
 * - "disabled" : No auth enforcement at all.
 * - undefined  : Legacy mode — no middleware enforcement; routes handle their own auth.
 */
export async function middleware(request: NextRequest) {
  const authMode = getAuthMode();
  const isApiRoute = request.nextUrl.pathname.startsWith("/api/");

  // "disabled" mode — no enforcement
  if (authMode === "disabled") {
    return NextResponse.next();
  }

  if (authMode === "oidc") {
    if (isApiRoute) {
      return NextResponse.next();
    }

    const token = await getToken({
      req: request,
      secret: process.env.NEXTAUTH_SECRET,
      secureCookie: shouldUseSecureAuthCookie(request),
    });
    if (token) {
      return NextResponse.next();
    }

    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }

  // No auth mode set (legacy) — no middleware enforcement; routes handle their own auth
  if (!authMode) {
    return NextResponse.next();
  }

  const authHeader = request.headers.get("authorization");

  if (isApiRoute && (isBearerAuthorized(authHeader) || isBasicAuthorized(authHeader))) {
    return NextResponse.next();
  }

  // "basic" mode — enforce Basic Auth on operator UI routes
  if (isBasicAuthorized(authHeader)) {
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
