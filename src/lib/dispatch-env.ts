/**
 * Dispatch environment variable resolution.
 *
 * Supported env vars: DISPATCH_URL, DISPATCH_AGENT_TOKEN,
 *                     DISPATCH_MAINTAINER_TOKEN, DISPATCH_WORKER_TOKEN,
 *                     DISPATCH_WORKER_TOKENS, DISPATCH_AGENT_NAME,
 *                     DISPATCH_AUTH_MODE, DISPATCH_AUTH_USERNAME,
 *                     DISPATCH_AUTH_PASSWORD
 *
 * Bearer tokens carry a tier:
 *   - "maintainer" : DISPATCH_AGENT_TOKEN and the optional
 *                    DISPATCH_MAINTAINER_TOKEN alias — full rights.
 *   - "worker"     : DISPATCH_WORKER_TOKEN (legacy, unbound) and bound
 *                    credentials from DISPATCH_WORKER_TOKENS
 *                    ("agent:token" pairs) — restricted allowlist of routes
 *                    (see `requiredTierForRoute` in src/lib/auth.ts). Bound
 *                    credentials additionally carry an immutable agent
 *                    identity (see `getBearerTokenIdentity`).
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
// Worker token → agent bindings (DISPATCH_WORKER_TOKENS)
// ---------------------------------------------------------------------------

/**
 * A worker bearer credential bound to exactly one agent name.
 */
export type WorkerTokenBinding = { token: string; agentName: string };

let _workerTokenBindings: WorkerTokenBinding[] | undefined;
let _ambiguousWorkerTokens: Set<string> | undefined;

/**
 * Parse `DISPATCH_WORKER_TOKENS` into token→agent bindings.
 *
 * Format: `agentName:token` entries separated by commas and/or newlines, e.g.
 * `alpha:<token-a>,bravo:<token-b>`. Each entry and each side is trimmed; the
 * split happens on the FIRST colon only so tokens may contain `:`. Empty and
 * malformed entries are skipped with a one-time warning that names the env var
 * but NEVER the token value.
 *
 * A token mapped to two different agent names is ambiguous: it is excluded
 * from the binding table (and from the accepted-token table) so it fails
 * closed everywhere. Multiple tokens may map to the same agent (rotation).
 */
export function getWorkerTokenBindings(): WorkerTokenBinding[] {
  if (_workerTokenBindings !== undefined) return _workerTokenBindings;

  const raw = process.env.DISPATCH_WORKER_TOKENS ?? "";
  const parsed: WorkerTokenBinding[] = [];
  const tokenAgents = new Map<string, Set<string>>();

  for (const rawEntry of raw.split(/[\n,]+/)) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    const colonIndex = entry.indexOf(":");
    if (colonIndex <= 0 || colonIndex === entry.length - 1) {
      console.warn(
        'DISPATCH_WORKER_TOKENS: ignoring a malformed entry (expected "agent:token")',
      );
      continue;
    }

    const agentName = entry.slice(0, colonIndex).trim();
    const token = entry.slice(colonIndex + 1).trim();
    if (!agentName || !token) {
      console.warn(
        "DISPATCH_WORKER_TOKENS: ignoring an entry with an empty agent name or token",
      );
      continue;
    }

    parsed.push({ token, agentName });
    const agents = tokenAgents.get(token) ?? new Set<string>();
    agents.add(agentName);
    tokenAgents.set(token, agents);
  }

  // A token bound to more than one agent is ambiguous — fail closed by
  // dropping it entirely. Only the env var name is logged.
  const ambiguous = new Set<string>();
  for (const [token, agents] of tokenAgents) {
    if (agents.size > 1) {
      ambiguous.add(token);
      console.warn(
        "DISPATCH_WORKER_TOKENS: a token is bound to multiple agent names; ignoring it (fail-closed)",
      );
    }
  }

  _ambiguousWorkerTokens = ambiguous;
  _workerTokenBindings = parsed.filter((binding) => !ambiguous.has(binding.token));
  return _workerTokenBindings;
}

/**
 * Full identity resolved from a bearer token:
 *   - `{ tier: "maintainer" }` — a maintainer token (unbound, full rights)
 *   - `{ tier: "worker", agentName }` — a bound worker credential
 *   - `{ tier: "worker", legacyUnbound: true }` — the legacy shared
 *     DISPATCH_WORKER_TOKEN, which carries no agent identity
 *
 * Returns null for unknown, empty, or ambiguous tokens (fail closed).
 */
export type BearerTokenIdentity =
  | { tier: "maintainer" }
  | { tier: "worker"; agentName: string; legacyUnbound?: false }
  | { tier: "worker"; agentName?: undefined; legacyUnbound: true };

/**
 * Resolve the full identity of a bearer token. The presented token is trimmed
 * before comparison. Ambiguous bound tokens resolve to null (fail closed) even
 * when they also match the legacy worker token.
 */
