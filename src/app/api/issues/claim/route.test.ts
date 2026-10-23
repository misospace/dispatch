const { guardState } = vi.hoisted(() => ({ guardState: { resuming: false, stillHolds: true } }));
vi.mock("@/lib/issue-mutation-guard", () => ({
  withIssueMutationGuard: async (_request: unknown, callback: any) => {
    const result = await callback(undefined, { resuming: guardState.resuming, stillHoldsGuard: async () => guardState.stillHolds });
    return { status: result.complete ? "completed" : "retained", value: result.value };
  },
}));
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, authedRequest } from "@/test/route-helpers";

const { WORKER_TOKEN } = vi.hoisted(() => ({ WORKER_TOKEN: "worker-token" }));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUnique: vi.fn(), updateIssue: vi.fn(), createAuditLog: vi.fn(),
    createLifecycleEvent: vi.fn().mockResolvedValue({ id: "evt-1" }),
    upsertLifecycleEvent: vi.fn().mockResolvedValue({ id: "evt-1" }),
    addIssueLabel: vi.fn(), removeIssueLabel: vi.fn(),
    leaseFindMany: vi.fn(), leaseDeleteMany: vi.fn(),
    leaseFindUnique: vi.fn(), leaseFindUniqueOrThrow: vi.fn(),
    leaseCreate: vi.fn(), leaseUpdate: vi.fn(), leaseDelete: vi.fn(), leaseFindFirst: vi.fn(),
    intentFindFirst: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
    intentUpdateMany: vi.fn(async () => ({ count: 1 })),
    supersedeAuditCreate: vi.fn(async () => ({ id: "audit-supersede" })),
    getLiveIssueLabels: vi.fn().mockResolvedValue([] as string[]),
    agentWorkFindMany: vi.fn().mockResolvedValue([]),
    agentWorkUpdate: vi.fn().mockResolvedValue({}),
    agentWorkDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    transaction: vi.fn((arg: any) => {
      if (typeof arg === "function") {
        return Promise.resolve(
          arg({
            issue: { update: mocks.updateIssue },
            issueLifecycleEvent: {
              create: mocks.createLifecycleEvent,
              upsert: mocks.upsertLifecycleEvent,
            },
            agentWork: { update: mocks.agentWorkUpdate },
            agentWorkHistory: { create: vi.fn().mockResolvedValue({}) },
          }),
        );
      }
      return Promise.all(arg.map((op: any) => op));
    }),
  },
}));

