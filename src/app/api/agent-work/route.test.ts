import { describe, expect, it, vi, beforeEach } from "vitest";
import { makeDispatchEnvMock } from "@/test/route-helpers";

// #1395: the reassign path now moves the claim, so its guarded-flow
// collaborators are hoisted: the guard fake's per-region state plus the
// stubbed remote/lease/lifecycle mocks used by both the vi.mock factories and
// the test assertions.
const { guardState, fencedTx, mockReleaseIssueClaim, mockAddIssueLabel, mockRemoveIssueLabel, mockGetLiveIssueLabels, mockRecordClaimEvent, mockUpsertLease } = vi.hoisted(() => ({
  guardState: {
    busy: false,
    releaseGuardLost: false,
    addGuardLost: false,
    request: null as unknown,
    regionOptions: [] as Array<{ timeoutMs?: number } | undefined>,
  },
  fencedTx: { issue: { id: "issue-1" }, issueLifecycleEvent: undefined },
  mockReleaseIssueClaim: vi.fn(),
  mockAddIssueLabel: vi.fn(async () => true),
  mockRemoveIssueLabel: vi.fn(async () => true),
  mockGetLiveIssueLabels: vi.fn(),
  mockRecordClaimEvent: vi.fn(async (_tx: unknown, _input: any): Promise<boolean> => true),
  mockUpsertLease: vi.fn(async () => ({
    created: true,
    mintedToken: true,
    lease: { id: "lease-1", claimToken: "tok-1", renewedAt: new Date(0) },
  })),
}));

vi.mock("@/lib/auth", () => ({
  authorizeRequest: vi.fn(),
  authErrorResponse: vi.fn((auth: { forbidden?: boolean }) =>
    new Response(JSON.stringify({ error: auth.forbidden ? "Forbidden" : "Unauthorized" }), {
      status: auth.forbidden ? 403 : 401,
      headers: { "content-type": "application/json" },
    }),
  ),
}));

const mockAgentWork = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
};

const mockLease = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  delete: vi.fn(),
};

const mockAgentWorkHistory = {
  create: vi.fn(),
};

const mockAuditLog = {
  create: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    agentWork: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    lease: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      // #1395: the release's dedupe key reads the old owner's claim epoch.
      findFirst: vi.fn(),
      delete: vi.fn(),
      // #1395: fence-deletes the minted receipt when the add region loses the guard.
      deleteMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    agentWorkHistory: {
      create: vi.fn(),
    },
    issue: {
      findUnique: vi.fn(),
      // #1395: reassign moves the cached agent/* label mirror.
      update: vi.fn(),
    },
    $transaction: vi.fn(async (arg: any) => {
      // Handle array of promises (parallel execution used in release by agentName+issueId)
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      // Handle function argument (used in original release path)
      return arg({
        agentWork: {
          findFirst: vi.fn(),
          findMany: vi.fn(async () => []),
          update: vi.fn(),
        },
        agentWorkHistory: {
          create: vi.fn(),
        },
        // #1395: the guarded reassign commits the cache mirror + lifecycle evidence.
        issue: { update: vi.fn(async () => ({ id: "issue-1" })) },
        issueLifecycleEvent: { create: vi.fn(), upsert: vi.fn() },
      });
    }),
  },
}));

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock("test-token"));

vi.mock("@/lib/agent-work", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-work")>()),
  releaseStaleWork: vi.fn(async () => []),
}));

vi.mock("@/lib/ownership-reconciliation", () => ({
  // #1254: operator release supersedes pending reconciler intents; the fake
  // records nothing.
  supersedeOwnershipReleaseIntent: vi.fn(async () => false),
}));
vi.mock("@/lib/lease", () => ({
  releaseLeaseByAgentAndIssue: vi.fn(async () => 1),
  releaseAllLeasesByAgent: vi.fn(async () => 1),
  releaseAgentWorkByAgentAndIssue: vi.fn(async () => 0),
  // #1395: reassign mints the new owner's lease under the guard.
  upsertLease: mockUpsertLease,
}));

// #1395: the reassign path stubs the claim-release core but keeps the REAL
// fencedClaimClient and releaseIssueClaimWorstCaseCalls: the thin-client
// reshape and the label-derived budget arithmetic are the load-bearing
// pieces the route must keep using (unclaim suite's pattern).
vi.mock("@/lib/issue-claim", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/issue-claim")>();
  return { ...actual, releaseIssueClaim: mockReleaseIssueClaim };
});

// #1395: the fenced add writes the new owner's agent/* label via the GitHub
// client; removeIssueLabel is also stubbed because the real issue-claim and
// issue-status modules (importOriginal chain) import it.
vi.mock("@/lib/github", () => ({
  addIssueLabel: mockAddIssueLabel,
  removeIssueLabel: mockRemoveIssueLabel,
}));

// #1395: the foreign-agent reassign check reads the live GitHub label state
// under the guard; the route itself must never derive ownership from cache.
vi.mock("@/lib/claim-gate", () => ({
  getLiveIssueLabels: mockGetLiveIssueLabels,
}));

// #1395: the hand-over commits its `claim` lifecycle evidence row. The real
// issue-claim (importOriginal chain) imports the remaining helpers here.
vi.mock("@/lib/issue-lifecycle", () => ({
  recordClaimEvent: mockRecordClaimEvent,
  recordLifecycleEvent: vi.fn(async () => true),
  lifecycleDedupeKey: vi.fn(() => "dedupe-key"),
  lifecycleStatusLabel: vi.fn(() => null),
}));

// #1395: the whole claim move runs under the per-issue mutation anchor; the
// fake grants it unless the test simulates a busy anchor or a guard lost in
// one of the two fenced regions. The fenced remote writes are counted in
// call order — first the shared claim release, then the new agent's label
// add — so each region has its own lost flag.
vi.mock("@/lib/issue-mutation-guard", () => ({
  fencedWriteTimeoutMs: () => 60_000,
  fencedWriteTimeoutForCalls: (calls: number) => Math.max(1, Math.ceil(calls)) * 45_000 + 15_000,
  withIssueMutationGuard: async (req: unknown, cb: any) => {
    guardState.request = req;
    if (guardState.busy) {
      return { status: "busy", ownerToken: "owner-token", operation: "reassign" };
    }
    let fencedRegion = 0;
    const result = await cb(undefined, {
      resuming: false,
      stillHoldsGuard: async () => true,
      runFencedRemoteWrite: async (
        fn: (tx: unknown) => Promise<unknown>,
        options?: { timeoutMs?: number },
      ) => {
        fencedRegion += 1;
        guardState.regionOptions.push(options);
        const lost = fencedRegion === 1 ? guardState.releaseGuardLost : guardState.addGuardLost;
        if (lost) return { status: "guard-lost" };
        return { status: "written", value: await fn(fencedTx) };
      },
    });
    return { status: result.complete ? "completed" : "retained", value: result.value };
  },
}));

