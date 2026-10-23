vi.mock("@/lib/issue-mutation-guard", () => ({
  // The capacity-handoff module derives its fenced-region transaction budget
  // from this at import time.
  fencedWriteTimeoutMs: () => 195_000,
  withIssueMutationGuard: async (_request: unknown, callback: any) => {
    const result = await callback(undefined, {
      resuming: false,
      // #1254: the fenced remote write is ATOMIC with the guard check — a
      // stolen guard means the forge function is NEVER called.
      runFencedRemoteWrite: async (fn: any) => {
        const { prisma } = await import("@/lib/prisma");
        return { status: "written", value: await fn({ issue: prisma.issue }) };
      },
    });
    return { status: result.complete ? "completed" : "retained", value: result.value };
  },
}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authedRequest,
  makeDispatchEnvMock,
  TEST_AGENT_TOKEN as mockToken,
} from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

// dispatch-env: maintainer token (full rights), a worker token bound to
// "alpha", and an unbound legacy worker token (#1129 refusals).
vi.mock("@/lib/dispatch-env", () =>
  makeDispatchEnvMock(mockToken, { "unbound-worker-token": "worker" }, { "bound-alpha-token": "alpha" }),
);

const { mocks, db } = vi.hoisted(() => {
  const mocks = {
    getLiveIssueLabels: vi.fn<(repo: string, num: number) => Promise<string[]>>(async () => []),
    addIssueLabel: vi.fn(async () => {}),
    removeIssueLabel: vi.fn(async () => {}),
    fetchPullRequestState: vi.fn(async () => ({ state: null as string | null, mergedAt: null as string | null })),
  };
  // Mutable in-memory database, reset per test via makeState().
  const db: Record<string, any> = {
    issue: null,
    lease: null,
    agentWork: [] as any[],
    agentWorkUpdates: [] as any[],
    agentWorkHistory: [] as any[],
    handoffs: [] as any[],
    settlements: [] as any[],
    audit: [] as any[],
    leaseDeletes: 0,
    failSettlementUpsert: false,
  };
  return { mocks, db };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      findUnique: async ({ where }: any) =>
        db.issue && db.issue.id === where.id ? db.issue : null,
      update: async ({ where, data }: any) => {
        if (db.issue && db.issue.id === where.id) db.issue = { ...db.issue, ...data };
        return db.issue;
      },
    },
    lease: {
      findUnique: async ({ where }: any) => {
        const key = where.agentName_issueId;
        return db.lease && db.lease.agentName === key.agentName && db.lease.issueId === key.issueId
          ? db.lease
          : null;
      },
      deleteMany: async ({ where }: any) => {
        if (
          db.lease &&
          db.lease.id === where.id &&
          db.lease.agentName === where.agentName &&
          db.lease.issueId === where.issueId &&
          db.lease.claimToken === where.claimToken
        ) {
          db.lease = null;
          db.leaseDeletes += 1;
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
    capacityHandoff: {
      create: async ({ data }: any) => {
        if (db.failHandoffCreate) throw new Error("cooldown write failed");
        db.handoffs.push(data);
        return data;
      },
      findMany: async () => db.handoffs,
      deleteMany: async () => ({ count: 0 }),
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
        return db.settlements.find((r: any) =>
          r.agentName === key.agentName && r.issueId === key.issueId && r.settlementKey === key.settlementKey,
        ) ?? null;
      },
      upsert: async ({ where, create }: any) => {
        if (db.failSettlementUpsert) throw new Error("settlement write failed");
        const key = where.agentName_issueId_settlementKey;
        const existing = db.settlements.find((r: any) =>
          r.agentName === key.agentName && r.issueId === key.issueId && r.settlementKey === key.settlementKey,
        );
        // First write wins: update: {} never rewrites an existing proof.
        if (existing) return existing;
        const row = { id: `settle-${db.settlements.length + 1}`, ...create };
        db.settlements.push(row);
        return row;
      },
      deleteMany: async ({ where }: any) => {
        const key = where.agentName_issueId_settlementKey ?? where;
        const before = db.settlements.length;
        db.settlements = db.settlements.filter((r: any) => {
          if (!(r.agentName === key.agentName && r.issueId === key.issueId && r.settlementKey === key.settlementKey)) return true;
          if (where.claimToken && r.claimToken !== where.claimToken) return true;
          if (where.expiresAt?.lte && new Date(r.expiresAt).getTime() > where.expiresAt.lte.getTime()) return true;
          return false;
        });
        return { count: before - db.settlements.length };
      },
    },
  },
}));