process.env.DISPATCH_AGENT_TOKEN = mockToken;
process.env.DISPATCH_WORKER_TOKEN = WORKER_TOKEN;
// #1129: bind the worker credential to the agent it acts as, so the
// identity-scope gate accepts its own-agent claim.
process.env.DISPATCH_WORKER_TOKENS = `worker-agent:${WORKER_TOKEN}`;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // #1254: the claim route checks for a pending reconciler release intent.
    ownershipReleaseIntent: { findFirst: mocks.intentFindFirst, findUnique: vi.fn(async () => null), updateMany: mocks.intentUpdateMany },
    issue: { findUnique: mocks.findUnique, update: mocks.updateIssue },
    auditLog: { create: mocks.createAuditLog },
    issueLifecycleEvent: {
      create: mocks.createLifecycleEvent,
      upsert: mocks.upsertLifecycleEvent,
    },
    lease: { 
      findMany: mocks.leaseFindMany, 
      deleteMany: mocks.leaseDeleteMany, 
      findUnique: mocks.leaseFindUnique,
      findUniqueOrThrow: mocks.leaseFindUniqueOrThrow,
      create: mocks.leaseCreate,
      update: mocks.leaseUpdate,
      delete: mocks.leaseDelete,
      findFirst: mocks.leaseFindFirst,
    },
    agentWork: {
      findMany: mocks.agentWorkFindMany,
      update: mocks.agentWorkUpdate,
      deleteMany: mocks.agentWorkDeleteMany,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/github", () => ({ addIssueLabel: mocks.addIssueLabel, removeIssueLabel: mocks.removeIssueLabel }));
vi.mock("@/lib/issue-status", () => ({ transitionIssueStatus: vi.fn(async (_repo: string, _number: number, labels: string[], status: string) => { for (const label of labels.filter((value) => value.startsWith("status/") && value !== status)) await mocks.removeIssueLabel(_repo, _number, label); await mocks.addIssueLabel(_repo, _number, status); }) }));

vi.mock("@/lib/claim-gate", () => ({ getLiveIssueLabels: mocks.getLiveIssueLabels }));

import { resetRateLimits } from "@/lib/rate-limit";
import { POST } from "./route";

// Per-actor rate-limit windows are process-global; reset them per test so the
// shared TEST_AGENT_TOKEN buckets cannot bleed across describes (same pattern
// as move/webhook suites).
beforeEach(() => {
  guardState.resuming = false;
  guardState.stillHolds = true;
  resetRateLimits();
});

function makePayload(o = {}) { return { issueId: "issue-1", repoFullName: "org/repo", issueNumber: 42, agentName: "test-agent", ...o }; }
function makeRequest(overrides = {}, extraHeaders = {}) {
  const payload = typeof overrides === "object" && !Array.isArray(overrides) ? { ...makePayload(), ...overrides } : overrides;
  return authedRequest("http://localhost/api/issues/claim", { method: "POST", body: payload, headers: extraHeaders });
}

describe("POST /api/issues/claim — auth", () => {
  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(makePayload()) }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(authedRequest("http://localhost/api/issues/claim", { method: "POST", body: makePayload(), headers: { Authorization: "Bearer wrong-token" } }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/issues/claim — validation", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.findUnique.mockResolvedValue(null); mocks.leaseFindMany.mockResolvedValue([]); mocks.leaseDeleteMany.mockResolvedValue({ count: 0 });
    mocks.leaseFindUnique.mockResolvedValue(null);
    mocks.leaseFindUniqueOrThrow.mockResolvedValue({ id: "l-1", agentName: "test-agent", issueId: "issue-1", checkpoint: "issue_claimed", branch: null, prUrl: null, expiredAt: new Date(Date.now() + 60000), renewedAt: new Date(), createdAt: new Date() });
    mocks.leaseCreate.mockResolvedValue({ id: "l-1", agentName: "test-agent", issueId: "issue-1", checkpoint: "issue_claimed", branch: null, prUrl: null, expiredAt: new Date(Date.now() + 60000), renewedAt: new Date(), createdAt: new Date() });
    mocks.leaseUpdate.mockResolvedValue({ id: "l-1", agentName: "test-agent", issueId: "issue-1", checkpoint: "issue_claimed", branch: null, prUrl: null, expiredAt: new Date(Date.now() + 60000), renewedAt: new Date(), createdAt: new Date() });
    mocks.leaseDelete.mockResolvedValue({ id: "l-1" });
    mocks.leaseFindFirst.mockResolvedValue(null); });

  it("returns 400 when agentName is missing", async () => {
    const res = await POST(makeRequest(makePayload({agentName: undefined})));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required fields: issueId, repoFullName, issueNumber, agentName");
  });

  it("returns 400 when agentName is not a string", async () => {
    const res = await POST(makeRequest(makePayload({agentName: 123})));
    expect(res.status).toBe(400);
  });

  it("returns 400 when repoFullName is missing", async () => {
    const res = await POST(makeRequest(makePayload({repoFullName: undefined})));
    expect(res.status).toBe(400);
  });

  it("returns 400 when issueNumber is missing", async () => {
    const res = await POST(makeRequest(makePayload({issueNumber: undefined})));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json", Authorization: `Bearer ${mockToken}`}, body: "not-json" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-object body", async () => {
    const res = await POST(makeRequest([1,2,3]));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/issues/claim — business logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: [] as string[] });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.leaseFindMany.mockResolvedValue([]);
    mocks.leaseDeleteMany.mockResolvedValue({ count: 0 });
    mocks.removeIssueLabel.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation((arg: any) => {
      if (typeof arg === "function") return Promise.resolve(arg({
        issue: { update: mocks.updateIssue },
        issueLifecycleEvent: { create: mocks.createLifecycleEvent, upsert: mocks.upsertLifecycleEvent },
        agentWork: { update: mocks.agentWorkUpdate },
        agentWorkHistory: { create: vi.fn().mockResolvedValue({}) },
      }));
      return Promise.all(arg.map((op: any) => op));
    });
  });

  it("adds agent label and moves a fresh claim to in-progress", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-progress");
    expect(body.labels).toContain("status/in-progress");
    expect(mocks.createAuditLog).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "claim_issue", success: true, actor: "test-agent" }) });
  });

  it("echoes the issued claim token that fences a later capacity handoff (#1256)", async () => {
    // Mirror the real client: create persists what the code minted.
    mocks.leaseCreate.mockImplementation(async ({ data }: any) => ({ id: "l-1", ...data }));
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.claimToken).toBe("string");
    expect(body.claimToken).toMatch(/^claim_/);
    // The minted token is persisted on the lease row, not just returned.
    const created = (mocks.leaseCreate.mock.calls[0] as any)[0].data;
    expect(created.claimToken).toBe(body.claimToken);
  });

  it("refuses closed issues", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "closed", number: 42, repository: { fullName: "org/repo" }, labels: [] as string[] });
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Cannot claim a closed issue");
  });

  it.each(["status/blocked", "status/done"])("refuses %s while resuming without remote or lease writes", async (status) => {
    guardState.resuming = true;
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: [status] });
    mocks.getLiveIssueLabels.mockResolvedValueOnce([status]);
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(mocks.leaseCreate).not.toHaveBeenCalled();
    expect(mocks.leaseUpdate).not.toHaveBeenCalled();
  });

  it("repairs a failed claim transaction on exact-agent retry without repeating remote labels", async () => {
    guardState.resuming = false;
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["status/ready"]).mockResolvedValue(["agent/test-agent", "status/in-progress"]);
    mocks.transaction.mockRejectedValueOnce(new Error("db transaction failed"));
    // §8.7 claim side: the first attempt commits the claim intent (the lease
    // row, fresh attempt token) BEFORE the remote writes; the retry renews
    // that same row instead of minting a second one.
    const leaseRow = {
      id: "l-1",
      agentName: "test-agent",
      issueId: "issue-1",
      claimToken: "claim_retry-1",
      checkpoint: "issue_claimed",
      expiredAt: new Date(Date.now() + 60000),
      renewedAt: new Date(),
      createdAt: new Date(),
    };
    mocks.leaseFindUnique.mockResolvedValueOnce(null).mockResolvedValue(leaseRow);
    mocks.leaseUpdate.mockResolvedValue(leaseRow);
    const first = await POST(makeRequest());
    expect(first.status).toBe(500);
    guardState.resuming = true;
    const retry = await POST(makeRequest());
    expect(retry.status).toBe(200);
    // The remote add is replayed idempotently on retry: a crash between the
    // intent commit and the remote add must never leave the label un-added.
    expect(mocks.addIssueLabel).toHaveBeenCalledTimes(3); // agent + status on attempt 1, agent replay on retry
    expect(mocks.removeIssueLabel).toHaveBeenCalledTimes(1);
    expect(mocks.createLifecycleEvent).toHaveBeenCalledTimes(1);
    expect(mocks.leaseCreate).toHaveBeenCalledTimes(1); // attempt 1 only; the retry renewed
    expect(mocks.leaseUpdate).toHaveBeenCalledTimes(1);
  });

  it("refuses a resumed claim after live ownership changes without writes", async () => {
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["status/ready"]);
    mocks.transaction.mockRejectedValueOnce(new Error("db transaction failed"));
    const first = await POST(makeRequest());
    expect(first.status).toBe(500);
    expect(mocks.addIssueLabel).toHaveBeenCalledTimes(2);
    const remoteAddCount = mocks.addIssueLabel.mock.calls.length;
    const remoteRemoveCount = mocks.removeIssueLabel.mock.calls.length;
    const issueUpdateCount = mocks.updateIssue.mock.calls.length;
    const leaseCreateCount = mocks.leaseCreate.mock.calls.length;

    guardState.resuming = true;
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["agent/other-agent", "status/in-progress"]);
    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    expect(mocks.addIssueLabel).toHaveBeenCalledTimes(remoteAddCount);
    expect(mocks.removeIssueLabel).toHaveBeenCalledTimes(remoteRemoveCount);
    expect(mocks.updateIssue).toHaveBeenCalledTimes(issueUpdateCount);
    expect(mocks.leaseCreate).toHaveBeenCalledTimes(leaseCreateCount);
  });

  // The 20-day stall: an issue left at status/ready while still carrying its own
  // agent label was served at the head of the queue, 409'd on every claim, and
  // skipped by claim_one so the lane never starved — and nothing surfaced it.
  it("re-claims its own issue instead of 409ing on itself", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "issue-1",
      state: "open",
      number: 42, repository: { fullName: "org/repo" },
      labels: ["status/ready", "agent/test-agent", "priority/p0"],
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it("still 409s when a second agent holds the issue alongside this one", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "issue-1",
      state: "open",
      number: 42, repository: { fullName: "org/repo" },
      labels: ["agent/test-agent", "agent/other-agent"],
    });
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["agent/test-agent", "agent/other-agent"]);
    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
  });

  it("returns 409 when already assigned to another agent without force", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["agent/other-agent"] });
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["agent/other-agent"]);
    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already assigned to other-agent");
  });

  it("force claims by removing old agent label when force=true", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["agent/other-agent"] });
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["agent/other-agent"]);
    const res = await POST(makeRequest({ force: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/other-agent");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
  });

  it("force claims by removing ALL conflicting agent labels when live labels carry more than one", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["agent/other-agent", "agent/third-agent"] });
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["agent/other-agent", "agent/third-agent"]);
    const res = await POST(makeRequest({ force: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/other-agent");
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/third-agent");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
    // Cache and GitHub agree: no stale agent label survives in the cache
    expect(body.labels).not.toContain("agent/other-agent");
    expect(body.labels).not.toContain("agent/third-agent");
  });

  it("logs error when force claim label removal fails but continues", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockReturnValue();
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["agent/other-agent"] });
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["agent/other-agent"]);
    mocks.removeIssueLabel.mockRejectedValueOnce(new Error("github 500"));
    const res = await POST(makeRequest({ force: true }));
    expect(res.status).toBe(200);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to remove stale agent label agent/other-agent"), expect.any(Error));
    consoleSpy.mockRestore();
  });

  it("returns 404 when issue not found in local cache", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Issue not found in local cache");
  });

  it("writes failure audit log when GitHub API fails", async () => {
    mocks.addIssueLabel.mockRejectedValueOnce(new Error("github 500"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("github 500");
    expect(mocks.createAuditLog).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "claim_issue", success: false, errorMessage: "github 500" }) });
  });

  it("replaces an existing status label with in-progress", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["status/in-review"] });
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["status/in-review"]);
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-review");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-progress");
  });

  it("removes ALL existing status labels when an issue carries more than one (approved fix)", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["status/in-review", "status/backlog"] });
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["status/in-review", "status/backlog"]);
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-review");
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/backlog");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-progress");
    const body = await res.json();
    expect(body.labels).toContain("status/in-progress");
    expect(body.labels).not.toContain("status/in-review");
    expect(body.labels).not.toContain("status/backlog");
  });

  it("updates local cache with agent label after claim", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(mocks.updateIssue).toHaveBeenCalledWith({ where: { id: "issue-1" }, data: expect.objectContaining({ labels: expect.arrayContaining(["agent/test-agent", "status/in-progress"]) }) });
  });

  it("adds agent and in-progress labels regardless of force when no status exists", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: [] as string[] });
    const res = await POST(makeRequest({ force: false }));
    expect(res.status).toBe(200);
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-progress");
  });
});

