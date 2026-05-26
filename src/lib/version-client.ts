/**
 * Client-safe version label.
 *
 * Uses `NEXT_PUBLIC_DISPATCH_VERSION` (injected at build time by
 * next.config.js).  Falls back to `"0.0.0"` when the env var is not set.
 *
 * This module must NOT import any Node.js built-ins (fs, path, etc.) so
 * that it can be safely tree-shaken into client bundles.
 */

export function getClientVersionLabel(): string {
  return `v${process.env.NEXT_PUBLIC_DISPATCH_VERSION ?? "0.0.0"}`;
}
