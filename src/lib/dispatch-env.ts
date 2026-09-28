/**
 * Dispatch environment variable resolution.
 *
 * Supported env vars: DISPATCH_URL, DISPATCH_AGENT_TOKEN,
 *                     DISPATCH_MAINTAINER_TOKEN, DISPATCH_WORKER_TOKEN,
 *                     DISPATCH_AGENT_NAME, DISPATCH_AUTH_MODE,
 *                     DISPATCH_AUTH_USERNAME, DISPATCH_AUTH_PASSWORD
 *
 * Bearer tokens carry a tier:
 *   - "maintainer" : DISPATCH_AGENT_TOKEN and the optional
 *                    DISPATCH_MAINTAINER_TOKEN alias — full rights.
 *   - "worker"     : DISPATCH_WORKER_TOKEN — restricted allowlist of routes
 *                    (see `requiredTierForRoute` in src/lib/auth.ts).
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
// Accepted tokens and tiers (for server-side auth)
// ---------------------------------------------------------------------------

/**
 * Bearer token tiers:
 *   - "maintainer" : full rights (DISPATCH_AGENT_TOKEN, DISPATCH_MAINTAINER_TOKEN)
 *   - "worker"     : restricted allowlist (DISPATCH_WORKER_TOKEN)
 */
export type TokenTier = "worker" | "maintainer";

let _tokenTiers: Array<{ token: string; tier: TokenTier }> | undefined;

/**
 * Return the canonical token→tier table built from the environment (values
 * are trimmed; empty-after-trim is treated as unset):
 *   - DISPATCH_AGENT_TOKEN     → "maintainer"
 *   - DISPATCH_MAINTAINER_TOKEN → "maintainer"
 *   - DISPATCH_WORKER_TOKEN    → "worker"
 *
 * Entries are ordered maintainer-first. When the same value is configured in
 * multiple tiers, the tier lookup (`getBearerTokenTier`) resolves it with the
 * LOWER "worker" privilege winning (fail-closed). A one-time console warning
 * is emitted here when the table is built in that misconfigured state; token
 * values are never logged.
 */
export function getAcceptedTokenTiers(): Array<{ token: string; tier: TokenTier }> {
  if (_tokenTiers !== undefined) return _tokenTiers;

  const tiers: Array<{ token: string; tier: TokenTier }> = [];
  // Trim env values at table construction: presented bearer tokens are
  // trimmed before comparison, so a whitespace-padded value is the same
  // token, and an empty-after-trim value is treated as unset.
  const agentToken = process.env.DISPATCH_AGENT_TOKEN?.trim();
  if (agentToken) tiers.push({ token: agentToken, tier: "maintainer" });

  const maintainerToken = process.env.DISPATCH_MAINTAINER_TOKEN?.trim();
  if (maintainerToken) tiers.push({ token: maintainerToken, tier: "maintainer" });

  const workerToken = process.env.DISPATCH_WORKER_TOKEN?.trim();
  if (workerToken) {
    tiers.push({ token: workerToken, tier: "worker" });
    // Fail-closed misconfiguration check: a worker token value that is also
    // configured as a maintainer token resolves to the LOWER worker tier.
    // Surface that once (the table is cached, so this runs once per module
    // instance) without ever logging a token value. A duplicate between the
    // two maintainer aliases is fine and needs no warning.
    const collidesWithAgent = agentToken !== undefined && safeEqual(workerToken, agentToken);
    const collidesWithMaintainer =
      maintainerToken !== undefined && safeEqual(workerToken, maintainerToken);
    if (collidesWithAgent || collidesWithMaintainer) {
      const collidingVars = [
        collidesWithAgent ? "DISPATCH_AGENT_TOKEN" : null,
        collidesWithMaintainer ? "DISPATCH_MAINTAINER_TOKEN" : null,
      ]
        .filter((v): v is string => v !== null)
        .join(" and ");
      console.warn(
        `Token tier misconfiguration: DISPATCH_WORKER_TOKEN has the same value as ${collidingVars}; it will be treated as worker-tier only. Set DISPATCH_WORKER_TOKEN to a distinct value.`,
      );
    }
  }

  _tokenTiers = tiers;
  return _tokenTiers;
}

/**
 * Return all configured bearer tokens that should be accepted for inbound auth,
 * derived from the token→tier table (de-duplicated).
 */
export function getAcceptedAgentTokens(): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const { token } of getAcceptedTokenTiers()) {
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Resolve the tier of a bearer token using timing-safe comparison against each
 * configured token. The presented token is trimmed before comparison (env
 * values are trimmed at table construction); a whitespace-only token resolves
 * to null. Returns null when the token matches no configured token.
 * If the same value is configured for multiple tiers, "worker" wins
 * (fail-closed): an ambiguous cross-tier token never resolves to the higher
 * "maintainer" privilege. The misconfiguration is surfaced by a one-time
 * console warning when the token table is built (token values are never
 * logged).
 */
export function getBearerTokenTier(token: string | null | undefined): TokenTier | null {
  if (!token) return null;
  const trimmed = token.trim();
  if (!trimmed) return null;

  let maintainerMatch = false;
  let workerMatch = false;
  for (const { token: configured, tier } of getAcceptedTokenTiers()) {
    if (!safeEqual(configured, trimmed)) continue;
    if (tier === "maintainer") maintainerMatch = true;
    else workerMatch = true;
  }
  // Worker is the lower privilege tier, so it wins any cross-tier duplicate.
  if (workerMatch) return "worker";
  if (maintainerMatch) return "maintainer";
  return null;
}

/**
 * Check if a bearer token is authorized (any tier). Uses timing-safe comparison.
 */
export function isAuthorizedBearerToken(token: string | null | undefined): boolean {
  return getBearerTokenTier(token) !== null;
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
  _tokenTiers = undefined;
}
