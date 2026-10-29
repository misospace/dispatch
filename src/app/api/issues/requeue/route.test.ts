// @vitest-environment node
//
// Route tests for POST /api/issues/requeue (#1491) — the fenced, idempotent
// operator retry of `implement` (issue) work. Pins the Courier wire contract:
//   - success `{success:true, replayed:<bool>, attemptId?:string}` where
//     `attemptId` is present only when a lease row existed (an honest
//     attempt identity);
//   - refusals `409 {"reason": stale-generation | superseded | item-closed |
//     human-hold}` — a closed vocabulary; 404 is reserved for route absence
//     and NEVER answers a per-item condition;
//   - key-conflicts are uncoded 409s ("idempotencyKey already used for a
//     different issue requeue payload");
//   - ledger/guard contention is retryable 503, never a partial success.
//
// The real `@/lib/issue-requeue` + real `@/lib/issue-handoff-settlement`
// ledger run against a fake global prisma; the mutation guard (whose callback
// results are recorded, so the COMPLETE-vs-RETAINED contract can be pinned),
// the reconciler supersede, and the shared claim release are the mocked
// seams. The dispatch-env mock carries the maintainer token plus an unbound
// and a bound worker-tier credential for the auth-gate pins.
import { vi } from "vitest";

const { db, guard, mocks } = vi.hoisted(() => ({
  // Mutable in-memory database, reset per test via makeState().
  db: {
    issue: null as any,
    lease: null as any,
    agentWork: [] as any[],
    agentWorkUpdates: [] as any[],
    agentWorkHistory: [] as any[],
    // Durable settlement ledger rows (the shared #1262 surface).
    settlements: [] as any[],
    // A competing writer's row that is invisible to the pre-write read but
    // wins the upsert (first write wins) — simulates the #8.7-style race.
    racingSettlements: [] as any[],
    // Durable issuance ledger (the fence proof outliving the live lease).
    issuances: [] as any[],
    audit: [] as any[],
    leaseDeleteCalls: [] as any[],
    settlementDeleteCalls: [] as any[],
    failLeaseDelete: false,
    // Failure toggles for the review pins: a dead settlement WRITE and a
    // dead issuance-ledger READ (both must fail closed as 503, never 409).
    failSettlementRecord: false,
    failIssuanceLookup: false,
  },
  // The fake guard's behavior for the next request. `callbackResults`
  // records each guard callback's `{ complete, value }` result so tests can
  // pin the COMPLETE-vs-RETAINED contract the callback returns.
  guard: {
    behavior: "ok" as "ok" | "busy" | "guard-lost" | "throw",
    callbackResults: [] as { complete: boolean; value: unknown }[],
  },
  mocks: {
    releaseIssueClaim: vi.fn(),
    supersedeIntent: vi.fn(),
    // Worker-tier credentials for the auth-gate pin: the legacy UNBOUND
    // token and a BOUND credential for agent "alpha".
    workerToken: "test-worker-token",
    workerBoundToken: "test-worker-bound-alpha",
    workerBoundAgent: "alpha",
  },
}));

vi.mock("@/lib/issue-mutation-guard", () => ({
  // The real helper's arithmetic (n × per-call budget + slack) on a fake
  // per-call figure.
  fencedWriteTimeoutMs: () => 60_000,
  fencedWriteTimeoutForCalls: (calls: number) => Math.max(1, Math.ceil(calls)) * 45_000 + 15_000,
  withIssueMutationGuard: async (_request: unknown, callback: any) => {
    if (guard.behavior === "busy") {
      return { status: "busy", ownerToken: "guard-token", operation: "attempt-requeue" };
    }
    const result = await callback(undefined, {
      resuming: false,
      // The fenced remote write is atomic with the guard check: a lost guard
      // means the forge function is NEVER called.
      runFencedRemoteWrite: async (fn: any) => {
        if (guard.behavior === "guard-lost") return { status: "guard-lost" as const };
        if (guard.behavior === "throw") {
          // The forge write lands, then the region's transaction fails —
          // the remote effect is in flight when the region aborts.
          await fn({});
          throw new Error("fenced remote write failed");
        }
        const value = await fn({});
        return { status: "written" as const, value };
      },
    });
    // Record the callback's own result (independent of the status label
    // computed below) so a test can pin COMPLETE vs RETAINED.
    guard.callbackResults.push(result);
    return { status: result.complete ? "completed" : "retained", value: result.value };
  },
}));

vi.mock("@/lib/ownership-reconciliation", () => ({
  supersedeOwnershipReleaseIntent: mocks.supersedeIntent,
}));