import { prisma } from "@/lib/prisma";
import * as leaseModule from "@/lib/lease";
import { AGENT_WORK_LEASE_DURATION_MS } from "@/lib/agent-work";
import { authorizeRequest } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";
import { GET, POST } from "./route";

const agentWork = prisma.agentWork as any;
const lease = prisma.lease as any;
const auditLog = prisma.auditLog as any;
const agentWorkHistory = prisma.agentWorkHistory as any;
const transaction = prisma.$transaction as any;
const issueFindUnique = prisma.issue.findUnique as any;

// Access the mocked lease module functions (they are vi.fn() mocks)
const releaseLeaseByAgentAndIssueMock = leaseModule.releaseLeaseByAgentAndIssue as any;
const releaseAllLeasesByAgentMock = leaseModule.releaseAllLeasesByAgent as any;
const releaseAgentWorkByAgentAndIssueMock = leaseModule.releaseAgentWorkByAgentAndIssue as any;

const mockAuthorizeRequest = vi.mocked(authorizeRequest);

// ─── GET Tests ───────────────────────────────────────────────────────────────

function makeGetRequest(url: string) {
  return GET(new Request(url));
}

describe("GET /api/agent-work", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizeRequest.mockResolvedValue({ authorized: true, type: "disabled", actor: "test-agent", throttleKey: "disabled:test-agent", tier: "maintainer" });
    agentWork.findMany.mockResolvedValue([]);
    lease.findMany.mockResolvedValue([]);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthorizeRequest.mockResolvedValue({ authorized: false });

    const res = await makeGetRequest("http://localhost/api/agent-work");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns empty activeWork and staleLeases when none exist", async () => {
    const res = await makeGetRequest("http://localhost/api/agent-work");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activeWork).toEqual([]);
    expect(body.staleLeases).toEqual([]);
  });

  it("returns active work items with issue details", async () => {
    agentWork.findMany.mockResolvedValueOnce([
      {
        id: "work-1",
        agentName: "test-agent",
        issueId: "issue-1",
        runId: null,
        state: "IN_PROGRESS",
        checkpoint: "CHANGES_MADE",
        branch: "feat/my-feature",
        prUrl: "https://github.com/org/repo/pull/42",
        leaseExpiresAt: new Date(),
        lastHeartbeatAt: new Date(),
        summary: "Implementing feature X",
        blockerReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        issue: { number: 10, title: "Add feature X", repository: { fullName: "org/repo" } },
      },
    ]);

    const res = await makeGetRequest("http://localhost/api/agent-work");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activeWork).toHaveLength(1);
    expect(body.activeWork[0].agentName).toBe("test-agent");
    expect(body.activeWork[0].state).toBe("IN_PROGRESS");
    expect(body.activeWork[0].issueNumber).toBe(10);
    expect(body.activeWork[0].repoFullName).toBe("org/repo");
  });

  it("filters by state when state query param is provided", async () => {
    await makeGetRequest("http://localhost/api/agent-work?state=BLOCKED");
    expect(agentWork.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { state: "BLOCKED" } })
    );
  });

  it("filters by agent name when agent query param is provided", async () => {
    await makeGetRequest("http://localhost/api/agent-work?agent=my-agent");
    const callArgs = agentWork.findMany.mock.calls[0][0];
    expect(callArgs.where.agentName).toBe("my-agent");
  });

  it("returns stale leases when include_stale is true (default)", async () => {
    lease.findMany.mockResolvedValueOnce([
      {
        id: "lease-1",
        agentName: "stale-agent",
        issueId: "issue-2",
        checkpoint: "BRANCH_CREATED",
        branch: "feat/old-feature",
        prUrl: null,
        expiredAt: new Date(Date.now() - 60000),
        renewedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        issue: { number: 20, title: "Old task", repository: { fullName: "org/repo" } },
      },
    ]);

    const res = await makeGetRequest("http://localhost/api/agent-work?include_stale=true");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.staleLeases).toHaveLength(1);
    expect(body.staleLeases[0].agentName).toBe("stale-agent");
    expect(body.staleLeases[0].blockerReason).toBe("Lease expired");
  });

  it("excludes stale leases when include_stale=false", async () => {
    const res = await makeGetRequest("http://localhost/api/agent-work?include_stale=false");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activeWork).toEqual([]);
    expect(body.staleLeases).toEqual([]);
  });

  it("returns 500 on database error", async () => {
    agentWork.findMany.mockRejectedValueOnce(new Error("DB connection failed"));
    const res = await makeGetRequest("http://localhost/api/agent-work");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch agent work");
  });
});

// ─── POST Tests ──────────────────────────────────────────────────────────────

function makePostRequest(payload: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/agent-work", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify(payload),
    })
  );
}

