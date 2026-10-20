import { describe, expect, it, beforeEach, vi } from "vitest";

const { githubMocks, claimGateMocks, claimMocks, guardState } = vi.hoisted(() => ({
  guardState: { resuming: false, busy: false, lastComplete: undefined as boolean | undefined },
  githubMocks: { removeIssueLabel: vi.fn().mockResolvedValue(undefined) },
  claimGateMocks: { getLiveIssueLabels: vi.fn() },
  claimMocks: { releaseIssueClaim: vi.fn() },
}));

vi.mock("./github", () => ({ removeIssueLabel: githubMocks.removeIssueLabel }));
vi.mock("./claim-gate", () => ({ getLiveIssueLabels: claimGateMocks.getLiveIssueLabels }));
vi.mock("./issue-claim", () => ({ releaseIssueClaim: claimMocks.releaseIssueClaim }));
vi.mock("./issue-mutation-guard", () => ({
  withIssueMutationGuard: async (_request: unknown, callback: (...args: any[]) => Promise<{ complete: boolean; value: unknown }>) => {
    if (guardState.busy) return { status: "busy", ownerToken: "owner-1", operation: "capacity-release" };
    const outcome = await callback(undefined, { resuming: guardState.resuming });
    guardState.lastComplete = outcome.complete;
    return { status: "completed", value: outcome.value };
  },
}));

import { recoverIssueCapacityHandoff, IssueCapacityHandoffClient } from "./issue-capacity-handoff";
import { ISSUE_HANDOFF_SETTLEMENT_RETENTION_MS } from "./issue-handoff-settlement";

const REPO = "org/repo", NUMBER = 42, ISSUE_ID = "issue-42", AGENT = "alpha", TOKEN = "claim_token_abc";
const SETTLE_KEY = "settle-1";

function settlementMatches(row: any, key: any) {
  return row.agentName === key.agentName && row.issueId === key.issueId && row.settlementKey === key.settlementKey;
}

function makeClient(overrides: Record<string, any> = {}) {
  const audits: any[] = [], mirrors: any[] = [], handoffs: any[] = [], events: string[] = [];
  const settlements: any[] = [];
  const client: any = {
    audits, mirrors, handoffs, events, settlements,
    issue: {
      findUnique: async () => ({ id: ISSUE_ID, number: NUMBER, state: "open", labels: ["agent/alpha", "status/in-progress"], blockedReason: null, repository: { fullName: REPO } }),
      update: async ({ where, data }: any) => mirrors.push({ where, data }),
    },
    lease: {
      findUnique: async () => ({ id: "lease-1", agentName: AGENT, issueId: ISSUE_ID, claimToken: TOKEN, expiredAt: new Date(Date.now() + 600_000) }),
      deleteMany: vi.fn(async () => { events.push("lease.deleteMany"); return { count: 1 }; }),
    },
    agentWork: { findMany: async () => [], update: async () => ({}) },
    agentWorkHistory: { create: async () => ({}) },
    auditLog: { create: async ({ data }: any) => audits.push(data) },
    capacityHandoff: { create: async ({ data }: any) => { const row = { id: `handoff-${handoffs.length + 1}`, ...data }; handoffs.push(row); return row; } },
    issueHandoffSettlement: {
      findUnique: vi.fn(async ({ where }: any) => settlements.find((r) => settlementMatches(r, where.agentName_issueId_settlementKey)) ?? null),
      upsert: vi.fn(async ({ where, create }: any) => {
        events.push("settlement.upsert");
        const existing = settlements.find((r) => settlementMatches(r, where.agentName_issueId_settlementKey));
        // First write wins: update: {} never rewrites an existing proof.
        if (existing) return existing;
        const row = { id: `settle-${settlements.length + 1}`, ...create };
        settlements.push(row);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const key = where.agentName_issueId_settlementKey ?? where;
        const before = settlements.length;
        for (let i = settlements.length - 1; i >= 0; i--) {
          const row = settlements[i];
          if (!settlementMatches(row, key)) continue;
          if (where.claimToken && row.claimToken !== where.claimToken) continue;
          if (where.expiresAt?.lte && new Date(row.expiresAt).getTime() > where.expiresAt.lte.getTime()) continue;
          settlements.splice(i, 1);
        }
        return { count: before - settlements.length };
      }),
    },
    ...overrides,
  };
  return client as IssueCapacityHandoffClient & {
    audits: any[]; mirrors: any[]; handoffs: any[]; events: string[]; settlements: any[];
    lease: { findUnique: any; deleteMany: any };
    issueHandoffSettlement: { findUnique: any; upsert: any; deleteMany: any };
  };
}