export function getBearerTokenIdentity(
  token: string | null | undefined,
): BearerTokenIdentity | null {
  if (!token) return null;
  const trimmed = token.trim();
  if (!trimmed) return null;

  // Populate the binding/ambiguity caches first.
  const bindings = getWorkerTokenBindings();

  // A non-ambiguous bound credential wins any cross-tier collision (worker is
  // the lower privilege) and carries its immutable agent identity.
  const bound = bindings.find((binding) => safeEqual(binding.token, trimmed));
  if (bound) return { tier: "worker", agentName: bound.agentName };

  // An ambiguous binding is excluded from the table above. It must never
  // authenticate as maintainer; it is usable only as the legacy unbound worker
  // token when its value also matches DISPATCH_WORKER_TOKEN, and is otherwise
  // rejected outright.
  if (_ambiguousWorkerTokens?.has(trimmed)) {
    const legacy = process.env.DISPATCH_WORKER_TOKEN?.trim();
    if (legacy && safeEqual(legacy, trimmed)) return { tier: "worker", legacyUnbound: true };
    return null;
  }

  const tier = getBearerTokenTier(trimmed);
  if (tier === null) return null;
  if (tier === "maintainer") return { tier: "maintainer" };
  return { tier: "worker", legacyUnbound: true };
}

/**
 * Convenience accessor: the agent name a token is bound to, or undefined for
 * maintainer/legacy-unbound/unknown tokens.
 */
export function getBoundAgentName(token: string | null | undefined): string | undefined {
  const identity = getBearerTokenIdentity(token);
  return identity && identity.tier === "worker" ? identity.agentName : undefined;
}

let _warnedLegacyWorkerToken = false;

/**
 * Emit a one-time deprecation notice when the legacy unbound
 * DISPATCH_WORKER_TOKEN is configured. Called at boot from
 * src/instrumentation.ts. Never logs the token value.
 */
export function warnLegacyWorkerToken(): void {
  if (_warnedLegacyWorkerToken) return;
  if (!process.env.DISPATCH_WORKER_TOKEN?.trim()) return;
  _warnedLegacyWorkerToken = true;
  console.warn(
    "DISPATCH_WORKER_TOKEN is a legacy unbound worker credential; agent-scoped worker routes now require a bound credential from DISPATCH_WORKER_TOKENS (\"agent:token\"). Migrate before the legacy token stops working.",
  );
}

// ---------------------------------------------------------------------------
// Accepted tokens and tiers (for server-side auth)
// ---------------------------------------------------------------------------

/**
 * Bearer token tiers:
 *   - "maintainer" : full rights (DISPATCH_AGENT_TOKEN, DISPATCH_MAINTAINER_TOKEN)
 *   - "worker"     : restricted allowlist (DISPATCH_WORKER_TOKEN and bound
 *                    DISPATCH_WORKER_TOKENS credentials)
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
    warnWorkerMaintainerCollision("DISPATCH_WORKER_TOKEN", workerToken, agentToken, maintainerToken);
  }

  // Bound worker credentials from DISPATCH_WORKER_TOKENS. Ambiguous tokens are
  // already excluded by getWorkerTokenBindings() (fail-closed). A bound token
  // that collides with a maintainer token resolves to the LOWER worker tier
  // with its agent binding intact.
  const boundTokens = new Set<string>();
  for (const binding of getWorkerTokenBindings()) {
    if (boundTokens.has(binding.token)) continue;
    boundTokens.add(binding.token);
    tiers.push({ token: binding.token, tier: "worker" });
    warnWorkerMaintainerCollision("DISPATCH_WORKER_TOKENS", binding.token, agentToken, maintainerToken);
  }

  _tokenTiers = tiers;
  return _tokenTiers;
}

/**
 * One-time (per module instance) fail-closed warning when a worker credential
 * shares its value with a maintainer token. Names the colliding env vars but
 * never the token value.
 */
function warnWorkerMaintainerCollision(
  envVar: string,
  token: string,
  agentToken: string | undefined,
  maintainerToken: string | undefined,
): void {
  const collidesWithAgent = agentToken !== undefined && safeEqual(token, agentToken);
  const collidesWithMaintainer =
    maintainerToken !== undefined && safeEqual(token, maintainerToken);
  if (!collidesWithAgent && !collidesWithMaintainer) return;
  const collidingVars = [
    collidesWithAgent ? "DISPATCH_AGENT_TOKEN" : null,
    collidesWithMaintainer ? "DISPATCH_MAINTAINER_TOKEN" : null,
  ]
    .filter((v): v is string => v !== null)
    .join(" and ");
  console.warn(
    `Token tier misconfiguration: a worker token from ${envVar} has the same value as ${collidingVars}; it will be treated as worker-tier only. Set ${envVar} to a distinct value.`,
  );
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
  _workerTokenBindings = undefined;
  _ambiguousWorkerTokens = undefined;
  _warnedLegacyWorkerToken = false;
}
