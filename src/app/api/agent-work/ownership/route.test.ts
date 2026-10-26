import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authedRequest,
  makeDispatchEnvMock,
  TEST_AGENT_TOKEN as mockToken,
} from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

// Maintainer (default token), a legacy unbound worker token, and two bound
// worker credentials (#1129 identity-scope matrix for the ownership route).
vi.mock("@/lib/dispatch-env", () =>
  makeDispatchEnvMock(
    mockToken,
    { "unbound-worker-token": "worker" },
    { "bound-alpha-token": "alpha", "bound-beta-token": "beta" },
  ),
);

const { mocks, db, applyData } = vi.hoisted(() => {
  // Mirrors Prisma's `{ increment: n }` update input on the in-memory lease.
  const applyData = (lease: any, data: Record<string, unknown>) => {
    const next = { ...lease };
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && typeof value === "object" && "increment" in value) {
        next[key] = (typeof next[key] === "number" ? next[key] : 0) + (value as { increment: number }).increment;
      } else {
        next[key] = value;
      }
    }
    return next;
  };
  return {
    applyData,
    mocks: {
      guardBusy: false,
      // One-shot write-failure injection: the named delegate throws the first
      // time it is reached after being armed, so the retry runs clean.
      failAt: null as null | "agentWork.update" | "agentWorkHistory.create" | "lifecycle" | "audit",
    },
    db: {
      issue: null as any,
      lease: null as any,
      agentWork: null as any,
      // Additional active AgentWork rows sharing the (agent, issue) pair —
      // an older BLOCKED row survives a new start, so several active rows
      // coexist and the CURRENT claim's work must be picked by freshness,
      // not pool position (#1251 review).
      agentWorkRows: [] as any[],
      agentWorkUpdates: [] as any[],
      agentWorkHistory: [] as any[],
      leaseUpdates: [] as any[],
      updateManyCount: undefined as number | undefined,
      audit: [] as any[],
      lifecycleEvents: [] as any[],
      txCount: 0,
      // Every mutating delegate call, tagged with the client it was issued
      // through: "prisma" (root) or "tx#<n>" (a transaction client). The
      // atomicity assertions read this to prove each write actually rode the
      // transaction rather than the ambient root client.
      writes: [] as Array<{ op: string; client: string }>,
    },
  };
});

// Pass-through guard (capacity-handoff convention); flip `mocks.guardBusy`
// to exercise the busy branch.
vi.mock("@/lib/issue-mutation-guard", () => ({
  withIssueMutationGuard: async (_request: unknown, callback: any) => {
    if (mocks.guardBusy) return { status: "busy", ownerToken: "other-owner", operation: "ownership" };
    const result = await callback(undefined, { resuming: false });
    return { status: result.complete ? "completed" : "retained", value: result.value };
  },
}));

vi.mock("@/lib/prisma", () => {
  const maybeFail = (point: string) => {
    if (mocks.failAt !== point) return;
    mocks.failAt = null;
    // Arranged BEFORE the throw and issued through the ROOT client, i.e. an
    // out-of-transaction write that must survive the rollback.
    client.auditLog.create({ data: { action: "ambient_out_of_transaction" } });
    throw new Error(`injected failure at ${point}`);
  };

  type Undo = () => void;

  /**
   * Build a client over the shared in-memory store.
   *
   * `journal` is what makes `$transaction` honest: only a client handed a
   * journal registers its writes as undoable, and a rollback replays that
   * journal alone. The root client has no journal, so a write issued through it
   * is NOT rolled back — which means swapping `tx.*` for `prisma.*` inside a
   * transaction leaves real writes behind and the atomicity assertions fail,
   * rather than passing on a mock that made both spellings equivalent.
   */
  // Sorts the active-row pool exactly like `orderBy` does in the database:
  // the keys apply IN ORDER; `Date`s compare by instant, strings lexically.
  // A key or direction this helper does not implement throws, so a selection
  // rule change in production cannot silently read as "pool order won".
  const compareRows = (orderBy: unknown) => {
    const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, "asc" | "desc">>;
    return (a: any, b: any) => {
      for (const spec of specs) {
        for (const [key, direction] of Object.entries(spec)) {
          if (direction !== "desc" && direction !== "asc") {
            throw new Error(`test fake: unsupported orderBy direction ${String(direction)}`);
          }
          const left = a[key];
          const right = b[key];
          if (left === undefined || right === undefined) {
            throw new Error(`test fake: orderBy on missing field ${key}`);
          }
          let cmp = 0;
          if (left instanceof Date || right instanceof Date) {
            if (!(left instanceof Date) || !(right instanceof Date)) {
              throw new Error(`test fake: mixed Date/plain comparison on ${key}`);
            }
            cmp = left.getTime() - right.getTime();
          } else if (typeof left === "number" && typeof right === "number") {
            cmp = left - right;
          } else {
            cmp = String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
          }
          if (cmp !== 0) return direction === "desc" ? -cmp : cmp;
        }
      }
      return 0;
    };
  };

  const makeClient = (tag: string, journal: Undo[] | null) => {
    const note = (op: string) => {
      db.writes.push({ op, client: tag });
    };
    // Pushing onto a bookkeeping array and undoing that push are one write.
    const pushRow = (op: string, rows: any[], row: any) => {
      const length = rows.length;
      note(op);
      journal?.push(() => {
        rows.length = length;
      });
      rows.push(row);
    };

    return {
      issue: {
        findUnique: async ({ where }: any) =>
          db.issue && db.issue.id === where.id ? db.issue : null,
      },
      lease: {
        findUnique: async ({ where }: any) => {
          if (where.agentName_issueId) {
            const { agentName, issueId } = where.agentName_issueId;
            return db.lease && db.lease.agentName === agentName && db.lease.issueId === issueId
              ? db.lease
              : null;
          }
          return db.lease && db.lease.id === where.id ? db.lease : null;
        },
        // Honors a claim-token fence in `where` the way Prisma does: no match
        // means the row does not carry that token.
        update: async ({ where, data }: any) => {
          if (where.claimToken !== undefined && db.lease && db.lease.claimToken !== where.claimToken) {
            throw new Error(`lease ${where.id} does not carry claim token ${where.claimToken}`);
          }
          if (db.lease && db.lease.id === where.id) {
            const previous = db.lease;
            pushRow("lease.update", db.leaseUpdates, { where, data });
            db.lease = applyData(db.lease, data);
            journal?.push(() => {
              db.lease = previous;
            });
          }
          return db.lease;
        },
        // Honors the fenced compare-and-set (id + claimToken + null disposition).
        updateMany: async ({ where, data }: any) => {
          if (db.updateManyCount !== undefined) return { count: db.updateManyCount };
          if (!db.lease || db.lease.id !== where.id) return { count: 0 };
          if (where.claimToken !== undefined && db.lease.claimToken !== where.claimToken) return { count: 0 };
          if (where.disposition !== undefined && db.lease.disposition !== where.disposition) return { count: 0 };
          const previous = db.lease;
          note("lease.updateMany");
          journal?.push(() => {
            db.lease = previous;
          });
          db.lease = applyData(db.lease, data);
          return { count: 1 };
        },
      },
      agentWork: {
        findFirst: async ({ where, orderBy }: any) => {
          const pool = [db.agentWork, ...db.agentWorkRows].filter(Boolean);
          const matches = pool.filter(
            (row: any) =>
              row.agentName === where.agentName &&
              row.issueId === where.issueId &&
              (!where.state?.in || where.state.in.includes(row.state)),
          );
          if (matches.length === 0) return null;
          if (orderBy) matches.sort(compareRows(orderBy));
          return matches[0];
        },
        update: async ({ where, data }: any) => {
          maybeFail("agentWork.update");
          if (db.agentWork && db.agentWork.id === where.id) {
            const previous = db.agentWork;
            pushRow("agentWork.update", db.agentWorkUpdates, { where, data });
            db.agentWork = { ...db.agentWork, ...data };
            journal?.push(() => {
              db.agentWork = previous;
            });
            return db.agentWork;
          }
          const pooled = db.agentWorkRows.find((row: any) => row.id === where.id);
          if (pooled) {
            const previous = { ...pooled };
            pushRow("agentWork.update", db.agentWorkUpdates, { where, data });
            Object.assign(pooled, data);
            journal?.push(() => {
              Object.assign(pooled, previous);
            });
            return pooled;
          }
          return db.agentWork;
        },
      },
      agentWorkHistory: {
        create: async ({ data }: any) => {
          maybeFail("agentWorkHistory.create");
          pushRow("agentWorkHistory.create", db.agentWorkHistory, data);
          return data;
        },
      },
      auditLog: {
        create: async ({ data }: any) => {
          maybeFail("audit");
          pushRow("auditLog.create", db.audit, data);
          return data;
        },
      },
      issueLifecycleEvent: {
        create: async ({ data }: any) => {
          maybeFail("lifecycle");
          pushRow("issueLifecycleEvent.create", db.lifecycleEvents, data);
          return data;
        },
        // A dedupe hit writes nothing at all, so it is not recorded either.
        upsert: async ({ where, create }: any) => {
          maybeFail("lifecycle");
          const existing = db.lifecycleEvents.find((e) => e.dedupeKey === where.dedupeKey);
          if (existing) return existing;
          pushRow("issueLifecycleEvent.upsert", db.lifecycleEvents, create);
          return create;
        },
      },
    };
  };

  // The root client carries no journal: nothing it writes is undoable.
  const client: any = makeClient("prisma", null);

  // Interactive transaction over a DISTINCT client object. A write only lands
  // in the store through the transaction client and only that client's writes
  // are undone when the callback throws — so the suite proves the lease CAS,
  // the AgentWork settlement, its history, the lifecycle event and the audit
  // row all ride this transaction (#1251 review MAJOR), and that a rollback
  // leaves writes made outside it alone.
  client.$transaction = async (fn: (tx: any) => Promise<any>) => {
    db.txCount += 1;
    const journal: Undo[] = [];
    try {
      return await fn(makeClient(`tx#${db.txCount}`, journal));
    } catch (error) {
      for (let i = journal.length - 1; i >= 0; i -= 1) journal[i]();
      throw error;
    }
  };

  return { prisma: client };
});

