/**
 * Dispatch environment variable resolution.
 *
 * Supported env vars: DISPATCH_URL, DISPATCH_AGENT_TOKEN, DISPATCH_AGENT_NAME,
 *                     DATABASE_URL, DISPATCH_DATABASE_URL, DISPATCH_AUTH_MODE,
 *                     DISPATCH_AUTH_USERNAME, DISPATCH_AUTH_PASSWORD
 */

import { timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------

let _cachedUrl: string | undefined;

/**
 * Resolve the Dispatch instance URL.
 *
 * Resolution order:
 * 1. DISPATCH_URL (preferred)
 */
export function getDispatchUrl(): string | undefined {
  if (_cachedUrl !== undefined) return _cachedUrl;

  const url = process.env.DISPATCH_URL;
  _cachedUrl = url ? url.replace(/\/+$/, "") : undefined;
  return _cachedUrl;
}

// ---------------------------------------------------------------------------
// Agent token resolution (outbound / client-side)
// ---------------------------------------------------------------------------

let _cachedToken: string | undefined;

/**
 * Resolve the agent bearer token for outbound calls.
 *
 * Resolution order:
 * 1. DISPATCH_AGENT_TOKEN
 */
export function getDispatchAgentToken(): string | undefined {
  if (_cachedToken !== undefined) return _cachedToken;

  _cachedToken = process.env.DISPATCH_AGENT_TOKEN;
  return _cachedToken;
}

// ---------------------------------------------------------------------------
// Agent name resolution (default identity for MCP clients)
// ---------------------------------------------------------------------------

let _cachedAgentName: string | undefined;

/**
 * Resolve the default agent name used when MCP tools do not receive an explicit
 * `agentName` argument.
 *
 * This prevents models from inventing poor identities like "Dispatch MCP" when
 * claiming work. Callers should set this to a stable operator identity such as
 * `jory-opencode`.
 *
 * Resolution order:
 * 1. DISPATCH_AGENT_NAME
 *
 * Returns undefined if not configured — callers must then require an explicit
 * agentName argument.
 */
export function getDispatchAgentName(): string | undefined {
  if (_cachedAgentName !== undefined) return _cachedAgentName;

  const name = process.env.DISPATCH_AGENT_NAME;
  _cachedAgentName = name || undefined;
  return _cachedAgentName;
}

// ---------------------------------------------------------------------------
// Accepted tokens (for server-side auth)
// ---------------------------------------------------------------------------

let _acceptedTokens: string[] | undefined;

/**
 * Return all configured agent tokens that should be accepted for inbound auth.
 */
export function getAcceptedAgentTokens(): string[] {
  if (_acceptedTokens !== undefined) return _acceptedTokens;

  const tokens: string[] = [];
  const token = process.env.DISPATCH_AGENT_TOKEN;
  if (token) tokens.push(token);

  _acceptedTokens = tokens;
  return _acceptedTokens;
}

/**
 * Check if a bearer token is authorized. Uses timing-safe comparison.
 */
export function isAuthorizedBearerToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const accepted = getAcceptedAgentTokens();

  for (const acceptedToken of accepted) {
    if (safeEqual(acceptedToken, token)) return true;
  }
  return false;
}

/**
 * Backward-compatible alias — check if a request token is authorized.
 */
export function isAuthorizedAgentToken(token: string | null | undefined): boolean {
  return isAuthorizedBearerToken(token);
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return timingSafeEqual(aBuf, bBuf);
}

// ---------------------------------------------------------------------------
// Database URL resolution
// ---------------------------------------------------------------------------

let _cachedDbUrl: string | undefined;

/**
 * Resolve the database connection URL for Prisma/runtime.
 *
 * Resolution order:
 * 1. DATABASE_URL (canonical)
 * 2. DISPATCH_DATABASE_URL
 *
 * Returns undefined if none are set. This function does NOT mutate process.env;
 * call ensureDatabaseUrl() for startup shim behavior that exports to process.env.
 */
export function getDatabaseUrl(): string | undefined {
  if (_cachedDbUrl !== undefined) return _cachedDbUrl;

  const canonical = process.env.DATABASE_URL;
  if (canonical) {
    _cachedDbUrl = canonical;
    return _cachedDbUrl;
  }

  const dispatch = process.env.DISPATCH_DATABASE_URL;
  _cachedDbUrl = dispatch;
  return _cachedDbUrl;
}

// ---------------------------------------------------------------------------
// Startup shim — mutates process.env for container entrypoint use
// ---------------------------------------------------------------------------

let _shimApplied = false;

/**
 * Apply compatibility aliases to process.env.
 * Safe to call multiple times — idempotent.
 * Called by docker-entrypoint.sh before Prisma migrate and app startup.
 */
export function ensureDatabaseUrl(): void {
  if (_shimApplied) return;
  _shimApplied = true;

  if (process.env.DATABASE_URL) {
    return;
  }

  if (process.env.DISPATCH_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.DISPATCH_DATABASE_URL;
  }
}

// ---------------------------------------------------------------------------
// Cache reset (for testing)
// ---------------------------------------------------------------------------

/**
 * Reset all internal caches. Intended for test isolation — call in beforeEach.
 */
export function resetCaches(): void {
  _cachedUrl = undefined;
  _cachedToken = undefined;
  _cachedAgentName = undefined;
  _acceptedTokens = undefined;
  _cachedDbUrl = undefined;
  _shimApplied = false;
}
