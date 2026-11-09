/**
 * Structural Prisma known-request-error classification.
 *
 * Structural on purpose: tests (and any environment without the Prisma error
 * class) may throw a plain object with the same shape, so the classification
 * never depends on an `instanceof Prisma.PrismaClientKnownRequestError`
 * narrowing.
 */

/**
 * Prisma unique-constraint violation (P2002): the real client throws
 * `PrismaClientKnownRequestError`; tests may throw a plain object with the
 * same shape.
 */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/**
 * Prisma foreign-key violation (P2003) — e.g. the #1361 anchor's guard row
 * REFERENCES the issue, so acquiring it for an unknown issue raises one
 * before the caller's own "issue not found" check can run. The structural
 * check keeps callers free of a direct Prisma error-class import.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2003"
  );
}
