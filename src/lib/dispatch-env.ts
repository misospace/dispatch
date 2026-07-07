/**
 * Dispatch environment variable resolution.
 *
 * Supported env vars: DISPATCH_URL, DISPATCH_AGENT_TOKEN, DISPATCH_AGENT_NAME,
 *                     DISPATCH_AUTH_MODE, DISPATCH_AUTH_USERNAME,
 *                     DISPATCH_AUTH_PASSWORD
 *
 * NOTE: This module is imported by src/middleware.ts, which runs in the Edge
 * runtime. It must therefore stay free of Node-only APIs (node:crypto, Buffer,
 * fs, etc.) at both module scope and in any code path the middleware reaches.
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
 * Timing-safe string comparison to prevent timing attacks.
 *
 * Pure-JS implementation (no node:crypto / Buffer) so it is safe to call from
 * the Edge runtime via src/middleware.ts.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
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
}
