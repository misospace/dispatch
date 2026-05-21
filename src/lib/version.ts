/**
 * Dispatch app version.
 *
 * Source of truth: `NEXT_PUBLIC_DISPATCH_VERSION` (set by next.config.js at
 * build time from package.json).  Falls back to reading package.json directly
 * so the value is correct during local dev when next.config.js has not yet run.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Lazy version resolution (testable)
// ---------------------------------------------------------------------------

let _cachedVersion: string | undefined;

/**
 * Resolve the app version string (e.g. `"0.2.2"`).
 */
export function getAppVersion(): string {
  if (_cachedVersion !== undefined) return _cachedVersion;

  const buildVersion = process.env.NEXT_PUBLIC_DISPATCH_VERSION;
  if (buildVersion) {
    _cachedVersion = buildVersion;
    return _cachedVersion;
  }

  try {
    const pkg: { version?: string } = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf-8"),
    );
    _cachedVersion = pkg.version ?? "0.0.0";
  } catch {
    _cachedVersion = "0.0.0";
  }

  return _cachedVersion;
}

/**
 * Return the version string displayed in the UI (e.g. `"v0.2.2"`).
 */
export function getVersionLabel(): string {
  return `v${getAppVersion()}`;
}

/**
 * Reset the cached version. Intended for test isolation — call in beforeEach.
 */
export function resetVersionCache(): void {
  _cachedVersion = undefined;
}
