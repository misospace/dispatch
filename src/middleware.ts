import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { safeEqual } from "@/lib/dispatch-env";
import { enforceRateLimit, resetRateLimitKey } from "@/lib/rate-limit";

type AuthMode = "basic" | "oidc" | "disabled" | undefined;

// Static security headers applied to all responses. The CSP is dynamic (it
// carries a per-request nonce) and is set separately in applySecurityHeaders.
const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

// CSP template. `script-src 'self'` alone blocks every inline <script> —
// including the App Router's own RSC flight payload (the self.__next_f
// scripts the framework injects at render time), which kills hydration on
// every page, not just the theme initialiser (dispatch#841). The per-request
// nonce is the escape hatch for those scripts; see applySecurityHeaders.
const CSP_TEMPLATE =
  "default-src 'self'; script-src 'self' 'nonce-__NONCE__'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

/**
 * Secret for the deterministic CSP nonce, stable for the process lifetime.
 *
 * DISPATCH_CSP_NONCE_SECRET is preferred (survives process restarts);
 * NEXTAUTH_SECRET is a reasonable fallback (already required for the oidc
 * auth mode); otherwise a random per-process value is generated. The nonce
 * only needs to be stable across the proxy passes of a single request — see
 * generateCspNonce for why a per-process value is sufficient in practice.
 */
const CSP_NONCE_SECRET: string = (() => {
  const envSecret = process.env.DISPATCH_CSP_NONCE_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (envSecret) return envSecret;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
})();

/**
 * Generate the CSP nonce for this request.
 *
 * The nonce is an HMAC-SHA256 digest over the request identity (method +
 * path + query), NOT a fresh random value per invocation. That is because
 * Next 16 invokes the proxy (middleware) several times for a single document
 * request, each pass seeing the original incoming request — a fresh random
 * nonce per pass yields several response CSP headers with different nonces,
 * and the browser intersects them: the flight scripts carry only the last
 * pass's nonce and are still blocked. A deterministic nonce makes every pass
 * of the same request compute the identical value (verified against a
 * production build of this repo: 4 proxy passes, 4 identical headers, and
 * the framework stamps that nonce on every inline script it emits).
 *
 * Security note: this means the nonce for a given URL is stable until the
 * secret changes. That is not a practical downgrade here: responses are
 * `no-cache, must-revalidate` (no shared-cache poisoning vector), an
 * attacker who can tamper with a response in transit can read the nonce from
 * its CSP header whether it is random or not, and inline event handlers
 * (the usual XSS shape) cannot carry nonces at all. What the nonce buys is
 * letting the framework's own scripts through while `script-src 'self'`
 * still blocks every nonce-less inline script.
 *
 * Uses Web Crypto because the proxy runs in the Edge runtime, where
 * node:crypto is unavailable (verified: importing it makes the proxy fail
 * to load and every page 500s).
 */
async function generateCspNonce(request: NextRequest): Promise<string> {
  const material = `${request.method}\n${request.nextUrl.pathname}\n${request.nextUrl.search}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(CSP_NONCE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(material));
  const bytes = new Uint8Array(signature).slice(0, 16);
  return btoa(String.fromCharCode(...bytes));
}

async function applySecurityHeaders(request: NextRequest, response: NextResponse): Promise<void> {
  const nonce = await generateCspNonce(request);

  // The policy the browser enforces: same-origin scripts plus this request's
  // nonce. Our own page markup carries no inline scripts (the theme
  // initialiser is a static file, see src/app/layout.tsx); the nonce exists
  // for the framework's inline scripts.
  response.headers.set("Content-Security-Policy", CSP_TEMPLATE.replace("__NONCE__", nonce));

  // The nonce the framework's own inline scripts will carry. Next's App
  // Router reads a nonce from the *incoming request's* content-security-policy
  // header and stamps it onto the inline scripts it emits itself (the RSC
  // flight payload, the preinit script) — see parseRequestHeaders /
  // getScriptNonceFromHeader in next/dist/server/app-render. Without this
  // header those scripts are emitted without a nonce and script-src 'self'
  // blocks them, so hydration fails regardless of our own markup. This is
  // the same pattern Next documents for edge proxies that set the CSP; the
  // proxy just plays the proxy's role in-process.
  request.headers.set("content-security-policy", `script-src 'nonce-${nonce}'`);

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
    await applySecurityHeaders(request, response);
    return response;
  }

  if (authMode === "oidc") {
    if (isApiRoute) {
      const response = NextResponse.next();
      await applySecurityHeaders(request, response);
      return response;
    }

    const token = await getToken({
      req: request,
      secret: process.env.NEXTAUTH_SECRET,
      secureCookie: shouldUseSecureAuthCookie(request),
    });
    if (token) {
      const response = NextResponse.next();
      await applySecurityHeaders(request, response);
      return response;
    }

    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", request.nextUrl.pathname + request.nextUrl.search);
    const redirectResponse = NextResponse.redirect(loginUrl);
    await applySecurityHeaders(request, redirectResponse);
    return redirectResponse;
  }

  // No auth mode set (legacy) — no middleware enforcement; routes handle their own auth
  if (!authMode) {
    const response = NextResponse.next();
    await applySecurityHeaders(request, response);
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
    await applySecurityHeaders(request, response);
    return response;
  }

  const authHeader = request.headers.get("authorization");

  // "basic" mode — enforce Basic Auth. Basic is checked before Bearer so that
  // a successful password authentication resets the rate-limit counter on any
  // route (UI or API), and so that a syntactically valid Basic attempt with
  // a wrong password is the only thing counted toward the lockout. Bearer is
  // retained as the API-route credential (DISPATCH_AGENT_TOKEN) for agents
  // and workers that do not speak Basic.
  if (isBasicAuthorized(authHeader)) {
    resetRateLimitKey(`basic-auth:${clientIp(request)}`);
    const response = NextResponse.next();
    await applySecurityHeaders(request, response);
    return response;
  }

  if (isApiRoute && isBearerAuthorized(authHeader)) {
    const response = NextResponse.next();
    await applySecurityHeaders(request, response);
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
      await applySecurityHeaders(request, lockedResponse);
      return lockedResponse;
    }
  }

  // No valid credentials — reject
  const unauthorizedResp = unauthorizedResponse(request);
  await applySecurityHeaders(request, unauthorizedResp);
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
