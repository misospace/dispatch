/**
 * Clamp and validate a `limit` query parameter before it reaches Prisma `take`
 * (issue #1308). A misconfigured client or bad link must never produce a 500
 * (Prisma rejects a NaN take) or an effectively unbounded row pull.
 *
 * The value falls back to the default when absent, blank, non-numeric, or
 * non-positive (Prisma interprets a negative take as "last N rows", which is
 * not a sensible debug knob), and is capped at the maximum.
 */
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

export function parseListLimit(
  value: string | null | undefined,
  fallback: number = DEFAULT_LIST_LIMIT,
  cap: number = MAX_LIST_LIMIT,
): number {
  if (value === null || value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, cap);
}

/**
 * Parse an optional integer entity-number query parameter (e.g. `issueNumber`,
 * issue #1379 — sibling of the `limit` guard above). Absent, blank, non-numeric,
 * or out-of-range values yield `undefined` so the caller can omit the filter
 * instead of NaN-reaching a Prisma `Int` column as a validation-error 500.
 * GitHub issue numbers are non-negative and fit an Int, so anything outside
 * [0, MAX_ISSUE_NUMBER] is treated as "no value" too.
 */
export const MAX_ISSUE_NUMBER = 2147483647; // 2**31 - 1, the Prisma `Int` bound.

export function parseIssueNumber(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_ISSUE_NUMBER) {
    return undefined;
  }
  return parsed;
}