describe("POST /api/agent-work", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // #1395: reset the per-credential POST window so the added guarded-reassign
    // requests cannot 429 an earlier test in this file.
    resetRateLimits();

    // Default mock for transaction's agentWork.update
    transaction.mockImplementation(async (arg: any) => {
      const txAgentWorkUpdate = vi.fn(async () => ({
        id: "work-1",
        agentName: "old-agent",
        issueId: "issue-1",
        state: "RELEASED",
        leaseExpiresAt: new Date(),
        summary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        blockerReason: null,
        runId: null,
        checkpoint: "CLAIMED",
        branch: null,
        prUrl: null,
        lastHeartbeatAt: new Date(),
        issue: { number: 10, repository: { fullName: "org/repo" } },
      }));
      const txAgentWorkFindFirst = vi.fn();
      const txAgentWorkFindMany = vi.fn(async () => []);
      const txAgentWorkHistoryCreate = vi.fn(async () => ({ id: "hist-1" }));

      // Handle array of promises (parallel execution)
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }

      return arg({
        agentWork: {
          update: txAgentWorkUpdate,
          findFirst: txAgentWorkFindFirst,
          findMany: txAgentWorkFindMany,
        },
        agentWorkHistory: {
          create: txAgentWorkHistoryCreate,
        },
        // #1395: the guarded reassign commits the cache mirror + lifecycle evidence.
        issue: { update: vi.fn(async () => ({ id: "issue-1" })) },
        issueLifecycleEvent: { create: vi.fn(), upsert: vi.fn() },
      });
    });

    auditLog.create.mockResolvedValue({ id: "audit-1" });
  });

  describe("release action", () => {
    it("releases an AgentWork item by workId", async () => {
      agentWork.findUnique.mockResolvedValueOnce({
        id: "work-1",
        agentName: "old-agent",
        issueId: "issue-1",
        state: "IN_PROGRESS",
      });

      const res = await makePostRequest({ action: "release", workId: "work-1" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it("returns 404 for nonexistent workId", async () => {
      agentWork.findUnique.mockResolvedValueOnce(null);
      const res = await makePostRequest({ action: "release", workId: "nonexistent" });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Work item not found");
    });

    it("returns 400 for already completed work", async () => {
      agentWork.findUnique.mockResolvedValueOnce({
        id: "work-1",
        state: "DONE",
      } as any);
      const res = await makePostRequest({ action: "release", workId: "work-1" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Work is already completed or released");
    });

    it("releases a Lease by leaseId", async () => {
      lease.findUnique.mockResolvedValueOnce({
        id: "lease-1",
        agentName: "stale-agent",
        issueId: "issue-2",
        issue: { number: 20, repository: { fullName: "org/repo" } },
      } as any);

      const res = await makePostRequest({ action: "release", leaseId: "lease-1" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);

      expect(lease.delete).toHaveBeenCalledWith({ where: { id: "lease-1" } });
    });

    it("returns 400 when neither workId nor leaseId is provided", async () => {
      const res = await makePostRequest({ action: "release" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Missing workId, leaseId, or agentName");
    });

    it("creates audit log on successful release", async () => {
      agentWork.findUnique.mockResolvedValueOnce({
        id: "work-1",
        agentName: "old-agent",
        issueId: "issue-1",
        state: "IN_PROGRESS",
      });

      await makePostRequest({ action: "release", workId: "work-1" });
      expect(auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "agent_work_released",
            success: true,
            notes: expect.stringContaining("Released work for agent"),
          }),
        })
      );
    });

    it("creates audit log on lease release", async () => {
      lease.findUnique.mockResolvedValueOnce({
        id: "lease-1",
        agentName: "stale-agent",
        issueId: "issue-2",
        issue: { number: 20, repository: { fullName: "org/repo" } },
      } as any);

      await makePostRequest({ action: "release", leaseId: "lease-1" });
      expect(auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "lease_released",
            success: true,
          }),
        })
      );
    });
  });

  describe("reassign action", () => {
    // #1395: reassign now moves the claim under the per-issue mutation
    // anchor. These defaults let the pre-existing row-only assertions flow
    // through the guarded path unchanged: the cached issue and the live
    // GitHub labels both show the work row's owner holding the claim.
    const reassignIssue = {
      id: "issue-1",
      number: 10,
      state: "open",
      labels: ["agent/old-agent", "status/in-progress"],
      blockedReason: null,
      linkedPrNumber: null,
      repository: { fullName: "org/repo" },
    };

    function reassignWorkRow(overrides: Record<string, unknown> = {}) {
      return {
        id: "work-1",
        agentName: "old-agent",
        issueId: "issue-1",
        state: "IN_PROGRESS",
        createdAt: new Date(),
        updatedAt: new Date(),
        runId: null,
        summary: null,
        blockerReason: null,
        checkpoint: "CLAIMED",
        branch: null,
        prUrl: null,
        leaseExpiresAt: new Date(),
        lastHeartbeatAt: new Date(),
        issue: { number: 10, repository: { fullName: "org/repo" } },
        ...overrides,
      };
    }

    beforeEach(() => {
      // Reset the guard fake's per-region state and the claim-move stubs.
      guardState.busy = false;
      guardState.releaseGuardLost = false;
      guardState.addGuardLost = false;
      guardState.request = null;
      guardState.regionOptions = [];
      issueFindUnique.mockResolvedValue(reassignIssue);
      // Default: the old owner's lease row is already gone (a prior release
      // or drift) — tests that pin the epoch-scoped dedupe key override it.
      lease.findFirst.mockResolvedValue(null);
      mockGetLiveIssueLabels.mockResolvedValue(["agent/old-agent", "status/in-progress"]);
      mockReleaseIssueClaim.mockResolvedValue({
        released: true,
        labels: ["status/in-progress"],
        status: "status/in-progress",
        statusNote: null,
      });
      mockAddIssueLabel.mockResolvedValue(true);
      mockRecordClaimEvent.mockResolvedValue(true);
      mockUpsertLease.mockResolvedValue({
        created: true,
        mintedToken: true,
        lease: { id: "lease-1", claimToken: "tok-1", renewedAt: new Date(0) },
      });
      lease.deleteMany.mockResolvedValue({ count: 1 });
      auditLog.create.mockResolvedValue({ id: "audit-1" });
    });

    it("reassigns work to a new agent", async () => {
      agentWork.findUnique.mockResolvedValueOnce({
        id: "work-1",
        agentName: "old-agent",
        issueId: "issue-1",
        state: "IN_PROGRESS",
        createdAt: new Date(),
        updatedAt: new Date(),
        runId: null,
        summary: null,
        blockerReason: null,
        checkpoint: "CLAIMED",
        branch: null,
        prUrl: null,
        leaseExpiresAt: new Date(),
        lastHeartbeatAt: new Date(),
        issue: { number: 10, repository: { fullName: "org/repo" } },
      });

      const res = await makePostRequest({
        action: "reassign",
        workId: "work-1",
        newAgentName: "new-agent",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it("returns 404 for nonexistent workId", async () => {
      agentWork.findUnique.mockResolvedValueOnce(null);
      const res = await makePostRequest({
        action: "reassign",
        workId: "nonexistent",
        newAgentName: "new-agent",
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Work item not found");
    });

    it("returns 400 when newAgentName is missing", async () => {
      const res = await makePostRequest({ action: "reassign", workId: "work-1" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Missing newAgentName");
    });

    it("returns 400 when workId is missing", async () => {
      const res = await makePostRequest({ action: "reassign", newAgentName: "new-agent" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Missing workId");
    });

    it("releases existing active work for the new agent on the same issue during reassign", async () => {
      agentWork.findUnique.mockResolvedValueOnce({
        id: "work-1",
        agentName: "old-agent",
        issueId: "issue-1",
        state: "IN_PROGRESS",
        createdAt: new Date(),
        updatedAt: new Date(),
        runId: null,
        summary: null,
        blockerReason: null,
        checkpoint: "CLAIMED",
        branch: null,
        prUrl: null,
        leaseExpiresAt: new Date(),
        lastHeartbeatAt: new Date(),
        issue: { number: 10, repository: { fullName: "org/repo" } },
      });

      let conflictReleased = false;
      transaction.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
        const txAgentWorkUpdate = vi.fn(async (args: any) => {
          if (args.where.id === "conflict-work") {
            conflictReleased = true;
          }
          return {
            id: "work-1",
            agentName: "new-agent",
            issueId: "issue-1",
            state: "CLAIMED",
            leaseExpiresAt: new Date(),
            summary: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            blockerReason: null,
            runId: null,
            checkpoint: "CLAIMED",
            branch: null,
            prUrl: null,
            lastHeartbeatAt: new Date(),
            issue: { number: 10, repository: { fullName: "org/repo" } },
          };
        });
        const txAgentWorkFindMany = vi.fn(async (args: any) => {
          if (args.where.agentName === "new-agent") {
            return [{ id: "conflict-work", agentName: "new-agent", issueId: "issue-1", state: "CLAIMED" }];
          }
          return [];
        });
        const txAgentWorkHistoryCreate = vi.fn(async () => ({ id: "hist-1" }));

        return fn({
          agentWork: {
            update: txAgentWorkUpdate,
            findMany: txAgentWorkFindMany,
          },
          agentWorkHistory: {
            create: txAgentWorkHistoryCreate,
          },
          // #1395: the guarded reassign also mirrors the moved label in the cache.
          issue: { update: vi.fn(async () => ({ id: "issue-1" })) },
          issueLifecycleEvent: { create: vi.fn(), upsert: vi.fn() },
        });
      });

      await makePostRequest({
        action: "reassign",
        workId: "work-1",
        newAgentName: "new-agent",
      });

      expect(conflictReleased).toBe(true);
    });

    it("releases other active work for the new agent during reassign", async () => {
      agentWork.findUnique.mockResolvedValueOnce({
        id: "work-1",
        agentName: "old-agent",
        issueId: "issue-1",
        state: "IN_PROGRESS",
        createdAt: new Date(),
        updatedAt: new Date(),
        runId: null,
        summary: null,
        blockerReason: null,
        checkpoint: "CLAIMED",
        branch: null,
        prUrl: null,
        leaseExpiresAt: new Date(),
        lastHeartbeatAt: new Date(),
        issue: { number: 10, repository: { fullName: "org/repo" } },
      });

      let otherWorkReleased = false;
      transaction.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
        const txAgentWorkUpdate = vi.fn(async (args: any) => {
          if (args.where.id === "other-work") {
            otherWorkReleased = true;
          }
          return {
            id: "work-1",
            agentName: "new-agent",
            issueId: "issue-1",
            state: "CLAIMED",
            leaseExpiresAt: new Date(),
            summary: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            blockerReason: null,
            runId: null,
            checkpoint: "CLAIMED",
            branch: null,
            prUrl: null,
            lastHeartbeatAt: new Date(),
            issue: { number: 10, repository: { fullName: "org/repo" } },
          };
        });
        const txAgentWorkFindMany = vi.fn(async (args: any) => {
          if (args.where.agentName === "new-agent") {
            return [{ id: "other-work", agentName: "new-agent", state: "IN_PROGRESS" }];
          }
          return [];
        });
        const txAgentWorkHistoryCreate = vi.fn(async () => ({ id: "hist-1" }));

        return fn({
          agentWork: {
            update: txAgentWorkUpdate,
            findMany: txAgentWorkFindMany,
          },
          agentWorkHistory: {
            create: txAgentWorkHistoryCreate,
          },
          // #1395: the guarded reassign also mirrors the moved label in the cache.
          issue: { update: vi.fn(async () => ({ id: "issue-1" })) },
          issueLifecycleEvent: { create: vi.fn(), upsert: vi.fn() },
        });
      });

      await makePostRequest({
        action: "reassign",
        workId: "work-1",
        newAgentName: "new-agent",
      });

      expect(otherWorkReleased).toBe(true);
    });

    it("creates audit log on successful reassign", async () => {
      agentWork.findUnique.mockResolvedValueOnce({
        id: "work-1",
        agentName: "old-agent",
        issueId: "issue-1",
        state: "IN_PROGRESS",
        createdAt: new Date(),
        updatedAt: new Date(),
        runId: null,
        summary: null,
        blockerReason: null,
        checkpoint: "CLAIMED",
        branch: null,
        prUrl: null,
        leaseExpiresAt: new Date(),
        lastHeartbeatAt: new Date(),
        issue: { number: 10, repository: { fullName: "org/repo" } },
      });

      await makePostRequest({
        action: "reassign",
        workId: "work-1",
        newAgentName: "new-agent",
      });

      expect(auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "agent_work_reassigned",
            success: true,
            notes: expect.stringContaining("Reassigned work from old-agent to new-agent"),
          }),
        })
      );
    });

    // #1391: a sweep-marked row (`STALE` + `staleClaimReleasePending: true`)
    // reassigned to a new owner must not carry the marker into its `CLAIMED`
    // shape — the sweep's retry arm only advances `STALE` rows, so a carried
    // marker would strand the owed release on a live-shaped row forever.
    it("settles the stale-claim-release marker when rewriting the swept row to CLAIMED", async () => {
      agentWork.findUnique.mockResolvedValueOnce({
        id: "work-1",
        agentName: "old-agent",
        issueId: "issue-1",
        state: "STALE",
        staleClaimReleasePending: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        runId: null,
        summary: null,
        blockerReason: null,
        checkpoint: "CLAIMED",
        branch: null,
        prUrl: null,
        leaseExpiresAt: new Date(),
        lastHeartbeatAt: new Date(),
        issue: { number: 10, repository: { fullName: "org/repo" } },
      });

      // Capture the rewrite-to-CLAIMED update: the second of the two updates
      // on work-1 inside the reassign transaction (the first sets RELEASED).
      const claimedUpdates: Array<Record<string, unknown>> = [];
      const before = Date.now();
      transaction.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
        const txAgentWorkUpdate = vi.fn(async (args: any) => {
          if (args.where.id === "work-1" && args.data.state === "CLAIMED") {
            claimedUpdates.push(args.data);
          }
          return {
            id: "work-1",
            agentName: "new-agent",
            issueId: "issue-1",
            state: "CLAIMED",
            leaseExpiresAt: new Date(),
            summary: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            blockerReason: null,
            runId: null,
            checkpoint: "CLAIMED",
            branch: null,
            prUrl: null,
            lastHeartbeatAt: new Date(),
            issue: { number: 10, repository: { fullName: "org/repo" } },
          };
        });
        const txAgentWorkFindMany = vi.fn(async () => []);
        const txAgentWorkHistoryCreate = vi.fn(async () => ({ id: "hist-1" }));

        return fn({
          agentWork: {
            update: txAgentWorkUpdate,
            findMany: txAgentWorkFindMany,
          },
          agentWorkHistory: {
            create: txAgentWorkHistoryCreate,
          },
          // #1395: the guarded reassign also mirrors the moved label in the cache.
          issue: { update: vi.fn(async () => ({ id: "issue-1" })) },
          issueLifecycleEvent: { create: vi.fn(), upsert: vi.fn() },
        });
      });

      await makePostRequest({
        action: "reassign",
        workId: "work-1",
        newAgentName: "new-agent",
      });

      expect(claimedUpdates).toHaveLength(1);
      expect(claimedUpdates[0]).toEqual(
        expect.objectContaining({
          agentName: "new-agent",
          state: "CLAIMED",
          staleClaimReleasePending: false,
        })
      );

      // PR #1393 review: the same write must hand the new owner a LIVE
      // lease. The preceding RELEASED update stamps `leaseExpiresAt` with
      // "now", so a rewrite that left the field alone would carry an
      // already-expired lease into the `CLAIMED` shape. The handover is a
      // fresh claim, so it carries the claim path's horizon — asserted
      // against the write's own heartbeat so the check is clock-independent.
      const claimedLease = claimedUpdates[0].leaseExpiresAt as Date | undefined;
      const claimedHeartbeat = claimedUpdates[0].lastHeartbeatAt as Date | undefined;
      expect(claimedLease).toBeInstanceOf(Date);
      expect(claimedHeartbeat).toBeInstanceOf(Date);
      expect(claimedLease!.getTime()).toBeGreaterThan(before);
      expect(claimedLease!.getTime() - claimedHeartbeat!.getTime()).toBe(
        AGENT_WORK_LEASE_DURATION_MS
      );
    });

    // #1395: happy path — the claim (lease + agent/* label) moves to the new
    // owner under the guard, not just the AgentWork row.
    it("moves the claim (lease + agent label) to the new owner", async () => {
      agentWork.findUnique.mockResolvedValueOnce(
        reassignWorkRow({
          branch: "fix/handover",
          prUrl: "https://github.com/org/repo/pull/7",
        })
      );

      const issueUpdates: Array<{ where: Record<string, unknown>; data: Record<string, any> }> = [];
      transaction.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
        const txAgentWorkUpdate = vi.fn(async () => ({
          id: "work-1",
          agentName: "new-agent",
          issueId: "issue-1",
          state: "CLAIMED",
          leaseExpiresAt: new Date(),
          summary: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          blockerReason: null,
          runId: null,
          checkpoint: "CLAIMED",
          branch: "fix/handover",
          prUrl: "https://github.com/org/repo/pull/7",
          lastHeartbeatAt: new Date(),
          issue: { number: 10, repository: { fullName: "org/repo" } },
        }));
        const txAgentWorkFindMany = vi.fn(async () => []);
        const txAgentWorkHistoryCreate = vi.fn(async () => ({ id: "hist-1" }));
        const txIssueUpdate = vi.fn(async (args: any) => {
          issueUpdates.push(args);
          return { id: "issue-1" };
        });

        return fn({
          agentWork: {
            update: txAgentWorkUpdate,
            findMany: txAgentWorkFindMany,
          },
          agentWorkHistory: {
            create: txAgentWorkHistoryCreate,
          },
          issue: { update: txIssueUpdate },
          issueLifecycleEvent: { create: vi.fn(), upsert: vi.fn() },
        });
      });

      const res = await makePostRequest({
        action: "reassign",
        workId: "work-1",
        newAgentName: "new-agent",
        reason: "handover",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.claimMoved).toBe(true);

      // The mutation anchor engaged for the new owner's handover.
      expect(guardState.request).toEqual({
        issueId: "issue-1",
        operation: "reassign",
        agentName: "new-agent",
      });

      // The shared release runs with the OLD owner's identity, keeps the
      // status, and tolerates the label already being gone.
      expect(mockReleaseIssueClaim).toHaveBeenCalledTimes(1);
      const releaseArgs = mockReleaseIssueClaim.mock.calls[0][0];
      expect(releaseArgs.agentName).toBe("old-agent");
      expect(releaseArgs.repoFullName).toBe("org/repo");
      expect(releaseArgs.issueNumber).toBe(10);
      expect(releaseArgs.options).toEqual({
        allowMissingAgent: true,
        preserveStatus: true,
        // #1407 review: the move opts out of the shared release's refusal to
        // touch a label set that carries another agent's label — the old
        // owner's label must go even when the new owner's is already there.
        allowOtherAgentPresent: true,
        source: "api:unclaim",
        actor: "operator",
        releaseKey: "agent-work-reassign:work-1:no-lease",
      });
      // The release region's transaction budget is DERIVED from the live
      // label set (1 agent removal + 1 status removal + 1 target add + 1 PR
      // read = 4 calls on the fake's per-call arithmetic), never the
      // single-call default; the label-add region keeps the default.
      expect(guardState.regionOptions[0]?.timeoutMs).toBe(4 * 45_000 + 15_000);
      expect(guardState.regionOptions[1]?.timeoutMs).toBeUndefined();

      // The old owner's lease rows are destroyed UNCONDITIONALLY, expired
      // rows included: an expired survivor would hand its id/claimToken to a
      // later epoch of the same agent through `upsertLease`'s renew, colliding
      // with the epoch identity this release just recorded. The
      // expiry-filtered operator helper must NOT be used here.
      expect(lease.deleteMany).toHaveBeenCalledWith({
        where: { agentName: "old-agent", issueId: "issue-1" },
      });
      expect(releaseLeaseByAgentAndIssueMock).not.toHaveBeenCalled();
      // The new owner's receipt is minted with the work row's resume context
      // before the remote label lands.
      expect(mockUpsertLease).toHaveBeenCalledWith({
        agentName: "new-agent",
        issueId: "issue-1",
        checkpoint: "issue_claimed",
        branch: "fix/handover",
        prUrl: "https://github.com/org/repo/pull/7",
        mutationGuardHeld: true,
      });
      expect(mockAddIssueLabel).toHaveBeenCalledWith("org/repo", 10, "agent/new-agent");

      // The hand-over commits its `claim` evidence row with the live before
      // snapshot, the cached before-state for retries, and the reassign marker.
      expect(mockRecordClaimEvent).toHaveBeenCalledTimes(1);
      const claimInput = mockRecordClaimEvent.mock.calls[0][1];
      expect(claimInput.agentName).toBe("new-agent");
      expect(claimInput.source).toBe("api:claim");
      expect(claimInput.actor).toBe("operator");
      expect(claimInput.before).toEqual(["agent/old-agent", "status/in-progress"]);
      expect(claimInput.after).toEqual(["status/in-progress", "agent/new-agent"]);
      expect(claimInput.mirroredBefore).toEqual(["agent/old-agent", "status/in-progress"]);
      expect(claimInput.metadata).toEqual({ reassignedFrom: "old-agent" });

      // The cache mirror moves the labels: old owner's label out, new
      // owner's label appended.
      expect(issueUpdates).toHaveLength(1);
      expect(issueUpdates[0].where).toEqual({ id: "issue-1" });
      expect(issueUpdates[0].data.labels).toEqual(["status/in-progress", "agent/new-agent"]);
      expect(issueUpdates[0].data.labels).not.toContain("agent/old-agent");
      expect(issueUpdates[0].data.lastSyncedAt).toBeInstanceOf(Date);

      expect(auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "agent_work_reassigned",
            success: true,
            notes: expect.stringContaining("claim moved"),
          }),
        })
      );
    });

    // #1407 review: the shared release refuses to release the old owner's
    // label when ANOTHER agent's label is present — it reads the FIRST
    // `agent/*` label of the set, so it refuses whenever the new owner's label
    // comes first. The handover used to ignore that refusal and carried on,
    // which left BOTH labels on GitHub (two owners on one issue). The move
    // opts out of the refusal, and the foreign-agent check is what proves the
    // other label belongs to the intended new owner.
    it("moves the claim when the live labels carry both the old and the new owner", async () => {
      agentWork.findUnique.mockResolvedValueOnce(reassignWorkRow());
      mockGetLiveIssueLabels.mockResolvedValueOnce([
        "agent/new-agent",
        "agent/old-agent",
        "status/in-progress",
      ]);

      const issueUpdates: Array<{ where: Record<string, unknown>; data: Record<string, any> }> = [];
      transaction.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
        const txIssueUpdate = vi.fn(async (args: any) => {
          issueUpdates.push(args);
          return { id: "issue-1" };
        });

        return fn({
          agentWork: {
            update: vi.fn(async () => ({
              id: "work-1",
              agentName: "new-agent",
              issueId: "issue-1",
              state: "CLAIMED",
              leaseExpiresAt: new Date(),
              summary: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              blockerReason: null,
              runId: null,
              checkpoint: "CLAIMED",
              branch: null,
              prUrl: null,
              lastHeartbeatAt: new Date(),
              issue: { number: 10, repository: { fullName: "org/repo" } },
            })),
            findMany: vi.fn(async () => []),
          },
          agentWorkHistory: {
            create: vi.fn(async () => ({ id: "hist-1" })),
          },
          issue: { update: txIssueUpdate },
          issueLifecycleEvent: { create: vi.fn(), upsert: vi.fn() },
        });
      });

      const res = await makePostRequest({
        action: "reassign",
        workId: "work-1",
        newAgentName: "new-agent",
        reason: "handover",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.claimMoved).toBe(true);

      // The release sees the LIVE label set (both owners) and is told to
      // release the old owner's label even though another agent's label is on
      // the issue.
      expect(mockReleaseIssueClaim).toHaveBeenCalledTimes(1);
      const releaseArgs = mockReleaseIssueClaim.mock.calls[0][0];
      expect(releaseArgs.agentName).toBe("old-agent");
      expect(releaseArgs.issue.labels).toEqual([
        "agent/new-agent",
        "agent/old-agent",
        "status/in-progress",
      ]);
      expect(releaseArgs.options.allowOtherAgentPresent).toBe(true);

      // The cached mirror keeps exactly ONE agent label — the new owner's.
      expect(issueUpdates).toHaveLength(1);
      expect(issueUpdates[0].data.labels).toEqual(["status/in-progress", "agent/new-agent"]);
      expect(issueUpdates[0].data.labels).not.toContain("agent/old-agent");
    });

    // #1407 review: the route must NOT ignore a refused release. The release
    // is the only writer that removes the old owner's label, so a refusal
    // would leave both labels on GitHub once the new owner's label lands.
    it("answers 409 and audits the failure when the claim release is refused", async () => {
      agentWork.findUnique.mockResolvedValueOnce(reassignWorkRow());
      mockReleaseIssueClaim.mockResolvedValueOnce({
        released: false,
        labels: ["agent/new-agent", "status/in-progress"],
        status: "status/in-progress",
        statusNote: null,
        skipReason: "agent claim belongs to agent/new-agent",
      });

      const res = await makePostRequest({
        action: "reassign",
        workId: "work-1",
        newAgentName: "new-agent",
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe(
        "Reassign refused: agent claim belongs to agent/new-agent; resolve that claim before reassigning",
      );

      // Fail closed: no lease teardown, no lease mint, no label add, no row
      // move — the handover stops at the refused release.
      expect(lease.deleteMany).not.toHaveBeenCalled();
      expect(mockUpsertLease).not.toHaveBeenCalled();
      expect(mockAddIssueLabel).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();

      expect(auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "agent_work_reassign_failed",
            repoFullName: "org/repo",
            issueNumber: 10,
            issueId: "issue-1",
            success: false,
            errorMessage: "Claim release refused: agent claim belongs to agent/new-agent",
          }),
        })
      );
    });

    it("answers 409 without any writes when another writer holds the anchor", async () => {
      guardState.busy = true;
      agentWork.findUnique.mockResolvedValueOnce(reassignWorkRow());

      const res = await makePostRequest({
        action: "reassign",
        workId: "work-1",
        newAgentName: "new-agent",
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("Issue mutation is in progress; retry shortly");

      // The busy anchor short-circuits before any claim-move side effect.
      expect(mockGetLiveIssueLabels).not.toHaveBeenCalled();
      expect(mockReleaseIssueClaim).not.toHaveBeenCalled();
      expect(lease.deleteMany).not.toHaveBeenCalled();
      expect(releaseLeaseByAgentAndIssueMock).not.toHaveBeenCalled();
      expect(mockUpsertLease).not.toHaveBeenCalled();
      expect(mockAddIssueLabel).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(auditLog.create).not.toHaveBeenCalled();
    });

    it("answers 503 without any writes when live GitHub labels cannot be verified", async () => {
      agentWork.findUnique.mockResolvedValueOnce(reassignWorkRow());
      mockGetLiveIssueLabels.mockRejectedValueOnce(new Error("github 500"));

      const res = await makePostRequest({
        action: "reassign",
        workId: "work-1",
        newAgentName: "new-agent",
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe("Could not verify live GitHub labels: github 500");

      // The claim is still gated on the live read: nothing is released,
      // minted, written, or committed — the audited reconciler-intent
      // supersede that precedes the fail-closed read is the only write this
      // path may make (the claim route's force path takes the same posture).
      expect(mockReleaseIssueClaim).not.toHaveBeenCalled();
      expect(mockUpsertLease).not.toHaveBeenCalled();
      expect(mockAddIssueLabel).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    it("refuses a reassign over a third agent's live claim", async () => {
      agentWork.findUnique.mockResolvedValueOnce(reassignWorkRow());
      // A third agent holds the live claim; neither the old owner nor the new
      // owner may clobber it.
      mockGetLiveIssueLabels.mockResolvedValueOnce(["agent/interloper", "status/in-progress"]);

      const res = await makePostRequest({
        action: "reassign",
        workId: "work-1",
        newAgentName: "new-agent",
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe(
        "Issue is assigned to interloper; resolve that claim before reassigning",
      );

      // The foreign check short-circuits before any release or write.
      expect(mockReleaseIssueClaim).not.toHaveBeenCalled();
      expect(mockUpsertLease).not.toHaveBeenCalled();
      expect(mockAddIssueLabel).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    it("answers 409 and audits the failure when the guard is lost before the remote claim release", async () => {
      agentWork.findUnique.mockResolvedValueOnce(reassignWorkRow());
      guardState.releaseGuardLost = true;

      const res = await makePostRequest({
        action: "reassign",
        workId: "work-1",
        newAgentName: "new-agent",
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe(
        "Reassign was superseded by an operator override before the remote claim release; retry shortly",
      );

      // The fence is atomic: the release never fires and nothing is minted.
      expect(mockReleaseIssueClaim).not.toHaveBeenCalled();
      expect(mockUpsertLease).not.toHaveBeenCalled();
      expect(mockAddIssueLabel).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();

      expect(auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "agent_work_reassign_failed",
            repoFullName: "org/repo",
            issueNumber: 10,
            issueId: "issue-1",
            beforeLabels: ["agent/old-agent", "status/in-progress"],
            afterLabels: [],
            success: false,
            errorMessage:
              "Reassign was superseded by an operator override before the remote claim release",
          }),
        })
      );
    });

    it("fence-deletes the minted lease receipt and answers 409 when the guard is lost before the remote label write", async () => {
      agentWork.findUnique.mockResolvedValueOnce(reassignWorkRow());
      guardState.addGuardLost = true;

      const res = await makePostRequest({
        action: "reassign",
        workId: "work-1",
        newAgentName: "new-agent",
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe(
        "Reassign was superseded by an operator override before the remote label write; retry shortly",
      );

      // The release did run (its region completed)...
      expect(mockReleaseIssueClaim).toHaveBeenCalledTimes(1);
      // ...and the lease was minted before the fenced add (the §8.7
      // claim-side order)...
      expect(mockUpsertLease).toHaveBeenCalledTimes(1);
      // ...but the add itself never fired (the fence is atomic).
      expect(mockAddIssueLabel).not.toHaveBeenCalled();

      // The minted receipt is fence-deleted by its exact CAS so the
      // override's claim can own the issue.
      expect(lease.deleteMany).toHaveBeenCalledWith({
        where: { id: "lease-1", claimToken: "tok-1", renewedAt: new Date(0) },
      });

      // No work-row move or lifecycle evidence committed.
      expect(transaction).not.toHaveBeenCalled();
      expect(mockRecordClaimEvent).not.toHaveBeenCalled();

      expect(auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "agent_work_reassign_failed",
            success: false,
            errorMessage:
              "Reassign was superseded by an operator override before the remote label write",
          }),
        })
      );
    });

    it("scopes the release dedupe key to the old owner's claim epoch", async () => {
      agentWork.findUnique.mockResolvedValue(reassignWorkRow());
      // The old owner's live lease row IS the epoch: its token keys the
      // `claim_released` evidence, so a later handover cycle that releases
      // the same agent label in a DIFFERENT epoch cannot upsert onto this
      // row and swallow the evidence.
      lease.findFirst.mockResolvedValueOnce({ id: "lease-old", claimToken: "epoch-tok-9" });

      const first = await makePostRequest({
        action: "reassign",
        workId: "work-1",
        newAgentName: "new-agent",
      });
      expect(first.status).toBe(200);
      expect(mockReleaseIssueClaim.mock.calls[0][0].options.releaseKey).toBe(
        "agent-work-reassign:work-1:epoch-tok-9",
      );

      // With the old owner's lease row gone (already released / drift), the
      // attempt still keys its own retries onto one row off the work row.
      const second = await makePostRequest({
        action: "reassign",
        workId: "work-1",
        newAgentName: "other-agent",
      });
      expect(second.status).toBe(200);
      expect(mockReleaseIssueClaim.mock.calls[1][0].options.releaseKey).toBe(
        "agent-work-reassign:work-1:no-lease",
      );
      expect(lease.findFirst).toHaveBeenCalledWith({
        where: { agentName: "old-agent", issueId: "issue-1" },
        orderBy: { expiredAt: "desc" },
        select: { id: true, claimToken: true },
      });
    });

    it("leaves the lease receipt intact when the add guard is lost on a receipt this attempt only renewed", async () => {
      agentWork.findUnique.mockResolvedValueOnce(reassignWorkRow());
      guardState.addGuardLost = true;
      // upsertLease echoed a LIVE attempt's own token (mintedToken false):
      // the claim-route supersede rule deletes ONLY a receipt THIS attempt
      // minted — deleting a live attempt's row is the bug that rule exists
      // to prevent.
      mockUpsertLease.mockResolvedValueOnce({
        created: false,
        mintedToken: false,
        lease: { id: "lease-live", claimToken: "tok-live", renewedAt: new Date(0) },
      });

      const res = await makePostRequest({
        action: "reassign",
        workId: "work-1",
        newAgentName: "new-agent",
      });
      expect(res.status).toBe(409);
      expect(mockUpsertLease).toHaveBeenCalledTimes(1);
      // Step 2's blanket old-owner cleanup runs, but the NEW owner's receipt
      // this attempt only renewed (mintedToken false) must survive: the
      // claim-route supersede rule deletes ONLY a receipt THIS attempt minted
      // — deleting a live attempt's row is the bug that rule exists to
      // prevent.
      expect(lease.deleteMany).not.toHaveBeenCalledWith({
        where: { id: "lease-live", claimToken: "tok-live", renewedAt: new Date(0) },
      });
    });

    it("reassigns a work row without an issue as a row-only move", async () => {
      agentWork.findUnique.mockResolvedValueOnce(
        reassignWorkRow({ issueId: null, issue: null })
      );

      const claimedUpdates: Array<Record<string, unknown>> = [];
      transaction.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
        const txAgentWorkUpdate = vi.fn(async (args: any) => {
          if (args.where.id === "work-1" && args.data.state === "CLAIMED") {
            claimedUpdates.push(args.data);
          }
          return {
            id: "work-1",
            agentName: "new-agent",
            issueId: null,
            state: "CLAIMED",
            leaseExpiresAt: new Date(),
            summary: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            blockerReason: null,
            runId: null,
            checkpoint: "CLAIMED",
            branch: null,
            prUrl: null,
            lastHeartbeatAt: new Date(),
            issue: null,
          };
        });
        const txAgentWorkFindMany = vi.fn(async () => []);
        const txAgentWorkHistoryCreate = vi.fn(async () => ({ id: "hist-1" }));

        return fn({
          agentWork: {
            update: txAgentWorkUpdate,
            findMany: txAgentWorkFindMany,
          },
          agentWorkHistory: {
            create: txAgentWorkHistoryCreate,
          },
        });
      });

      const res = await makePostRequest({
        action: "reassign",
        workId: "work-1",
        newAgentName: "new-agent",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.claimMoved).toBe(false);

      // No claim to move: the anchor never engages and no GitHub/lease write
      // happens.
      expect(guardState.request).toBeNull();
      expect(mockGetLiveIssueLabels).not.toHaveBeenCalled();
      expect(mockReleaseIssueClaim).not.toHaveBeenCalled();
      expect(mockUpsertLease).not.toHaveBeenCalled();
      expect(mockAddIssueLabel).not.toHaveBeenCalled();

      // The row itself is still rewritten CLAIMED for the new owner.
      expect(claimedUpdates).toHaveLength(1);
      expect(claimedUpdates[0]).toEqual(
        expect.objectContaining({
          agentName: "new-agent",
          state: "CLAIMED",
          staleClaimReleasePending: false,
        })
      );

      expect(auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: "agent_work_reassigned", success: true }),
        })
      );
    });
  });

  describe("release by agentName + issueId", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      releaseLeaseByAgentAndIssueMock.mockResolvedValue(1);
      releaseAgentWorkByAgentAndIssueMock.mockResolvedValue(0);
      auditLog.create.mockResolvedValue({ id: "audit-1" });
    });

    it("returns 400 when agentName is missing", async () => {
      const res = await makePostRequest({ action: "release", issueId: "issue-1" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Missing workId, leaseId, or agentName");
    });

    it("returns 400 when neither issueId nor releaseAll is provided", async () => {
      const res = await makePostRequest({ action: "release", agentName: "test-agent" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Missing required field: issueId, or set releaseAll: true");
    });

    it("releases leases and work by agentName + issueId", async () => {
      agentWork.findUnique.mockResolvedValueOnce(null);
      issueFindUnique.mockResolvedValueOnce({ number: 42, repository: { fullName: "org/repo" } });
      const res = await makePostRequest({
        action: "release",
        agentName: "test-agent",
        issueId: "issue-orphaned",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.releasedLeases).toBe(1);
      expect(body.releasedWork).toBe(0);
    });

    it("creates audit log with orphan_work_released action", async () => {
      agentWork.findUnique.mockResolvedValueOnce(null);
      issueFindUnique.mockResolvedValueOnce({ number: 42, repository: { fullName: "org/repo" } });
      await makePostRequest({
        action: "release",
        agentName: "test-agent",
        issueId: "issue-orphaned",
      });
      expect(auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "orphan_work_released",
            success: true,
            notes: expect.stringContaining("Released 1 lease(s)"),
          }),
        })
      );
    });

    it("returns 400 when issueId is missing and releaseAll is false", async () => {
      const res = await makePostRequest({
        action: "release",
        agentName: "test-agent",
        releaseAll: false,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Missing required field: issueId, or set releaseAll: true");
    });
  });

  describe("release all by agentName", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      releaseAllLeasesByAgentMock.mockResolvedValue(1);
      auditLog.create.mockResolvedValue({ id: "audit-1" });
    });

    it("releases all leases and work for an agent when releaseAll is true", async () => {
      // Mock findMany to return a work item, then findFirst to get repo info
      agentWork.findMany.mockResolvedValueOnce([{ id: "work-1", issueId: "issue-1" }]);
      agentWork.findFirst.mockResolvedValueOnce({
        issue: { number: 10, repository: { fullName: "org/repo" } },
      });
      const res = await makePostRequest({
        action: "release",
        agentName: "test-agent",
        releaseAll: true,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.releasedLeases).toBe(1);
    });

    it("creates audit log with orphan_work_released action for releaseAll", async () => {
      agentWork.findMany.mockResolvedValueOnce([{ id: "work-1", issueId: "issue-1" }]);
      agentWork.findFirst.mockResolvedValueOnce({
        issue: { number: 10, repository: { fullName: "org/repo" } },
      });
      await makePostRequest({
        action: "release",
        agentName: "test-agent",
        releaseAll: true,
      });
      expect(auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "orphan_work_released",
            success: true,
            notes: expect.stringContaining("Released 1 lease(s)"),
          }),
        })
      );
    });
  });

  describe("POST auth", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockAuthorizeRequest.mockResolvedValue({ authorized: true, type: "disabled", actor: "test-agent", throttleKey: "disabled:test-agent", tier: "maintainer" });
    });

    it("returns 401 when token is invalid", async () => {
      mockAuthorizeRequest.mockResolvedValue({ authorized: false });
      const res = await POST(
        new Request("http://localhost/api/agent-work", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer wrong-token",
          },
          body: JSON.stringify({ action: "release", workId: "work-1" }),
        })
      );
      expect(res.status).toBe(401);
    });

    it("returns 400 for unknown action", async () => {
      const res = await makePostRequest({ action: "unknown-action" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Unknown action");
    });
  });
});