describe("POST /api/issues/claim — owner label handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: [] as string[] });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.leaseFindMany.mockResolvedValue([]);
    mocks.leaseDeleteMany.mockResolvedValue({ count: 0 });
  });

  it("preserves owner labels when claiming an issue with owner/*", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["owner/alice"] });
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["owner/alice"]);
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.labels).toContain("agent/test-agent");
    expect(body.labels).toContain("owner/alice");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
  });

  it("allows claim when only owner label exists (no agent conflict)", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["owner/bob", "priority/p1"] });
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["owner/bob", "priority/p1"]);
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.labels).toContain("agent/test-agent");
    expect(body.labels).toContain("owner/bob");
  });

  it("handles both agent and owner conflicts — refuses without force", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["agent/other-agent", "owner/alice"] });
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["agent/other-agent", "owner/alice"]);
    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already assigned to other-agent");
  });

  it("force claims when both agent and owner labels exist", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["agent/other-agent", "owner/alice", "priority/p2"] });
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["agent/other-agent", "owner/alice", "priority/p2"]);
    const res = await POST(makeRequest({ force: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.labels).toContain("agent/test-agent");
    expect(body.labels).toContain("owner/alice");
    expect(body.labels).toContain("priority/p2");
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/other-agent");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
  });
});

describe("POST /api/issues/claim — audit trail with conflict analysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: [] as string[] });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.leaseFindMany.mockResolvedValue([]);
    mocks.leaseDeleteMany.mockResolvedValue({ count: 0 });
  });

  it("includes conflict details in audit log when agent conflict exists and force is used", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["agent/other-agent"] });
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["agent/other-agent"]);
    await POST(makeRequest({ force: true }));
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "claim_issue",
        success: true,
        notes: expect.stringContaining("conflict:"),
      }),
    });
  });

  it("includes owner conflict details in audit log when owner labels exist", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["owner/alice"] });
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["owner/alice"]);
    await POST(makeRequest());
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "claim_issue",
        success: true,
        notes: expect.stringContaining("conflict:"),
      }),
    });
  });

  it("no conflict notes when no existing assignments", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["status/backlog"] });
    await POST(makeRequest());
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "claim_issue",
        success: true,
        notes: undefined,
      }),
    });
  });
});

