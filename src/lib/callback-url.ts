export const DEFAULT_CALLBACK_URL = "/board";

/**
 * Validate and sanitise a callbackUrl to prevent open redirects.
 *
 * Allowed:
 *  - missing / empty -> default
 *  - relative path starting with a single / (e.g. /board, /board/issues),
 *    including query strings and fragments
 *
 * Rejected:
 *  - protocol-relative URLs (//evil.com)
 *  - absolute URLs (https://evil.com)
 *  - variants that the WHATWG URL parser normalizes into an external origin:
 *    slash-backslash prefixes (/\evil.com — backslashes are treated as
 *    slashes for special schemes) and embedded C0/DEL control characters
 *    (e.g. /<TAB>/evil.com — the parser strips tab, LF and CR).
 */
const CONTROL_OR_BACKSLASH = /[\\\u0000-\u001f\u007f]/;
const CALLBACK_ORIGIN_BASE = "http://callback.invalid";
const CALLBACK_ORIGIN = new URL(CALLBACK_ORIGIN_BASE).origin;

export function safeCallbackUrl(raw: string | null): string {
  if (!raw || raw.trim() === "") return DEFAULT_CALLBACK_URL;
  // Only allow paths that start with a single /.
  if (!raw.startsWith("/") || raw.startsWith("//")) return DEFAULT_CALLBACK_URL;
  // Reject anything that looks like an absolute external redirect.
  if (/^https?:\/\//i.test(raw)) return DEFAULT_CALLBACK_URL;
  // Backslashes and control characters are never valid in a local path and
  // can re-form a protocol-relative URL once a browser strips/converts them.
  if (CONTROL_OR_BACKSLASH.test(raw)) return DEFAULT_CALLBACK_URL;
  // Final normalization check: resolve against a sentinel origin and require
  // the result to stay on that origin (catches remaining parser tricks).
  try {
    const resolved = new URL(raw, CALLBACK_ORIGIN_BASE);
    if (resolved.origin !== CALLBACK_ORIGIN) {
      return DEFAULT_CALLBACK_URL;
    }
  } catch {
    return DEFAULT_CALLBACK_URL;
  }
  return raw;
}
