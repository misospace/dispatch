import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { safeEqual } from "@/lib/dispatch-env";
import { enforceRateLimit, resetRateLimitKey } from "@/lib/rate-limit";

type AuthMode = "basic" | "oidc" | "disabled" | undefined;

// Security headers applied to all responses
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

function applySecurityHeaders(response: NextResponse): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }
}

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
 * Rate limit for failed Basic-auth attempts per source IP. Five attempts per
 * minute. With this, an exposed instance can be brute-forced at most five
 * guesses per minute per IP before being locked out, and a successful auth
 * resets the counter. The limiter is in-memory and per-instance; see the
 * Operational Notes section of the README for the implications under
 * horizontal scaling.
 */
const BASIC_AUTH_RATE_LIMIT = { limit: 5, windowMs: 60_000 };

/**
 * Extract the source IP for rate limiting. Prefer the rightmost entry of
 * `X-Forwarded-For` because Envoy Gateway appends the observed peer address
 * to the right of the chain rather than replacing the header. The leftmost
 * entry is whatever the client sent, so an attacker rotating it would evade
 * the per-IP bucket — taking the last hop discards the attacker-controlled
 * portion. Fall back to `X-Real-IP` (which Envoy also sets to the peer
 * address) when the chain is absent, and finally to the literal string
 * `"unknown"`. The unknown bucket is only reachable when no proxy header
 * arrives at all (e.g. in-cluster or port-forward in dev); under a gateway
 * the request always has one of the two headers set, so it is a coarse but
 * safe last resort rather than an attacker-controllable bypass.
 */
function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const last = forwarded.split(",").pop()?.trim();
    if (last) return last;
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "unknown";
}

/**
 * True when the request carries a syntactically valid Basic credential pair
 * (decoded username:password) — i.e. it is an actual Basic-auth attempt
 * rather than a Bearer call or an unauthenticated hit. Only such attempts
 * count toward the rate-limit tally; the browser's first unauthenticated
 * request to a guarded page is excluded by this filter so that an honest
 * user loading the page does not burn a failure against their own IP.
 */
function isBasicAttempt(authHeader: string | null): boolean {
  return parseBasicCredentials(authHeader) !== null;
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
    const response = NextResponse.next();
    applySecurityHeaders(response);
    return response;
  }

  if (authMode === "oidc") {
    if (isApiRoute) {
      const response = NextResponse.next();
      applySecurityHeaders(response);
      return response;
    }

    const token = await getToken({
      req: request,
      secret: process.env.NEXTAUTH_SECRET,
      secureCookie: shouldUseSecureAuthCookie(request),
    });
    if (token) {
      const response = NextResponse.next();
      applySecurityHeaders(response);
      return response;
    }

    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", request.nextUrl.pathname + request.nextUrl.search);
    const redirectResponse = NextResponse.redirect(loginUrl);
    applySecurityHeaders(redirectResponse);
    return redirectResponse;
  }

  // No auth mode set (legacy) — no middleware enforcement; routes handle their own auth
  if (!authMode) {
    const response = NextResponse.next();
    applySecurityHeaders(response);
    return response;
  }

  // The GitHub PR-followup webhook authenticates via HMAC signature when
  // WEBHOOK_SECRET is configured. GitHub's delivery shape carries no
  // Authorization header, so we must let the request reach the route handler
  // (which performs the signature check) instead of rejecting it here in
  // basic mode. Without this exemption, direct GitHub deliveries always 401
  // before the signature is ever checked. See issue #761.
  if (request.nextUrl.pathname.startsWith("/api/pr-followup/webhook") && process.env.WEBHOOK_SECRET) {
    const response = NextResponse.next();
    applySecurityHeaders(response);
    return response;
  }

  const authHeader = request.headers.get("authorization");

  // "basic" mode — enforce Basic Auth. Basic is checked before Bearer so that
  // a successful password authentication resets the rate-limit counter on any
  // route (UI or API), and so that a syntactically valid Basic attempt with a
  // wrong password is the only thing counted toward the lockout. Bearer is
  // retained as the API-route credential (DISPATCH_AGENT_TOKEN) for agents
  // and workers that do not speak Basic.
  if (isBasicAuthorized(authHeader)) {
    resetRateLimitKey(`basic-auth:${clientIp(request)}`);
    const response = NextResponse.next();
    applySecurityHeaders(response);
    return response;
  }

  if (isApiRoute && isBearerAuthorized(authHeader)) {
    const response = NextResponse.next();
    applySecurityHeaders(response);
    return response;
  }

  // A request with a syntactically valid Basic credential pair but the wrong
  // password is the only thing we count toward the lockout — a missing
  // header, a malformed header, or a Bearer-only call does not burn a
  // failure against the source IP.
  if (isBasicAttempt(authHeader)) {
    const ip = clientIp(request);
    const lockedResponse = enforceRateLimit(`basic-auth:${ip}`, BASIC_AUTH_RATE_LIMIT);
    if (lockedResponse) {
      applySecurityHeaders(lockedResponse);
      return lockedResponse;
    }
  }

  // No valid credentials — reject
  const unauthorizedResp = unauthorizedResponse(request);
  applySecurityHeaders(unauthorizedResp);
  return unauthorizedResp;
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