import { POST } from "./route";
import { upsertLease } from "@/lib/lease";
import { sweepStaleWork, type StaleWorkClient } from "@/lib/stale-work";
import { getAuthorizedActor, authorizeRequest, resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";
import { lifecycleDedupeKey } from "@/lib/issue-lifecycle";

const URL = "http://localhost/api/agent-work/ownership";
const AGENT = "alpha";
const CLAIM_TOKEN = "SECRET-CLAIM-TOKEN-123";
const inMin = (n: number) => new Date(Date.now() + n * 60_000);

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "iss1",
    number: 7,
    state: "open",
    labels: ["agent/alpha"],
    blockedReason: null,
    linkedPrNumber: null,
    linkedPrMergeState: null,
    repository: { fullName: "acme/widgets" },
    ...overrides,
  };
}

function makeLease(overrides: Record<string, unknown> = {}) {
  return {
    id: "lease-1",
    agentName: AGENT,
    issueId: "iss1",
    claimToken: CLAIM_TOKEN,
    expiredAt: inMin(30),
    renewedAt: null,
    registeredAt: null,
    registrationOccurredAt: null,
    renewCount: 0,
    lastRenewalObservedAt: null,
    lastRenewalOccurredAt: null,
    retryAfter: null,
    waitReason: null,
    disposition: null,
    dispositionNote: null,
    successorRef: null,
    dispositionOccurredAt: null,
    dispositionObservedAt: null,
    runRef: null,
    createdAt: inMin(-1),
    ...overrides,
  };
}

function makeAgentWork(overrides: Record<string, unknown> = {}) {
  return {
    id: "work-1",
    agentName: AGENT,
    issueId: "iss1",
    state: "IN_PROGRESS",
    lastHeartbeatAt: inMin(-2),
    // The stale-work sweeper reads both timestamps: a row is reclaimed only
    // when its heartbeat fell past the cutoff AND its lease expiry is not
    // live (#1418) — silence alone is not abandonment while the lease stands.
    leaseExpiresAt: inMin(5),
    staleClaimReleasePending: false,
    blockerReason: null,
    // The current-claim-work tie-break sorts on `createdAt` when heartbeats
    // tie, so every row needs one.
    createdAt: inMin(-3),
    ...overrides,
  };
}

// ─── Stale-work eligibility helpers (#1251) ─────────────────────────────────
//
// The sweeper selects its reclaim candidates with a WHERE clause over the
// AgentWork row (`state`, `staleClaimReleasePending`, `lastHeartbeatAt`,
// `leaseExpiresAt`). These helpers answer that clause against a row in
// memory, so the sweeper's REAL candidate selection can be exercised without
// a database — the clause is the one `sweepStaleWork` actually passes, not a
// hand-copied predicate.

/** The clause keys the sweeper's WHERE clause is allowed to use. */
const SWEEP_CLAUSE_KEYS = new Set([
  "OR",
  "AND",
  "state",
  "staleClaimReleasePending",
  "lastHeartbeatAt",
  "leaseExpiresAt",
]);

/**
 * Evaluate the operators the sweep's clause uses. A clause key or operator
 * this evaluator does not implement (`NOT`, `NOT_IN`, `gte`, …) throws, so
 * the fake can never silently disagree with the clause — an unimplemented
 * clause must not read as "no candidates".
 */
