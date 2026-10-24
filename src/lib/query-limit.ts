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
