// @vitest-environment node
//
// Route tests for POST /api/pr-fix-queue/attempt-requeue (requeue a fenced
// infra_failed / PARKED pr-fix item back to QUEUED at generation+1).
//
// Mirrors the cipark/requeue test conventions:
//   - REAL lib/issue-requeue (parseAttemptRequeueInput + attemptRequeuePrFixItem)
//     run against a FAKE Prisma client (deep-clone reads; rollback $transaction).
//   - lib/dispatch-env mocked via makeDispatchEnvMock (maintainer token + a
//     worker-tier binding for the 403 path); lib/prisma mocked (auditLog +
//     asPrFixQueueClient holder); REAL lib/rate-limit + lib/auth.
//
// The fake client exposes its stores so tests can seed issuance/settlement rows
// and assert zero-mutation on refusals. Each test gets a fresh client via
// vi.hoisted holder reassigned in beforeEach.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Prisma } from "@prisma/client";
import {
  TEST_AGENT_TOKEN as mockToken,
  makeDispatchEnvMock,
  authedRequest,
} from "@/test/route-helpers";
import { requeuePayloadHash } from "@/lib/issue-requeue";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

// Hoisted holder: referenced by the lazy vi.mock factories below, which run
// only after this module's top-level bindings are initialized.
const { holder } = vi.hoisted(
  (): { holder: { current: any; prisma: any } } => ({
    holder: {
      current: null as any,
      prisma: null as any,
    },
  }),
);

// lib/dispatch-env — maintainer token accepted; a worker-tier binding is
// registered so the worker-403 path (maintainer-tier route) is exercised
// against the real authorizeRequest tier enforcement.
vi.mock(
  "@/lib/dispatch-env",
  () => makeDispatchEnvMock(mockToken, {}, { "bound-worker-token": "alpha" }),
);

// lib/prisma — auditLog store (asserted on) + the asPrFixQueueClient holder the
// route's client dependency resolves to.
vi.mock("@/lib/prisma", () => {
  if (!holder.prisma) {
    const audits: any[] = [];
    holder.prisma = {
      audits,
      auditLog: {
        create: vi.fn(async ({ data }: { data: any }) => {
          audits.push(data);
          return { id: `audit-${audits.length}`, ...data };
        }),
      },
    };
  }
  return {
    prisma: holder.prisma,
    asPrFixQueueClient: () => holder.current,
  };
});

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";