// The release is the shared `releaseIssueClaim` seam: stub the release
// itself, keep a pass-through `fencedClaimClient` (a pure reshape whose
// job is to hand the fenced transaction to the release).
vi.mock("@/lib/issue-claim", () => ({
  releaseIssueClaim: mocks.releaseIssueClaim,
  fencedClaimClient: (tx: any) => tx,
  releaseIssueClaimWorstCaseCalls: () => 1,
}));

// The issue-requeue lib pulls `nonEmpty` (and pr-fix-only helpers) from the
// heavy pr-fix-queue module; the fakes keep the real semantics.
vi.mock("@/lib/pr-fix-queue", () => ({
  nonEmpty: (value: unknown) => typeof value === "string" && value.trim().length > 0,
  normalizeQueueRepo: (repo: string) => repo.trim().toLowerCase(),
  freshAttemptGeneration: () => ({
    generation: { increment: 1 },
    attemptEvidenceWatermark: null,
    ciParkState: null,
    ciParkHead: null,
    ciParkKey: null,
    ciParkFence: null,
    ciParkAt: null,
    attemptType: null,
  }),
  findHandoutReceipt: () => null,
}));

import { authedRequest, makeDispatchEnvMock, TEST_AGENT_TOKEN as mockToken } from "@/test/route-helpers";

// Maintainer-tier bearer (full rights) — the requeue route is absent from the
// worker allowlist, so the token resolves to the full-rights path. Also
// carries an unbound and a bound worker-tier credential so the auth-gate
// pins can exercise the worker-tier 403 path.
vi.mock(
  "@/lib/dispatch-env",
  () =>
    makeDispatchEnvMock(
      mockToken,
      { [mocks.workerToken]: "worker" },
      { [mocks.workerBoundToken]: mocks.workerBoundAgent },
    ),
);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      findUnique: async ({ where }: any) =>
        db.issue && db.issue.id === where.id ? db.issue : null,
    },
    lease: {
      findUnique: async ({ where }: any) => {
        const key = where.agentName_issueId;
        return db.lease && db.lease.agentName === key.agentName && db.lease.issueId === key.issueId
          ? db.lease
          : null;
      },
      deleteMany: async ({ where }: any) => {
        db.leaseDeleteCalls.push(where);
        if (db.failLeaseDelete) return { count: 0 };
        if (
          db.lease &&
          db.lease.id === where.id &&
          db.lease.agentName === where.agentName &&
          db.lease.issueId === where.issueId &&
          db.lease.claimToken === where.claimToken
        ) {
          db.lease = null;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    agentWork: {
      findMany: async () => db.agentWork,
      update: async ({ where, data }: any) => {
        db.agentWorkUpdates.push({ where, data });
        return null;
      },
    },
    agentWorkHistory: {
      create: async ({ data }: any) => {
        db.agentWorkHistory.push(data);
        return data;
      },
    },
    attemptIssuance: {
      findUnique: async ({ where }: any) => {
        if (db.failIssuanceLookup) throw new Error("issuance ledger read failed");
        return db.issuances.find((r: any) => r.token === where.token) ?? null;
      },
      create: async ({ data }: any) => {
        db.issuances.push(data);
        return data;
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        db.audit.push(data);
        return data;
      },
    },
    issueHandoffSettlement: {
      findUnique: async ({ where }: any) => {
        const key = where.agentName_issueId_settlementKey;
        return (
          db.settlements.find(
            (r: any) =>
              r.agentName === key.agentName &&
              r.issueId === key.issueId &&
              r.settlementKey === key.settlementKey,
          ) ?? null
        );
      },
      upsert: async ({ where, create }: any) => {
        if (db.failSettlementRecord) throw new Error("settlement ledger write failed");
        const key = where.agentName_issueId_settlementKey;
        // A competing writer's already-committed row wins the key (the
        // pre-write read did not see it).
        const racing = db.racingSettlements.find(
          (r: any) =>
            r.agentName === key.agentName &&
            r.issueId === key.issueId &&
            r.settlementKey === key.settlementKey,
        );
        if (racing) return racing;
        // First write wins: the fake `update: {}` never rewrites an
        // existing proof.
        const existing = db.settlements.find(
          (r: any) =>
            r.agentName === key.agentName &&
            r.issueId === key.issueId &&
            r.settlementKey === key.settlementKey,
        );
        if (existing) return existing;
        const row = { id: `settle-${db.settlements.length + 1}`, ...create };
        db.settlements.push(row);
        return row;
      },
      deleteMany: async ({ where }: any) => {
        db.settlementDeleteCalls.push(where);
        const key = where.agentName_issueId_settlementKey ?? where;
        const before = db.settlements.length;
        db.settlements = db.settlements.filter((r: any) => {
          if (
            !(
              r.agentName === key.agentName &&
              r.issueId === key.issueId &&
              r.settlementKey === key.settlementKey
            )
          )
            return true;
          if (key.claimToken && r.claimToken !== key.claimToken) return true;
          if (key.expiresAt?.lte && new Date(r.expiresAt).getTime() > key.expiresAt.lte.getTime())
            return true;
          return false;
        });
        return { count: before - db.settlements.length };
      },
    },
  },
}));

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { POST } from "./route";
import { requeuePayloadHash } from "@/lib/issue-requeue";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

