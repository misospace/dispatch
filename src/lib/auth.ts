/**
 * Shared authentication helpers for Dispatch.
 *
 * Supports four auth modes (controlled by DISPATCH_AUTH_MODE):
 *   - "basic"    : HTTP Basic Auth for operator/browser UI access
 *   - "oidc"     : OIDC provider authentication with session cookies
 *   - "disabled" : No auth enforcement (full open access)
 *
 * When DISPATCH_AUTH_MODE is not set, the legacy behavior is preserved:
 * Bearer token auth via DISPATCH_AGENT_TOKEN is used for route-level checks.
 *
 * All mutating routes should use `authorizeRequest(request)` instead of
 * duplicating auth parsing logic. The middleware protects operator UI routes;
 * route handlers authorize API access for browsers and agents.
 */

import { isAuthorizedBearerToken as _isAuthed, resetCaches as _resetEnvCaches, safeEqual } from "./dispatch-env";

// ---------------------------------------------------------------------------
// Auth mode resolution
// ---------------------------------------------------------------------------

let _cachedAuthMode: "basic" | "oidc" | "disabled" | undefined;

/**
 * Resolve the authentication mode.
 *
 * - "basic"    : Require HTTP Basic Auth for all requests
 * - "oidc"     : OIDC session-based auth (enforced by NextAuth, not middleware)
 * - "disabled" : No auth enforcement (open access)
 * - undefined  : Legacy mode — no middleware enforcement; routes use Bearer token checks
 */
export function getAuthMode(): "basic" | "oidc" | "disabled" | undefined {
  if (_cachedAuthMode !== undefined) return _cachedAuthMode;

  const mode = process.env.DISPATCH_AUTH_MODE;
  if (mode === "basic") {
    _cachedAuthMode = "basic";
  } else if (mode === "oidc") {
    _cachedAuthMode = "oidc";
  } else if (mode === "disabled") {
    _cachedAuthMode = "disabled";
  } else {
    _cachedAuthMode = undefined;
  }

  return _cachedAuthMode;
}

// ---------------------------------------------------------------------------
// Basic Auth credential resolution
// ---------------------------------------------------------------------------

let _cachedBasicUser: string | undefined;
let _cachedBasicPass: string | undefined;

/**
 * Resolve Basic Auth credentials from environment variables.
 * Returns null if either DISPATCH_AUTH_USERNAME or DISPATCH_AUTH_PASSWORD is not set.
 */
export function getBasicAuthCredentials(): { username: string; password: string } | null {
  const user = process.env.DISPATCH_AUTH_USERNAME;
  const pass = process.env.DISPATCH_AUTH_PASSWORD;

  if (!user || !pass) return null;

  return { username: user, password: pass };
}

// ---------------------------------------------------------------------------
// Authorization header parsing
// ---------------------------------------------------------------------------

/** Parsed authorization header result. */
export type AuthResult =
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | null;

/**
 * Parse an Authorization header value into a typed result.
 * Handles both Bearer and Basic schemes (case-insensitive).
 */
