export const DEFAULT_CALLBACK_URL = "/board";

/**
 * Validate and sanitise a callbackUrl to prevent open redirects.
 *
 * Allowed:
 *  - missing / empty -> default
 *  - relative path starting with / (e.g. /board, /board/issues)
 *
 * Rejected:
 *  - protocol-relative URLs (//evil.com)
 *  - absolute URLs (https://evil.com)
 */
export function safeCallbackUrl(raw: string | null): string {
  if (!raw || raw.trim() === "") return DEFAULT_CALLBACK_URL;
  // Reject anything that looks like an external redirect.
  if (raw.startsWith("//") || /^https?:\/\//i.test(raw)) return DEFAULT_CALLBACK_URL;
  // Only allow paths that start with a single /.
  if (raw.startsWith("/")) return raw;
  return DEFAULT_CALLBACK_URL;
}
