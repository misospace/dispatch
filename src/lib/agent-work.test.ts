import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  parseStartAgentWorkInput,
  parseCheckpointAgentWorkInput,
  parseFinishAgentWorkInput,
  startAgentWork,
  checkpointAgentWork,
  finishAgentWork,
  getActiveWorkByAgent,
  releaseStaleWork,
} from "./agent-work";

describe("parseStartAgentWorkInput", () => {
  it("returns parsed input when valid", () => {
    const result = parseStartAgentWorkInput({ agentName: "test-agent", issueId: "issue-1", branch: "feat/x" });
    expect(result).toEqual({
      agentName: "test-agent",
      issueId: "issue-1",
      runId: null,
      branch: "feat/x",
    });
  });

  it("returns error when agentName is missing", () => {
    const result = parseStartAgentWorkInput({});
    expect(result).toEqual({ error: "Missing required field: agentName (string)" });
  });

  it("returns error for invalid body", () => {
    expect(parseStartAgentWorkInput(null)).toEqual({ error: "Invalid JSON body: expected an object" });
    expect(parseStartAgentWorkInput([])).toEqual({ error: "Invalid JSON body: expected an object" });
    expect(parseStartAgentWorkInput("string")).toEqual({ error: "Invalid JSON body: expected an object" });
  });
});

describe("parseCheckpointAgentWorkInput", () => {
  it("returns parsed input when valid", () => {
    const result = parseCheckpointAgentWorkInput({ agentName: "test-agent", checkpoint: "CHANGES_MADE" });
    expect(result).toEqual({
      agentName: "test-agent",
      checkpoint: "CHANGES_MADE",
      summary: null,
      blockerReason: null,
    });
  });

  it("returns error for invalid checkpoint", () => {
    const result = parseCheckpointAgentWorkInput({ agentName: "test-agent", checkpoint: "INVALID" });
    expect(result).toEqual({ error: 'Invalid checkpoint value: "INVALID" (expected one of: CLAIMED, REPO_PREPARED, BRANCH_CREATED, CHANGES_MADE, TESTS_RUNNING, PR_OPENED, DONE, BLOCKED)' });
  });

  it("returns error when required fields are missing", () => {
    expect(parseCheckpointAgentWorkInput({})).toEqual({ error: "Missing required field: agentName (string)" });
    expect(parseCheckpointAgentWorkInput({ agentName: "test" })).toEqual({ error: "Invalid checkpoint value: expected a string, got undefined" });
  });

  it("returns error for null body", () => {
    const result = parseCheckpointAgentWorkInput(null);
    expect(result).toEqual({ error: "Invalid JSON body: expected an object with agentName and checkpoint" });
  });

  it("returns error for array body", () => {
    const result = parseCheckpointAgentWorkInput([{ agentName: "test", checkpoint: "DONE" }]);
    expect(result).toEqual({ error: "Invalid JSON body: expected an object with agentName and checkpoint" });
  });

  it("returns error for string body", () => {
    const result = parseCheckpointAgentWorkInput("not a valid body");
    expect(result).toEqual({ error: "Invalid JSON body: expected an object with agentName and checkpoint" });
  });

  it("returns error when checkpoint is a nested object", () => {
    const result = parseCheckpointAgentWorkInput({ agentName: "test-agent", checkpoint: { nested: "value" } });
    expect(result).toEqual({ error: "Invalid checkpoint value: expected a string, got object" });
  });

  it("returns error when checkpoint is an array", () => {
    const result = parseCheckpointAgentWorkInput({ agentName: "test-agent", checkpoint: ["CHANGES_MADE"] });
    expect(result).toEqual({ error: "Invalid checkpoint value: expected a string, got object" });
  });

  it("returns error when checkpoint is a number", () => {
    const result = parseCheckpointAgentWorkInput({ agentName: "test-agent", checkpoint: 42 });
    expect(result).toEqual({ error: "Invalid checkpoint value: expected a string, got number" });
  });

  it("normalizes hyphenated checkpoint values", () => {
    const result = parseCheckpointAgentWorkInput({ agentName: "test-agent", checkpoint: "branch-created" });
    expect(result).toEqual({
      agentName: "test-agent",
      checkpoint: "BRANCH_CREATED",
      summary: null,
      blockerReason: null,
    });
  });

  it("accepts BLOCKED checkpoint with string blockerReason", () => {
    const result = parseCheckpointAgentWorkInput({ agentName: "test-agent", checkpoint: "BLOCKED", blockerReason: "waiting on API" });
    expect(result).toEqual({
      agentName: "test-agent",
      checkpoint: "BLOCKED",
      summary: null,
      blockerReason: "waiting on API",
    });
  });

  it("returns error when checkpoint is BLOCKED but blockerReason is a number", () => {
    const result = parseCheckpointAgentWorkInput({ agentName: "test-agent", checkpoint: "BLOCKED", blockerReason: 123 });
    expect(result).toEqual({ error: "Invalid blockerReason: expected a string when checkpoint is BLOCKED" });
  });

  it("returns error when checkpoint is BLOCKED but blockerReason is missing", () => {
    const result = parseCheckpointAgentWorkInput({ agentName: "test-agent", checkpoint: "BLOCKED" });
    expect(result).toEqual({ error: "Missing required field: blockerReason (string) is required when checkpoint is BLOCKED" });
  });

  it("returns error when checkpoint is BLOCKED but blockerReason is empty", () => {
    const result = parseCheckpointAgentWorkInput({ agentName: "test-agent", checkpoint: "BLOCKED", blockerReason: "   " });
    expect(result).toEqual({ error: "Missing required field: blockerReason (string) is required when checkpoint is BLOCKED" });
  });

  it("returns error when checkpoint is empty string", () => {
    const result = parseCheckpointAgentWorkInput({ agentName: "test-agent", checkpoint: "" });
    expect(result).toEqual({ error: "Missing required field: checkpoint (one of: CLAIMED, REPO_PREPARED, BRANCH_CREATED, CHANGES_MADE, TESTS_RUNNING, PR_OPENED, DONE, BLOCKED)" });
  });

  it("returns error when agentName is empty string", () => {
    const result = parseCheckpointAgentWorkInput({ agentName: "", checkpoint: "DONE" });
    expect(result).toEqual({ error: "Missing required field: agentName (string)" });
  });
});