const clone = (v: unknown) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// Fake Prisma client. Reads deep-clone (so the route never mutates a shared
// reference); updateMany applies data on CAS match (or returns count 0 when
// `casLost`); $transaction snapshots the stores and restores them on throw.
// ---------------------------------------------------------------------------
function makeFakeClient() {
  const items: any[] = [];
  const history: any[] = [];
  const settlements: any[] = [];
  const issuances: any[] = [];
  const casLost = { value: false };

  const matchesWhere = (row: any, where: any): boolean => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.generation !== undefined && row.generation !== where.generation) {
      return false;
    }
    if (where.status && typeof where.status === "object") {
      if (Array.isArray(where.status.notIn) && where.status.notIn.includes(row.status)) {
        return false;
      }
      if (Array.isArray(where.status.in) && !where.status.in.includes(row.status)) {
        return false;
      }
    }
    if (where.lane && typeof where.lane === "object") {
      if (where.lane.not !== undefined && row.lane === where.lane.not) return false;
    }
    return true;
  };

  const client: any = {
    // live stores, exposed for seeding / assertion
    items,
    history,
    settlements,
    issuances,
    casLost,

    prFixQueueItem: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id !== undefined) {
          return clone(items.find((i) => i.id === where.id) ?? null);
        }
        return clone(
          items.find(
            (i) => i.repo === where.repo_pr.repo && i.pr === where.repo_pr.pr,
          ) ?? null,
        );
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of items) if (matchesWhere(row, where)) count++;
        if (casLost.value) return { count: 0 }; // concurrent mutation -> CAS lost
        if (count > 0) {
          for (const row of items) {
            if (!matchesWhere(row, where)) continue;
            for (const [k, v] of Object.entries(data)) {
              if (v && typeof v === "object" && "increment" in v) {
                row[k] = (row[k] ?? 0) + (v as any).increment;
              } else if (v === Prisma.DbNull) {
                row[k] = null;
              } else {
                row[k] = clone(v);
              }
            }
          }
        }
        return { count };
      }),
    },

    prFixHistory: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `h-${history.length + 1}`, ...clone(data) };
        history.push(row);
        return row;
      }),
    },

    prFixRequeueSettlement: {
      findUnique: vi.fn(async ({ where }: any) => {
        const w = where.agentName_itemId_settlementKey;
        return clone(
          settlements.find(
            (s) =>
              s.agentName === w.agentName &&
              s.itemId === w.itemId &&
              s.settlementKey === w.settlementKey,
          ) ?? null,
        );
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        return clone(
          settlements.find(
            (s) =>
              (where.itemId === undefined || s.itemId === where.itemId) &&
              (where.generation === undefined || s.generation === where.generation),
          ) ?? null,
        );
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `set-${settlements.length + 1}`, ...clone(data) };
        settlements.push(row);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = settlements.length;
        for (let i = settlements.length - 1; i >= 0; i--) {
          const s = settlements[i];
          if (where.id !== undefined && s.id !== where.id) continue;
          if (
            where.expiresAt &&
            where.expiresAt.lte !== undefined &&
            new Date(s.expiresAt).getTime() > new Date(where.expiresAt.lte).getTime()
          ) {
            continue;
          }
          settlements.splice(i, 1);
        }
        return { count: before - settlements.length };
      }),
    },

    attemptIssuance: {
      findUnique: vi.fn(async ({ where }: any) =>
        clone(issuances.find((r) => r.token === where.token) ?? null),
      ),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `iss-${issuances.length + 1}`, ...clone(data) };
        issuances.push(row);
        return row;
      }),
    },

    $transaction: async (fn: (c: any) => Promise<any>) => {
      const snapshot = clone({ items, history, settlements, issuances });
      try {
        return await fn(client);
      } catch (err) {
        items.length = 0;
        history.length = 0;
        settlements.length = 0;
        issuances.length = 0;
        snapshot.items.forEach((i: any) => items.push(i));
        snapshot.history.forEach((h: any) => history.push(h));
        snapshot.settlements.forEach((s: any) => settlements.push(s));
        snapshot.issuances.forEach((i: any) => issuances.push(i));
        throw err;
      }
    },
  };

  return client;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------
function post(
  body: unknown,
  opts: { includeAuth?: boolean; token?: string } = {},
) {
  const { includeAuth = true, token = mockToken } = opts;
  const req = authedRequest("http://localhost/api/pr-fix-queue/attempt-requeue", {
    method: "POST",
    body,
    includeAuth,
    token,
  });
  return POST(req as any);
}

function postRaw(body: string) {
  return POST(
    new Request("http://localhost/api/pr-fix-queue/attempt-requeue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mockToken}`,
      },
      body,
    }) as any,
  );
}

const BASE = {
  repo: "ACME/WIDGETS", // uppercase on purpose: pins repo normalization
  pr: 77,
  generation: 3,
  agentName: "worker",
  fenceToken: "hnd_deadbeefdeadbeef",
  idempotencyKey: "k1",
};