describe("POST /api/issues/claim — #1037 live label gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: [] as string[] });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.removeIssueLabel.mockResolvedValue(undefined);
    mocks.leaseFindMany.mockResolvedValue([]);
    mocks.leaseDeleteMany.mockResolvedValue({ count: 0 });
  });

  it("refuses 409 when only the live GitHub labels show another agent (cache is clean)", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["status/ready"] });
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["status/ready", "agent/other-agent"]);
    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already assigned to other-agent");
  });

  it("force-claims when only the live GitHub labels show another agent, removing that label", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["status/ready"] });
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["status/ready", "agent/other-agent"]);
    const res = await POST(makeRequest({ force: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/other-agent");
  });

  it("returns 503 and performs no writes when live GitHub labels cannot be verified", async () => {
    mocks.getLiveIssueLabels.mockRejectedValueOnce(new Error("github 500"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("Could not verify live GitHub labels: github 500");
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(mocks.updateIssue).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "claim_issue",
        success: false,
        errorMessage: "Could not verify live GitHub labels: github 500",
      }),
    });
  });

  it("builds the resulting label set from live labels, not the stale cache", async () => {
    // Cache still has status/in-review; GitHub no longer does and carries status/backlog
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["status/in-review"] });
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["status/backlog", "priority/p0"]);
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).toContain("status/in-progress");
    expect(body.labels).toContain("priority/p0");
    expect(body.labels).not.toContain("status/in-review");
    // GitHub ops act on the live base: only the live status label is removed
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/backlog");
    expect(mocks.removeIssueLabel).not.toHaveBeenCalledWith("org/repo", 42, "status/in-review");
  });

  it("refuses a done issue when only live labels carry status/done (cache does not)", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["status/ready"] });
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["status/ready", "status/done"]);
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Cannot claim a done issue");
  });
});

