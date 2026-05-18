/**
 * Dispatch environment variable resolution.
 *
 * Supported env vars: DISPATCH_URL, DISPATCH_AGENT_TOKEN, DATABASE_URL, DISPATCH_DATABASE_URL
 */

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
 * Check if a request token is authorized.
 */
export function isAuthorizedAgentToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const accepted = getAcceptedAgentTokens();
  return accepted.includes(token);
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