// Seed a requeue-able item (PARKED / infra_failure / generation 3 / NORMAL) plus
// a durable issuance row proving the fence. Pass issuance:false for the live-
// receipt subsumption test, or a custom row for the wrong-agent/generation cases.
function seedAttempt(opts: {
  item?: Record<string, unknown>;
  issuance?: false | Record<string, unknown>;
} = {}) {
  const client: any = holder.current;
  const item = {
    id: "fix-1",
    repo: "acme/widgets",
    pr: 77,
    lane: "NORMAL",
    status: "PARKED",
    outcome: "infra_failure",
    generation: 3,
    headSha: "aaaaaaaa11111111bbbbbbbb22222222cccccccc",
    agentHandouts: [],
    handoutAcks: [],
    handoutAckTimes: [],
    handoutReceipts: [],
    postDispatchEvidenceKeys: [],
    dispatchedGeneration: null,
    dispatchedAt: null,
    retryAt: null,
    staleDisposition: true,
    ...opts.item,
  };
  client.items.push(item);
  if (opts.issuance !== false) {
    const row =
      opts.issuance ??
      {
        id: "iss-1",
        surface: "pr-fix",
        attemptId: item.id,
        agentName: "worker",
        token: "hnd_deadbeefdeadbeef",
        generation: 3,
      };
    client.issuances.push(row);
  }
  return item;
}

function seedSettlement(
  extra: Record<string, unknown>,
): { id: string } & Record<string, unknown> {
  const client: any = holder.current;
  const row = {
    id: `set-seed-${client.settlements.length}`,
    agentName: "worker",
    itemId: "fix-1",
    settlementKey: "k1",
    generation: 3, // the fenced generation (queried by findFirst on the advance path)
    requeuedGeneration: 4,
    expiresAt: new Date(Date.now() + 86400000),
    ...extra,
  };
  client.settlements.push(row);
  return row;
}

function json(res: Awaited<ReturnType<typeof POST>>) {
  return res.json();
}

beforeEach(() => {
  delete process.env.DISPATCH_AUTH_MODE;
  delete process.env.DISPATCH_AUTH_USERNAME;
  delete process.env.DISPATCH_AUTH_PASSWORD;
  resetAuthCaches();
  resetRateLimits();
  (holder.prisma as any).audits.length = 0;
  holder.current = makeFakeClient();
});

afterEach(() => {
  resetAuthCaches();
  resetRateLimits();
  delete process.env.DISPATCH_AUTH_MODE;
});