describe("POST /api/issues/claim — worker tier (#1111)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardState.resuming = false;
    mocks.getLiveIssueLabels.mockResolvedValue([]);
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: [] as string[] });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.removeIssueLabel.mockResolvedValue(undefined);
    mocks.leaseFindMany.mockResolvedValue([]);
    mocks.leaseDeleteMany.mockResolvedValue({ count: 0 });
    mocks.leaseCreate.mockResolvedValue({ id: "l-1", agentName: "worker-agent", issueId: "issue-1", checkpoint: "issue_claimed", branch: null, prUrl: null, expiredAt: new Date(Date.now() + 60000), renewedAt: new Date(), createdAt: new Date() });
  });

  function workerRequest(overrides = {}) {
    const payload = { ...makePayload({ agentName: "worker-agent" }), ...overrides };
    return authedRequest("http://localhost/api/issues/claim", {
      method: "POST",
      body: payload,
      token: WORKER_TOKEN,
      headers: { "x-agent-name": "worker-agent" },
    });
  }

  it("returns 403 when a worker force-claims", async () => {
    const res = await POST(workerRequest({ force: true }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Force claim requires a maintainer token");
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "claim_issue",
        success: false,
        errorMessage: "Force claim requires a maintainer token",
      }),
    });
  });

  it("still returns 403 when the worker denial audit write fails", async () => {
    // The 403 path's audit row is best-effort: a failing write must not
    // mask the denial or leak into label/lease state.
    mocks.createAuditLog.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(workerRequest({ force: true }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Force claim requires a maintainer token");
    // The write was attempted (then failed) with the denial payload;
    // nothing else was touched.
    expect(mocks.createAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "claim_issue",
        success: false,
        errorMessage: "Force claim requires a maintainer token",
        actor: "worker-agent",
        repoFullName: "org/repo",
        issueNumber: 42,
      }),
    });
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(mocks.updateIssue).not.toHaveBeenCalled();
    expect(mocks.leaseCreate).not.toHaveBeenCalled();
  });

  it("allows a worker to claim without force", async () => {
    const res = await POST(workerRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it("does not let a truthy non-boolean force override another agent", async () => {
    mocks.getLiveIssueLabels.mockResolvedValueOnce(["agent/other-agent"]);
    const res = await POST(workerRequest({ force: "true" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Use force=true to override");
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
  });

  it("denies a bound worker naming another agent in the body", async () => {
    const res = await POST(workerRequest({ agentName: "other-agent" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("may not act for");
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
  });
});

describe("POST /api/issues/claim — cross-issue identity invariant (#1129 review)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({
      id: "issue-1",
      state: "open",
      number: 42,
      repository: { fullName: "org/repo" },
      labels: [] as string[],
    });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.removeIssueLabel.mockResolvedValue(undefined);
    mocks.leaseFindMany.mockResolvedValue([]);
    mocks.leaseDeleteMany.mockResolvedValue({ count: 0 });
  });

  it("refuses with 400 when body repoFullName does not match the loaded issue's canonical repo", async () => {
    // Loaded issue belongs to org/repo but the caller supplies their own
    // org/repo#42 (alpha-owned) while pointing at issueId of an alpha-assigned A.
    const res = await POST(makeRequest({
      issueId: "issue-1",
      repoFullName: "bravo/repo",
      issueNumber: 99,
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("does not match");
    expect(body.error).toContain("org/repo#42");
    // No GitHub or DB writes — the mismatch is caught before any side effect.
    expect(mocks.getLiveIssueLabels).not.toHaveBeenCalled();
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(mocks.updateIssue).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("refuses with 400 when body issueNumber does not match the loaded issue's canonical number", async () => {
    const res = await POST(makeRequest({
      issueId: "issue-1",
      repoFullName: "org/repo",
      issueNumber: 7,
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("does not match");
    expect(mocks.getLiveIssueLabels).not.toHaveBeenCalled();
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(mocks.updateIssue).not.toHaveBeenCalled();
  });

  it("uses the canonical repoFullName/issueNumber for every GitHub write when bodies agree", async () => {
    const res = await POST(makeRequest({ repoFullName: "org/repo", issueNumber: 42 }));
    expect(res.status).toBe(200);
    // All label operations hit the canonical pair derived from the DB row.
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-progress");
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "claim_issue",
        repoFullName: "org/repo",
        issueNumber: 42,
        success: true,
      }),
    });
  });
});

describe("POST /api/issues/claim — lifecycle evidence (#1202)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardState.resuming = false;
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: [] as string[] });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.leaseFindMany.mockResolvedValue([]);
    mocks.leaseDeleteMany.mockResolvedValue({ count: 0 });
    mocks.removeIssueLabel.mockResolvedValue(undefined);
    resetRateLimits();
  });

  it("records the claim with its source, actor and transition", async () => {
    mocks.getLiveIssueLabels.mockResolvedValue(["status/ready", "type/feature"]);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    expect(mocks.createLifecycleEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({
        issueId: "issue-1",
        repoFullName: "org/repo",
        issueNumber: 42,
        kind: "claim",
        source: "api:claim",
        actor: "test-agent",
        agentName: "test-agent",
        fromStatus: "status/ready",
        toStatus: "status/in-progress",
      }),
    });
  });

  it("records nothing for a redelivered claim of an already-claimed issue", async () => {
    // Live GitHub already shows this agent holding the issue as in-progress,
    // which is exactly what a replayed claim request looks like — and so does
    // the cache, because the first attempt's mirror committed.
    mocks.getLiveIssueLabels.mockResolvedValue(["status/in-progress", "agent/test-agent"]);
    mocks.findUnique.mockResolvedValue({
      id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" },
      labels: ["status/in-progress", "agent/test-agent"],
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(mocks.updateIssue).toHaveBeenCalled();
    expect(mocks.createLifecycleEvent).not.toHaveBeenCalled();
  });

  it("recovers the claim on a retry whose GitHub writes already landed", async () => {
    // First attempt: GitHub takes the labels, the event insert fails, and the
    // transaction rolls the mirror back. The retry then reads an
    // already-claimed issue — only the cache row still shows the pre-claim
    // state, and it is what makes the first attempt's evidence recoverable.
    mocks.getLiveIssueLabels
      .mockResolvedValueOnce(["status/ready", "type/feature"])
      .mockResolvedValue(["type/feature", "agent/test-agent", "status/in-progress"]);
    mocks.findUnique.mockResolvedValue({
      id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" },
      labels: ["status/ready", "type/feature"],
    });
    mocks.createLifecycleEvent.mockRejectedValueOnce(new Error("lifecycle write failed"));

    const first = await POST(makeRequest());
    expect(first.status).toBe(500);
    expect(mocks.createLifecycleEvent).toHaveBeenCalledTimes(1);

    guardState.resuming = true;
    const retry = await POST(makeRequest());
    expect(retry.status).toBe(200);

    expect(mocks.createLifecycleEvent).toHaveBeenCalledTimes(2);
    expect(mocks.createLifecycleEvent).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        kind: "claim",
        fromStatus: "status/ready",
        toStatus: "status/in-progress",
        metadata: { recoveredFromMirroredState: true },
      }),
    });
  });

  it("records a force-claim that only changes ownership", async () => {
    mocks.getLiveIssueLabels.mockResolvedValue(["status/in-progress", "agent/other-agent"]);

    const res = await POST(makeRequest({ force: true }));
    expect(res.status).toBe(200);

    expect(mocks.createLifecycleEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "claim",
        actor: "test-agent",
        fromStatus: "status/in-progress",
        toStatus: "status/in-progress",
        metadata: {
          force: true,
          claimedFrom: "agent/other-agent",
          claimedTo: "agent/test-agent",
          note: "ownership changed without a status transition",
        },
      }),
    });
  });

  it("fails the claim when the evidence write fails, instead of recording nothing", async () => {
    // The cache write and the event share a transaction: a claim that landed
    // without its evidence row would silently drop an attempt.
    mocks.getLiveIssueLabels.mockResolvedValue(["status/ready"]);
    mocks.createLifecycleEvent.mockRejectedValueOnce(new Error("lifecycle write failed"));

    const res = await POST(makeRequest());

    expect(res.status).toBe(500);
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "claim_issue", success: false }),
    });
  });
});

