/**
 * Shared pure time helpers. No I/O, no clock reads — callers pass values in.
 */
/** Parse a defensive timestamp: unparseable (or absent) values yield null. */
export function toMillis(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms =
    value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}