describe("parseFinishAgentWorkInput", () => {
  it("returns parsed input when valid", () => {
    const result = parseFinishAgentWorkInput({ agentName: "test-agent", state: "DONE" });
    expect(result).toEqual({
      agentName: "test-agent",
      state: "DONE",
      summary: null,
    });
  });

  it("normalizes completed to DONE", () => {
    const result = parseFinishAgentWorkInput({ agentName: "test-agent", state: "completed" });
    expect(result).toEqual({
      agentName: "test-agent",
      state: "DONE",
      summary: null,
    });
  });

  it("normalizes stuck to BLOCKED", () => {
    const result = parseFinishAgentWorkInput({ agentName: "test-agent", state: "stuck" });
    expect(result).toEqual({
      agentName: "test-agent",
      state: "BLOCKED",
      summary: null,
    });
  });

  it("returns error for invalid state", () => {
    const result = parseFinishAgentWorkInput({ agentName: "test-agent", state: "INVALID" });
    expect(result).toEqual({ error: 'Invalid state value: "INVALID" (expected one of: CLAIMED, IN_PROGRESS, BLOCKED, DONE, RELEASED, STALE)' });
  });

  it("returns error for null body", () => {
    const result = parseFinishAgentWorkInput(null);
    expect(result).toEqual({ error: "Invalid JSON body: expected an object with agentName and state" });
  });

  it("returns error for array body", () => {
    const result = parseFinishAgentWorkInput([{ agentName: "test", state: "DONE" }]);
    expect(result).toEqual({ error: "Invalid JSON body: expected an object with agentName and state" });
  });

  it("returns error for string body", () => {
    const result = parseFinishAgentWorkInput("not a valid body");
    expect(result).toEqual({ error: "Invalid JSON body: expected an object with agentName and state" });
  });

  it("returns error when state is a nested object", () => {
    const result = parseFinishAgentWorkInput({ agentName: "test-agent", state: { nested: "DONE" } });
    expect(result).toEqual({ error: "Invalid state value: expected a string, got object" });
  });

  it("returns error when state is an array", () => {
    const result = parseFinishAgentWorkInput({ agentName: "test-agent", state: ["DONE"] });
    expect(result).toEqual({ error: "Invalid state value: expected a string, got object" });
  });

  it("returns error when state is a number", () => {
    const result = parseFinishAgentWorkInput({ agentName: "test-agent", state: 42 });
    expect(result).toEqual({ error: "Invalid state value: expected a string, got number" });
  });

  it("normalizes hyphenated state values", () => {
    const result = parseFinishAgentWorkInput({ agentName: "test-agent", state: "in-progress" });
    expect(result).toEqual({
      agentName: "test-agent",
      state: "IN_PROGRESS",
      summary: null,
    });
  });

  it("returns error when state is empty string", () => {
    const result = parseFinishAgentWorkInput({ agentName: "test-agent", state: "" });
    expect(result).toEqual({ error: "Missing required field: state (one of: CLAIMED, IN_PROGRESS, BLOCKED, DONE, RELEASED, STALE)" });
  });

  it("returns error when agentName is empty string", () => {
    const result = parseFinishAgentWorkInput({ agentName: "", state: "DONE" });
    expect(result).toEqual({ error: "Missing required field: agentName (string)" });
  });
});