const REPO = "org/repo";
const ISSUE_ID = "issue-1";
const ISSUE_NUMBER = 42;
const AGENT = "alpha";
const CLAIM_TOKEN = "claim_test-token-1";
const KEY = "run-1:requeue";
// "é" is 2 UTF-8 bytes: 150 chars = exactly 300 bytes (passes), 151 = 302
// (over the pinned bound).
const NOTE_300_BYTES = "é".repeat(150);
const NOTE_302_BYTES = "é".repeat(151);

/** The lib's payload fingerprint for the canonical test payload. */
function payloadHash(note: string | null = null) {
  return requeuePayloadHash({
    issueId: ISSUE_ID,
    repoFullName: REPO,
    issueNumber: ISSUE_NUMBER,
    agentName: AGENT,
    claimToken: CLAIM_TOKEN,
    note,
  });
}

function makeState(overrides: Record<string, unknown> = {}) {
  db.issue = {
    id: ISSUE_ID,
    number: ISSUE_NUMBER,
    state: "open",
    labels: ["agent/alpha", "status/in-progress"],
    repository: { fullName: REPO },
    ...(overrides.issue as object | undefined),
  };
  if (overrides.issue === null) db.issue = null;
  db.lease = { id: "lease-1", agentName: AGENT, issueId: ISSUE_ID, claimToken: CLAIM_TOKEN };
  if (overrides.lease === null) db.lease = null;
  else if (overrides.lease) db.lease = { ...db.lease, ...(overrides.lease as object) };
  db.agentWork = [{ id: "work-1" }];
  db.agentWorkUpdates = [];
  db.agentWorkHistory = [];
  db.settlements = (overrides.settlements as any[]) ?? [];
  db.racingSettlements = (overrides.racingSettlements as any[]) ?? [];
  db.issuances = (overrides.issuances as any[]) ?? [];
  db.audit = [];
  db.leaseDeleteCalls = [];
  db.settlementDeleteCalls = [];
  db.failLeaseDelete = false;
  db.failSettlementRecord = false;
  db.failIssuanceLookup = false;
  guard.behavior = "ok";
  guard.callbackResults = [];
  mocks.releaseIssueClaim.mockResolvedValue({
    labels: ["status/in-progress"],
    status: null,
    statusNote: null,
  });
  mocks.supersedeIntent.mockResolvedValue(undefined);
}

function postRequest(body: Record<string, unknown> = {}, token?: string) {
  return POST(
    authedRequest("http://localhost/api/issues/requeue", {
      method: "POST",
      token,
      body: {
        issueId: ISSUE_ID,
        repoFullName: REPO,
        issueNumber: ISSUE_NUMBER,
        agentName: AGENT,
        claimToken: CLAIM_TOKEN,
        idempotencyKey: KEY,
        ...body,
      },
    }),
  );
}

