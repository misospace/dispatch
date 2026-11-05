/**
 * In-memory `ExternalContributionRequest` delegate shared by the external-
 * contribution test harnesses (#1537 / #1556 review).
 *
 * The submission state machine's concurrency behavior (atomic in-flight claim,
 * lease staleness, token-guarded settlement) lives in conditional Prisma
 * `updateMany` calls, so the test double must evaluate the same predicates
 * faithfully — including `OR`/`AND` nesting, `{ lt }` comparisons with real
 * Date semantics, `{ increment }` writes, and SQL-NULL rules (a NULL column
 * never satisfies a comparison or an equality against a value). Production
 * code is exercised unmocked; only the store is simulated.
 *
 * Safe to reference from inside hoisted `vi.mock()` factories (same reasoning
 * as `route-helpers.ts`): factory bodies run lazily, after this module is
 * initialized.
 */
import { Prisma } from "@prisma/client";

/** The ledger row shape the state machine reads and writes. */
export interface ContributionLedgerRow {
  id: string;
  idempotencyKey: string;
  createdBy: string;
  namespace: string;
  lane: string;
  baseRepo: string;
  baseRef: string;
  workRepo: string;
  goal: string;
  upstreamIssue: string | null;
  payloadDigest: string;
  deliveryStatus: string;
  courierRun: string | null;
  courierNamespace: string | null;
  courierWorkItemId: string | null;
  resumed: boolean | null;
  courierHttpStatus: number | null;
  lastError: string | null;
  attemptCount: number;
  lastAttemptAt: Date | null;
  inFlightUntil: Date | null;
  attemptToken: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type Where = Record<string, unknown>;
type Row = ContributionLedgerRow & Record<string, unknown>;

/** Three-valued compare with Date support; returns -1/0/1. */
function compare(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : (a as number);
  const bv = b instanceof Date ? b.getTime() : (b as number);
  return av === bv ? 0 : av < bv ? -1 : 1;
}

/**
 * Evaluate a Prisma-style where clause against one row. NULL columns match
 * only a `null` equality, mirroring SQL: `inFlightUntil: { lt: now }` never
 * matches a row whose lease is unset.
 */
function matchesWhere(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === "AND") return (cond as Where[]).every((c) => matchesWhere(row, c));
    if (key === "OR") return (cond as Where[]).some((c) => matchesWhere(row, c));
    if (key === "NOT") return !matchesWhere(row, cond as Where);
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Where;
      if (value === null || value === undefined) return false; // SQL NULL
      if ("in" in c) return (c.in as unknown[]).some((v) => compare(value, v) === 0);
      if ("lt" in c) return compare(value, c.lt) < 0;
      if ("lte" in c) return compare(value, c.lte) <= 0;
      if ("gt" in c) return compare(value, c.gt) > 0;
      if ("gte" in c) return compare(value, c.gte) >= 0;
      if ("not" in c) return compare(value, c.not) !== 0;
      return false;
    }
    if (value === null || value === undefined) return cond === null;
    return compare(value, cond) === 0;
  });
}

/** Apply an updateMany/update payload, honoring `{ increment: N }`. */
function applyData(row: Row, data: Where): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && !(value instanceof Date) && "increment" in value) {
      row[key] = (row[key] as number) + ((value as { increment: number }).increment as number);
    } else {
      row[key] = value;
    }
  }
  row.updatedAt = new Date();
}

export interface ContributionLedger {
  /** Prisma-delegate-shaped store for `externalContributionRequest`. */
  delegate: {
    findUnique(args: { where: Where }): Promise<ContributionLedgerRow | null>;
    create(args: { data: Where }): Promise<ContributionLedgerRow>;
    update(args: { where: { id: string }; data: Where }): Promise<ContributionLedgerRow>;
    updateMany(args: { where: Where; data: Where }): Promise<{ count: number }>;
  };
  rows: ContributionLedgerRow[];
  /** Mutation log ("create", "updateMany", "update") for ordering assertions. */
  calls: string[];
  /** Make findUnique miss once, so create hits the unique constraint (lost create race). */
  setLostCreateRace(active: boolean): void;
  /** Plant a fully-formed row (defaults match the canonical baseline body). */
  plantRow(overrides?: Partial<ContributionLedgerRow>): ContributionLedgerRow;
  reset(): void;
}

/** Build a fresh in-memory ledger (call once per test file/harness). */
export function createContributionLedger(): ContributionLedger {
  const rows: ContributionLedgerRow[] = [];
  const calls: string[] = [];
  let rowSeq = 0;
  let loseNextFindUnique = false;

  const findUnique = async ({ where }: { where: Where }) => {
    if (loseNextFindUnique) {
      loseNextFindUnique = false;
      return null; // simulate reading before a concurrent winner landed
    }
    if (typeof where.idempotencyKey === "string") {
      return rows.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null;
    }
    if (typeof where.id === "string") {
      return rows.find((r) => r.id === where.id) ?? null;
    }
    return null;
  };

  return {
    rows,
    calls,
    setLostCreateRace(active: boolean) {
      loseNextFindUnique = active;
    },
    plantRow(overrides: Partial<ContributionLedgerRow> = {}) {
      const now = new Date();
      const row: ContributionLedgerRow = {
        id: `row-${++rowSeq}`,
        idempotencyKey: "planted-key",
        createdBy: "operator",
        namespace: "team-alpha",
        lane: "contribution",
        baseRepo: "acme/widgets",
        baseRef: "main",
        workRepo: "acme/widgets-fork",
        goal: "Add a widget",
        upstreamIssue: null,
        payloadDigest: "",
        deliveryStatus: "pending",
        courierRun: null,
        courierNamespace: null,
        courierWorkItemId: null,
        resumed: null,
        courierHttpStatus: null,
        lastError: null,
        attemptCount: 0,
        lastAttemptAt: null,
        inFlightUntil: null,
        attemptToken: null,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      };
      rows.push(row);
      return row;
    },
    reset() {
      rows.splice(0, rows.length);
      calls.splice(0, calls.length);
      loseNextFindUnique = false;
    },
    delegate: {
      findUnique,
      async create({ data }: { data: Where }) {
        calls.push("create");
        if (rows.some((r) => r.idempotencyKey === data.idempotencyKey)) {
          // Faithful to the unique idempotencyKey constraint.
          throw new Prisma.PrismaClientKnownRequestError(
            "Unique constraint failed on the fields: (`ExternalContributionRequest.idempotencyKey`)",
            { code: "P2002", clientVersion: "test" },
          );
        }
        const now = new Date();
        const row = {
          id: `row-${++rowSeq}`,
          courierRun: null,
          courierNamespace: null,
          courierWorkItemId: null,
          resumed: null,
          courierHttpStatus: null,
          lastError: null,
          lastAttemptAt: null,
          inFlightUntil: null,
          attemptToken: null,
          ...data,
          createdAt: now,
          updatedAt: now,
        } as Row;
        rows.push(row);
        return row;
      },
      async update({ where, data }: { where: { id: string }; data: Where }) {
        calls.push("update");
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error("row not found");
        applyData(row as Row, data);
        return row;
      },
      async updateMany({ where, data }: { where: Where; data: Where }) {
        calls.push("updateMany");
        let count = 0;
        for (const row of rows) {
          if (!matchesWhere(row as Row, where)) continue;
          applyData(row as Row, data);
          count += 1;
        }
        return { count };
      },
    },
  };
}
