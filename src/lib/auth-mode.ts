/**
 * Authentication mode resolution, isolated in a dependency-free module.
 *
 * This lives apart from src/lib/auth.ts so client-reachable components can
 * read the auth mode without pulling the full auth module (which lazily
 * imports Prisma for tier-denial audit rows) into the browser bundle.
 */

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

/**
 * Reset the cached auth mode. Intended for test isolation.
 */
export function resetAuthModeCache(): void {
  _cachedAuthMode = undefined;
}