// ===========================================================================
// 1. Authentication
// ===========================================================================
describe("authentication", () => {
  it("returns 401 when no auth header is present", async () => {
    const res = await post(BASE, { includeAuth: false });
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("Unauthorized");
  });

  it("returns 401 for an unknown bearer token", async () => {
    const res = await post(BASE, { token: "not-a-real-token" });
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("Unauthorized");
  });

  it("returns 403 for a worker-tier credential (maintainer-tier route)", async () => {
    seedAttempt();
    const res = await post(BASE, { token: "bound-worker-token" });
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.error).toMatch(/maintainer token/i);
    // No mutation happened before the tier gate.
    expect(holder.current.prFixQueueItem.updateMany).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 2. Body validation (delegated to parseAttemptRequeueInput)
// ===========================================================================
describe("body validation", () => {
  it("returns 400 'Invalid JSON body' on malformed JSON", async () => {
    const res = await postRaw("not-json");
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("Invalid JSON body");
  });

  it.each([
    [
      "missing repo",
      {
        pr: 77,
        generation: 3,
        agentName: "worker",
        fenceToken: "hnd_deadbeefdeadbeef",
        idempotencyKey: "k1",
      },
      "Missing required field: repo",
    ],
    [
      "missing pr",
      {
        repo: "acme/widgets",
        generation: 3,
        agentName: "worker",
        fenceToken: "hnd_deadbeefdeadbeef",
        idempotencyKey: "k1",
      },
      "Missing required field: pr",
    ],
    [
      "missing generation",
      {
        repo: "acme/widgets",
        pr: 77,
        agentName: "worker",
        fenceToken: "hnd_deadbeefdeadbeef",
        idempotencyKey: "k1",
      },
      "generation must integer >= 1",
    ],
    [
      "generation 0",
      {
        repo: "acme/widgets",
        pr: 77,
        generation: 0,
        agentName: "worker",
        fenceToken: "hnd_deadbeefdeadbeef",
        idempotencyKey: "k1",
      },
      "generation must integer >= 1",
    ],
    [
      "missing agentName",
      {
        repo: "acme/widgets",
        pr: 77,
        generation: 3,
        fenceToken: "hnd_deadbeefdeadbeef",
        idempotencyKey: "k1",
      },
      "agentName must be a non-empty string of at most 200 characters",
    ],
    [
      "missing fenceToken",
      {
        repo: "acme/widgets",
        pr: 77,
        generation: 3,
        agentName: "worker",
        idempotencyKey: "k1",
      },
      "fenceToken must be a non-empty string of at most 1024 characters (the issued hand-out receipt)",
    ],
    [
      "missing idempotencyKey",
      {
        repo: "acme/widgets",
        pr: 77,
        generation: 3,
        agentName: "worker",
        fenceToken: "hnd_deadbeefdeadbeef",
      },
      "idempotencyKey must be a non-empty string of at most 512 characters",
    ],
  ])("%s -> 400 with the pinned message, no mutation", async (_name, body, msg) => {
    seedAttempt();
    const res = await post(body as any);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe(msg);
    expect(holder.current.prFixQueueItem.updateMany).not.toHaveBeenCalled();
    expect(holder.current.settlements).toHaveLength(0);
  });

  it("returns 400 'note must be at most 300 bytes' when the note exceeds 300 UTF-8 bytes", async () => {
    seedAttempt();
    const res = await post({ ...BASE, note: "é".repeat(151) }); // 302 bytes
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("note must be at most 300 bytes");
    expect(holder.current.prFixQueueItem.updateMany).not.toHaveBeenCalled();
  });

  it("accepts a note of exactly 300 UTF-8 bytes (multibyte) and proceeds", async () => {
    seedAttempt();
    const res = await post({ ...BASE, note: "é".repeat(150) }); // exactly 300 bytes
    expect(res.status).toBe(200);
    expect((await json(res)).replayed).toBe(false);
  });
});

// ===========================================================================
// 3. Success path (fresh requeue) + exact mutation pins
// ===========================================================================
describe("success (fresh requeue)", () => {
  it("requeues a PARKED infra_failure item to QUEUED at generation+1 and pins the mutation", async () => {
    seedAttempt();
    const res = await post(BASE);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.replayed).toBe(false);
    expect(body.prFixItem).toEqual({ id: "fix-1", generation: 4 });

    // --- updateMany where + data pins ---
    expect(holder.current.prFixQueueItem.updateMany).toHaveBeenCalledTimes(1);
    const call = holder.current.prFixQueueItem.updateMany.mock.calls[0][0];
    expect(call.where).toEqual(
      expect.objectContaining({
        id: "fix-1",
        generation: 3,
        status: { notIn: ["STALE", "IGNORED"] },
        lane: { not: "NEEDS_HUMAN" },
      }),
    );
    const data = call.data;
    expect(data.status).toBe("QUEUED");
    expect(data.outcome).toBe(null);
    expect(data.decisionDetail).toBe(null);
    expect(data.staleDisposition).toBe(false);
    expect(data.handoutReceipts).toEqual([]);
    expect(data.agentHandouts).toEqual([]);
    expect(data.handoutAcks).toEqual([]);
    expect(data.dispatchedGeneration).toBe(null);
    expect(data.generation).toEqual({ increment: 1 });
    // Fields that must NOT appear in the requeue update.
    expect(data).not.toHaveProperty("fixAttempts");
    expect(data).not.toHaveProperty("handoutReclaims");
    expect(data).not.toHaveProperty("recoveryAppliedAt");
    expect(data).not.toHaveProperty("lane");

    // --- durable settlement committed at the new generation ---
    expect(holder.current.settlements).toHaveLength(1);
    expect(holder.current.settlements[0]).toEqual(
      expect.objectContaining({
        itemId: "fix-1",
        repo: "acme/widgets", // normalized from ACME/WIDGETS
        pr: 77,
        generation: 3,
        agentName: "worker",
        fenceToken: "hnd_deadbeefdeadbeef",
        settlementKey: "k1",
        requeuedGeneration: 4,
      }),
    );

    // --- history + audit ---
    expect(holder.current.prFixHistory.create).toHaveBeenCalledTimes(1);
    expect(holder.current.history[0].action).toBe("attempt-requeue");
    const audit = (holder.prisma as any).audits.at(-1) as any;
    expect(audit).toEqual(
      expect.objectContaining({
        actor: "worker",
        action: "pr_fix_attempt_requeue",
        repoFullName: "acme/widgets",
        success: true,
      }),
    );
  });

  it("accepts a live-receipt fence (no durable issuance row) and succeeds", async () => {
    seedAttempt({
      item: {
        handoutReceipts: ["hnd_deadbeefdeadbeef@worker@3"],
      },
      issuance: false,
    });
    const res = await post(BASE);
    expect(res.status).toBe(200);
    expect((await json(res)).replayed).toBe(false);
    // No issuance row was present or created; the live receipt subsumed the fence.
    expect(holder.current.issuances).toHaveLength(0);
    expect(holder.current.prFixQueueItem.updateMany).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 4. Refusals (never 404; no mutation; refusal audit)
// ===========================================================================
describe("refusals (always 409, never 404)", () => {
  // `baselineSettlements` is the number of settlement rows seeded up front
  // (the superseded case seeds one); the invariant is that NO NEW row is written.
  const assertRefusal = async (
    res: any,
    reason: string,
    baselineSettlements = 0,
  ) => {
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ reason });
    expect(res.status).not.toBe(404);
    expect(holder.current.prFixQueueItem.updateMany).not.toHaveBeenCalled();
    expect(holder.current.prFixRequeueSettlement.create).not.toHaveBeenCalled();
    expect(holder.current.settlements).toHaveLength(baselineSettlements);
    const audit = (holder.prisma as any).audits.at(-1) as any;
    expect(audit).toEqual(
      expect.objectContaining({
        action: "pr_fix_attempt_requeue",
        success: false,
        errorMessage: `refused: ${reason}`,
      }),
    );
  };

  it("unknown repo/pr (no item) -> stale-generation (never 404)", async () => {
    // No item seeded for this repo/pr.
    const res = await post({ ...BASE, repo: "acme/other", pr: 999 });
    await assertRefusal(res, "stale-generation");
  });

  it("item generation advanced, no settlement -> stale-generation", async () => {
    seedAttempt({ item: { generation: 5 } }); // fenced gen 3, item now 5
    const res = await post(BASE);
    await assertRefusal(res, "stale-generation");
  });

  it("item generation advanced + settlement exists -> superseded", async () => {
    seedAttempt({ item: { generation: 5 } });
    // A settlement for the fenced generation exists (moved under another key).
    seedSettlement({ settlementKey: "other-key", payloadHash: "x" });
    const res = await post(BASE);
    await assertRefusal(res, "superseded", 1);
  });

  it("item STALE -> item-closed", async () => {
    seedAttempt({ item: { status: "STALE" } });
    const res = await post(BASE);
    await assertRefusal(res, "item-closed");
  });

  it("item IGNORED -> superseded", async () => {
    seedAttempt({ item: { status: "IGNORED" } });
    const res = await post(BASE);
    await assertRefusal(res, "superseded");
  });

  it("item lane NEEDS_HUMAN -> human-hold", async () => {
    seedAttempt({ item: { lane: "NEEDS_HUMAN" } });
    const res = await post(BASE);
    await assertRefusal(res, "human-hold");
  });

  it("fence not provable (no issuance, no live receipt) -> stale-generation", async () => {
    seedAttempt({ issuance: false });
    const res = await post(BASE);
    await assertRefusal(res, "stale-generation");
  });

  it("fence not provable (issuance bound to another agent) -> stale-generation", async () => {
    seedAttempt({
      issuance: {
        id: "iss-1",
        surface: "pr-fix",
        attemptId: "fix-1",
        agentName: "someone-else",
        token: "hnd_deadbeefdeadbeef",
        generation: 3,
      },
    });
    const res = await post(BASE);
    await assertRefusal(res, "stale-generation");
  });

  it("fence not provable (issuance for a different generation) -> stale-generation", async () => {
    seedAttempt({
      issuance: {
        id: "iss-1",
        surface: "pr-fix",
        attemptId: "fix-1",
        agentName: "worker",
        token: "hnd_deadbeefdeadbeef",
        generation: 2,
      },
    });
    const res = await post(BASE);
    await assertRefusal(res, "stale-generation");
  });
});

// ===========================================================================
// 5. Replay (idempotency by payload hash)
// ===========================================================================
describe("replay", () => {
  it("replays a committed settlement with an equal payload hash; no mutation", async () => {
    seedAttempt();
    seedSettlement({
      payloadHash: requeuePayloadHash({
        repo: "acme/widgets",
        pr: 77,
        generation: 3,
        agentName: "worker",
        fenceToken: "hnd_deadbeefdeadbeef",
        note: null,
      }),
    });
    const res = await post(BASE);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.replayed).toBe(true);
    expect(body.prFixItem).toEqual({ id: "fix-1", generation: 4 });
    // No mutation on replay.
    expect(holder.current.prFixQueueItem.updateMany).not.toHaveBeenCalled();
    expect(holder.current.prFixRequeueSettlement.create).not.toHaveBeenCalled();
    // Success audit marks the replay.
    const audit = (holder.prisma as any).audits.at(-1) as any;
    expect(audit).toEqual(
      expect.objectContaining({
        action: "pr_fix_attempt_requeue",
        success: true,
        notes: "pr=77 generation=3->4 replayed agent=worker",
      }),
    );
  });
});

// ===========================================================================
// 6. Key conflict (same key, different payload)
// ===========================================================================
describe("key conflict", () => {
  it("returns 409 with an 'already used' error and no reason code", async () => {
    seedAttempt();
    // Same idempotencyKey but a different payload (different note) -> different hash.
    seedSettlement({
      payloadHash: requeuePayloadHash({
        repo: "acme/widgets",
        pr: 77,
        generation: 3,
        agentName: "worker",
        fenceToken: "hnd_deadbeefdeadbeef",
        note: "a different note",
      }),
    });
    const res = await post(BASE);
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error).toContain("already used");
    expect(body.reason).toBeUndefined();
    // No mutation.
    expect(holder.current.prFixQueueItem.updateMany).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 7. Expired settlement (treated absent; prune attempted; normal path proceeds)
// ===========================================================================
describe("expired settlement", () => {
  it("prunes an expired settlement and then performs a fresh requeue", async () => {
    seedAttempt();
    const expired = seedSettlement({
      id: "set-expired",
      payloadHash: "whatever",
      expiresAt: new Date(Date.now() - 60000), // in the past
    });
    const res = await post(BASE);
    expect(res.status).toBe(200);
    expect((await json(res)).replayed).toBe(false);
    // The prune was attempted against the expired row's id.
    expect(holder.current.prFixRequeueSettlement.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: expired.id }),
      }),
    );
    // The expired row is gone; a fresh settlement was committed.
    expect(holder.current.settlements).toHaveLength(1);
    expect(holder.current.settlements[0].id).not.toBe("set-expired");
    expect(holder.current.settlements[0].requeuedGeneration).toBe(4);
    expect(holder.current.prFixQueueItem.updateMany).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 8. Missing durable surfaces -> 503 fail-closed, no mutation
// ===========================================================================
describe("missing durable surfaces", () => {
  const assertUnavailable = async (res: any) => {
    expect(res.status).toBe(503);
    expect((await json(res)).error).toBe(
      "Attempt-requeue did not settle (ledger unavailable or a concurrent change landed); retry shortly",
    );
    expect(holder.current.prFixQueueItem.updateMany).not.toHaveBeenCalled();
    expect(holder.current.settlements).toHaveLength(0);
  };

  it("returns 503 when prFixRequeueSettlement is unavailable", async () => {
    seedAttempt();
    delete (holder.current as any).prFixRequeueSettlement;
    const res = await post(BASE);
    await assertUnavailable(res);
  });

  it("returns 503 when attemptIssuance is unavailable", async () => {
    seedAttempt();
    delete (holder.current as any).attemptIssuance;
    const res = await post(BASE);
    await assertUnavailable(res);
  });
});

// ===========================================================================
// 9. CAS lost (updateMany count 0) -> rollback, no success
// ===========================================================================
describe("CAS lost", () => {
  it("rolls back when the CAS updateMany matches no row; no settlement is committed", async () => {
    const item = seedAttempt();
    (holder.current as any).casLost.value = true; // updateMany returns count 0
    const res = await post(BASE);
    // A still-proceeding item yields the fail-closed unavailable branch.
    expect(res.status).toBe(503);
    // The transaction rolled back: no settlement committed, item unchanged.
    expect(holder.current.settlements).toHaveLength(0);
    expect(holder.current.prFixHistory.create).not.toHaveBeenCalled();
    expect(holder.current.items[0].id).toBe(item.id);
    expect(holder.current.items[0].status).toBe("PARKED");
    expect(holder.current.items[0].generation).toBe(3);
    // The CAS update matched zero rows.
    const lastUpdate = holder.current.prFixQueueItem.updateMany.mock.calls.at(-1);
    expect(lastUpdate[0].data.generation).toEqual({ increment: 1 });
    expect(
      await holder.current.prFixQueueItem.updateMany.mock.results.at(-1).value,
    ).toEqual({ count: 0 });
  });
});

// ===========================================================================
// 10. B2 fence fix: a live receipt at the fenced generation shadows the
//     durable ledger — a rotated token refuses, an empty generation consults
//     the ledger
// ===========================================================================
describe("live-receipt fence (B2)", () => {
  it("refuses stale-generation when the fenced generation owns a live receipt with a DIFFERENT token, even when the durable ledger proves the presented token; the ledger is never consulted", async () => {
    // The live receipt (same agent, same generation, rotated token) means
    // the named issuance was released and re-issued: the current owner is
    // NEVER touched. The durable row proves the PRESENTED token, which is
    // exactly the pre-B2 fall-through that would have authorized the bump.
    seedAttempt({
      item: { handoutReceipts: ["hnd_0123456789abcdef@worker@3"] },
      issuance: {
        id: "iss-1",
        surface: "pr-fix",
        attemptId: "fix-1",
        agentName: "worker",
        token: "hnd_deadbeefdeadbeef", // === the presented fenceToken
        generation: 3,
      },
    });
    const res = await post(BASE);
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ reason: "stale-generation" });
    // No settlement write, no transition: the current live hand-out stands.
    expect(holder.current.prFixQueueItem.updateMany).not.toHaveBeenCalled();
    expect(holder.current.prFixRequeueSettlement.create).not.toHaveBeenCalled();
    expect(holder.current.settlements).toHaveLength(0);
    expect(holder.current.history).toHaveLength(0);
    // The B2 fix: the live-receipt shadow short-circuits BEFORE the durable
    // ledger — the ledger is not even read in this path.
    expect(holder.current.attemptIssuance.findUnique).not.toHaveBeenCalled();
    // The refusal was audited with the pinned code.
    const audit = (holder.prisma as any).audits.at(-1) as any;
    expect(audit).toEqual(
      expect.objectContaining({
        action: "pr_fix_attempt_requeue",
        success: false,
        errorMessage: "refused: stale-generation",
      }),
    );
  });

  it("consults the durable issuance ledger (and can succeed) when the fenced generation owns no live receipt at all", async () => {
    seedAttempt(); // empty handoutReceipts + a durable issuance row for the fence
    const res = await post(BASE);
    expect(res.status).toBe(200);
    expect((await json(res)).replayed).toBe(false);
    // The ledger WAS the fence authority here and proved the presented token.
    expect(holder.current.attemptIssuance.findUnique).toHaveBeenCalledTimes(1);
    expect(holder.current.attemptIssuance.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ token: "hnd_deadbeefdeadbeef" }),
      }),
    );
    // ...and the requeue proceeded and settled.
    expect(holder.current.prFixQueueItem.updateMany).toHaveBeenCalledTimes(1);
    expect(holder.current.settlements).toHaveLength(1);
  });
});