describe("GET /api/agent-work — bound worker scope (#1129)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentWork.findMany.mockResolvedValue([]);
    lease.findMany.mockResolvedValue([]);
  });

  function asBoundWorker(agentName: string) {
    mockAuthorizeRequest.mockResolvedValue({
      authorized: true,
      type: "bearer",
      actor: agentName,
      throttleKey: `agent:${agentName}`,
      tier: "worker",
      agentName,
    });
  }

  it("denies a bound worker listing another agent's work", async () => {
    asBoundWorker("alpha");
    const res = await makeGetRequest("http://localhost/api/agent-work?agent=bravo");
    expect(res.status).toBe(403);
    expect(agentWork.findMany).not.toHaveBeenCalled();
  });

  it("forces the agent filter to the bound identity", async () => {
    asBoundWorker("alpha");
    await makeGetRequest("http://localhost/api/agent-work");
    const callArgs = agentWork.findMany.mock.calls[0][0];
    expect(callArgs.where.agentName).toBe("alpha");
  });

  it("accepts an explicit filter naming the bound agent", async () => {
    asBoundWorker("alpha");
    const res = await makeGetRequest("http://localhost/api/agent-work?agent=alpha");
    expect(res.status).toBe(200);
  });

  it("scopes the stale-lease query to the bound agent", async () => {
    asBoundWorker("alpha");
    await makeGetRequest("http://localhost/api/agent-work");
    const callArgs = lease.findMany.mock.calls[0][0];
    expect(callArgs.where.agentName).toBe("alpha");
  });

  it("does not scope the stale-lease query for maintainer callers", async () => {
    mockAuthorizeRequest.mockResolvedValue({ authorized: true, type: "disabled", actor: "test-agent", throttleKey: "disabled:test-agent", tier: "maintainer" });
    await makeGetRequest("http://localhost/api/agent-work");
    const callArgs = lease.findMany.mock.calls[0][0];
    expect(callArgs.where.agentName).toBeUndefined();
  });

  it("denies an unbound legacy worker token", async () => {
    mockAuthorizeRequest.mockResolvedValue({
      authorized: true,
      type: "bearer",
      actor: "agent",
      throttleKey: "worker-cred:test",
      tier: "worker",
    });
    const res = await makeGetRequest("http://localhost/api/agent-work");
    expect(res.status).toBe(403);
    expect(agentWork.findMany).not.toHaveBeenCalled();
  });
});
