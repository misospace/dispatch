/**
 * Shared authentication helpers for Dispatch.
 *
 * Supports two auth modes (controlled by DISPATCH_AUTH_MODE):
 *   - "basic"    : HTTP Basic Auth for operator/browser UI access
 *   - "disabled" : No auth enforcement (full open access)
 *
 * When DISPATCH_AUTH_MODE is not set, the legacy behavior is preserved:
 * Bearer token auth via DISPATCH_AGENT_TOKEN is used for route-level checks.
 *
 * All mutating routes should use `isAuthorized(request)` instead of
 * duplicating auth parsing logic. The middleware enforces Basic Auth at
 * the request level when DISPATCH_AUTH_MODE="basic".
 */

import { getAcceptedAgentTokens, isAuthorizedBearerToken as _isAuthed, resetCaches as _resetEnvCaches } from "./dispatch-env";
import { timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Auth mode resolution
// ---------------------------------------------------------------------------

let _cachedAuthMode: "basic" | "disabled" | undefined;

/**
 * Resolve the authentication mode.
 *
 * - "basic"    : Require HTTP Basic Auth for all requests
 * - "disabled" : No auth enforcement (open access)
 * - undefined  : Legacy mode — no middleware enforcement; routes use Bearer token checks
 */
export function getAuthMode(): "basic" | "disabled" | undefined {
  if (_cachedAuthMode !== undefined) return _cachedAuthMode;

  const mode = process.env.DISPATCH_AUTH_MODE;
  if (mode === "basic") {
    _cachedAuthMode = "basic";
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

/**
 * Compare two strings using a constant-time algorithm to prevent timing attacks.
 * Returns true if the strings are equal, false otherwise.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return timingSafeEqual(aBuf, bBuf);
}

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

/**
 * Check if a request is authorized.
 *
 * In "basic" mode: only Basic Auth credentials are accepted.
 * In default/legacy mode: Bearer token via DISPATCH_AGENT_TOKEN is accepted.
 * In "disabled" mode: all requests are authorized.
 *
 * This function is safe to call from both middleware and route handlers.
 */
export function isAuthorized(request: Request): boolean {
  const authMode = getAuthMode();

  // Disabled mode — allow everything
  if (authMode === "disabled") return true;

  // Basic auth mode — only accept Basic Auth credentials
  if (authMode === "basic") {
    const parsed = parseAuthorizationHeader(request.headers.get("authorization"));
    if (!parsed || parsed.type !== "basic") return false;
    return isAuthorizedBasicAuth(parsed.username, parsed.password);
  }

  // Legacy mode — accept Bearer token
  const bearerToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return isAuthorizedBearerToken(bearerToken);
}

/**
 * Type-safe version of isAuthorized that also returns the parsed auth info.
 */
export function authenticateRequest(request: Request):
  | { authorized: true; type: "basic"; username: string }
  | { authorized: true; type: "bearer" }
  | { authorized: false } {
  const authMode = getAuthMode();

  // Disabled mode — allow everything as bearer (no-op, just for type safety)
  if (authMode === "disabled") return { authorized: true, type: "bearer" };

  // Basic auth mode
  if (authMode === "basic") {
    const parsed = parseAuthorizationHeader(request.headers.get("authorization"));
    if (!parsed || parsed.type !== "basic") return { authorized: false };
    if (!isAuthorizedBasicAuth(parsed.username, parsed.password)) {
      return { authorized: false };
    }
    return { authorized: true, type: "basic", username: parsed.username };
  }

  // Legacy mode — Bearer token
  const bearerToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!isAuthorizedBearerToken(bearerToken)) return { authorized: false };
  return { authorized: true, type: "bearer" };
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