describe("POST /api/issues/claim — §8.7 pending release intent (#1254)", () => {
  const intent = {
    id: "int-1", issueId: "issue-1", agentName: "alpha", agentLabel: "agent/alpha",
    phase: "pending", attemptToken: "claim_retired",
  };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["status/ready", "agent/alpha"] });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.removeIssueLabel.mockResolvedValue(undefined);
    mocks.getLiveIssueLabels.mockResolvedValue(["status/ready", "agent/alpha"]);
    mocks.leaseFindMany.mockResolvedValue([]);
    mocks.leaseDeleteMany.mockResolvedValue({ count: 0 });
    mocks.transaction.mockImplementation((arg: any) => {
      if (typeof arg === "function") return Promise.resolve(arg({
        issue: { update: mocks.updateIssue },
        issueLifecycleEvent: { create: mocks.createLifecycleEvent, upsert: mocks.upsertLifecycleEvent },
        agentWork: { update: mocks.agentWorkUpdate },
        agentWorkHistory: { create: vi.fn().mockResolvedValue({}) },
        // supersedeOwnershipReleaseIntent drives the intent through tx.
        ownershipReleaseIntent: { findFirst: vi.fn(async () => intent), updateMany: mocks.intentUpdateMany },
        auditLog: { create: mocks.supersedeAuditCreate },
      }));
      return Promise.all(arg.map((op: any) => op));
    });
  });

  it("holds a non-force claim with a retryable 409 while a release intent is pending", async () => {
    mocks.intentFindFirst.mockResolvedValueOnce(intent);
    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Ownership release is pending");
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(mocks.leaseCreate).not.toHaveBeenCalled();
    expect(mocks.leaseUpdate).not.toHaveBeenCalled();
    // The supersede is the force-claim exemption only: a held claim cancels nothing.
    expect(mocks.intentUpdateMany).not.toHaveBeenCalled();
  });

  it("force-claim supersedes the pending intent and mints a FRESH claim token over the Phase A retired lease", async () => {
    // §8.7 control 1b through the production claim wiring: the reconciler's
    // Phase A retired the fence (`claimToken = null`, `disposition = null`).
    // Superseding the intent and re-claiming must NOT renew the token-less
    // row into a null-token echo — the response and the persisted row must
    // carry a fresh attempt token, or every later fence is inert.
    mocks.intentFindFirst.mockResolvedValueOnce(intent);
    const retired = {
      id: "l-1", agentName: "test-agent", issueId: "issue-1",
      claimToken: null, disposition: null, checkpoint: "issue_claimed",
      expiredAt: new Date(Date.now() + 60000), renewedAt: new Date(), createdAt: new Date(),
      runRef: null, registeredAt: null, renewCount: 2, lastRenewalObservedAt: null,
    };
    mocks.leaseFindUnique.mockResolvedValue(retired);
    mocks.leaseUpdate.mockImplementation((args: any) => Promise.resolve({ ...retired, ...args.data }));

    const res = await POST(makeRequest({ force: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.claimToken).toBe("string");
    expect(body.claimToken).toMatch(/^claim_/);
    // The minted token is what got persisted on the lease row.
    const updateData = (mocks.leaseUpdate.mock.calls[0] as any)[0].data;
    expect(updateData.claimToken).toBe(body.claimToken);
    // The pending intent was superseded (force exemption), not raced.
    expect(mocks.intentUpdateMany).toHaveBeenCalled();
    expect(mocks.supersedeAuditCreate).toHaveBeenCalled();
  });
});

