/**
 * Route-test harness for the CI park lifecycle routes (#495): a minimal
 * stateful Prisma store the REAL `pr-fix-ci-park` lib runs against, plus a
 * where-evaluator carrying the exact Prisma semantics the lifecycle writes
 * lean on (nullable-column `not` excludes NULL rows; plain `null` matches
 * NULL; AND/OR/NOT composition).
 */
import { vi } from "vitest";

/** Unique constraint a duplicate ledger create throws with Prisma v7. */
export function p2002Error(): Error & { code: string } {
  return Object.assign(new Error("Unique constraint failed on the fields: (itemId,kind,key)"), {
    code: "P2002",
  });
}

/**
 * Prisma where-evaluator for the conditions the CI park lifecycle writes use:
 * flat column equality (plain `null` matches NULL/absent), operator objects
 * (`{ not: x }` with Prisma's NULL-exclusion), and AND/OR/NOT composition.
 */
export function matchesCIParkWhere(row: any, where: any): boolean {
  return Object.keys(where).every((key) => {
    const cond = where[key];
    if (key === "AND") return cond.every((sub: any) => matchesCIParkWhere(row, sub));
    if (key === "OR") return cond.some((sub: any) => matchesCIParkWhere(row, sub));
    if (key === "NOT") {
      return Array.isArray(cond) ? !cond.some((sub: any) => matchesCIParkWhere(row, sub)) : !matchesCIParkWhere(row, cond);
    }
    if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      if ("not" in cond) {
        // Prisma on a nullable column: a NULL row is EXCLUDED from `{ not: x }`.
        return row[key] !== null && row[key] !== undefined && row[key] !== cond.not;
      }
      if ("has" in cond) {
        return Array.isArray(row[key]) && row[key].includes(cond.has);
      }
      if ("in" in cond) {
        return cond.in.includes(row[key]);
      }
    }
    return (row[key] ?? null) === cond;
  });
}

export type CIParkRouteHarness = ReturnType<typeof makeCIParkPrismaMocks>;

/**
 * In-memory `@/lib/prisma` stand-in: prFixQueueItem rows, the
 * PrFixCIParkLedger table (duplicate creates throw a real P2002-shaped
 * error), and the audit log. `$transaction` passes the store through, so the
 * production code paths run unmocked.
 */
export function makeCIParkPrismaMocks() {
  const items: any[] = [];
  const ledger: any[] = [];
  const audits: any[] = [];

  /** A queue row with all pre-#495 defaults (deferral columns null). */
  const makeItem = (overrides: Record<string, unknown> = {}) => ({
    id: "fix-1",
    repo: "acme/widgets",
    pr: 77,
    issue: null,
    lane: "NORMAL",
    type: "OTHER",
    status: "QUEUED",
    reason: "review changes requested",
    feedback: [],
    evidenceKeys: [],
    generation: 3,
    queuedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    author: "bot",
    agentHandouts: [],
    handoutAcks: [],
    ciParkState: null,
    ciParkHead: null,
    ciParkKey: null,
    ciParkFence: null,
    ciParkAt: null,
    ...overrides,
  });

  const prisma = {
    prFixQueueItem: {
      findMany: vi.fn(async ({ where }: any) => items.filter((row) => matchesCIParkWhere(row, where))),
      findUnique: vi.fn(async ({ where }: any) => items.find((row) => row.id === where.id) ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of items) {
          if (!matchesCIParkWhere(row, where)) continue;
          count++;
          Object.assign(row, data, { updatedAt: new Date("2026-01-02T00:00:00Z") });
        }
        return { count };
      }),
    },
    prFixCIParkLedger: {
      findUnique: vi.fn(async ({ where }: any) => {
        const w = where.itemId_kind_key;
        return ledger.find((row) => row.itemId === w.itemId && row.kind === w.kind && row.key === w.key) ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        if (ledger.some((row) => row.itemId === data.itemId && row.kind === data.kind && row.key === data.key)) {
          throw p2002Error();
        }
        const row = { id: `ledger-${ledger.length + 1}`, createdAt: new Date("2026-01-01T00:00:00Z"), ...data };
        ledger.push(row);
        return row;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `audit-${audits.length + 1}`, ...data };
        audits.push(row);
        return row;
      }),
    },
    $transaction: async (fn: any) => fn(prisma),
  };

  return { prisma, items, ledger, audits, makeItem };
}
