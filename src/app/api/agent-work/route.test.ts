import { describe, expect, it, vi, beforeEach } from "vitest";

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
      delete: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    agentWorkHistory: {
      create: vi.fn(),
    },
    issue: {
      findUnique: vi.fn(),
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
      });
    }),
  },
}));

vi.mock("@/lib/dispatch-env", () => ({
  isAuthorizedBearerToken: vi.fn((token: string | null | undefined) => token === "test-token"),
  getAcceptedAgentTokens: vi.fn(() => ["test-token"]),
  resetCaches: vi.fn(),
}));

vi.mock("@/lib/agent-work", () => ({
  releaseStaleWork: vi.fn(async () => []),
}));

vi.mock("@/lib/lease", () => ({
  releaseLeaseByAgentAndIssue: vi.fn(async () => 1),
  releaseAllLeasesByAgent: vi.fn(async () => 1),
  releaseAgentWorkByAgentAndIssue: vi.fn(async () => 0),
}));

import { prisma } from "@/lib/prisma";
import * as leaseModule from "@/lib/lease";
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

// ─── GET Tests ───────────────────────────────────────────────────────────────

function makeGetRequest(url: string) {
  return GET(new Request(url));
}

describe("GET /api/agent-work", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentWork.findMany.mockResolvedValue([]);
    lease.findMany.mockResolvedValue([]);
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
    it("returns 401 when token is invalid", async () => {
      const res = POST(
        new Request("http://localhost/api/agent-work", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer wrong-token",
          },
          body: JSON.stringify({ action: "release", workId: "work-1" }),
        })
      );
      expect((await res).status).toBe(401);
    });

    it("returns 400 for unknown action", async () => {
      const res = await makePostRequest({ action: "unknown-action" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Unknown action");
    });
  });
});
