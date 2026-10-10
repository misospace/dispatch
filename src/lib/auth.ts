/**
 * Shared authentication helpers for Dispatch.
 *
 * Supports four auth modes (controlled by DISPATCH_AUTH_MODE):
 *   - "basic"    : HTTP Basic Auth for operator/browser UI access
 *   - "oidc"     : OIDC provider authentication with session cookies
 *   - "disabled" : No auth enforcement (full open access)
 *
 * When DISPATCH_AUTH_MODE is not set, the legacy behavior is preserved:
 * Bearer token auth is used for route-level checks.
 *
 * Bearer tokens carry a tier (see `getBearerTokenTier` in dispatch-env):
 *   - "maintainer" : DISPATCH_AGENT_TOKEN (and the optional
 *                    DISPATCH_MAINTAINER_TOKEN alias) — full rights on every
 *                    route. OIDC sessions, basic auth, and auth-disabled
 *                    mode all resolve to the maintainer tier as well.
 *   - "worker"     : DISPATCH_WORKER_TOKEN — restricted to the allowlist in
 *                    `WORKER_ALLOWLIST` below; a worker token on any other
 *                    route is rejected with 403 (`forbidden: true`) and a
 *                    best-effort `auth_tier_denied` audit row.
 *
 * Tiers are enforced centrally from the single route→tier table in
 * `requiredTierForRoute`, which defaults every route to "maintainer".
 *
 * All mutating routes should use `authorizeRequest(request)` instead of
 * duplicating auth parsing logic. The middleware protects operator UI routes;
 * route handlers authorize API access for browsers and agents.
 */

import { NextResponse } from "next/server";
import { errorResponse } from "./api-errors";
import { getAuthMode, resetAuthModeCache } from "./auth-mode";
import {
  getBearerTokenIdentity,
  getBearerTokenTier,
  isAuthorizedBearerToken as _isAuthed,
  isConfiguredWorkerToken,
  resetCaches as _resetEnvCaches,
  safeEqual,
  type TokenTier,
} from "./dispatch-env";

// ---------------------------------------------------------------------------
// Auth mode resolution (delegates to the client-safe auth-mode module; the
// full auth module lazily imports Prisma for tier-denial audits and must not
// be pulled into client bundles)
// ---------------------------------------------------------------------------

export { getAuthMode };

// ---------------------------------------------------------------------------
// OIDC config validation (fail-fast startup check)
// ---------------------------------------------------------------------------

/**
 * Env vars required when DISPATCH_AUTH_MODE=oidc.
 */
export const OIDC_REQUIRED_ENV_VARS = [
  "DISPATCH_OIDC_ISSUER",
  "DISPATCH_OIDC_CLIENT_ID",
  "DISPATCH_OIDC_CLIENT_SECRET",
] as const;

/**
 * Validate that all required OIDC env vars are present.
 *
 * Intended to run once at startup (see src/instrumentation.ts register()) so
 * a misconfiguration fails fast with a clear error instead of surfacing as an
 * opaque NextAuth error at first login. Mirrors the GitHub App misconfiguration
 * check in src/lib/github-auth.ts.
 *
 * @throws {Error} listing the missing keys when any required var is absent.
 */
export function validateOidcConfig(): void {
  const missing = OIDC_REQUIRED_ENV_VARS.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `OIDC authentication is misconfigured — missing required env vars: ${missing.join(", ")}`,
    );
  }
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
// Route → tier table (central tier enforcement)
// ---------------------------------------------------------------------------

/**
 * The single source of truth for which routes a worker-tier token
 * (DISPATCH_WORKER_TOKEN) may call. Every route not listed here requires the
 * maintainer tier, so a new route defaults to maintainer by construction.
 *
 * `method` is the HTTP method ("*" matches any method). The patterns match
 * the request pathname exactly (no query string).
 */