export function parseAuthorizationHeader(
  authHeaderValue: string | null,
): AuthResult {
  if (!authHeaderValue) return null;

  // Bearer token
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeaderValue);
  if (bearerMatch) {
    return { type: "bearer", token: bearerMatch[1].trim() };
  }

  // Basic auth
  const basicMatch = /^Basic\s+(.+)$/i.exec(authHeaderValue);
  if (basicMatch) {
    try {
      const decoded = Buffer.from(basicMatch[1], "base64").toString("utf-8");
      const colonIndex = decoded.indexOf(":");
      if (colonIndex === -1) return null;

      const username = decoded.slice(0, colonIndex);
      const password = decoded.slice(colonIndex + 1);
      return { type: "basic", username, password };
    } catch {
      return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Basic Auth authorization
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Bearer token authorization (delegates to dispatch-env)
// ---------------------------------------------------------------------------

/**
 * Check if a bearer token is authorized. Delegates to dispatch-env.
 */
export function isAuthorizedBearerToken(token: string | null | undefined): boolean {
  return _isAuthed(token);
}

// ---------------------------------------------------------------------------
// Basic Auth authorization
// ---------------------------------------------------------------------------

/**
 * Check if Basic Auth credentials are valid.
 */
export function isAuthorizedBasicAuth(username: string, password: string): boolean {
  const creds = getBasicAuthCredentials();
  if (!creds) return false;

  return safeEqual(creds.username, username) && safeEqual(creds.password, password);
}

// ---------------------------------------------------------------------------
// Unified authorization entry point
// ---------------------------------------------------------------------------

export type AuthorizedRequest =
  | { authorized: true; type: "basic"; username: string; actor: string }
  | { authorized: true; type: "bearer"; actor: string }
  | { authorized: true; type: "oidc"; actor: string }
  | { authorized: true; type: "disabled"; actor: string }
  | { authorized: false };

/**
 * Check header-based auth (Bearer / Basic) and return the parsed auth info.
 */
export function authenticateRequest(request: Request):
  | { authorized: true; type: "basic"; username: string }
  | { authorized: true; type: "bearer" }
  | { authorized: false } {
  const authMode = getAuthMode();

  // Disabled mode — allow everything as bearer (no-op, just for type safety)
  if (authMode === "disabled") return { authorized: true, type: "bearer" };

  const parsed = parseAuthorizationHeader(request.headers.get("authorization"));

  if (parsed?.type === "bearer" && isAuthorizedBearerToken(parsed.token)) {
    return { authorized: true, type: "bearer" };
  }

  // OIDC mode — route handlers must call authorizeRequest for session cookies
  if (authMode === "oidc") return { authorized: false };

  // Basic auth mode
  if (authMode === "basic") {
    if (!parsed || parsed.type !== "basic") return { authorized: false };
    if (!isAuthorizedBasicAuth(parsed.username, parsed.password)) {
      return { authorized: false };
    }
    return { authorized: true, type: "basic", username: parsed.username };
  }

  // Legacy mode — Bearer token
  return { authorized: false };
}

function resolveBearerActor(request: Request): string {
  return request.headers.get("x-agent-name")?.trim() || "agent";
}

function resolveSessionActor(user: { email?: string | null; name?: string | null } | undefined): string {
  return user?.email?.trim() || user?.name?.trim() || "operator";
}

/**
 * Authorize a route handler request and return the authenticated actor.
 *
 * Accepts:
 * - valid DISPATCH_AGENT_TOKEN Bearer auth in basic, oidc, and legacy modes
 * - valid Basic Auth operator credentials in basic mode
 * - valid NextAuth/OIDC session cookies in oidc mode
 */
export async function authorizeRequest(request: Request): Promise<AuthorizedRequest> {
  const authMode = getAuthMode();

  if (authMode === "disabled") {
    return { authorized: true, type: "disabled", actor: "operator" };
  }

  const headerAuth = authenticateRequest(request);
  if (headerAuth.authorized) {
    if (headerAuth.type === "basic") {
      return { ...headerAuth, actor: headerAuth.username };
    }
    return { ...headerAuth, actor: resolveBearerActor(request) };
  }

  if (authMode === "oidc") {
    const { auth } = await import("@/lib/auth-next");
    const session = await auth();
    if (session?.user) {
      return { authorized: true, type: "oidc", actor: resolveSessionActor(session.user) };
    }
  }

  return { authorized: false };
}

export function getAuthorizedActor(
  auth: AuthorizedRequest,
  request: Request,
  fallback?: unknown,
): string {
  if (!auth.authorized) return "unknown";
  if (auth.type === "basic" || auth.type === "oidc" || auth.type === "disabled") {
    return auth.actor;
  }
  return (typeof fallback === "string" && fallback.trim()) || resolveBearerActor(request);
}

/**
 * Authorize a request for the hosted groomer route.
 * Accepts standard auth (agent token, basic, oidc) OR the dedicated groomer token.
 */
export async function authorizeGroomerRequest(request: Request): Promise<AuthorizedRequest> {
  const standard = await authorizeRequest(request);
  if (standard.authorized) return standard;

  const token = process.env.DISPATCH_GROOMER_TOKEN?.trim();
  if (!token) return { authorized: false };

  const parsed = parseAuthorizationHeader(request.headers.get("authorization"));
  if (parsed?.type === "bearer" && safeEqual(parsed.token, token)) {
    return { authorized: true, type: "bearer", actor: "hosted-groomer-scheduler" };
  }
  return { authorized: false };
}

// ---------------------------------------------------------------------------
// Cache reset (for testing)
// ---------------------------------------------------------------------------

/**
 * Reset all internal auth caches. Intended for test isolation — call in beforeEach.
 */
export function resetAuthCaches(): void {
  _cachedAuthMode = undefined;
  // Also reset dispatch-env token cache since auth delegates to it
  _resetEnvCaches();
}