describe("startAgentWork", () => {
  it("creates work and releases existing active work on same issue", async () => {
    const tx = createMockTransaction();
    tx.agentWork.findMany.mockResolvedValueOnce([{ id: "old-work", state: "IN_PROGRESS" }]);

    await startAgentWork(tx, { agentName: "agent-1", issueId: "issue-1" });

    expect(tx.agentWork.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "old-work" }), data: expect.objectContaining({ state: "RELEASED" }) })
    );
    expect(tx.agentWorkHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "released_by_new_claim" }) })
    );
  });

  it("releases other active work for the agent", async () => {
    const tx = createMockTransaction();
    tx.agentWork.findMany.mockResolvedValueOnce([{ id: "old-work-other", state: "IN_PROGRESS" }]);

    await startAgentWork(tx, { agentName: "agent-1", issueId: "issue-2" });

    expect(tx.agentWork.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "old-work-other" }), data: expect.objectContaining({ state: "RELEASED" }) })
    );
  });
});

describe("checkpointAgentWork", () => {
  it("extends lease on heartbeat", async () => {
    const tx = createMockTransaction();
    tx.agentWork.findFirst.mockResolvedValue({ id: "work-1", state: "IN_PROGRESS" });

    await checkpointAgentWork(tx, { agentName: "agent-1", checkpoint: "BRANCH_CREATED" });

    expect(tx.agentWork.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ leaseExpiresAt: expect.any(Date) }) })
    );
  });

  it("transitions to IN_PROGRESS when checkpoint advances from CLAIMED", async () => {
    const tx = createMockTransaction();
    tx.agentWork.findFirst.mockResolvedValue({ id: "work-1", state: "CLAIMED" });

    await checkpointAgentWork(tx, { agentName: "agent-1", checkpoint: "BRANCH_CREATED" });

    expect(tx.agentWork.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "IN_PROGRESS" }) })
    );
  });

  it("returns null when no active work found", async () => {
    const tx = createMockTransaction();
    tx.agentWork.findFirst.mockResolvedValue(null);

    const result = await checkpointAgentWork(tx, { agentName: "agent-1", checkpoint: "BRANCH_CREATED" });
    expect(result).toBeNull();
  });
});