vi.mock("@/lib/claim-gate", () => ({
  getLiveIssueLabels: mocks.getLiveIssueLabels,
}));

vi.mock("@/lib/github", () => ({
  addIssueLabel: mocks.addIssueLabel,
  removeIssueLabel: mocks.removeIssueLabel,
}));

vi.mock("@/lib/github-prs", () => ({
  fetchPullRequestState: mocks.fetchPullRequestState,
}));

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";

const CLAIM_TOKEN = "claim_test-token-1";

function makeState(overrides: Record<string, unknown> = {}) {
  db.issue = {
    id: "issue-1",
    number: 42,
    state: "open",
    blockedReason: null,
    linkedPrNumber: null,
    labels: ["agent/alpha", "status/in-progress"],
    repository: { fullName: "org/repo" },
    ...overrides,
  };
  db.lease = {
    id: "lease-1",
    agentName: "alpha",
    issueId: "issue-1",
    claimToken: CLAIM_TOKEN,
    expiredAt: new Date(Date.now() + 10 * 60 * 1000),
    ...(overrides.lease as object | undefined),
  };
  if (overrides.lease === null) db.lease = null;
  db.agentWork = [{ id: "work-1" }];
  db.agentWorkUpdates = [];
  db.agentWorkHistory = [];
  db.handoffs = [];
  db.settlements = (overrides.settlements as any[]) ?? [];
  db.audit = [];
  db.leaseDeletes = 0;
  db.failHandoffCreate = false;
  db.failSettlementUpsert = false;
  mocks.getLiveIssueLabels.mockResolvedValue(
    (overrides.liveLabels as string[] | undefined) ?? ["agent/alpha", "status/in-progress"],
  );
  mocks.addIssueLabel.mockResolvedValue(undefined);
  mocks.removeIssueLabel.mockResolvedValue(undefined);
}

function postRequest(body: Record<string, unknown> = {}, token?: string) {
  return POST(
    authedRequest("http://localhost/api/issues/capacity-handoff", {
      method: "POST",
      token,
      body: {
        issueId: "issue-1",
        repoFullName: "org/repo",
        issueNumber: 42,
        agentName: "alpha",
        claimToken: CLAIM_TOKEN,
        capacity: "provider/model-a",
        ...body,
      },
    }),
  );
}

