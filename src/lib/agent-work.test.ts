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
    expect(result).toEqual({ error: "Missing required field: agentName" });
  });

  it("returns error for invalid body", () => {
    expect(parseStartAgentWorkInput(null)).toEqual({ error: "Invalid JSON body" });
    expect(parseStartAgentWorkInput([])).toEqual({ error: "Invalid JSON body" });
    expect(parseStartAgentWorkInput("string")).toEqual({ error: "Invalid JSON body" });
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
    expect(result).toEqual({ error: "Invalid checkpoint value" });
  });

  it("returns error when required fields are missing", () => {
    expect(parseCheckpointAgentWorkInput({})).toEqual({ error: "Missing required field: agentName" });
    expect(parseCheckpointAgentWorkInput({ agentName: "test" })).toEqual({ error: "Missing required field: checkpoint" });
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
    expect(result).toEqual({ error: "Invalid state value" });
  });
});

describe("startAgentWork", () => {
  it("creates work and releases existing active work on same issue", async () => {
    const tx = createMockTransaction();
    tx.agentWork.findFirst.mockResolvedValueOnce({ id: "old-work", state: "IN_PROGRESS" });

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
    tx.agentWork.findFirst
      .mockResolvedValueOnce({ id: "old-work-other", state: "IN_PROGRESS" })
      .mockResolvedValueOnce(null);

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
    expect(tx.agentWork.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "STALE" }) })
    );
  });
});

function createMockTransaction() {
  const agentWork = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn().mockResolvedValue({ id: "work-1", state: "CLAIMED", checkpoint: "CLAIMED" }),
    update: vi.fn().mockResolvedValue({ id: "work-1" }),
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
  const mockPrisma = {
    lease: { findMany: vi.fn() },
    agentWork: { findMany: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn((fn) => fn({ agentWork: mockPrisma.agentWork })),
  };

  it("returns 0 when no stale work exists", async () => {
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");
    mockPrisma.lease.findMany.mockResolvedValue([]);
    mockPrisma.agentWork.findMany.mockResolvedValue([]);

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1");
    expect(result).toBe(0);
  });

  it("releases work whose agent has no active lease", async () => {
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");
    mockPrisma.lease.findMany.mockResolvedValue([{ agentName: "other-agent" }]);
    mockPrisma.agentWork.findMany.mockResolvedValue([
      { id: "stale-1", state: "IN_PROGRESS", agentName: "crashed-agent" },
    ]);

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1");
    expect(result).toBe(1);
    expect(mockPrisma.agentWork.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "STALE" }) })
    );
  });

  it("does not release work whose agent has an active lease", async () => {
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");
    mockPrisma.lease.findMany.mockResolvedValue([{ agentName: "active-agent" }]);
    mockPrisma.agentWork.findMany.mockResolvedValue([
      { id: "active-1", state: "IN_PROGRESS", agentName: "active-agent" },
    ]);

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1");
    expect(result).toBe(0);
  });
});