describe("finishAgentWork", () => {
  it("sets state to DONE and checkpoint to DONE", async () => {
    const tx = createMockTransaction();
    tx.agentWork.findFirst.mockResolvedValue({ id: "work-1", state: "IN_PROGRESS" });

    await finishAgentWork(tx, { agentName: "agent-1", state: "DONE", summary: "all done" });

    expect(tx.agentWork.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "DONE", checkpoint: "DONE" }) })
    );
  });

  it("returns null when no active work found", async () => {
    const tx = createMockTransaction();
    tx.agentWork.findFirst.mockResolvedValue(null);

    const result = await finishAgentWork(tx, { agentName: "agent-1", state: "DONE" });
    expect(result).toBeNull();
  });
});

describe("releaseStaleWork", () => {
  it("marks work as STALE when heartbeat is old", async () => {
    const tx = createMockTransaction();
    const oldDate = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    tx.agentWork.findMany.mockResolvedValue([{ id: "stale-work", state: "IN_PROGRESS", lastHeartbeatAt: oldDate }]);

    const result = await releaseStaleWork(tx, 5 * 60 * 1000); // 5 minute threshold

    expect(result).toHaveLength(1);
    expect(tx.agentWork.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] },
          OR: expect.any(Array),
        }),
        data: expect.objectContaining({ state: "STALE" }),
      }),
    );
  });
});

function createMockTransaction() {
  const agentWork = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: "work-1", state: "CLAIMED", checkpoint: "CLAIMED" }),
    update: vi.fn().mockResolvedValue({ id: "work-1" }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const agentWorkHistory = {
    create: vi.fn().mockResolvedValue({ id: "hist-1" }),
  };
  return {
    agentWork,
    agentWorkHistory,
    $transaction: (fn: (tx: any) => Promise<any>) => fn({ agentWork, agentWorkHistory }),
  };
}

describe("findAndReleaseStaleAgentWorkForIssue", () => {
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      lease: { findMany: vi.fn() },
      agentWork: { 
        findMany: vi.fn().mockImplementation(({ where }: any) => {
          let result: any[] = [];
          // Return data based on what's been mocked — simulate notIn filtering
          const mockData = (mockPrisma.agentWork as any)._mockData;
          if (mockData) {
            result = [...mockData];
            if (where?.agentName?.notIn) {
              result = result.filter((w: any) => !where.agentName.notIn.includes(w.agentName));
            }
          }
          return Promise.resolve(result);
        }),
        update: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      agentWorkHistory: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "log-1" }) },
      $transaction: vi.fn((arg: any) => {
        if (typeof arg === "function") {
          return Promise.resolve(arg(mockPrisma));
        }
        return Promise.all(arg.map((op: any) => op));
      }),
    };
  });

  it("returns 0 when no stale work exists", async () => {
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");
    mockPrisma.lease.findMany.mockResolvedValue([]);
    (mockPrisma.agentWork as any)._mockData = [];

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1", "org/repo");
    expect(result).toBe(0);
  });

  it("releases work whose agent has no active lease", async () => {
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");
    mockPrisma.lease.findMany.mockResolvedValue([{ agentName: "other-agent" }]);
    (mockPrisma.agentWork as any)._mockData = [
      { id: "stale-1", state: "IN_PROGRESS", agentName: "crashed-agent" },
    ];

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1", "org/repo");
    expect(result).toBe(1);
    expect(mockPrisma.agentWork.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["stale-1"] } },
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "stale_agentwork_cleanup",
        repoFullName: "org/repo",
        issueId: "issue-1",
        success: true,
        notes: expect.stringContaining("Deleted 1 stale AgentWork record"),
      }),
    });
  });

  it("does not release work whose agent has an active lease", async () => {
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");
    mockPrisma.lease.findMany.mockResolvedValue([{ agentName: "active-agent" }]);
    (mockPrisma.agentWork as any)._mockData = [
      { id: "active-1", state: "IN_PROGRESS", agentName: "active-agent" },
    ];

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1", "org/repo");
    expect(result).toBe(0);
  });
});