describe("POST /api/issues/capacity-handoff (#1256)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuthCaches();
    resetRateLimits();
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.DISPATCH_CAPACITY_COOLDOWN_MS;
    makeState();
  });

  afterEach(() => {
    delete process.env.DISPATCH_CAPACITY_COOLDOWN_MS;
  });

  // ── auth ──────────────────────────────────────────────────────────────────

  it("requires bearer authentication", async () => {
    const response = await POST(
      new Request("http://localhost/api/issues/capacity-handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("refuses a bound worker token handing off ANOTHER agent's claim", async () => {
    const response = await postRequest({ agentName: "bravo" }, "bound-alpha-token");
    expect(response.status).toBe(403);
    expect(db.leaseDeletes).toBe(0);
  });

  it("refuses the unbound legacy worker token (#1129)", async () => {
    const response = await postRequest({}, "unbound-worker-token");
    expect(response.status).toBe(403);
    expect(db.leaseDeletes).toBe(0);
  });

  // ── validation ─────────────────────────────────────────────────────────────

  it("rejects a missing or blank capacity (explicit recognition required)", async () => {
    expect((await postRequest({ capacity: undefined })).status).toBe(400);
    expect((await postRequest({ capacity: "   " })).status).toBe(400);
    expect((await postRequest({ capacity: "x".repeat(201) })).status).toBe(400);
    expect(db.leaseDeletes).toBe(0);
  });

  it("rejects a missing or oversized claim token", async () => {
    expect((await postRequest({ claimToken: undefined })).status).toBe(400);
    expect((await postRequest({ claimToken: "" })).status).toBe(400);
    expect((await postRequest({ claimToken: "t".repeat(201) })).status).toBe(400);
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("releases the exact claim, returns the issue to ready, and records a scoped cooldown", async () => {
    const response = await postRequest();
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.labels).not.toContain("agent/alpha");
    expect(json.labels).toContain("status/ready");
    expect(json.status).toBe("status/ready");
    expect(new Date(json.cooldownUntil).getTime()).toBeGreaterThan(Date.now());

    // Ownership token consumed, claim label removed, in-progress -> ready.
    expect(db.lease).toBeNull();
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/alpha");
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-progress");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/ready");
    expect(db.issue.labels).toContain("status/ready");
    expect(db.issue.labels).not.toContain("agent/alpha");

    // Capacity-scoped cooldown row.
    expect(db.handoffs).toHaveLength(1);
    expect(db.handoffs[0]).toMatchObject({
      kind: "issue",
      capacity: "provider/model-a",
      repoFullName: "org/repo",
      issueNumber: 42,
      agentName: "alpha",
      issueId: "issue-1",
    });

    // AgentWork retired with history.
    expect(db.agentWorkUpdates[0]).toMatchObject({
      where: { id: "work-1" },
      data: { state: "RELEASED" },
    });
    expect(db.agentWorkHistory[0]).toMatchObject({
      workId: "work-1",
      action: "capacity_handoff",
      state: "RELEASED",
    });

    // Audit trail.
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({
      action: "issue_capacity_handoff",
      success: true,
      issueNumber: 42,
    });
    expect(db.audit[0].notes).toContain("capacity=provider/model-a");
  });

  it("honors DISPATCH_CAPACITY_COOLDOWN_MS for the bounded cooldown", async () => {
    process.env.DISPATCH_CAPACITY_COOLDOWN_MS = "120000";
    const response = await postRequest();
    const json = await response.json();
    const delta = new Date(json.cooldownUntil).getTime() - Date.now();
    expect(delta).toBeGreaterThan(100_000);
    expect(delta).toBeLessThan(130_000);
  });

  // ── fencing: stale owners, races, changed ownership ───────────────────────

  it("refuses a stale claim token after the claim was re-issued (exact-claim fence)", async () => {
    // The lease was released and re-claimed: new row, new token.
    db.lease = { ...db.lease, id: "lease-2", claimToken: "claim_newer-token" };
    const response = await postRequest(); // old CLAIM_TOKEN
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/does not match the current claim/i);
    // The NEW claim is untouched.
    expect(db.lease).not.toBeNull();
    expect(db.lease.claimToken).toBe("claim_newer-token");
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(db.handoffs).toHaveLength(0);
  });

  it("refuses an expired claim (stale recovery owns release)", async () => {
    db.lease = { ...db.lease, expiredAt: new Date(Date.now() - 1000) };
    const response = await postRequest();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/expired/i);
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("refuses when no claim exists", async () => {
    db.lease = null;
    const response = await postRequest();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/no active tokened claim/i);
  });

  it("refuses when GitHub shows a DIFFERENT agent owns the claim (concurrent new owner)", async () => {
    mocks.getLiveIssueLabels.mockResolvedValue(["agent/bravo", "status/in-progress"]);
    const response = await postRequest();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/belongs to agent\/bravo/i);
    // No writes at all — bravo's claim is untouched.
    expect(db.lease).not.toBeNull();
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(db.handoffs).toHaveLength(0);
  });

  it("refuses when the agent label is gone from GitHub (ownership changed / already released)", async () => {
    mocks.getLiveIssueLabels.mockResolvedValue(["status/ready"]);
    const response = await postRequest();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/no agent claim/i);
    expect(db.lease).not.toBeNull();
  });

  it("relies on the issue guard for cooperating writers and retains the lease if a bypassed CAS fails", async () => {
    // A cooperating writer cannot enter while this operation owns the durable
    // guard. Simulate an out-of-band/bypassing writer winning the lease CAS:
    // remote cleanup may already have happened, but no cooldown is recorded.
    const { prisma } = await import("@/lib/prisma");
    const leaseModel = (prisma as any).lease;
    const original = leaseModel.deleteMany;
    leaseModel.deleteMany = async () => ({ count: 0 });
    try {
      const response = await postRequest();
      expect(response.status).toBe(409);
      expect((await response.json()).error).toMatch(/changed concurrently/i);
      expect(mocks.removeIssueLabel).toHaveBeenCalled();
      expect(db.handoffs).toHaveLength(0);
      expect(db.lease).not.toBeNull();
    } finally {
      leaseModel.deleteMany = original;
    }
  });

  // ── human holds ────────────────────────────────────────────────────────────

  it("refuses a deliberate block (human hold with blockedReason)", async () => {
    db.issue = { ...db.issue, labels: ["agent/alpha", "status/blocked"], blockedReason: "waiting on vendor API" };
    mocks.getLiveIssueLabels.mockResolvedValue(["agent/alpha", "status/blocked"]);
    const response = await postRequest();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/human hold/i);
    expect(db.lease).not.toBeNull();
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("refuses a LIVE status/blocked even when the cache has not caught up (fail-closed hold)", async () => {
    // Cache still says in-progress with no blockedReason; GitHub was blocked
    // out-of-band. The live set wins — the block is never reversed.
    mocks.getLiveIssueLabels.mockResolvedValue(["agent/alpha", "status/blocked"]);
    const response = await postRequest();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/status\/blocked/i);
    expect(db.lease).not.toBeNull();
    expect(db.leaseDeletes).toBe(0);
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("narrows to an ownership-only release when ownership changed after the CAS", async () => {
    // First (pre-CAS) read shows our claim; the post-CAS re-read shows a
    // force-claim moved the issue to bravo. Only OUR label may be removed —
    // bravo's status transition must survive.
    mocks.getLiveIssueLabels
      .mockResolvedValueOnce(["agent/alpha", "status/in-progress"])
      .mockResolvedValueOnce(["agent/bravo", "status/in-progress"]);
    const response = await postRequest();
    expect(response.status).toBe(200);
    const json = await response.json();
    // Ownership-only: our agent label removed, no status churn.
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/alpha");
    expect(mocks.removeIssueLabel).not.toHaveBeenCalledWith("org/repo", 42, "status/in-progress");
    expect(mocks.addIssueLabel).not.toHaveBeenCalledWith("org/repo", 42, "status/ready");
    expect(json.labels).toContain("status/in-progress");
    expect(json.labels).not.toContain("agent/alpha");
    expect(db.audit[0].notes).toMatch(/ownership changed before cleanup/i);
  });

  it("still succeeds when the cooldown write fails after the release committed", async () => {
    db.failHandoffCreate = true;
    const response = await postRequest();
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.cooldownUntil).toBeNull();
    expect(db.lease).toBeNull();
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/alpha");
    expect(db.audit[0].notes).toMatch(/none \(cooldown write failed\)/i);
  });

  it("refuses a done issue (live status/done wins over the cache)", async () => {
    mocks.getLiveIssueLabels.mockResolvedValue(["agent/alpha", "status/done"]);
    const response = await postRequest();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/done/i);
    expect(db.lease).not.toBeNull();
  });

  it("refuses a closed issue before touching the lease", async () => {
    db.issue = { ...db.issue, state: "closed" };
    const response = await postRequest();
    expect(response.status).toBe(400);
    expect(db.leaseDeletes).toBe(0);
    expect(mocks.getLiveIssueLabels).not.toHaveBeenCalled();
  });

  // ── fail-closed GitHub behavior ───────────────────────────────────────────

  it("fails closed when live GitHub labels cannot be verified", async () => {
    mocks.getLiveIssueLabels.mockRejectedValue(new Error("GitHub 503"));
    const response = await postRequest();
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/could not verify live github labels/i);
    expect(db.lease).not.toBeNull();
    expect(db.handoffs).toHaveLength(0);
  });

  it("rejects a cross-referenced issue identity before any write (#1129)", async () => {
    const response = await postRequest({ issueNumber: 43 });
    expect(response.status).toBe(400);
    expect(db.leaseDeletes).toBe(0);
  });

  it("retains the lease and guard after remote label cleanup fails", async () => {
    mocks.removeIssueLabel.mockRejectedValueOnce(new Error("GitHub write failed"));
    const response = await postRequest();
    expect(response.status).toBe(500);
    // Remote cleanup is incomplete: retain ownership state and permit only an
    // exact-token retry to resume the durable guard.
    expect(db.lease).not.toBeNull();
    expect(db.leaseDeletes).toBe(0);
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({ action: "issue_capacity_handoff", success: false });
    expect(db.audit[0].errorMessage).toMatch(/lease retained/i);
    expect(db.handoffs).toHaveLength(0);
  });

  // ── durable settlement replay (#1262) ──────────────────────────────────────

  it("rejects a malformed settlementKey", async () => {
    expect((await postRequest({ settlementKey: "" })).status).toBe(400);
    expect((await postRequest({ settlementKey: "k".repeat(201) })).status).toBe(400);
    expect((await postRequest({ settlementKey: 42 })).status).toBe(400);
    expect(db.leaseDeletes).toBe(0);
  });

  it("accepts an explicit null settlementKey as the pre-#1262 path", async () => {
    expect((await postRequest({ settlementKey: null })).status).toBe(200);
    expect(db.settlements).toHaveLength(0);
  });

  it("records the settlement on a keyed release and echoes replayed:false", async () => {
    const response = await postRequest({ settlementKey: "run-1:handoff" });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.replayed).toBe(false);
    expect(db.settlements).toHaveLength(1);
    expect(db.settlements[0]).toMatchObject({
      agentName: "alpha",
      issueId: "issue-1",
      settlementKey: "run-1:handoff",
      claimToken: CLAIM_TOKEN,
      capacity: "provider/model-a",
      labels: expect.arrayContaining(["status/ready"]),
      status: "status/ready",
    });
    expect(new Date(db.settlements[0].expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(db.audit[0].notes).toContain("settlementKey=run-1:handoff");
  });

  it("replays the recorded success for the same key and claim token after the lease is gone", async () => {
    db.lease = null;
    db.settlements = [{
      id: "settle-seed",
      agentName: "alpha",
      issueId: "issue-1",
      settlementKey: "run-1:handoff",
      claimToken: CLAIM_TOKEN,
      capacity: "provider/model-a",
      labels: ["status/ready"],
      status: "status/ready",
      statusNote: null,
      cooldownUntil: new Date(Date.now() + 600_000),
      settledAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 6 * 24 * 3600_000),
    }];
    const response = await postRequest({ settlementKey: "run-1:handoff" });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.replayed).toBe(true);
    expect(json.labels).toEqual(["status/ready"]);
    expect(json.cooldownUntil).not.toBeNull();
    // Zero mutation: no label writes, no lease delete, no cooldown row.
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(db.leaseDeletes).toBe(0);
    expect(db.handoffs).toHaveLength(0);
    expect(db.audit[0].notes).toContain("replayed");
  });

  it("never replays a foreign token over a settled key", async () => {
    db.lease = null;
    db.settlements = [{
      id: "settle-seed",
      agentName: "alpha",
      issueId: "issue-1",
      settlementKey: "run-1:handoff",
      claimToken: "claim_other-token",
      capacity: "provider/model-a",
      labels: ["status/ready"],
      status: "status/ready",
      statusNote: null,
      cooldownUntil: new Date(Date.now() + 600_000),
      settledAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 6 * 24 * 3600_000),
    }];
    const response = await postRequest({ settlementKey: "run-1:handoff" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/different claim token/i);
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("fails closed when the settlement record cannot be persisted", async () => {
    db.failSettlementUpsert = true;
    const response = await postRequest({ settlementKey: "run-1:handoff" });
    expect(response.status).toBe(500);
    // Proof must be durable or the release does not report success.
    expect(db.lease).not.toBeNull();
    expect(db.leaseDeletes).toBe(0);
    expect(db.audit[0]).toMatchObject({ action: "issue_capacity_handoff", success: false });
    expect(db.audit[0].errorMessage).toMatch(/settlement/i);
  });
});