describe("POST /api/issues/claim — §8.7 override pre-write re-check (#1254)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: [] as string[] });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.removeIssueLabel.mockResolvedValue(undefined);
    mocks.getLiveIssueLabels.mockResolvedValue([] as string[]);
    mocks.leaseFindMany.mockResolvedValue([]);
    // clearAllMocks does not reset prior tests' implementations; pin the lease
    // read so upsertLease takes the create path and honors the per-test lease.
    mocks.leaseFindUnique.mockResolvedValue(null);
    mocks.leaseDeleteMany.mockResolvedValue({ count: 1 });
    mocks.intentFindFirst.mockResolvedValue(null);
    mocks.transaction.mockImplementation((arg: any) => {
      if (typeof arg === "function") return Promise.resolve(arg({
        issue: { update: mocks.updateIssue },
        issueLifecycleEvent: { create: mocks.createLifecycleEvent, upsert: mocks.upsertLifecycleEvent },
        agentWork: { update: mocks.agentWorkUpdate },
        agentWorkHistory: { create: vi.fn().mockResolvedValue({}) },
      }));
      return Promise.all(arg.map((op: any) => op));
    });
  });

  it("does not commit a superseded non-force claim before the remote add (check b)", async () => {
    guardState.stillHolds = false;
    mocks.leaseCreate.mockResolvedValue({ id: "lease-1", claimToken: "tok-1" });
    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
    // The minted receipt is fenced-deleted so the override's claim can own it.
    expect(mocks.leaseDeleteMany).toHaveBeenCalledWith({ where: { id: "lease-1", claimToken: "tok-1" } });
    expect(mocks.createAuditLog).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "claim_issue", success: false }) });
  });

  it("does not start a superseded force claim before the remote removals (check a)", async () => {
    guardState.stillHolds = false;
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: ["agent/other"] });
    mocks.getLiveIssueLabels.mockResolvedValue(["agent/other"]);
    const res = await POST(makeRequest({ force: true }));
    expect(res.status).toBe(409);
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    // No lease was minted before the re-check, so there is nothing to fence-delete.
    expect(mocks.leaseDeleteMany).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "claim_issue", success: false }) });
  });

  it("commits a normal claim when the guard is still held (control)", async () => {
    // stillHolds stays true (reset in the module-level beforeEach): the claim lands.
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(mocks.addIssueLabel).toHaveBeenCalled();
    expect(mocks.leaseDeleteMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/issues/claim — parked claims (#1316, #1334)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", number: 42, repository: { fullName: "org/repo" }, labels: [] as string[] });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.removeIssueLabel.mockResolvedValue(undefined);
    mocks.leaseDeleteMany.mockResolvedValue({ count: 0 });
    mocks.leaseFindUnique.mockResolvedValue(null);
    mocks.leaseCreate.mockResolvedValue({ id: "l-new", agentName: "test-agent", issueId: "issue-1", checkpoint: "issue_claimed", branch: null, prUrl: null, expiredAt: new Date(Date.now() + 60000), renewedAt: new Date(), createdAt: new Date() });
    mocks.leaseUpdate.mockResolvedValue({ id: "l-1", agentName: "test-agent", issueId: "issue-1", checkpoint: "issue_claimed", branch: null, prUrl: null, expiredAt: new Date(Date.now() + 60000), renewedAt: new Date(), createdAt: new Date() });
    mocks.agentWorkFindMany.mockResolvedValue([]);
    mocks.getLiveIssueLabels.mockResolvedValue([] as string[]);
    mocks.transaction.mockImplementation((arg: any) => {
      if (typeof arg === "function") return Promise.resolve(arg({
        issue: { update: mocks.updateIssue },
        issueLifecycleEvent: { create: mocks.createLifecycleEvent, upsert: mocks.upsertLifecycleEvent },
        agentWork: { update: mocks.agentWorkUpdate, deleteMany: mocks.agentWorkDeleteMany },
        agentWorkHistory: { create: vi.fn().mockResolvedValue({}) },
        auditLog: { create: mocks.createAuditLog },
      }));
      return Promise.all(arg.map((op: any) => op));
    });
  });

  /**
   * Behavioral stand-in (SQL 3VL) for the three lease queries the claim path
   * runs against one parked row: `findActiveLeasesForIssue` (`expiredAt > now`
   * — a park whose ownership TTL elapsed is not "active"), `releaseExpiredLeases`
   * (`expiredAt <= now` AND the wait marker gone — a future `retryAfter`
   * matches neither OR arm), and `findAndReleaseStaleAgentWorkForIssue`'s
   * protecting-lease read (`expiredAt > now OR retryAfter > now` — a running
   * park protects its agent's active-shaped rows, mirroring the sweep's
   * parked-claim exclusion). A NULL comparison column never satisfies a
   * bound arm. The parked row is only ever returned to a query that actually
   * selects it, so the assertions below cannot pass by accident.
   */
  function leaseQueriesSee(parked: Record<string, any>) {
    mocks.leaseFindMany.mockImplementation(({ where }: any) => {
      const cmp = (value: Date | null | undefined, cond: any): boolean => {
        if (value === null || value === undefined) return false;
        if (cond.gt !== undefined) return value.getTime() > cond.gt.getTime();
        if (cond.lte !== undefined) return value.getTime() <= cond.lte.getTime();
        return false;
      };
      const matchesArm = (row: Record<string, any>, arm: Record<string, any>) =>
        Object.entries(arm).every(([field, cond]) =>
          // The marker-gone arm of the cleanup clause is a literal-NULL test.
          cond === null ? row[field] === null || row[field] === undefined : cmp(row[field], cond),
        );
      const matches = (row: Record<string, any>) => {
        if (where.issueId !== undefined && row.issueId !== where.issueId) return false;
        if (where.expiredAt !== undefined && !cmp(row.expiredAt, where.expiredAt)) return false;
        if (where.OR !== undefined) return where.OR.some((arm: any) => matchesArm(row, arm));
        return true;
      };
      return Promise.resolve(matches(parked) ? [parked] : []);
    });
  }

  it("does not erase another agent's running park through expired-lease cleanup when claiming the issue (#1334)", async () => {
    // The #1334 hazard end to end at the route: agent `other-agent` parked a
    // blocked claim (wait deadline in the future, ownership TTL elapsed), and
    // `test-agent` now claims the same issue. The pre-claim cleanup used to
    // delete any expired lease — destroying the park receipt — while the
    // parked BLOCKED AgentWork row survived until its own deadline.
    const parked = {
      id: "lease-parked",
      agentName: "other-agent",
      issueId: "issue-1",
      checkpoint: "issue_claimed",
      expiredAt: new Date(Date.now() - 5 * 60_000),
      retryAfter: new Date(Date.now() + 30 * 60_000),
      waitReason: "waiting on dependency",
    };
    leaseQueriesSee(parked);

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    // The park's lease row is never deleted, by any cleanup call the route makes.
    expect(mocks.leaseDeleteMany).not.toHaveBeenCalled();
    // The claim is its own row (the park row is keyed to another agent and is
    // never mutated by a different agent's claim).
    expect(mocks.leaseUpdate).not.toHaveBeenCalled();
    expect(mocks.leaseCreate).toHaveBeenCalledTimes(1);
    expect((mocks.leaseCreate.mock.calls[0] as any)[0].data.agentName).toBe("test-agent");
  });

  it("does not delete a renewal-parked agent's active-shaped AgentWork row during the claim-path cleanup (#1316, #1334)", async () => {
    // An `externalWait` renewal parks the LEASE but leaves the heartbeated
    // AgentWork row CLAIMED/IN_PROGRESS. Once the ownership TTL lapses while
    // the wait deadline is still running — the steady state of any park
    // longer than the renew TTL — a claim on the issue must not delete that
    // row: the running park protects its agent, exactly as it does the
    // stale-work sweep.
    const parked = {
      id: "lease-parked",
      agentName: "other-agent",
      issueId: "issue-1",
      checkpoint: "issue_claimed",
      expiredAt: new Date(Date.now() - 5 * 60_000),
      retryAfter: new Date(Date.now() + 30 * 60_000),
      waitReason: "waiting on dependency",
    };
    leaseQueriesSee(parked);
    const parkedWork = [{ id: "work-parked", state: "IN_PROGRESS", agentName: "other-agent" }];
    mocks.agentWorkFindMany.mockImplementation(({ where }: any) => {
      let rows = [...parkedWork];
      if (where?.state?.in) rows = rows.filter((w) => where.state.in.includes(w.state));
      if (where?.agentName?.notIn) rows = rows.filter((w) => !where.agentName.notIn.includes(w.agentName));
      return Promise.resolve(rows);
    });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    // The parked agent's row survived the cleanup: nothing was deleted, and
    // the cleanup's audit row was never written.
    expect(mocks.agentWorkDeleteMany).not.toHaveBeenCalled();
    expect(mocks.createAuditLog.mock.calls.filter((call: any) => (call[0] as any).data.action === "stale_agentwork_cleanup")).toHaveLength(0);
  });

  it("a running park with a live ownership TTL 409s a normal claim outright (#1334)", async () => {
    // Before the TTL elapses the park is simply an active lease: no cleanup
    // runs, no write happens, and the claim is refused without force.
    const parked = {
      id: "lease-parked",
      agentName: "other-agent",
      issueId: "issue-1",
      checkpoint: "issue_claimed",
      expiredAt: new Date(Date.now() + 10 * 60_000),
      retryAfter: new Date(Date.now() + 30 * 60_000),
      waitReason: "waiting on dependency",
    };
    leaseQueriesSee(parked);

    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    expect(mocks.leaseDeleteMany).not.toHaveBeenCalled();
    expect(mocks.leaseUpdate).not.toHaveBeenCalled();
    expect(mocks.leaseCreate).not.toHaveBeenCalled();
  });

  it("the parked owner's own re-claim releases the park by design (documented resume path)", async () => {
    // A claim-path write is a fresh assertion of ACTIVE ownership (#1251):
    // the owner re-claiming its parked issue ends the wait deliberately, so
    // the renewal clears the marker instead of inheriting it. This is the
    // release path the capability doc names ("until it expires naturally or
    // the same agent re-claims") — not evidence loss.
    const parked = {
      id: "lease-parked",
      agentName: "test-agent",
      issueId: "issue-1",
      checkpoint: "issue_claimed",
      disposition: "blocked",
      expiredAt: new Date(Date.now() - 5 * 60_000),
      retryAfter: new Date(Date.now() + 30 * 60_000),
      waitReason: "waiting on dependency",
    };
    mocks.leaseFindUnique.mockResolvedValue(parked);
    mocks.leaseFindMany.mockResolvedValue([]);

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(mocks.leaseUpdate).toHaveBeenCalledTimes(1);
    const updateData = (mocks.leaseUpdate.mock.calls[0] as any)[0].data;
    expect(updateData.retryAfter).toBeNull();
    expect(updateData.waitReason).toBeNull();
  });
});