export const WORKER_ALLOWLIST: ReadonlyArray<{ method: string | "*"; pattern: RegExp }> = [
  // Per-agent worker loop routes (name = one path segment)
  { method: "GET", pattern: /^\/api\/agents\/[^/]+\/next-task$/ },
  { method: "POST", pattern: /^\/api\/agents\/[^/]+\/tasks\/report$/ },
  { method: "POST", pattern: /^\/api\/agents\/[^/]+\/heartbeat$/ },
  { method: "GET", pattern: /^\/api\/agents\/[^/]+\/active-work$/ },
  { method: "GET", pattern: /^\/api\/agents\/[^/]+\/queue$/ },
  { method: "GET", pattern: /^\/api\/agents\/[^/]+\/work-summary$/ },
  // Agent work lifecycle for the calling worker: read its listing and run its
  // own work. The root POST action surface (release/reassign any agent's work)
  // and POST /api/agent-work/sweep (stale-work recovery) stay maintainer-only.
  { method: "GET", pattern: /^\/api\/agent-work$/ },
  { method: "POST", pattern: /^\/api\/agent-work\/(?:start|checkpoint|finish)$/ },
  // Issue state changes a worker performs on its own claimed work
  { method: "POST", pattern: /^\/api\/issues\/claim$/ },
  { method: "POST", pattern: /^\/api\/issues\/unclaim$/ },
  { method: "GET", pattern: /^\/api\/issues\/state$/ },
  { method: "POST", pattern: /^\/api\/issues\/status$/ },
  { method: "GET", pattern: /^\/api\/issues$/ },
  // PR-fix queue reads + status marks
  { method: "GET", pattern: /^\/api\/pr-fix-queue\/queued$/ },
  { method: "GET", pattern: /^\/api\/pr-fix-queue\/history$/ },
  { method: "POST", pattern: /^\/api\/pr-fix-queue\/mark$/ },
];

/**
 * Resolve the tier required to call a route. Defaults to "maintainer"; only
 * returns "worker" when the (pathname, method) pair matches `WORKER_ALLOWLIST`.
 * Maintainer-tier callers can use every route.
 */
export function requiredTierForRoute(pathname: string, method: string): TokenTier {
  const normalizedMethod = method.toUpperCase();
  for (const entry of WORKER_ALLOWLIST) {
    if (entry.method !== "*" && entry.method !== normalizedMethod) continue;
    if (entry.pattern.test(pathname)) return "worker";
  }
  return "maintainer";
}

// ---------------------------------------------------------------------------
// Unified authorization entry point
// ---------------------------------------------------------------------------

export type AuthorizedRequest =
  | { authorized: true; type: "basic"; username: string; actor: string; tier: "maintainer" }
  | { authorized: true; type: "bearer"; actor: string; tier: TokenTier; agentName?: string }
  | { authorized: true; type: "oidc"; actor: string; tier: "maintainer" }
  | { authorized: true; type: "disabled"; actor: string; tier: "maintainer" }
  | { authorized: false }
  | { authorized: false; forbidden: true; requiredTier: TokenTier };

/**
 * Check header-based auth (Bearer / Basic) and return the parsed auth info.
 *
 * A bound worker credential carries its immutable `agentName` (from the token,
 * never from a self-reported header or body). Maintainer and legacy-unbound
 * worker tokens carry no `agentName`.
 */
