/**
 * Dispatch environment variable resolution with v0.2.1 legacy compatibility.
 *
 * Preferred env vars: DISPATCH_URL, DISPATCH_AGENT_TOKEN, DATABASE_URL, DISPATCH_DATABASE_URL
 * Legacy env vars (accepted through v0.2.1): MISSION_CONTROL_URL, MISSION_CONTROL_AGENT_TOKEN, MISSION_CONTROL_DATABASE_URL
 * Legacy support is deprecated and scheduled for removal in v0.2.2.
 */

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------

let _cachedUrl: string | undefined;
let _urlLegacyUsed = false;
let _urlConflictWarned = false;

/**
 * Resolve the Dispatch instance URL.
 *
 * Resolution order:
 * 1. DISPATCH_URL (preferred)
 * 2. MISSION_CONTROL_URL (legacy, deprecated — v0.2.1 only)
 *
 * If both are set and differ, DISPATCH_URL wins with a warning.
 */
export function getDispatchUrl(): string | undefined {
  if (_cachedUrl !== undefined) return _cachedUrl;

  const preferred = process.env.DISPATCH_URL;
  const legacy = process.env.MISSION_CONTROL_URL;

  if (preferred) {
    if (legacy && preferred !== legacy && !_urlConflictWarned) {
      console.warn(
        "[Dispatch] Both DISPATCH_URL and MISSION_CONTROL_URL are set and differ. " +
          "Using DISPATCH_URL. MISSION_CONTROL_URL is deprecated and will be removed in v0.2.2.",
      );
      _urlConflictWarned = true;
    }
    _cachedUrl = preferred.replace(/\/+$/, "");
    return _cachedUrl;
  }

  if (legacy) {
    if (!_urlLegacyUsed) {
      console.warn(
        "[Dispatch] MISSION_CONTROL_URL is deprecated and will be removed in v0.2.2. " +
          "Use DISPATCH_URL instead.",
      );
      _urlLegacyUsed = true;
    }
    _cachedUrl = legacy.replace(/\/+$/, "");
    return _cachedUrl;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Agent token resolution (outbound / client-side)
// ---------------------------------------------------------------------------

let _cachedToken: string | undefined;
let _tokenLegacyUsed = false;
let _tokenConflictWarned = false;

/**
 * Resolve the agent bearer token for outbound calls.
 *
 * Resolution order:
 * 1. DISPATCH_AGENT_TOKEN (preferred)
 * 2. MISSION_CONTROL_AGENT_TOKEN (legacy, deprecated — v0.2.1 only)
 *
 * If both are set and differ, DISPATCH_AGENT_TOKEN wins with a warning.
 */
export function getDispatchAgentToken(): string | undefined {
  if (_cachedToken !== undefined) return _cachedToken;

  const preferred = process.env.DISPATCH_AGENT_TOKEN;
  const legacy = process.env.MISSION_CONTROL_AGENT_TOKEN;

  if (preferred) {
    if (legacy && preferred !== legacy && !_tokenConflictWarned) {
      console.warn(
        "[Dispatch] Both DISPATCH_AGENT_TOKEN and MISSION_CONTROL_AGENT_TOKEN are set and differ. " +
          "Using DISPATCH_AGENT_TOKEN for outbound calls. MISSION_CONTROL_AGENT_TOKEN is deprecated and will be removed in v0.2.2.",
      );
      _tokenConflictWarned = true;
    }
    _cachedToken = preferred;
    return _cachedToken;
  }

  if (legacy) {
    if (!_tokenLegacyUsed) {
      console.warn(
        "[Dispatch] MISSION_CONTROL_AGENT_TOKEN is deprecated and will be removed in v0.2.2. " +
          "Use DISPATCH_AGENT_TOKEN instead.",
      );
      _tokenLegacyUsed = true;
    }
    _cachedToken = legacy;
    return _cachedToken;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Accepted tokens (for server-side auth — accepts both preferred and legacy)
// ---------------------------------------------------------------------------

let _acceptedTokens: string[] | undefined;

/**
 * Return all configured agent tokens that should be accepted for inbound auth.
 * Includes both DISPATCH_AGENT_TOKEN and MISSION_CONTROL_AGENT_TOKEN if set.
 */
export function getAcceptedAgentTokens(): string[] {
  if (_acceptedTokens !== undefined) return _acceptedTokens;

  const tokens: string[] = [];
  const preferred = process.env.DISPATCH_AGENT_TOKEN;
  const legacy = process.env.MISSION_CONTROL_AGENT_TOKEN;

  if (preferred) tokens.push(preferred);
  if (legacy && !tokens.includes(legacy)) tokens.push(legacy);

  _acceptedTokens = tokens;
  return _acceptedTokens;
}

/**
 * Check if a request token is authorized.
 * Accepts both preferred and legacy tokens during v0.2.1.
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
let _dbLegacyUsed = false;
let _dbConflictWarned = false;

/**
 * Resolve the database connection URL for Prisma/runtime.
 *
 * Resolution order:
 * 1. DATABASE_URL (canonical)
 * 2. DISPATCH_DATABASE_URL
 * 3. MISSION_CONTROL_DATABASE_URL (legacy, deprecated — v0.2.1 only)
 *
 * Returns undefined if none are set. This function does NOT mutate process.env;
 * call ensureDatabaseUrl() for startup shim behavior that exports to process.env.
 */
export function getDatabaseUrl(): string | undefined {
  if (_cachedDbUrl !== undefined) return _cachedDbUrl;

  const canonical = process.env.DATABASE_URL;
  const dispatch = process.env.DISPATCH_DATABASE_URL;
  const legacy = process.env.MISSION_CONTROL_DATABASE_URL;

  if (canonical) {
    if ((dispatch || legacy) && !_dbConflictWarned) {
      const activeFallback = dispatch ?? legacy;
      console.warn(
        `[Dispatch] DATABASE_URL is set. Ignoring ${activeFallback === dispatch ? "DISPATCH_DATABASE_URL" : "MISSION_CONTROL_DATABASE_URL"}. ` +
          "DATABASE_URL is the canonical connection string.",
      );
      _dbConflictWarned = true;
    }
    _cachedDbUrl = canonical;
    return _cachedDbUrl;
  }

  if (dispatch) {
    _cachedDbUrl = dispatch;
    return _cachedDbUrl;
  }

  if (legacy) {
    if (!_dbLegacyUsed) {
      console.warn(
        "[Dispatch] MISSION_CONTROL_DATABASE_URL is deprecated and will be removed in v0.2.2. " +
          "Use DATABASE_URL or DISPATCH_DATABASE_URL instead.",
      );
      _dbLegacyUsed = true;
    }
    _cachedDbUrl = legacy;
    return _cachedDbUrl;
  }

  return undefined;
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

  const existing = process.env.DATABASE_URL;
  const dispatch = process.env.DISPATCH_DATABASE_URL;
  const legacy = process.env.MISSION_CONTROL_DATABASE_URL;

  // If DATABASE_URL is already set, nothing to do (warn if others exist)
  if (existing) {
    if ((dispatch || legacy) && !_dbConflictWarned) {
      const activeFallback = dispatch ?? legacy;
      console.warn(
        `[Dispatch] DATABASE_URL is already set. Ignoring ${activeFallback === dispatch ? "DISPATCH_DATABASE_URL" : "MISSION_CONTROL_DATABASE_URL"} as an alias.`,
      );
      _dbConflictWarned = true;
    }
    return;
  }

  // Derive DATABASE_URL from DISPATCH_DATABASE_URL
  if (dispatch) {
    process.env.DATABASE_URL = dispatch;
    return;
  }

  // Derive DATABASE_URL from legacy MISSION_CONTROL_DATABASE_URL
  if (legacy) {
    if (!_dbLegacyUsed) {
      console.warn(
        "[Dispatch] MISSION_CONTROL_DATABASE_URL is deprecated and will be removed in v0.2.2. " +
          "Exporting as DATABASE_URL for container startup compatibility.",
      );
      _dbLegacyUsed = true;
    }
    process.env.DATABASE_URL = legacy;
  }

  // Also apply token alias
  if (!process.env.DISPATCH_AGENT_TOKEN && process.env.MISSION_CONTROL_AGENT_TOKEN) {
    console.warn(
      "[Dispatch] MISSION_CONTROL_AGENT_TOKEN is deprecated and will be removed in v0.2.2. " +
        "Exporting as DISPATCH_AGENT_TOKEN for container startup compatibility.",
    );
    process.env.DISPATCH_AGENT_TOKEN = process.env.MISSION_CONTROL_AGENT_TOKEN;
  }

  // Also apply URL alias
  if (!process.env.DISPATCH_URL && process.env.MISSION_CONTROL_URL) {
    console.warn(
      "[Dispatch] MISSION_CONTROL_URL is deprecated and will be removed in v0.2.2. " +
        "Exporting as DISPATCH_URL for container startup compatibility.",
    );
    process.env.DISPATCH_URL = process.env.MISSION_CONTROL_URL;
  }
}