// ===========================================================================
// 11. m2: an unreadable issuance ledger is a retryable 503 — never a
//     stale-generation refusal, never a mutation
// ===========================================================================
describe("ledger-read failure (m2)", () => {
  it("returns 503 (never 409) and mutates nothing when the AttemptIssuance lookup throws", async () => {
    // No live receipt and no seeded ledger row: the fence MUST consult the
    // ledger, and that consultation is exactly where the read fails.
    seedAttempt({ issuance: false });
    (holder.current as any).attemptIssuance.findUnique = vi.fn(async () => {
      throw new Error("ledger read failure");
    });
    const res = await post(BASE);
    expect(res.status).toBe(503);
    expect(res.status).not.toBe(409);
    const body = await json(res);
    expect(body.error).toBe(
      "Attempt-requeue did not settle (ledger unavailable or a concurrent change landed); retry shortly",
    );
    expect(holder.current.prFixQueueItem.updateMany).not.toHaveBeenCalled();
    expect(holder.current.prFixRequeueSettlement.create).not.toHaveBeenCalled();
    expect(holder.current.settlements).toHaveLength(0);
    expect(holder.current.history).toHaveLength(0);
  });
});

// ===========================================================================
// 12. m1: a failing audit row must never mask the response — the committed
//     200 success body and the pinned 409 refusal code survive it
// ===========================================================================
describe("audit failure (m1)", () => {
  // Override the shared prisma holder's audit sink for these tests only and
  // restore it afterwards (the mock factory creates it once for the file).
  let originalAuditCreate: any;

  beforeEach(() => {
    originalAuditCreate = (holder.prisma as any).auditLog.create;
    (holder.prisma as any).auditLog.create = vi.fn(async () => {
      throw new Error("audit store down");
    });
  });

  afterEach(() => {
    (holder.prisma as any).auditLog.create = originalAuditCreate;
  });

  it("success path: a rejecting audit sink still yields the 200 success body (the committed requeue is not masked)", async () => {
    seedAttempt();
    const res = await post(BASE);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.replayed).toBe(false);
    expect(body.prFixItem).toEqual({ id: "fix-1", generation: 4 });
    // The requeue itself committed despite the audit failure.
    expect(holder.current.prFixQueueItem.updateMany).toHaveBeenCalledTimes(1);
    expect(holder.current.settlements).toHaveLength(1);
    expect(holder.current.prFixHistory.create).toHaveBeenCalledTimes(1);
  });

  it("refusal path: a rejecting audit sink still yields the pinned 409 refusal code", async () => {
    seedAttempt({ item: { status: "STALE" } });
    const res = await post(BASE);
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ reason: "item-closed" });
    // The refusal settles nothing and touches nothing.
    expect(holder.current.prFixQueueItem.updateMany).not.toHaveBeenCalled();
    expect(holder.current.settlements).toHaveLength(0);
  });
});

// ===========================================================================
// 13. Idempotency key bound: exactly 512 chars is the pinned Courier cap
// ===========================================================================
describe("idempotency key bound", () => {
  it("accepts an exactly-512-character idempotencyKey and settles with it", async () => {
    seedAttempt();
    const key = "k".repeat(512);
    const res = await post({ ...BASE, idempotencyKey: key });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.replayed).toBe(false);
    expect(holder.current.settlements).toHaveLength(1);
    expect(holder.current.settlements[0].settlementKey).toBe(key);
  });

  it("returns 400 with the pinned message for a 513-character idempotencyKey; no mutation", async () => {
    seedAttempt();
    const res = await post({ ...BASE, idempotencyKey: "k".repeat(513) });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe(
      "idempotencyKey must be a non-empty string of at most 512 characters",
    );
    expect(holder.current.prFixQueueItem.updateMany).not.toHaveBeenCalled();
    expect(holder.current.settlements).toHaveLength(0);
  });
});