describe("POST /api/issues/requeue (#1491)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    resetAuthCaches();
    resetRateLimits();
    delete process.env.DISPATCH_AUTH_MODE;
    makeState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── auth ──────────────────────────────────────────────────────────────────

  it("returns 401 without a bearer token", async () => {
    const response = await POST(
      authedRequest("http://localhost/api/issues/requeue", {
        method: "POST",
        includeAuth: false,
        body: {},
      }),
    );
    expect(response.status).toBe(401);
  });

  it("returns 401 for an unknown bearer token", async () => {
    const response = await postRequest({}, "not-a-configured-token");
    expect(response.status).toBe(401);
    expect(db.leaseDeleteCalls).toHaveLength(0);
  });

  // The route is MAINTAINER-tier (absent from `WORKER_ALLOWLIST`), so a
  // worker-tier credential is refused by the central tier gate before any
  // state is read or mutated — for BOTH the legacy unbound token and a
  // bound worker credential.
  it("refuses worker-tier tokens (unbound and bound) with 403 and mutates nothing", async () => {
    const unbound = await postRequest({}, mocks.workerToken);
    expect(unbound.status).toBe(403);
    expect((await unbound.json()).error).toMatch(/requires a maintainer token/i);

    const bound = await postRequest({}, mocks.workerBoundToken);
    expect(bound.status).toBe(403);
    expect((await bound.json()).error).toMatch(/requires a maintainer token/i);

    // The tier gate fires before the body is even parsed into a transition:
    // no release, no supersede, no lease consumption, no settlement.
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(mocks.supersedeIntent).not.toHaveBeenCalled();
    expect(db.lease).not.toBeNull();
    expect(db.leaseDeleteCalls).toHaveLength(0);
    expect(db.settlements).toHaveLength(0);
    // The denial is best-effort audited (one row per denied credential).
    expect(db.audit.filter((r: any) => r.action === "auth_tier_denied")).toHaveLength(2);
  });

  // ── validation (400) ──────────────────────────────────────────────────────

  it("rejects a non-JSON body", async () => {
    const response = await POST(
      new Request("http://localhost/api/issues/requeue", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
        body: "this is not json",
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Invalid JSON body");
    expect(db.leaseDeleteCalls).toHaveLength(0);
  });

  it("rejects a non-object JSON body", async () => {
    const response = await POST(
      authedRequest("http://localhost/api/issues/requeue", {
        method: "POST",
        body: ["not", "an", "object"],
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Invalid JSON body");
  });

  it("rejects each missing required field", async () => {
    const expected: Record<string, RegExp> = {
      issueId: /Missing required field: issueId/i,
      repoFullName: /Missing required field: repoFullName/i,
      issueNumber: /Missing required field: issueNumber/i,
      agentName: /agentName must be a non-empty string/i,
      claimToken: /claimToken must be a non-empty string/i,
      idempotencyKey: /idempotencyKey must be a non-empty string/i,
    };
    for (const field of Object.keys(expected)) {
      const response = await postRequest({ [field]: undefined });
      expect(response.status, `expected 400 for missing ${field}`).toBe(400);
      expect((await response.json()).error).toMatch(expected[field]);
    }
    expect(db.leaseDeleteCalls).toHaveLength(0);
  });

  it("rejects a note over 300 UTF-8 bytes and accepts exactly 300", async () => {
    const rejected = await postRequest({ note: NOTE_302_BYTES }); // 302 bytes
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toMatch(/at most 300 bytes/i);
    expect(db.leaseDeleteCalls).toHaveLength(0);

    const accepted = await postRequest({ note: NOTE_300_BYTES }); // exactly 300 bytes
    expect(accepted.status).toBe(200);
    const json = await accepted.json();
    expect(json).toEqual({ success: true, replayed: false, attemptId: "lease-1" });
    // The stored fingerprint covers the (trimmed) multibyte note.
    expect(db.settlements[0].payloadHash).toBe(payloadHash(NOTE_300_BYTES));
  });

  // ── fresh release (success) ───────────────────────────────────────────────

  it("releases the fenced claim, records the settlement, and re-offers the issue", async () => {
    const response = await postRequest();
    expect(response.status).toBe(200);
    // The pinned success shape: attemptId is the lease row's identity.
    expect(await response.json()).toEqual({ success: true, replayed: false, attemptId: "lease-1" });

    // §8.7: the explicit fenced release supersedes a pending reconciler intent.
    expect(mocks.supersedeIntent).toHaveBeenCalledTimes(1);
    expect(mocks.supersedeIntent).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: ISSUE_ID, actor: AGENT }),
    );

    // The shared claim release ran for the presented claim.
    expect(mocks.releaseIssueClaim).toHaveBeenCalledTimes(1);
    expect(mocks.releaseIssueClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        issue: expect.objectContaining({ id: ISSUE_ID }),
        repoFullName: REPO,
        issueNumber: ISSUE_NUMBER,
        agentName: AGENT,
        options: expect.objectContaining({ actor: AGENT }),
      }),
    );

    // The EXACT lease row is consumed, pinned to the presented token.
    expect(db.lease).toBeNull();
    expect(db.leaseDeleteCalls).toHaveLength(1);
    expect(db.leaseDeleteCalls[0]).toEqual({
      id: "lease-1",
      agentName: AGENT,
      issueId: ISSUE_ID,
      claimToken: CLAIM_TOKEN,
    });

    // Durable settlement: first write wins, operation-tagged, fingerprinted.
    expect(db.settlements).toHaveLength(1);
    expect(db.settlements[0]).toMatchObject({
      agentName: AGENT,
      issueId: ISSUE_ID,
      claimToken: CLAIM_TOKEN,
      settlementKey: KEY,
      capacity: null,
      labels: ["status/in-progress"],
      status: null,
      statusNote: null,
      cooldownUntil: null,
      operation: "attempt-requeue",
      attemptId: "lease-1",
    });
    expect(db.settlements[0].payloadHash).toBe(payloadHash());
    expect(new Date(db.settlements[0].expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Active AgentWork rows retire with a history entry.
    expect(db.agentWorkUpdates).toHaveLength(1);
    expect(db.agentWorkUpdates[0]).toMatchObject({
      where: { id: "work-1" },
      data: expect.objectContaining({ state: "RELEASED" }),
    });
    expect(db.agentWorkHistory).toHaveLength(1);
    expect(db.agentWorkHistory[0]).toMatchObject({
      workId: "work-1",
      action: "attempt_requeue",
      state: "RELEASED",
    });

    // Audit success row.
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({
      action: "issue_attempt_requeue",
      success: true,
      repoFullName: REPO,
      issueNumber: ISSUE_NUMBER,
      issueId: ISSUE_ID,
    });
    expect(db.audit[0].notes).toContain("(committed)");
  });

  // B1/B3: the shared claim release is called with the audit actor AND
  // `allowMissingAgent: true`, so a terminal report that already removed the
  // `agent/*` label makes the release an idempotent repair instead of
  // throwing `Issue is not assigned to`. The exact options object is pinned
  // (no extra keys) in the state this route exists for.
  it("passes { actor, allowMissingAgent: true } to the shared release when the agent label is already gone", async () => {
    // The terminal report removed the `agent/alpha` label; only the status
    // label remains. This is the state requeue is meant to repair.
    makeState({ issue: { labels: ["status/in-progress"] } });
    const response = await postRequest();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, replayed: false, attemptId: "lease-1" });

    // The audit actor for a maintainer bearer is the requested (fenced)
    // agent, and the options object carries exactly the actor + the
    // missing-agent opt-in.
    expect(mocks.releaseIssueClaim).toHaveBeenCalledTimes(1);
    expect(mocks.releaseIssueClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: AGENT,
        options: { actor: AGENT, allowMissingAgent: true },
      }),
    );
  });

  // ── already-released path (no live lease) ─────────────────────────────────

  it("releases against the durable issuance ledger when the lease is gone and omits attemptId", async () => {
    makeState({
      lease: null,
      issuances: [
        { surface: "issue", attemptId: ISSUE_ID, agentName: AGENT, token: CLAIM_TOKEN, generation: null },
      ],
    });
    const response = await postRequest();
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.replayed).toBe(false);
    // No lease row existed → the server cannot promise an attempt identity.
    expect(!("attemptId" in json)).toBe(true);

    expect(mocks.supersedeIntent).toHaveBeenCalledTimes(1);
    expect(mocks.releaseIssueClaim).toHaveBeenCalledTimes(1);
    expect(db.leaseDeleteCalls).toHaveLength(0); // nothing live to consume
    expect(db.settlements).toHaveLength(1);
    expect(db.settlements[0].attemptId).toBeNull();
    expect(db.audit[0]).toMatchObject({ action: "issue_attempt_requeue", success: true });
  });

  // ── fence refusals (closed vocabulary) ────────────────────────────────────

  it("refuses a lease carrying a NEWER claim token (stale-generation)", async () => {
    makeState({ lease: { claimToken: "claim_newer-token" } });
    const response = await postRequest(); // presents the older CLAIM_TOKEN
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ reason: "stale-generation" });
    // The current (newer) owner is NEVER touched.
    expect(db.lease).not.toBeNull();
    expect(db.lease.claimToken).toBe("claim_newer-token");
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(mocks.supersedeIntent).not.toHaveBeenCalled();
    expect(db.leaseDeleteCalls).toHaveLength(0);
    expect(db.settlements).toHaveLength(0);
  });

  it("refuses when no lease remains and the issuance ledger proves nothing (stale-generation)", async () => {
    makeState({ lease: null }); // no issuance row either
    const response = await postRequest();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ reason: "stale-generation" });
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(db.leaseDeleteCalls).toHaveLength(0);
    expect(db.settlements).toHaveLength(0);
  });

  // m2: on the already-released path the issuance ledger read is the ONLY
  // proof. A failed read establishes nothing — it must fail closed as a
  // retryable 503, never be treated as absence (409 stale-generation) or as
  // issuance. Pinned for both shapes of "no live proof": no lease row, and a
  // lease row whose claimToken is null (pre-token legacy row).
  it("answers 503 (never 409) when the issuance ledger read fails on the already-released path", async () => {
    for (const lease of [null, { claimToken: null }]) {
      makeState({ lease });
      db.failIssuanceLookup = true;
      const response = await postRequest();
      // A failed ledger read is retryable, not a per-item condition.
      expect(response.status, `lease=${JSON.stringify(lease)}`).toBe(503);
      const json = await response.json();
      expect(json.error, `lease=${JSON.stringify(lease)}`).toMatch(
        /busy or the settlement ledger is unavailable/i,
      );
      // Never a coded refusal: 404 is reserved for route absence and 409 is
      // the closed-vocabulary per-item refusal — neither is the answer here.
      expect(json, `lease=${JSON.stringify(lease)}`).not.toHaveProperty("reason");
      // Nothing is touched on the failure: no release, no supersede, no
      // settlement, and the (absent or legacy) lease is left exactly as found.
      expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
      expect(mocks.supersedeIntent).not.toHaveBeenCalled();
      expect(db.leaseDeleteCalls).toHaveLength(0);
      expect(db.settlements).toHaveLength(0);
      if (lease === null) expect(db.lease).toBeNull();
      else expect(db.lease?.claimToken).toBeNull();
      // The callback COMPLETES with the unavailable value (no retained wedge).
      expect(guard.callbackResults).toHaveLength(1);
      expect(guard.callbackResults[0]).toEqual({
        complete: true,
        value: { ok: false, unavailable: true },
      });
    }
  });

  it("refuses an issuance row minted for a different agent/issue (stale-generation)", async () => {
    makeState({
      lease: null,
      issuances: [
        { surface: "issue", attemptId: "issue-2", agentName: "bravo", token: CLAIM_TOKEN, generation: null },
      ],
    });
    const response = await postRequest();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ reason: "stale-generation" });
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(db.leaseDeleteCalls).toHaveLength(0);
    expect(db.settlements).toHaveLength(0);
  });

  it("never answers 404 for a per-item condition (unknown issue → stale-generation)", async () => {
    makeState({ issue: null });
    const response = await postRequest();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ reason: "stale-generation" });
    expect(db.leaseDeleteCalls).toHaveLength(0);
  });

  // ── state gates (closed vocabulary) ───────────────────────────────────────

  it("refuses a closed issue (item-closed)", async () => {
    makeState({ issue: { state: "closed" } });
    const response = await postRequest();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ reason: "item-closed" });
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(db.lease).not.toBeNull();
    expect(db.leaseDeleteCalls).toHaveLength(0);
    expect(db.settlements).toHaveLength(0);
    expect(db.audit[0]).toMatchObject({
      action: "issue_attempt_requeue",
      success: false,
      errorMessage: "refused: item-closed",
    });
  });

  it("refuses a done issue (superseded)", async () => {
    makeState({ issue: { labels: ["agent/alpha", "status/done"] } });
    const response = await postRequest();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ reason: "superseded" });
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(db.lease).not.toBeNull();
    expect(db.leaseDeleteCalls).toHaveLength(0);
    expect(db.settlements).toHaveLength(0);
  });

  it("refuses a blocked issue (human-hold)", async () => {
    makeState({ issue: { labels: ["agent/alpha", "status/blocked"] } });
    const response = await postRequest();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ reason: "human-hold" });
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(db.lease).not.toBeNull();
    expect(db.leaseDeleteCalls).toHaveLength(0);
    expect(db.settlements).toHaveLength(0);
  });

  it("refuses when another agent owns the issue (superseded, owner untouched)", async () => {
    makeState({ issue: { labels: ["agent/beta", "status/in-progress"] } });
    const response = await postRequest(); // names agent/alpha
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ reason: "superseded" });
    // beta's ownership is untouched.
    expect(db.lease).not.toBeNull();
    expect(db.lease.claimToken).toBe(CLAIM_TOKEN);
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(db.leaseDeleteCalls).toHaveLength(0);
    expect(db.settlements).toHaveLength(0);
  });

  // ── durable replay (idempotency) ──────────────────────────────────────────

  it("replays a committed settlement for the same key and token with zero mutation", async () => {
    makeState({
      lease: null,
      settlements: [
        {
          id: "settle-seed",
          agentName: AGENT,
          issueId: ISSUE_ID,
          settlementKey: KEY,
          claimToken: CLAIM_TOKEN,
          capacity: null,
          labels: ["status/in-progress"],
          status: null,
          statusNote: null,
          cooldownUntil: null,
          settledAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
          operation: "attempt-requeue",
          payloadHash: payloadHash(),
          attemptId: "lease-1",
        },
      ],
    });
    const response = await postRequest();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, replayed: true, attemptId: "lease-1" });
    // The committed proof is the authorization: no re-release, no supersede,
    // no lease consumption, no new/rewritten settlement.
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(mocks.supersedeIntent).not.toHaveBeenCalled();
    expect(db.leaseDeleteCalls).toHaveLength(0);
    expect(db.settlements).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({ action: "issue_attempt_requeue", success: true });
    expect(db.audit[0].notes).toContain("replayed");
  });

  it("refuses a key reused for a DIFFERENT payload (409 'already used')", async () => {
    makeState({
      lease: null,
      settlements: [
        {
          id: "settle-seed",
          agentName: AGENT,
          issueId: ISSUE_ID,
          settlementKey: KEY,
          claimToken: CLAIM_TOKEN,
          capacity: null,
          labels: ["status/in-progress"],
          status: null,
          statusNote: null,
          cooldownUntil: null,
          settledAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
          operation: "attempt-requeue",
          // A different note → a different fingerprint.
          payloadHash: payloadHash("a different note"),
          attemptId: "lease-1",
        },
      ],
    });
    const response = await postRequest();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/already used/);
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(db.leaseDeleteCalls).toHaveLength(0);
    expect(db.settlements).toHaveLength(1); // the original proof is intact
  });

  it("refuses a foreign claim token under the same key (409 'already used')", async () => {
    makeState({
      lease: null,
      settlements: [
        {
          id: "settle-seed",
          agentName: AGENT,
          issueId: ISSUE_ID,
          settlementKey: KEY,
          claimToken: "claim_other-token",
          capacity: null,
          labels: ["status/in-progress"],
          status: null,
          statusNote: null,
          cooldownUntil: null,
          settledAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
          operation: "attempt-requeue",
          payloadHash: payloadHash(),
          attemptId: "lease-1",
        },
      ],
    });
    const response = await postRequest();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/already used/);
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(db.leaseDeleteCalls).toHaveLength(0);
    expect(db.settlements).toHaveLength(1);
  });

  // ── settlement ownership race ─────────────────────────────────────────────

  it("does not consume the lease when a foreign-token record wins the key first", async () => {
    // The pre-write read sees no row; the upsert hits a competing writer's
    // committed row (first write wins) carrying a different claim token.
    makeState({
      racingSettlements: [
        {
          id: "settle-race",
          agentName: AGENT,
          issueId: ISSUE_ID,
          settlementKey: KEY,
          claimToken: "claim_other-token",
          capacity: null,
          labels: ["status/in-progress"],
          status: null,
          statusNote: null,
          cooldownUntil: null,
          settledAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
          operation: "attempt-requeue",
          payloadHash: payloadHash(),
          attemptId: "lease-9",
        },
      ],
    });
    const response = await postRequest();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/already used/);
    // The remote release landed, but the proof is not ours: the lease must
    // NOT be consumed on a record we do not own.
    expect(mocks.releaseIssueClaim).toHaveBeenCalledTimes(1);
    expect(db.lease).not.toBeNull();
    expect(db.lease.claimToken).toBe(CLAIM_TOKEN);
    expect(db.leaseDeleteCalls).toHaveLength(0);
    expect(db.settlements).toHaveLength(0); // our own proof was never recorded
  });

  // ── guard contention / fenced-write failures (retryable 503) ──────────────

  it("returns 503 while the guard is busy, but replays a committed settlement", async () => {
    guard.behavior = "busy";
    const rejected = await postRequest();
    expect(rejected.status).toBe(503);
    expect((await rejected.json()).error).toMatch(/busy or the settlement ledger is unavailable/i);
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();

    // A committed, matching settlement still answers definitively under busy
    // (a post-release crash must not hide a durable success behind a 503).
    makeState({
      lease: null,
      settlements: [
        {
          id: "settle-seed",
          agentName: AGENT,
          issueId: ISSUE_ID,
          settlementKey: KEY,
          claimToken: CLAIM_TOKEN,
          capacity: null,
          labels: ["status/in-progress"],
          status: null,
          statusNote: null,
          cooldownUntil: null,
          settledAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
          operation: "attempt-requeue",
          payloadHash: payloadHash(),
          attemptId: "lease-1",
        },
      ],
    });
    const response = await postRequest();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, replayed: true, attemptId: "lease-1" });
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(db.leaseDeleteCalls).toHaveLength(0);
  });

  it("returns 503 and touches nothing when the fenced write loses the guard", async () => {
    guard.behavior = "guard-lost";
    const response = await postRequest();
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/busy or the settlement ledger is unavailable/i);
    // The supersede ran before the region; the release itself never did.
    expect(mocks.supersedeIntent).toHaveBeenCalledTimes(1);
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(db.lease).not.toBeNull();
    expect(db.leaseDeleteCalls).toHaveLength(0);
    expect(db.settlements).toHaveLength(0);
  });

  it("returns 503 and leaves the lease untouched when the fenced write throws", async () => {
    guard.behavior = "throw";
    const response = await postRequest();
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/busy or the settlement ledger is unavailable/i);
    expect(mocks.releaseIssueClaim).toHaveBeenCalledTimes(1); // the attempt was made
    expect(db.lease).not.toBeNull();
    expect(db.lease.claimToken).toBe(CLAIM_TOKEN);
    expect(db.leaseDeleteCalls).toHaveLength(0);
    expect(db.settlements).toHaveLength(0);
    expect(db.audit[0]).toMatchObject({ action: "issue_attempt_requeue", success: false });
  });

  it("retracts the settlement and returns 503 when the lease CAS misses after recording", async () => {
    db.failLeaseDelete = true;
    const response = await postRequest();
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/busy or the settlement ledger is unavailable/i);
    expect(mocks.releaseIssueClaim).toHaveBeenCalledTimes(1);
    expect(db.leaseDeleteCalls).toHaveLength(1); // the CAS was attempted…
    // …and missed: the self-recorded proof is retracted, pinned to our token.
    expect(db.settlementDeleteCalls).toHaveLength(1);
    expect(db.settlementDeleteCalls[0]).toEqual({
      agentName: AGENT,
      issueId: ISSUE_ID,
      settlementKey: KEY,
      claimToken: CLAIM_TOKEN,
    });
    expect(db.settlements).toHaveLength(0);
    expect(db.lease).not.toBeNull();
    expect(db.lease.claimToken).toBe(CLAIM_TOKEN);
    expect(db.audit[0]).toMatchObject({ action: "issue_attempt_requeue", success: false });
  });

  // B1: failure paths must COMPLETE the guard, not retain it. `attempt-
  // requeue` has no resume branch by design — every retry re-derives the
  // whole transition idempotently (absent label = repair, first-write-wins
  // settlement, lease CAS) — so a retained, unresumable guard would wedge
  // the issue (#1367 posture). The recorded callback result pins both the
  // COMPLETE flag and the retryable unavailable value.
  it("COMPLETES the guard (no retained wedge) with the unavailable value when the remote release throws", async () => {
    guard.behavior = "throw";
    const response = await postRequest();
    expect(response.status).toBe(503);
    // The release attempt was made, but the fenced region aborted: the
    // callback returns complete:true with the retryable unavailable value —
    // the guard is released, never retained.
    expect(mocks.releaseIssueClaim).toHaveBeenCalledTimes(1);
    expect(guard.callbackResults).toHaveLength(1);
    expect(guard.callbackResults[0]).toEqual({
      complete: true,
      value: { ok: false, unavailable: true },
    });
    // Nothing was settled and the lease stays intact for the retry.
    expect(db.settlements).toHaveLength(0);
    expect(db.leaseDeleteCalls).toHaveLength(0);
    expect(db.lease).not.toBeNull();
    expect(db.lease.claimToken).toBe(CLAIM_TOKEN);
  });

  it("COMPLETES the guard (no retained wedge) with the unavailable value when the settlement record throws", async () => {
    db.failSettlementRecord = true;
    const response = await postRequest();
    expect(response.status).toBe(503);
    // The remote release landed, but the proof write failed: the callback
    // still COMPLETES — the retry re-runs the transition idempotently.
    expect(mocks.releaseIssueClaim).toHaveBeenCalledTimes(1);
    expect(guard.callbackResults).toHaveLength(1);
    expect(guard.callbackResults[0]).toEqual({
      complete: true,
      value: { ok: false, unavailable: true },
    });
    // Nothing committed: no settlement row, and the lease is not consumed
    // on a proof that was never recorded.
    expect(db.settlements).toHaveLength(0);
    expect(db.settlementDeleteCalls).toHaveLength(0);
    expect(db.leaseDeleteCalls).toHaveLength(0);
    expect(db.lease).not.toBeNull();
    expect(db.lease.claimToken).toBe(CLAIM_TOKEN);
  });

  // ── identity mismatch (400) ───────────────────────────────────────────────

  it("rejects a repoFullName/issueNumber that does not match the issue (400)", async () => {
    const wrongRepo = await postRequest({ repoFullName: "org/other" });
    expect(wrongRepo.status).toBe(400);
    expect((await wrongRepo.json()).error).toMatch(/does not match.*org\/repo#42/);

    const wrongNumber = await postRequest({ issueNumber: 43 });
    expect(wrongNumber.status).toBe(400);
    expect((await wrongNumber.json()).error).toMatch(/does not match.*org\/repo#42/);

    expect(db.lease).not.toBeNull();
    expect(db.leaseDeleteCalls).toHaveLength(0);
    expect(db.settlements).toHaveLength(0);
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
  });

  // m5: the identity gate's repo half is case-INSENSITIVE (GitHub repo names
  // are), so a case-drifted body value must not 400 forever — and the remote
  // label write then uses the CANONICAL (DB) casing, not the caller's.
  it("accepts a repoFullName that matches only in case and releases with the canonical casing", async () => {
    const response = await postRequest({ repoFullName: "Org/Repo" }); // DB has "org/repo"
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, replayed: false, attemptId: "lease-1" });
    // The release receives the DB's canonical casing, not the request's.
    expect(mocks.releaseIssueClaim).toHaveBeenCalledTimes(1);
    expect(mocks.releaseIssueClaim).toHaveBeenCalledWith(
      expect.objectContaining({ repoFullName: REPO }),
    );
    // The lease is consumed and the settlement committed as usual.
    expect(db.lease).toBeNull();
    expect(db.leaseDeleteCalls).toHaveLength(1);
    expect(db.settlements).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({ action: "issue_attempt_requeue", success: true });
  });
});