function matchesWhere(row: Record<string, unknown>, where: unknown): boolean {
  if (where === null || typeof where !== "object") return true;
  for (const [key, cond] of Object.entries(where as Record<string, unknown>)) {
    if (key === "OR") {
      const clauses = cond as unknown[];
      if (!clauses.some((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    if (key === "AND") {
      const clauses = cond as unknown[];
      if (!clauses.every((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    if (!SWEEP_CLAUSE_KEYS.has(key)) {
      throw new Error(`test fake: unsupported where clause key ${key}`);
    }
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      for (const [op, operand] of Object.entries(cond as Record<string, unknown>)) {
        if (op === "in") {
          if (!Array.isArray(operand) || !operand.includes(value)) return false;
        } else if (op === "lt") {
          const left = value instanceof Date ? value.getTime() : value;
          const right = operand instanceof Date ? operand.getTime() : operand;
          if (typeof left !== "number" || typeof right !== "number" || !(left < right)) return false;
        } else {
          throw new Error(`test fake: unsupported where operator ${key}.${op}`);
        }
      }
      continue;
    }
    // Scalar equality: `state: "STALE"`, `staleClaimReleasePending: false`.
    if (value !== cond) return false;
  }
  return true;
}

/**
 * A sweep client whose `agentWork.findMany` evaluates the sweep's own clause
 * against the row it is handed — the row the renewal actually wrote.
 *
 * The mark transaction is inert on purpose: the controls below only have to
 * prove the sweeper SELECTED a row, never to release it (no forge call, no
 * label write, no lease delete).
 */
function makeSweepClient(getRow: () => Record<string, unknown> | null) {
  const capturedClauses: unknown[] = [];
  const client = {
    agentWork: {
      findMany: vi.fn(async (args: any) => {
        capturedClauses.push(args.where);
        const row = getRow();
        if (!row) return [];
        return matchesWhere(row, args.where) ? [row] : [];
      }),
    },
    issue: {
      update: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => ({ labels: [] })),
    },
    lease: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      // The parked-claim pre-filter: no lease in this fake carries a running
      // wait marker, so nothing is parked.
      findMany: vi.fn(async () => []),
    },
    // #1254: the sweep defers to pending reconciler release intents.
    ownershipReleaseIntent: { findMany: vi.fn(async () => []) },
    agentWorkHistory: { create: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async () => false),
  };
  return { client: client as unknown as StaleWorkClient, capturedClauses };
}

function post(
  body: Record<string, unknown>,
  opts: { token?: string; includeAuth?: boolean } = {},
) {
  return POST(
    authedRequest(URL, {
      method: "POST",
      token: opts.token,
      includeAuth: opts.includeAuth,
      body,
    }),
  );
}

function baseBody(overrides: Record<string, unknown> = {}) {
  return { agentName: AGENT, issueId: "iss1", claimToken: CLAIM_TOKEN, ...overrides };
}

function seedDb() {
  db.issue = makeIssue();
  db.lease = makeLease();
  db.agentWork = null;
  db.agentWorkRows = [];
  db.agentWorkUpdates = [];
  db.agentWorkHistory = [];
  db.leaseUpdates = [];
  db.updateManyCount = undefined;
  db.audit = [];
  db.lifecycleEvents = [];
  db.txCount = 0;
  db.writes = [];
  mocks.failAt = null;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAuthCaches();
  resetRateLimits();
  delete process.env.DISPATCH_AUTH_MODE;
  mocks.guardBusy = false;
  seedDb();
});

describe("POST /api/agent-work/ownership — auth", () => {
  it("returns 401 when no authorization header is provided", async () => {
    const res = await post(baseBody({ operation: "register" }), { includeAuth: false });
    expect(res.status).toBe(401);
  });

  it("refuses a bound worker acting for another agent with 403 and no writes", async () => {
    const res = await post(baseBody({ operation: "register" }), { token: "bound-beta-token" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('bound to agent "beta"');
    expect(body.error).toContain('"alpha"');
    expect(db.lease.registeredAt).toBeNull();
    expect(db.lease.disposition).toBeNull();
    expect(db.leaseUpdates).toHaveLength(0);
    expect(db.lifecycleEvents).toHaveLength(0);
    expect(db.audit.filter((a) => a.action.startsWith("ownership_"))).toHaveLength(0);
    // The only side effect is the best-effort scope-denial audit row.
    expect(db.audit.some((a) => a.action === "worker_scope_denied")).toBe(true);
  });

  it("refuses the legacy unbound worker token with 403", async () => {
    const res = await post(baseBody({ operation: "register" }), { token: "unbound-worker-token" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/not bound to an agent/i);
    expect(db.lease.registeredAt).toBeNull();
    expect(db.audit.some((a) => a.action === "worker_scope_denied")).toBe(true);
  });

  it("lets a bound worker operate for its own agent", async () => {
    const res = await post(baseBody({ operation: "register" }), { token: "bound-alpha-token" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.operation).toBe("register");
  });

  it("lets a maintainer record for a named agent, auditing as the resolved actor", async () => {
    const req = authedRequest(URL, { method: "POST", body: baseBody({ operation: "register" }) });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const auth = await authorizeRequest(req);
    expect(auth.authorized).toBe(true);
    const expectedActor = getAuthorizedActor(auth, req, AGENT);
    // A maintainer bearer has no bound identity: the named agent is the
    // fallback actor, per getAuthorizedActor in src/lib/auth.ts.
    expect(expectedActor).toBe(AGENT);
    const row = db.audit.find((a) => a.action === "ownership_register");
    expect(row).toBeDefined();
    expect(row.actor).toBe(expectedActor);
  });
});

describe("POST /api/agent-work/ownership — register", () => {
  it("records registration on the lease, one lifecycle event, and an audit row", async () => {
    const before = Date.now();
    const res = await post(baseBody({ operation: "register", runRef: "run-77" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.replayed).toBe(false);
    expect(body.leaseId).toBe("lease-1");
    expect(body.expiresAt).toBe(db.lease.expiredAt.toISOString());
    expect(body.registeredAt).toBe(db.lease.registeredAt.toISOString());
    expect(body.registrationOccurredAt).toBe(db.lease.registrationOccurredAt.toISOString());
    const elapsed = new Date(body.registeredAt).getTime() - before;
    expect(elapsed).toBeGreaterThanOrEqual(-1000);
    expect(elapsed).toBeLessThanOrEqual(15_000);

    expect(db.lease.registeredAt).toBeInstanceOf(Date);
    expect(db.lease.registrationOccurredAt).toBeInstanceOf(Date);
    expect(db.lease.runRef).toBe("run-77");

    expect(db.lifecycleEvents).toHaveLength(1);
    const [event] = db.lifecycleEvents;
    expect(event.kind).toBe("ownership_registered");
    expect(event.source).toBe("api:ownership");
    expect(event.actor).toBe(AGENT);
    expect(event.agentName).toBe(AGENT);
    expect(event.repoFullName).toBe("acme/widgets");
    expect(event.issueNumber).toBe(7);
    const expectedDedupeKey = lifecycleDedupeKey("ownership_registered", "iss1", AGENT, CLAIM_TOKEN);
    expect(event.dedupeKey).toBe(expectedDedupeKey);
    expect(event.dedupeKey).toContain("iss1");
    expect(event.dedupeKey).toContain(AGENT);
    expect(event.dedupeKey).toContain(CLAIM_TOKEN);
    expect(event.metadata.runRef).toBe("run-77");

    const audit = db.audit.find((a) => a.action === "ownership_register");
    expect(audit).toBeDefined();
    expect(audit.actor).toBe(AGENT);
    expect(audit.repoFullName).toBe("acme/widgets");
    expect(audit.issueNumber).toBe(7);
    expect(audit.success).toBe(true);
    expect(audit.notes).toBe("runRef=run-77");
  });

  it("returns 409 no_active_claim when the issue has no lease", async () => {
    db.lease = null;
    const res = await post(baseBody({ operation: "register" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("no_active_claim");
    expect(body.error).toBeTruthy();
    expect(db.audit).toHaveLength(0);
  });

  it("returns 409 stale_claim_token for a mismatched token and leaves the lease untouched", async () => {
    const res = await post(baseBody({ operation: "register", claimToken: "SOME-OTHER-TOKEN" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("stale_claim_token");
    expect(body.error).toBeTruthy();
    expect(db.lease.registeredAt).toBeNull();
    expect(db.lease.disposition).toBeNull();
    expect(db.leaseUpdates).toHaveLength(0);
    expect(db.lifecycleEvents).toHaveLength(0);
    expect(db.audit).toHaveLength(0);
  });

  it("returns 409 stale_claim_token for a lease with no claim token (pre-#1256 claim)", async () => {
    db.lease = makeLease({ claimToken: null });
    const res = await post(baseBody({ operation: "register" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("stale_claim_token");
    expect(db.leaseUpdates).toHaveLength(0);
    expect(db.lifecycleEvents).toHaveLength(0);
  });

  it("returns 409 disposed when the lease already carries a terminal disposition", async () => {
    db.lease = makeLease({ disposition: "completed" });
    const res = await post(baseBody({ operation: "register" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("disposed");
  });

  it("dedupes a replayed register on the claim token (one lifecycle event)", async () => {
    const first = await post(baseBody({ operation: "register", runRef: "run-1" }));
    const replay = await post(baseBody({ operation: "register", runRef: "run-1" }));
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect((await replay.json()).ok).toBe(true);
    expect(db.lifecycleEvents).toHaveLength(1);
  });

  it("returns the persisted registration on a replay and writes nothing (#1251 review)", async () => {
    const first = await post(baseBody({ operation: "register", runRef: "run-1" }));
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const registeredAt = db.lease.registeredAt;
    const occurredAt = db.lease.registrationOccurredAt;
    expect(db.audit.filter((a) => a.action === "ownership_register")).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const replay = await post(baseBody({ operation: "register", runRef: "run-2" }));
    expect(replay.status).toBe(200);
    const replayBody = await replay.json();
    // Truthful replay: the same response shape as the first call, flagged as a
    // replay, carrying the FIRST registration's persisted values.
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.leaseId).toBe("lease-1");
    expect(replayBody.registeredAt).toBe(registeredAt.toISOString());
    expect(replayBody.registrationOccurredAt).toBe(occurredAt.toISOString());
    expect(replayBody.expiresAt).toBe(firstBody.expiresAt);
    // Not one write: no timestamp refresh, no run-reference overwrite, no
    // second lifecycle event, no second audit row.
    expect(db.lease.registeredAt).toEqual(registeredAt);
    expect(db.lease.registrationOccurredAt).toEqual(occurredAt);
    expect(db.lease.runRef).toBe("run-1");
    expect(db.leaseUpdates).toHaveLength(1);
    expect(db.lifecycleEvents).toHaveLength(1);
    expect(db.audit.filter((a) => a.action === "ownership_register")).toHaveLength(1);
  });

  it("fences the in-transaction registration write with the presented claim token (#1251 review)", async () => {
    const res = await post(baseBody({ operation: "register", runRef: "run-1" }));
    expect(res.status).toBe(200);
    // The lease update names the token, so a row that rotated to a fresh
    // attempt under it can never be stamped with a retired registration.
    expect(db.leaseUpdates).toHaveLength(1);
    expect(db.leaseUpdates[0].where).toEqual({ id: "lease-1", claimToken: CLAIM_TOKEN });
    expect(db.lease.registeredAt).toBeInstanceOf(Date);
  });

  it("rejects an over-long runRef with 400", async () => {
    const res = await post(baseBody({ operation: "register", runRef: "x".repeat(501) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/runRef/);
  });

  it("rejects an unknown operation with 400", async () => {
    const res = await post(
      { operation: "explosify", agentName: AGENT, issueId: "iss1", claimToken: CLAIM_TOKEN },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid operation/);
  });
});

describe("POST /api/agent-work/ownership — renew", () => {
  it("extends the lease TTL, increments renewCount, and records renewal times", async () => {
    const before = Date.now();
    const res = await post(baseBody({ operation: "renew" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.leaseId).toBe("lease-1");
    expect(body.renewCount).toBe(1);
    expect(body.agentWorkHeartbeated).toBe(false);
    const delta = new Date(body.expiresAt).getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(30 * 60_000 - 10_000);
    expect(delta).toBeLessThanOrEqual(30 * 60_000 + 10_000);
    expect(body.lastRenewalObservedAt).toBeTruthy();
    expect(body.lastRenewalOccurredAt).toBeTruthy();
    expect(db.lease.renewCount).toBe(1);
    expect(db.lease.renewedAt).toBeInstanceOf(Date);
    expect(db.lease.lastRenewalObservedAt).toBeInstanceOf(Date);
    expect(db.lease.lastRenewalOccurredAt).toBeInstanceOf(Date);
  });

  it("accepts a renewal for a lapsed-but-present lease (late renewal)", async () => {
    db.lease = makeLease({ expiredAt: new Date(Date.now() - 5 * 60_000) });
    const res = await post(baseBody({ operation: "renew" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(db.lease.renewCount).toBe(1);
  });

  it("returns 409 stale_claim_token after the claim was re-issued a new token", async () => {
    const seeded = inMin(30);
    db.lease = makeLease({ claimToken: "FRESH-TOKEN-2", expiredAt: seeded });
    const res = await post(baseBody({ operation: "renew" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("stale_claim_token");
    // The fenced renewal must not have touched the live claim.
    expect(db.lease.expiredAt.getTime()).toBe(seeded.getTime());
    expect(db.lease.renewCount).toBe(0);
  });

  it("returns 409 disposed once the lease carries a terminal disposition", async () => {
    db.lease = makeLease({ disposition: "released" });
    const res = await post(baseBody({ operation: "renew" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("disposed");
  });

  it("returns 409 stale_claim_token when the compare-and-set matches nothing", async () => {
    db.updateManyCount = 0;
    const res = await post(baseBody({ operation: "renew" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("stale_claim_token");
    expect(body.error).toMatch(/concurrently/i);
  });

  it("heartbeats a matching active AgentWork row and writes history", async () => {
    db.agentWork = makeAgentWork();
    const res = await post(baseBody({ operation: "renew" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentWorkHeartbeated).toBe(true);
    expect(db.agentWorkUpdates).toHaveLength(1);
    expect(db.agentWorkUpdates[0].data.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(db.agentWorkHistory).toHaveLength(1);
    const [history] = db.agentWorkHistory;
    expect(history.workId).toBe("work-1");
    expect(history.action).toBe("ownership_renewed");
  });

  it("sets an external wait marker on the lease", async () => {
    const retryAfter = new Date(Date.now() + 3600_000);
    const res = await post(
      baseBody({ operation: "renew", externalWait: { reason: "waiting on infra", retryAfter: retryAfter.toISOString() } }),
    );
    expect(res.status).toBe(200);
    expect(db.lease.retryAfter).toEqual(retryAfter);
    expect(db.lease.waitReason).toBe("waiting on infra");
  });

  it("clears a previously set external wait when passed null", async () => {
    db.lease = makeLease({ retryAfter: inMin(60), waitReason: "waiting on infra" });
    const res = await post(baseBody({ operation: "renew", externalWait: null }));
    expect(res.status).toBe(200);
    expect(db.lease.retryAfter).toBeNull();
    expect(db.lease.waitReason).toBeNull();
  });

  it("preserves a valid past occurredAt in lastRenewalOccurredAt", async () => {
    const occurred = new Date(Date.now() - 5 * 60_000);
    const res = await post(baseBody({ operation: "renew", occurredAt: occurred.toISOString() }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lastRenewalOccurredAt).toBe(occurred.toISOString());
    expect(db.lease.lastRenewalOccurredAt).toEqual(occurred);
  });

  it("falls back to the server clock for a future occurredAt without rejecting", async () => {
    const future = new Date(Date.now() + 2 * 3600_000).toISOString();
    const before = Date.now();
    const res = await post(baseBody({ operation: "renew", occurredAt: future }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const got = new Date(body.lastRenewalOccurredAt).getTime();
    expect(got).toBeGreaterThan(before - 5000);
    expect(got).toBeLessThanOrEqual(before + 5000);
  });
});

describe("POST /api/agent-work/ownership — renew atomicity (#1315)", () => {
  // The renewal's fenced lease CAS and the matching AgentWork liveness write
  // are ONE local fact (#1315): the sweeper reclaims on `leaseExpiresAt` too,
  // so a crash between the two used to leave a renewed lease whose AgentWork
  // row still carried the old lapsed expiry — reclaimable, renewal lost. A
  // rolled-back renewal must never report success.
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  const assertRenewRolledBack = (seededExpiry: Date, seededHeartbeat: Date, seededRowExpiry: Date) => {
    // Lease: no renewal committed.
    expect(db.lease.renewCount).toBe(0);
    expect(db.lease.renewedAt).toBeNull();
    expect(db.lease.lastRenewalObservedAt).toBeNull();
    expect(db.lease.lastRenewalOccurredAt).toBeNull();
    expect(db.lease.expiredAt.getTime()).toBe(seededExpiry.getTime());
    // AgentWork: no liveness write survived either.
    expect(db.agentWorkUpdates).toHaveLength(0);
    expect(db.agentWorkHistory).toHaveLength(0);
    expect(db.agentWork.lastHeartbeatAt.getTime()).toBe(seededHeartbeat.getTime());
    expect(db.agentWork.leaseExpiresAt.getTime()).toBe(seededRowExpiry.getTime());
    // A rolled-back renewal answered nothing but the 500 (the injector's
    // ambient out-of-transaction audit row is not an ownership write).
    expect(db.audit.filter((a) => a.action.startsWith("ownership_"))).toHaveLength(0);
  };

  it("commits the lease CAS and the AgentWork liveness write through one transaction client", async () => {
    db.agentWork = makeAgentWork({ lastHeartbeatAt: inMin(-12), leaseExpiresAt: inMin(-10) });

    const res = await post(baseBody({ operation: "renew" }));
    expect(res.status).toBe(200);
    expect((await res.json()).agentWorkHeartbeated).toBe(true);
    expect(db.txCount).toBe(1);
    // Lease CAS, AgentWork heartbeat and its history all went out on the
    // transaction client — nothing escaped to the ambient root client.
    expect(db.writes.map((w) => w.op)).toEqual([
      "lease.updateMany",
      "agentWork.update",
      "agentWorkHistory.create",
    ]);
    expect(db.writes.filter((w) => w.client === "prisma")).toEqual([]);
  });

  it("rolls the lease CAS back when the AgentWork liveness write fails, and converges on retry", async () => {
    db.agentWork = makeAgentWork({ lastHeartbeatAt: inMin(-12), leaseExpiresAt: inMin(-10) });
    const seededExpiry = db.lease.expiredAt;
    const seededHeartbeat = db.agentWork.lastHeartbeatAt;
    const seededRowExpiry = db.agentWork.leaseExpiresAt;
    mocks.failAt = "agentWork.update";

    const failed = await post(baseBody({ operation: "renew" }));
    expect(failed.status).toBe(500);
    expect(db.txCount).toBe(1);
    assertRenewRolledBack(seededExpiry, seededHeartbeat, seededRowExpiry);

    // Renewals are idempotent by nature: the retry re-extends normally and
    // keeps the worker alive for the sweeper.
    const retry = await post(baseBody({ operation: "renew" }));
    expect(retry.status).toBe(200);
    const body = await retry.json();
    expect(body.renewCount).toBe(1);
    expect(body.agentWorkHeartbeated).toBe(true);
    expect(db.lease.renewCount).toBe(1);
    expect(db.agentWork.leaseExpiresAt.getTime()).toBe(db.lease.expiredAt.getTime());
  });

  it("rolls the heartbeat back as well when the history write fails after it", async () => {
    db.agentWork = makeAgentWork();
    const seededExpiry = db.lease.expiredAt;
    const seededHeartbeat = db.agentWork.lastHeartbeatAt;
    const seededRowExpiry = db.agentWork.leaseExpiresAt;
    mocks.failAt = "agentWorkHistory.create";

    const failed = await post(baseBody({ operation: "renew" }));
    expect(failed.status).toBe(500);
    expect(db.txCount).toBe(1);
    // The heartbeat HAD been written inside the transaction; the missing
    // history row rolls it back together with the lease CAS.
    assertRenewRolledBack(seededExpiry, seededHeartbeat, seededRowExpiry);
  });

  it("keeps the lost-race CAS first: a compare-and-set miss commits nothing and reports 409", async () => {
    db.agentWork = makeAgentWork();
    db.updateManyCount = 0;

    const res = await post(baseBody({ operation: "renew" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("stale_claim_token");
    // The CAS is the transaction's first statement, so the early return
    // committed an empty transaction: no heartbeat, no history.
    expect(db.writes).toEqual([]);
    expect(db.agentWorkUpdates).toHaveLength(0);
    expect(db.agentWorkHistory).toHaveLength(0);
  });
});

describe("POST /api/agent-work/ownership — renew keeps the worker alive for the stale-work sweep (#1251)", () => {
  // The sweeper reclaims an active AgentWork row only when its
  // `lastHeartbeatAt` fell past the cutoff AND its `leaseExpiresAt` is not
  // live (#1418). The AgentWork lease is the short one (5 minutes, set by
  // start/checkpoint), so a renewal that moved only the heartbeat would
  // shield the worker for barely the heartbeat window — the renewed expiry
  // is what buys the whole ownership TTL for a long-running worker that
  // keeps renewing.

  it("writes the renewed expiry and the operation clock onto the matching active AgentWork row", async () => {
    db.agentWork = makeAgentWork({ lastHeartbeatAt: inMin(-12), leaseExpiresAt: inMin(-10) });

    const res = await post(baseBody({ operation: "renew" }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(db.agentWorkUpdates).toHaveLength(1);
    const [update] = db.agentWorkUpdates;
    // The renewed ownership expiry — the very one the lease received.
    expect(update.data.leaseExpiresAt).toBeInstanceOf(Date);
    expect(update.data.leaseExpiresAt.getTime()).toBe(new Date(body.expiresAt).getTime());
    expect(update.data.leaseExpiresAt.getTime()).toBe(db.lease.expiredAt.getTime());
    // The operation's own clock, not a second `new Date()`.
    expect(update.data.lastHeartbeatAt.getTime()).toBe(db.lease.renewedAt.getTime());
    // And the row itself carries both.
    expect(db.agentWork.leaseExpiresAt.getTime()).toBe(update.data.leaseExpiresAt.getTime());
    expect(db.agentWork.lastHeartbeatAt.getTime()).toBe(update.data.lastHeartbeatAt.getTime());
  });

  it("leaves the renewed worker out of the stale-work sweeper's reclaim candidates", async () => {
    db.agentWork = makeAgentWork({ lastHeartbeatAt: inMin(-12), leaseExpiresAt: inMin(-10) });
    const res = await post(baseBody({ operation: "renew" }));
    expect(res.status).toBe(200);
    expect((await res.json()).agentWorkHeartbeated).toBe(true);

    // The row the renewal actually wrote.
    const renewedRow = db.agentWork;
    const { client, capturedClauses } = makeSweepClient(() => renewedRow);

    const report = await sweepStaleWork(client);

    // The sweeper's REAL candidate selection finds nothing to reclaim.
    expect(report.examined).toBe(0);
    expect(report.released).toBe(0);
    expect(report.skipped).toBe(0);
    expect(capturedClauses).toHaveLength(1);
  });

  it("negative control: the pre-renewal write shape IS selected by the same clause", async () => {
    db.agentWork = makeAgentWork({ lastHeartbeatAt: inMin(-12), leaseExpiresAt: inMin(-10) });
    const res = await post(baseBody({ operation: "renew" }));
    expect(res.status).toBe(200);

    const renewedRow = db.agentWork;
    const { client, capturedClauses } = makeSweepClient(() => renewedRow);
    await sweepStaleWork(client);
    const [clause] = capturedClauses;

    // The fully pre-renewal row (old heartbeat, old lapsed expiry): silence
    // without a live lease — reclaimable, exactly as before #1418.
    const preRenewalRow = { ...renewedRow, lastHeartbeatAt: inMin(-12), leaseExpiresAt: inMin(-10) };
    expect(matchesWhere(preRenewalRow, clause)).toBe(true);

    // The heartbeat-only pre-fix shape (fresh heartbeat, lapsed expiry) is
    // not reclaimable NOW — a fresh heartbeat is liveness on its own
    // (#1418) — but it ages into the cutoff within the 5-minute heartbeat
    // window, while the renewed row stays protected through the whole
    // renewed TTL. The expiry propagation is what buys the ownership window:
    const preFixRow = { ...renewedRow, leaseExpiresAt: inMin(-10) };
    expect(matchesWhere(preFixRow, clause)).toBe(false);
    expect(
      matchesWhere({ ...preFixRow, lastHeartbeatAt: inMin(-12) }, clause),
    ).toBe(true);
    // The renewed row is not reclaimable at any point inside the TTL.
    expect(matchesWhere(renewedRow, clause)).toBe(false);

    // The sweeper itself selects the aged pre-fix shape: examined 1 means the
    // clause returned it (the inert mark transaction keeps the release path
    // out of this control).
    const control = makeSweepClient(() => ({ ...preFixRow, lastHeartbeatAt: inMin(-12) }));
    const controlReport = await sweepStaleWork(control.client);
    expect(controlReport.examined).toBe(1);
    expect(controlReport.released).toBe(0);
  });
});

describe("stale-work clause evaluator (#1251)", () => {
  it("throws on a clause key or operator it does not implement, instead of reading as 'no candidates'", () => {
    // An unimplemented clause must not silently select nothing: the fake
    // would then agree with a clause it does not actually understand.
    expect(() => matchesWhere({ state: "IN_PROGRESS" }, { NOT: { state: "STALE" } })).toThrow(
      /unsupported where clause key/,
    );
    expect(() => matchesWhere({ state: "IN_PROGRESS" }, { state: { notIn: ["STALE"] } })).toThrow(
      /unsupported where operator/,
    );
  });
});

describe("POST /api/agent-work/ownership — disposition", () => {
  it("settles completed: terminal lease, DONE AgentWork, history, lifecycle, audit; lease retained", async () => {
    db.agentWork = makeAgentWork();
    const res = await post(
      baseBody({ operation: "disposition", disposition: "completed", note: "shipped and merged" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.replayed).toBe(false);
    expect(body.leaseId).toBe("lease-1");
    expect(body.disposition).toBe("completed");

    // The lease row is durable evidence — never deleted by a disposition.
    expect(db.lease).not.toBeNull();
    expect(db.lease.disposition).toBe("completed");
    expect(db.lease.dispositionNote).toBe("shipped and merged");
    expect(db.lease.dispositionOccurredAt).toBeInstanceOf(Date);
    expect(db.lease.dispositionObservedAt).toBeInstanceOf(Date);

    expect(db.agentWork.state).toBe("DONE");
    expect(db.agentWorkHistory).toHaveLength(1);
    const [history] = db.agentWorkHistory;
    expect(history.workId).toBe("work-1");
    expect(history.action).toBe("ownership_dispositioned");
    expect(history.state).toBe("DONE");

    expect(db.lifecycleEvents).toHaveLength(1);
    const [event] = db.lifecycleEvents;
    expect(event.kind).toBe("ownership_dispositioned");
    expect(event.dedupeKey).toBe(
      lifecycleDedupeKey("ownership_dispositioned", "iss1", AGENT, CLAIM_TOKEN, "completed"),
    );
    expect(event.metadata.disposition).toBe("completed");

    const audit = db.audit.find((a) => a.action === "ownership_disposition");
    expect(audit).toBeDefined();
    expect(audit.success).toBe(true);
  });

  it("settles the current claim's work, not an older active BLOCKED sibling (#1251 review)", async () => {
    // An older BLOCKED row survives `startAgentWork` while the current
    // IN_PROGRESS row owns the claim. A `completed` disposition must settle
    // the CURRENT claim's work — an unordered pick that terminalized the old
    // row would leave the live attempt active next to a terminal lease, and
    // replay would report success without ever finishing it.
    db.agentWork = makeAgentWork({ id: "work-current", state: "IN_PROGRESS", lastHeartbeatAt: inMin(-1) });
    db.agentWorkRows.push(
      makeAgentWork({
        id: "work-old-blocked",
        state: "BLOCKED",
        lastHeartbeatAt: inMin(-60),
        leaseExpiresAt: inMin(-55),
      }),
    );

    const res = await post(baseBody({ operation: "disposition", disposition: "completed" }));
    expect(res.status).toBe(200);

    expect(db.agentWorkUpdates).toHaveLength(1);
    expect(db.agentWorkUpdates[0].where.id).toBe("work-current");
    expect(db.agentWorkUpdates[0].data.state).toBe("DONE");
    expect(db.agentWork.state).toBe("DONE");
    const oldRow = db.agentWorkRows[0];
    expect(oldRow.state).toBe("BLOCKED");
    expect(db.agentWorkHistory).toHaveLength(1);
    expect(db.agentWorkHistory[0].workId).toBe("work-current");
    expect(db.agentWorkHistory[0].action).toBe("ownership_dispositioned");
  });

  it("picks the freshest active row regardless of which slot it lives in (#1251 review)", async () => {
    // The mirror arrangement: the OLD row is the primary one. Selection is
    // by freshness, never by pool position.
    db.agentWork = makeAgentWork({
      id: "work-old-blocked",
      state: "BLOCKED",
      lastHeartbeatAt: inMin(-60),
      leaseExpiresAt: inMin(-55),
    });
    const oldRow = db.agentWork;
    db.agentWorkRows.push(
      makeAgentWork({ id: "work-current", state: "IN_PROGRESS", lastHeartbeatAt: inMin(-1) }),
    );

    const res = await post(baseBody({ operation: "disposition", disposition: "released" }));
    expect(res.status).toBe(200);

    expect(db.agentWorkUpdates).toHaveLength(1);
    expect(db.agentWorkUpdates[0].where.id).toBe("work-current");
    expect(db.agentWorkUpdates[0].data.state).toBe("RELEASED");
    // The older row is untouched.
    expect(oldRow.state).toBe("BLOCKED");
    expect(db.agentWorkHistory[0].workId).toBe("work-current");
  });

  it("breaks freshness ties deterministically: createdAt, then id (#1251 review)", async () => {
    const tied = inMin(-2);
    db.agentWork = makeAgentWork({ id: "work-a", state: "IN_PROGRESS", lastHeartbeatAt: tied, createdAt: inMin(-90) });
    db.agentWorkRows.push(
      makeAgentWork({ id: "work-b", state: "IN_PROGRESS", lastHeartbeatAt: tied, createdAt: inMin(-5) }),
    );

    const res = await post(baseBody({ operation: "disposition", disposition: "completed" }));
    expect(res.status).toBe(200);
    expect(db.agentWorkUpdates).toHaveLength(1);
    expect(db.agentWorkUpdates[0].where.id).toBe("work-b");

    // Same heartbeat AND same createdAt: `id` decides, descending.
    seedDb();
    const tied2 = inMin(-2);
    db.agentWork = makeAgentWork({ id: "work-a", state: "IN_PROGRESS", lastHeartbeatAt: tied2, createdAt: tied2 });
    db.agentWorkRows.push(
      makeAgentWork({ id: "work-b", state: "IN_PROGRESS", lastHeartbeatAt: tied2, createdAt: tied2 }),
    );
    const second = await post(baseBody({ operation: "disposition", disposition: "completed" }));
    expect(second.status).toBe(200);
    expect(db.agentWorkUpdates).toHaveLength(1);
    expect(db.agentWorkUpdates[0].where.id).toBe("work-b");
  });

  it("heartbeats the freshest active row, not an older BLOCKED sibling (#1251 review)", async () => {
    // Renewal and disposition select through the same current-claim-work
    // rule, so the row a renewal protects is the row a disposition settles.
    db.agentWork = makeAgentWork({
      id: "work-old-blocked",
      state: "BLOCKED",
      lastHeartbeatAt: inMin(-60),
      leaseExpiresAt: inMin(-55),
    });
    const oldRow = db.agentWork;
    const oldHeartbeat = oldRow.lastHeartbeatAt;
    db.agentWorkRows.push(
      makeAgentWork({ id: "work-current", state: "IN_PROGRESS", lastHeartbeatAt: inMin(-1) }),
    );

    const res = await post(baseBody({ operation: "renew" }));
    expect(res.status).toBe(200);
    expect((await res.json()).agentWorkHeartbeated).toBe(true);

    expect(db.agentWorkUpdates).toHaveLength(1);
    expect(db.agentWorkUpdates[0].where.id).toBe("work-current");
    expect(db.agentWorkHistory).toHaveLength(1);
    expect(db.agentWorkHistory[0].workId).toBe("work-current");
    expect(oldRow.state).toBe("BLOCKED");
    expect(oldRow.lastHeartbeatAt).toBe(oldHeartbeat);
  });

  it("replays the same disposition idempotently", async () => {
    const first = await post(baseBody({ operation: "disposition", disposition: "completed" }));
    expect(first.status).toBe(200);
    const replay = await post(baseBody({ operation: "disposition", disposition: "completed" }));
    expect(replay.status).toBe(200);
    const body = await replay.json();
    expect(body.replayed).toBe(true);
    expect(body.disposition).toBe("completed");
    expect(db.lifecycleEvents).toHaveLength(1);
    expect(db.audit.filter((a) => a.action === "ownership_disposition")).toHaveLength(1);
  });

  it("rejects a different disposition after a terminal one", async () => {
    db.lease = makeLease({ disposition: "completed" });
    const res = await post(baseBody({ operation: "disposition", disposition: "blocked" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("disposition_conflict");
  });

  it("parks a blocked disposition with a future retryAfter", async () => {
    const retryAfter = new Date(Date.now() + 2 * 3600_000);
    const res = await post(
      baseBody({
        operation: "disposition",
        disposition: "blocked",
        note: "waiting on infra",
        retryAfter: retryAfter.toISOString(),
        waitReason: "infra cooldown",
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).disposition).toBe("blocked");
    expect(db.lease.disposition).toBe("blocked");
    expect(db.lease.retryAfter).toEqual(retryAfter);
    expect(db.lease.waitReason).toBe("infra cooldown");
  });

  it("parks the settled AgentWork row's lease expiry at the retryAfter deadline (#1316)", async () => {
    // The row carries the short execution expiry written by start/checkpoint.
    db.agentWork = makeAgentWork({ lastHeartbeatAt: inMin(-6), leaseExpiresAt: inMin(-1) });
    const retryAfter = new Date(Date.now() + 2 * 3600_000);

    const res = await post(
      baseBody({
        operation: "disposition",
        disposition: "blocked",
        note: "waiting on infra",
        retryAfter: retryAfter.toISOString(),
      }),
    );
    expect(res.status).toBe(200);

    expect(db.agentWorkUpdates).toHaveLength(1);
    const [update] = db.agentWorkUpdates;
    expect(update.where.id).toBe("work-1");
    expect(update.data.state).toBe("BLOCKED");
    // The park deadline written onto the lease is also written onto the row:
    // the stale-work sweep gates BLOCKED reclamation on that expiry, so the
    // parked claim cannot be reclaimed before the park expires (#1316).
    expect(update.data.leaseExpiresAt).toBeInstanceOf(Date);
    expect((update.data.leaseExpiresAt as Date).getTime()).toBe(retryAfter.getTime());
    expect(db.agentWork.state).toBe("BLOCKED");
    expect(db.agentWork.leaseExpiresAt.getTime()).toBe(retryAfter.getTime());

    // The sweeper leaves the parked row alone.
    const settledRow = db.agentWork;
    const { client, capturedClauses } = makeSweepClient(() => settledRow);
    const report = await sweepStaleWork(client);
    expect(report.examined).toBe(0);
    expect(report.released).toBe(0);

    // Forensic controls against the REAL clause, evaluated at the moment the
    // bug used to fire (~5 minutes after the disposition, worker silent):
    // the fixed row is still NOT selected…
    const [clause] = capturedClauses;
    const agedParkedRow = { ...settledRow, lastHeartbeatAt: inMin(-11) };
    expect(matchesWhere(agedParkedRow, clause)).toBe(false);
    // …while the pre-fix write shape (same aged row, old execution expiry
    // left in place) is selected and would have had its parked claim
    // destroyed.
    const agedPreFixRow = { ...agedParkedRow, leaseExpiresAt: inMin(-6) };
    expect(matchesWhere(agedPreFixRow, clause)).toBe(true);
    const control = makeSweepClient(() => agedPreFixRow);
    const controlReport = await sweepStaleWork(control.client);
    expect(controlReport.examined).toBe(1);
  });

  it("clears the settled row's park deadline when a blocked disposition has no retryAfter (#1316)", async () => {
    // The settled decision: no `retryAfter` means no deadline to park until —
    // no deadline parks nothing. The settlement must NOT leave the (still
    // future) execution expiry in place to masquerade as a park: it clears
    // the row's `leaseExpiresAt`, so the park-gated sweep family reclaims the
    // row through its NULL-deadline arm and the row can never ride a
    // park-shaped hold it had no deadline for.
    db.agentWork = makeAgentWork({ lastHeartbeatAt: inMin(-15), leaseExpiresAt: inMin(5) });

    const res = await post(
      baseBody({ operation: "disposition", disposition: "blocked", note: "stuck on a decision" }),
    );
    expect(res.status).toBe(200);
    expect(db.lease.retryAfter).toBeNull();
    expect(db.agentWork.state).toBe("BLOCKED");

    expect(db.agentWorkUpdates).toHaveLength(1);
    const [update] = db.agentWorkUpdates;
    expect(update.data.state).toBe("BLOCKED");
    // The NO-park write clears the row's deadline outright.
    expect(update.data.leaseExpiresAt).toBeNull();
    expect(db.agentWork.leaseExpiresAt).toBeNull();

    // Forensic controls against the REAL clause: the settled row (worker
    // silent, NULL deadline) IS selected by the sweeper…
    const settledRow = db.agentWork;
    const { client, capturedClauses } = makeSweepClient(() => settledRow);
    const report = await sweepStaleWork(client);
    expect(report.examined).toBe(1);
    const [clause] = capturedClauses;
    const agedSettledRow = { ...settledRow, lastHeartbeatAt: inMin(-11) };
    expect(matchesWhere(agedSettledRow, clause)).toBe(true);
    // …while the pre-fix write shape (same aged row, the still-future
    // execution expiry left in place) is NOT selected: a dead park-shaped
    // hold would have shielded the row instead of returning it to the
    // normal stale path.
    const preFixRow = { ...agedSettledRow, leaseExpiresAt: inMin(5) };
    expect(matchesWhere(preFixRow, clause)).toBe(false);
  });

  it("clears a stale external wait when the disposition is not blocked (#1251 review)", async () => {
    // An earlier renew parked an external wait; a terminal completed
    // disposition must drop it so the gone owner is not EXTERNAL_WAIT.
    db.lease = { ...db.lease, retryAfter: new Date(Date.now() + 3600_000), waitReason: "dep" };
    const res = await post(baseBody({ operation: "disposition", disposition: "completed" }));
    expect(res.status).toBe(200);
    expect(db.lease.disposition).toBe("completed");
    expect(db.lease.retryAfter).toBeNull();
    expect(db.lease.waitReason).toBeNull();
  });

  it("clears a stale external wait when the disposition is blocked without retryAfter (#1316 review)", async () => {
    // The disposition is the latest statement of the owner's intent: a
    // blocked settlement with NO deadline overrides the wait marker an
    // earlier renew's externalWait left on the lease. Keeping it would put
    // the read model in EXTERNAL_WAIT against the recorded no-park
    // settlement, and the sweep's fenced delete would erase the marker
    // immediately after reclaiming the cleared row — the erasure class the
    // cleanup skip (#1334) prevents while the marker is legitimately running.
    db.lease = { ...db.lease, retryAfter: new Date(Date.now() + 3600_000), waitReason: "dep" };
    db.agentWork = makeAgentWork({ leaseExpiresAt: inMin(5) });

    const res = await post(
      baseBody({ operation: "disposition", disposition: "blocked", note: "stuck on a decision" }),
    );
    expect(res.status).toBe(200);
    expect(db.lease.disposition).toBe("blocked");
    expect(db.lease.retryAfter).toBeNull();
    expect(db.lease.waitReason).toBeNull();
    // The row settles to the same no-park shape: no deadline at all.
    expect(db.agentWork.state).toBe("BLOCKED");
    expect(db.agentWork.leaseExpiresAt).toBeNull();
  });

  it("rejects a past retryAfter with 400", async () => {
    const res = await post(
      baseBody({
        operation: "disposition",
        disposition: "blocked",
        retryAfter: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/future/);
  });

  it("rejects retryAfter on a non-blocked disposition with 400 (#1251 review)", async () => {
    const res = await post(
      baseBody({
        operation: "disposition",
        disposition: "completed",
        retryAfter: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/blocked/);
    // Nothing was written: the terminal record must not park as EXTERNAL_WAIT.
    expect(db.lease.disposition).toBeNull();
    expect(db.lease.retryAfter ?? null).toBeNull();
  });

  it("rejects an unknown disposition value with 400", async () => {
    const res = await post(baseBody({ operation: "disposition", disposition: "yanked" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid disposition/);
  });
});

describe("POST /api/agent-work/ownership — disposition atomicity (#1251 review)", () => {
  // The `ownership` guard has no resume branch: a throw deletes it and the
  // route 500s. So the terminal lease CAS and every local effect it implies
  // must commit together — otherwise the retry hits the `lease.disposition`
  // replay branch and returns `replayed: true` for a disposition whose
  // AgentWork settlement, history and `ownership_dispositioned` event never
  // landed (#1251 review MAJOR).
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  const assertNothingCommitted = () => {
    expect(db.lease.disposition).toBeNull();
    expect(db.lease.dispositionObservedAt).toBeNull();
    expect(db.agentWork.state).toBe("IN_PROGRESS");
    expect(db.agentWorkUpdates).toHaveLength(0);
    expect(db.agentWorkHistory).toHaveLength(0);
    expect(db.lifecycleEvents).toHaveLength(0);
    expect(db.audit.filter((a) => a.action === "ownership_disposition")).toHaveLength(0);
  };

  it("surfaces a 500 and commits nothing when the AgentWork settlement fails right after the lease CAS", async () => {
    db.agentWork = makeAgentWork();
    mocks.failAt = "agentWork.update";

    const res = await post(baseBody({ operation: "disposition", disposition: "completed" }));

    expect(res.status).toBe(500);
    expect(db.txCount).toBe(1);
    // The CAS rolled back with the effect it implies: a retry is not
    // short-circuited into a replay of a disposition that never settled.
    assertNothingCommitted();
  });

  it("surfaces a 500 and commits nothing when the lifecycle write fails after the AgentWork settlement", async () => {
    db.agentWork = makeAgentWork();
    mocks.failAt = "lifecycle";

    const res = await post(baseBody({ operation: "disposition", disposition: "completed" }));

    expect(res.status).toBe(500);
    expect(db.txCount).toBe(1);
    // AgentWork + history had been written inside the transaction; the
    // missing lifecycle event rolls them back with the lease CAS.
    assertNothingCommitted();
  });

  it("converges on retry of the same disposition after either injected post-CAS failure", async () => {
    for (const point of ["agentWork.update", "lifecycle"] as const) {
      seedDb();
      db.agentWork = makeAgentWork();
      mocks.failAt = point;

      const failed = await post(baseBody({ operation: "disposition", disposition: "completed", note: "shipped" }));
      expect(failed.status).toBe(500);
      assertNothingCommitted();

      // Same disposition, retry: the guard is gone and nothing was committed,
      // so the full path re-runs and reports a real (non-replayed) success.
      const retry = await post(baseBody({ operation: "disposition", disposition: "completed", note: "shipped" }));
      expect(retry.status).toBe(200);
      const body = await retry.json();
      expect(body.ok).toBe(true);
      expect(body.replayed).toBe(false);
      expect(body.disposition).toBe("completed");

      expect(db.lease.disposition).toBe("completed");
      expect(db.agentWork.state).toBe("DONE");
      expect(db.agentWorkHistory).toHaveLength(1);
      expect(db.agentWorkHistory[0].action).toBe("ownership_dispositioned");
      expect(db.lifecycleEvents).toHaveLength(1);
      expect(db.lifecycleEvents[0].kind).toBe("ownership_dispositioned");
      expect(db.audit.filter((a) => a.action === "ownership_disposition")).toHaveLength(1);
    }
  });

  it("rolls back only transaction-issued writes: an out-of-transaction write survives (#1251 review)", async () => {
    db.agentWork = makeAgentWork();
    // The injector writes through the ROOT client just before it throws — a
    // write that is not part of the transaction.
    mocks.failAt = "agentWork.update";

    const res = await post(baseBody({ operation: "disposition", disposition: "completed" }));

    expect(res.status).toBe(500);
    // The ambient write rode no transaction, so the rollback cannot reach it…
    expect(db.audit.filter((a) => a.action === "ambient_out_of_transaction")).toHaveLength(1);
    // …while everything the transaction itself wrote is gone. A rollback that
    // unwound the whole store would fail the first assertion; one that undid
    // nothing would fail assertNothingCommitted.
    assertNothingCommitted();
  });

  it("issues every local effect on the transaction client, lifecycle included (#1251 review)", async () => {
    db.agentWork = makeAgentWork();

    const res = await post(baseBody({ operation: "disposition", disposition: "completed" }));

    expect(res.status).toBe(200);
    expect(db.txCount).toBe(1);
    // The lease CAS, the AgentWork settlement, its history, the lifecycle event
    // and the audit row all went out on the transaction client…
    expect(db.writes.map((w) => w.op)).toEqual([
      "lease.updateMany",
      "agentWork.update",
      "agentWorkHistory.create",
      "issueLifecycleEvent.upsert",
      "auditLog.create",
    ]);
    // …and `recordLifecycleEvent` was handed that transaction client, not
    // `prisma`. Nothing escaped to the ambient root client.
    expect(db.writes.find((w) => w.op === "issueLifecycleEvent.upsert")?.client).toMatch(/^tx#\d+$/);
    expect(db.writes.filter((w) => w.client === "prisma")).toEqual([]);
  });

  it("fences the retired claim token after the claim path reactivates a disposed lease (#1251/#1256)", async () => {
    const disposed = await post(baseBody({ operation: "disposition", disposition: "completed" }));
    expect(disposed.status).toBe(200);
    expect(db.lease.disposition).toBe("completed");

    // The claim path reuses the live row: it clears the terminal marker and
    // rotates the fencing token, so the row now describes a NEW attempt
    // (lease.ts). Registration evidence is reset with it.
    const reclaimed = await upsertLease({ agentName: AGENT, issueId: "iss1" });
    expect(reclaimed.created).toBe(false);
    const freshToken = db.lease.claimToken as string;
    expect(freshToken).toMatch(/^claim_/);
    expect(freshToken).not.toBe(CLAIM_TOKEN);
    expect(db.lease.disposition).toBeNull();
    expect(db.lease.registeredAt).toBeNull();

    // The retired incarnation's receipt is inert against the new attempt…
    const retired = await post(baseBody({ operation: "disposition", disposition: "completed" }));
    expect(retired.status).toBe(409);
    expect((await retired.json()).code).toBe("stale_claim_token");
    expect(db.lease.disposition).toBeNull();

    // …while the new one registers and disposes normally. Registration is not
    // a replay of the retired attempt's, because reactivation reset it.
    const registered = await post(baseBody({ operation: "register", claimToken: freshToken, runRef: "run-new" }));
    expect(registered.status).toBe(200);
    expect((await registered.json()).replayed).toBe(false);
    const settled = await post(baseBody({ operation: "disposition", disposition: "released", claimToken: freshToken }));
    expect(settled.status).toBe(200);
    expect((await settled.json()).disposition).toBe("released");
    expect(db.lease.disposition).toBe("released");
  });
});

describe("POST /api/agent-work/ownership — mutation guard", () => {
  it("returns 409 mutation_busy while another mutation holds the guard", async () => {
    mocks.guardBusy = true;
    const res = await post(baseBody({ operation: "register" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("mutation_busy");
    expect(db.leaseUpdates).toHaveLength(0);
    expect(db.lease.renewCount).toBe(0);
  });
});