export function authenticateRequest(request: Request):
  | { authorized: true; type: "basic"; username: string }
  | { authorized: true; type: "bearer"; tier: TokenTier; agentName?: string }
  | { authorized: false } {
  const authMode = getAuthMode();

  // Disabled mode — allow everything as bearer (no-op, just for type safety)
  if (authMode === "disabled") {
    return { authorized: true, type: "bearer", tier: "maintainer" };
  }

  const parsed = parseAuthorizationHeader(request.headers.get("authorization"));

  if (parsed?.type === "bearer") {
    const identity = getBearerTokenIdentity(parsed.token);
    if (identity) {
      if (identity.tier === "maintainer") {
        return { authorized: true, type: "bearer", tier: "maintainer" };
      }
      return {
        authorized: true,
        type: "bearer",
        tier: "worker",
        ...(identity.agentName ? { agentName: identity.agentName } : {}),
      };
    }
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
 * Record a best-effort audit row when a worker-tier token is denied on a
 * maintainer-tier route. The lazy prisma import keeps the (otherwise
 * client-import-free) module graph lean, and the try/catch guarantees a DB
 * failure can never change the auth decision — the denial stands either way.
 *
 * The audit actor is the token-derived identity when one is available
 * (preferring the bound worker `agentName`); legacy unbound worker tokens
 * fall back to the self-reported `x-agent-name` header. Source from the
 * request header rather than a body argument so the bound identity cannot
 * be overridden by the caller, and so a denied worker cannot rotate header
 * values to evade the per-actor throttle or attribute the row to another
 * agent.
 *
 * Rows are throttled two ways so a misconfigured worker cannot write-amplify
 * the audit table: one row per (actor, method, pathname) per minute, with an
 * overall per-actor ceiling per minute (dynamic maintainer paths like
 * /api/issues/{id}/lane would otherwise each open a fresh bucket). The 403
 * response itself is never throttled — nothing here may change the auth
 * decision, so every step sits inside a try/catch.
 */
async function recordTierDenialAudit(
  headerAuth: {
    authorized: true;
    type: "bearer";
    tier: TokenTier;
    agentName?: string;
  },
  request: Request,
  pathname: string,
  method: string,
): Promise<void> {
  try {
    // Prefer the token-derived identity over the self-reported header so a
    // denied worker cannot attribute rows to another agent or rotate
    // identities to evade per-actor throttling.
    const actor = headerAuth.agentName ?? resolveBearerActor(request);
    const { checkRateLimit } = await import("./rate-limit");
    if (!checkRateLimit(`auth_tier_denied:${actor}`, { limit: 10, windowMs: 60_000 }).allowed) return;
    if (!checkRateLimit(`auth_tier_denied:${actor}:${method}:${pathname}`, { limit: 1, windowMs: 60_000 }).allowed) return;

    const { prisma } = await import("./prisma");
    await prisma.auditLog.create({
      data: {
        actor,
        action: "auth_tier_denied",
        repoFullName: "unknown",
        success: false,
        errorMessage: `worker tier denied ${method} ${pathname}; requires maintainer tier`,
        beforeLabels: [],
        afterLabels: [],
      },
    });
  } catch {
    // Best-effort audit only — never let a limiter or DB failure affect the
    // auth result.
  }
}

/**
 * Authorize a route handler request and return the authenticated actor.
 *
 * Accepts:
 * - valid Bearer auth in basic, oidc, and legacy modes; the tier of the
 *   token (maintainer vs worker) is resolved and enforced against the
 *   route's required tier (`requiredTierForRoute`)
 * - valid Basic Auth operator credentials in basic mode (maintainer tier)
 * - valid NextAuth/OIDC session cookies in oidc mode (maintainer tier)
 *
 * A worker-tier token on a maintainer-tier route is rejected with
 * `{ authorized: false, forbidden: true, requiredTier: "maintainer" }`
 * and a best-effort `auth_tier_denied` audit row.
 */
export async function authorizeRequest(request: Request): Promise<AuthorizedRequest> {
  const authMode = getAuthMode();

  if (authMode === "disabled") {
    return { authorized: true, type: "disabled", actor: "operator", tier: "maintainer" };
  }

  const headerAuth = authenticateRequest(request);
  if (headerAuth.authorized) {
    if (headerAuth.type === "basic") {
      return { ...headerAuth, actor: headerAuth.username, tier: "maintainer" };
    }

    if (headerAuth.type === "bearer" && headerAuth.tier === "worker") {
      const { pathname } = new URL(request.url);
      const required = requiredTierForRoute(pathname, request.method);
      if (required === "maintainer") {
        await recordTierDenialAudit(headerAuth, request, pathname, request.method);
        return { authorized: false, forbidden: true, requiredTier: "maintainer" };
      }
    }

    // A bound worker credential's actor is its immutable token-derived agent
    // name; maintainer and legacy-unbound tokens keep the self-reported
    // x-agent-name fallback.
    const actor =
      headerAuth.type === "bearer" && headerAuth.agentName
        ? headerAuth.agentName
        : resolveBearerActor(request);
    return { ...headerAuth, actor };
  }

  if (authMode === "oidc") {
    const { auth } = await import("@/lib/auth-next");
    const session = await auth();
    if (session?.user) {
      return {
        authorized: true,
        type: "oidc",
        actor: resolveSessionActor(session.user),
        tier: "maintainer",
      };
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
  // A bound worker token's identity is immutable: never let a self-reported
  // header or body fallback override it.
  if (auth.agentName) return auth.agentName;
  return (typeof fallback === "string" && fallback.trim()) || resolveBearerActor(request);
}

/**
 * The agent a worker-tier bearer token is bound to, if any. Returns undefined
 * for maintainer, OIDC, basic, disabled, and legacy-unbound worker callers.
 */
export function getBoundWorkerAgent(auth: AuthorizedRequest): string | undefined {
  return auth.authorized && auth.type === "bearer" ? auth.agentName : undefined;
}

/**
 * Build the HTTP error response for a failed authorization result.
 *
 * - `forbidden` (worker token on a maintainer-tier route) → 403 naming the
 *   required tier and the env vars involved
 * - anything else (unknown/missing/invalid credentials) → 401
 */
export function authErrorResponse(
  auth: Extract<AuthorizedRequest, { authorized: false }>,
): NextResponse<{ error: string }> {
  if ("forbidden" in auth && auth.forbidden) {
    return errorResponse(
      "Forbidden: this endpoint requires a maintainer token (DISPATCH_AGENT_TOKEN); worker tokens (DISPATCH_WORKER_TOKEN) are restricted",
      403,
    );
  }
  return errorResponse("Unauthorized", 401);
}

/**
 * Authorize a request for the hosted groomer route.
 * Accepts standard auth (agent token, basic, oidc) OR the dedicated groomer
 * token. The groomer token must be distinct from DISPATCH_WORKER_TOKEN: a
 * groomer token value that duplicates the worker token is denied here — the
 * tier table resolves it to the lower "worker" tier (fail-closed) — and the
 * standard result (including a worker-tier 403 `forbidden`) is returned.
 */
export async function authorizeGroomerRequest(request: Request): Promise<AuthorizedRequest> {
  const standard = await authorizeRequest(request);
  if (standard.authorized) return standard;

  const token = process.env.DISPATCH_GROOMER_TOKEN?.trim();
  if (!token) return standard;

  const parsed = parseAuthorizationHeader(request.headers.get("authorization"));
  if (parsed?.type === "bearer" && safeEqual(parsed.token, token)) {
    // Fail-closed: a groomer token value that also appears in
    // `DISPATCH_WORKER_TOKENS` (whether resolved successfully or dropped as
    // an ambiguous two-agent binding) cannot be escalated to the privileged
    // groomer/maintainer tier — even though the value matches DISPATCH_GROOMER_TOKEN.
    // `isConfiguredWorkerToken` checks every value parsed from that env var,
    // which is broader than `getBearerTokenTier === "worker"` (the tier table
    // excludes ambiguous bindings entirely). Returning the original `standard`
    // result preserves the worker-tier `forbidden` outcome so the caller gets
    // a 403 either way.
    if (isConfiguredWorkerToken(parsed.token)) return standard;
    if (getBearerTokenTier(parsed.token) === "worker") return standard;
    return {
      authorized: true,
      type: "bearer",
      actor: "hosted-groomer-scheduler",
      tier: "maintainer",
    };
  }
  // Preserve the standard failure (including a worker-tier `forbidden`) when
  // the groomer token does not match, so the caller still gets a 403.
  return standard;
}

// ---------------------------------------------------------------------------
// Cache reset (for testing)
// ---------------------------------------------------------------------------

/**
 * Reset all internal auth caches. Intended for test isolation — call in beforeEach.
 */
export function resetAuthCaches(): void {
  resetAuthModeCache();
  // Also reset dispatch-env token cache since auth delegates to it
  _resetEnvCaches();
}