function seedSettlement(client: any, overrides: Record<string, any> = {}) {
  const row = {
    id: "settle-seed",
    agentName: AGENT,
    issueId: ISSUE_ID,
    settlementKey: SETTLE_KEY,
    claimToken: TOKEN,
    capacity: "provider/model-a",
    labels: ["status/ready"],
    status: "status/ready",
    statusNote: null,
    cooldownUntil: new Date(Date.now() + 600_000),
    settledAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() - 60_000 + ISSUE_HANDOFF_SETTLEMENT_RETENTION_MS),
    ...overrides,
  };
  client.settlements.push(row);
  return row;
}

function call(client: any, overrides: Record<string, any> = {}) {
  return recoverIssueCapacityHandoff({
    client,
    issueId: ISSUE_ID,
    repoFullName: REPO,
    issueNumber: NUMBER,
    agentName: AGENT,
    claimToken: TOKEN,
    capacity: "provider/model-a",
    settlementKey: SETTLE_KEY,
    actor: AGENT,
    ...overrides,
  });
}

describe("recoverIssueCapacityHandoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardState.resuming = false;
    guardState.busy = false;
    guardState.lastComplete = undefined;
    githubMocks.removeIssueLabel.mockResolvedValue(undefined);
    claimGateMocks.getLiveIssueLabels.mockResolvedValue(["agent/alpha", "status/in-progress"]);
    claimMocks.releaseIssueClaim.mockResolvedValue({ labels: ["status/ready"], status: "status/ready", statusNote: null });
  });

  it("releases through the full policy after both live reads succeed", async () => {
    const client = makeClient();
    expect((await call(client)).ok).toBe(true);
    expect(claimMocks.releaseIssueClaim).toHaveBeenCalledTimes(1);
    expect(client.lease.deleteMany).toHaveBeenCalledTimes(1);
    expect(client.settlements).toHaveLength(1);
    expect(client.settlements[0]).toMatchObject({ agentName: AGENT, issueId: ISSUE_ID, settlementKey: SETTLE_KEY, claimToken: TOKEN });
  });

  it.each(["status/blocked", "status/done"])("refuses late %s without ownership or lease mutation", async (status) => {
    claimGateMocks.getLiveIssueLabels.mockResolvedValueOnce(["agent/alpha", "status/in-progress"]).mockResolvedValueOnce(["agent/alpha", status]);
    const client = makeClient();
    expect(await call(client)).toMatchObject({ ok: false, code: status === "status/blocked" ? "human_hold" : "issue_done" });
    expect(claimMocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(githubMocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(client.lease.deleteMany).not.toHaveBeenCalled();
    expect(client.mirrors).toHaveLength(0);
    expect(client.settlements).toHaveLength(0);
  });

  it("second read failure returns 503 without writes and retains lease", async () => {
    claimGateMocks.getLiveIssueLabels.mockResolvedValueOnce(["agent/alpha", "status/in-progress"]).mockRejectedValueOnce(new Error("offline"));
    const client = makeClient();
    const result = await call(client);
    expect(result).toMatchObject({ ok: false, httpStatus: 503, code: "github_unavailable" });
    expect(githubMocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(client.lease.deleteMany).not.toHaveBeenCalled();
    expect(client.mirrors).toHaveLength(0);
    expect(client.audits.at(-1)).toMatchObject({ success: false });
  });

  it("failed targeted removal returns 500 without cache mirroring", async () => {
    claimGateMocks.getLiveIssueLabels.mockResolvedValueOnce(["agent/alpha", "status/in-progress"]).mockResolvedValueOnce(["agent/omega", "status/in-progress"]);
    githubMocks.removeIssueLabel.mockRejectedValueOnce(new Error("write failed"));
    const client = makeClient();
    const result = await call(client);
    expect(result).toMatchObject({ ok: false, httpStatus: 500, code: "release_failed" });
    expect(client.lease.deleteMany).not.toHaveBeenCalled();
    expect(client.mirrors).toHaveLength(0);
    expect(client.audits.at(-1)).toMatchObject({ success: false });
  });

  it("resumes exact-token cleanup after prior label removal without changing resting status", async () => {
    guardState.resuming = true;
    claimGateMocks.getLiveIssueLabels.mockResolvedValue(["status/in-progress"]);
    const client = makeClient();
    const result = await call(client);
    expect(result).toMatchObject({ ok: true, status: "status/in-progress" });
    expect(claimMocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(client.lease.deleteMany).toHaveBeenCalledWith({ where: { id: "lease-1", agentName: AGENT, issueId: ISSUE_ID, claimToken: TOKEN } });
  });

  it("refuses a claim without a token", async () => {
    const client = makeClient({ lease: { findUnique: async () => ({ id: "lease-1", claimToken: null, expiredAt: new Date(Date.now() + 600_000) }), deleteMany: vi.fn() } });
    expect(await call(client)).toMatchObject({ ok: false, code: "no_active_claim" });
    expect(client.audits).toHaveLength(0);
  });

  it("omitting settlementKey keeps the pre-#1262 path and never touches settlement storage", async () => {
    const client = makeClient();
    const result = await call(client, { settlementKey: undefined });
    expect(result).toMatchObject({ ok: true, replayed: false });
    expect(client.issueHandoffSettlement.findUnique).not.toHaveBeenCalled();
    expect(client.issueHandoffSettlement.upsert).not.toHaveBeenCalled();
    expect(client.settlements).toHaveLength(0);
  });

  it("replays the recorded success with zero mutation when the lease is gone", async () => {
    const { client, row } = seededClient({}, { lease: { findUnique: async () => null, deleteMany: vi.fn() } });
    const result = await call(client);
    expect(result).toMatchObject({ ok: true, replayed: true, labels: row.labels, status: "status/ready", statusNote: null });
    expect((result as any).cooldownUntil?.getTime()).toBe(row.cooldownUntil.getTime());
    expect(claimMocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(githubMocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(client.lease.deleteMany).not.toHaveBeenCalled();
    expect(client.mirrors).toHaveLength(0);
    expect(client.handoffs).toHaveLength(0);
    expect(client.settlements).toHaveLength(1);
    expect(client.audits).toHaveLength(1);
    expect(client.audits[0]).toMatchObject({ action: "issue_capacity_handoff", success: true });
    expect(client.audits[0].notes).toContain("replayed");
  });

  it("replays even when the issue has since been blocked by a human, with zero mutation", async () => {
    const { client } = seededClient({}, { lease: { findUnique: async () => null, deleteMany: vi.fn() } });
    claimGateMocks.getLiveIssueLabels.mockResolvedValue(["agent/alpha", "status/blocked"]);
    const result = await call(client);
    expect(result).toMatchObject({ ok: true, replayed: true });
    expect(claimMocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(githubMocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(client.lease.deleteMany).not.toHaveBeenCalled();
    expect(client.mirrors).toHaveLength(0);
  });

  it("refuses with an expiry note and prunes when the proof has expired", async () => {
    const { client } = seededClient({ expiresAt: new Date(Date.now() - 1000) }, { lease: { findUnique: async () => null, deleteMany: vi.fn() } });
    const result = await call(client);
    expect(result).toMatchObject({ ok: false, httpStatus: 409, code: "no_active_claim" });
    expect((result as any).message).toContain("expired");
    expect(client.settlements).toHaveLength(0);
    expect(client.audits).toHaveLength(0);
  });

  it("refuses a foreign token presented to a settled key without replay", async () => {
    const { client } = seededClient({ claimToken: "claim_other" }, { lease: { findUnique: async () => null, deleteMany: vi.fn() } });
    const result = await call(client);
    expect(result).toMatchObject({ ok: false, httpStatus: 409, code: "no_active_claim" });
    expect((result as any).message).toContain("different claim token");
    expect(client.audits).toHaveLength(0);
    expect(claimMocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(client.lease.deleteMany).not.toHaveBeenCalled();
  });

  it("never replays over a newer claim epoch", async () => {
    const { client } = seededClient({ claimToken: "claim_old" }, {
      lease: {
        findUnique: async () => ({ id: "lease-2", agentName: AGENT, issueId: ISSUE_ID, claimToken: "claim_new", expiredAt: new Date(Date.now() + 600_000) }),
        deleteMany: vi.fn(),
      },
    });
    const result = await call(client);
    expect(result).toMatchObject({ ok: false, httpStatus: 409, code: "stale_claim_token" });
    expect(claimMocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(githubMocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(client.lease.deleteMany).not.toHaveBeenCalled();
    expect(client.mirrors).toHaveLength(0);
  });

  it("refuses a settlement key bound to a different claim incarnation before any remote work", async () => {
    const { client } = seededClient({ claimToken: "claim_other" });
    const result = await call(client);
    expect(result).toMatchObject({ ok: false, httpStatus: 409, code: "settlement_key_conflict" });
    expect(claimMocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(githubMocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(client.lease.deleteMany).not.toHaveBeenCalled();
    expect(client.mirrors).toHaveLength(0);
  });

  it("fails closed with zero mutation when the settlement fence read fails over a foreign-token proof", async () => {
    // T1 proof durably settled + live T2 lease + failed fence read: the read
    // cannot establish absence, so releasing T2 would bypass the cross-claim
    // key fence. Must refuse retryably before any GitHub or lease mutation.
    const { client } = seededClient({ claimToken: "claim_other" });
    client.issueHandoffSettlement.findUnique.mockRejectedValue(new Error("db down"));
    const result = await call(client);
    expect(result).toMatchObject({ ok: false, httpStatus: 503, code: "settlement_unavailable" });
    expect((result as any).message).toContain("nothing was released");
    // Retryable refusal with nothing mutated: the guard must stay so the
    // exact-token retry resumes once the database recovers.
    expect(guardState.lastComplete).toBe(false);
    expect(claimGateMocks.getLiveIssueLabels).not.toHaveBeenCalled();
    expect(claimMocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(githubMocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(client.lease.deleteMany).not.toHaveBeenCalled();
    expect(client.mirrors).toHaveLength(0);
  });

  it("refuses retryably when the settlement fence read fails without any record", async () => {
    const client = makeClient();
    client.issueHandoffSettlement.findUnique.mockRejectedValue(new Error("db down"));
    const result = await call(client);
    expect(result).toMatchObject({ ok: false, httpStatus: 503, code: "settlement_unavailable" });
    expect(claimMocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(client.lease.deleteMany).not.toHaveBeenCalled();
  });

  it("does not consume the lease when the settlement upsert returns a foreign-token row", async () => {
    // Concurrent foreign insert between the (absent) fence read and the
    // first-write-wins upsert: the returned proof is not ours, so the lease
    // CAS must not proceed and no success may be reported.
    const client = makeClient();
    client.issueHandoffSettlement.upsert.mockResolvedValueOnce({ id: "settle-race", claimToken: "claim_other" });
    const result = await call(client);
    expect(result).toMatchObject({ ok: false, httpStatus: 409, code: "settlement_key_conflict" });
    expect(client.lease.deleteMany).not.toHaveBeenCalled();
    expect(client.audits.at(-1)).toMatchObject({ success: false });
    // An unverifiable (null) upsert result proves nothing either: fail closed.
    const client2 = makeClient();
    client2.issueHandoffSettlement.upsert.mockResolvedValueOnce(null);
    const result2 = await call(client2);
    expect(result2).toMatchObject({ ok: false, httpStatus: 409, code: "settlement_key_conflict" });
    expect(client2.lease.deleteMany).not.toHaveBeenCalled();
  });

  it("reports cooldownUntil null on fresh success when the cooldown write fails, while replay echoes the pinned deadline", async () => {
    // Documented split (#1262): the fresh response degrades to "no cooldown"
    // when the best-effort cooldown write fails, while the durable settlement
    // row pins the intended deadline and the replay echoes the recorded proof.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = makeClient({ capacityHandoff: { create: async () => { throw new Error("cooldown db down"); } } });
      const result = await call(client);
      expect(result).toMatchObject({ ok: true, replayed: false, cooldownUntil: null });
      expect(client.settlements).toHaveLength(1);
      const pinned = new Date(client.settlements[0].cooldownUntil).getTime();
      expect(pinned).toBeGreaterThan(Date.now());
      client.lease.findUnique = async () => null;
      const replay = await call(client);
      expect(replay).toMatchObject({ ok: true, replayed: true });
      expect((replay as any).cooldownUntil.getTime()).toBe(pinned);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("records the settlement before consuming the lease, with bounded deadline and retention", async () => {
    const client = makeClient();
    const now = new Date("2026-10-18T00:00:00Z");
    const result = await call(client, { now });
    expect(result).toMatchObject({ ok: true, replayed: false });
    expect(client.events.indexOf("settlement.upsert")).toBeGreaterThanOrEqual(0);
    expect(client.events.indexOf("lease.deleteMany")).toBeGreaterThan(client.events.indexOf("settlement.upsert"));
    expect(client.settlements).toHaveLength(1);
    const record = client.settlements[0];
    expect(record.claimToken).toBe(TOKEN);
    expect(record.labels).toEqual(["status/ready"]);
    expect(new Date(record.settledAt).toISOString()).toBe(now.toISOString());
    expect(new Date(record.expiresAt).getTime() - new Date(record.settledAt).getTime()).toBe(ISSUE_HANDOFF_SETTLEMENT_RETENTION_MS);
    const cooldownMs = new Date(record.cooldownUntil).getTime() - now.getTime();
    expect(cooldownMs).toBeGreaterThanOrEqual(60_000);
    expect(cooldownMs).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
    expect((result as any).cooldownUntil?.getTime()).toBe(new Date(record.cooldownUntil).getTime());
    expect(client.audits.at(-1).notes).toContain(`settlementKey=${SETTLE_KEY}`);
  });

  it("retracts its own settlement record when the lease CAS misses", async () => {
    const client = makeClient();
    client.lease.deleteMany.mockResolvedValue({ count: 0 });
    const result = await call(client);
    expect(result).toMatchObject({ ok: false, httpStatus: 409, code: "handoff_race_lost" });
    expect(client.settlements).toHaveLength(0);
    expect(client.issueHandoffSettlement.deleteMany).toHaveBeenCalledWith({
      where: { agentName: AGENT, issueId: ISSUE_ID, settlementKey: SETTLE_KEY, claimToken: TOKEN },
    });
  });

  it("fails closed when the settlement record cannot be persisted", async () => {
    const client = makeClient();
    client.issueHandoffSettlement.upsert.mockRejectedValueOnce(new Error("disk full"));
    const result = await call(client);
    expect(result).toMatchObject({ ok: false, httpStatus: 500, code: "release_failed" });
    expect(client.lease.deleteMany).not.toHaveBeenCalled();
    expect(client.audits.at(-1)).toMatchObject({ success: false });
    expect(client.audits.at(-1).errorMessage).toContain("disk full");
  });

  it("crash resume keeps the original proof (first write wins) and completes the release", async () => {
    guardState.resuming = true;
    claimGateMocks.getLiveIssueLabels.mockResolvedValue(["status/in-progress"]);
    const client = makeClient();
    const seeded = seedSettlement(client, { settledAt: new Date(Date.now() - 3_600_000) });
    const result = await call(client);
    expect(result).toMatchObject({ ok: true, replayed: false, status: "status/in-progress" });
    expect(client.issueHandoffSettlement.upsert).toHaveBeenCalledTimes(1);
    expect(client.settlements).toHaveLength(1);
    expect(new Date(client.settlements[0].settledAt).getTime()).toBe(new Date(seeded.settledAt).getTime());
    expect(client.lease.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("answers a recorded replay even while the guard is held (post-release crash)", async () => {
    // Crash after the lease CAS but before the guard was deleted: the orphaned
    // executing guard must not hide the durably completed release.
    guardState.busy = true;
    const { client, row } = seededClient({}, { lease: { findUnique: async () => null, deleteMany: vi.fn() } });
    const result = await call(client);
    expect(result).toMatchObject({ ok: true, replayed: true, labels: row.labels, status: "status/ready" });
    expect(client.audits[0].notes).toContain("replayed");
    expect(client.lease.deleteMany).not.toHaveBeenCalled();
    expect(claimMocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(client.mirrors).toHaveLength(0);
  });

  it("replays only past the lease check when the guard is held mid-release", async () => {
    // Record present but lease still live (crash before the CAS): the release
    // is not provably complete, so the busy refusal stands.
    guardState.busy = true;
    const { client } = seededClient();
    const result = await call(client);
    expect(result).toMatchObject({ ok: false, httpStatus: 409, code: "handoff_race_lost" });
    expect(claimMocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(client.lease.deleteMany).not.toHaveBeenCalled();
    expect(client.audits).toHaveLength(0);
  });

  it("stays race lost when the guard is held without any record (lease gone)", async () => {
    guardState.busy = true;
    const client = makeClient({ lease: { findUnique: async () => null, deleteMany: vi.fn() } });
    const result = await call(client);
    expect(result).toMatchObject({ ok: false, httpStatus: 409, code: "handoff_race_lost" });
    expect(client.audits).toHaveLength(0);
  });

  it("applies the identity gate before answering a busy-path replay", async () => {
    guardState.busy = true;
    const { client } = seededClient({}, { lease: { findUnique: async () => null, deleteMany: vi.fn() } });
    const result = await call(client, { repoFullName: "org/other", issueNumber: 99 });
    expect(result).toMatchObject({ ok: false, httpStatus: 400, code: "identity_mismatch" });
    expect(client.audits).toHaveLength(0);
  });

  it("logs and stays fail-closed when the settlement retraction itself fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = makeClient();
      client.lease.deleteMany.mockResolvedValue({ count: 0 });
      client.issueHandoffSettlement.deleteMany.mockRejectedValueOnce(new Error("offline"));
      const result = await call(client);
      expect(result).toMatchObject({ ok: false, httpStatus: 409, code: "handoff_race_lost" });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("settlement retraction failed"), expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// Seed a settlement record into a fresh client and return both.
function seededClient(seed: Record<string, any> = {}, overrides: Record<string, any> = {}) {
  const client = makeClient(overrides);
  const row = seedSettlement(client, seed);
  return { client, row };
}
