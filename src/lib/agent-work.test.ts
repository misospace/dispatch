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
import { CURRENT_CLAIM_WORK_ORDER_BY } from "./worker-ownership";

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

  it("trims a padded issueId", () => {
    const result = parseStartAgentWorkInput({ agentName: "test-agent", issueId: " issue-1 " });
    expect(result).toEqual(expect.objectContaining({ issueId: "issue-1" }));
  });

  it("treats a non-string issueId as absent", () => {
    const result = parseStartAgentWorkInput({ agentName: "test-agent", issueId: 42 });
    expect(result).toEqual(expect.objectContaining({ issueId: null }));
  });

  it("treats an empty-string issueId as absent", () => {
    const result = parseStartAgentWorkInput({ agentName: "test-agent", issueId: "" });
    expect(result).toEqual(expect.objectContaining({ issueId: null }));
  });

  it("treats a whitespace-only issueId as absent", () => {
    const result = parseStartAgentWorkInput({ agentName: "test-agent", issueId: " " });
    expect(result).toEqual(expect.objectContaining({ issueId: null }));
  });

  it("treats an absent issueId as absent", () => {
    const result = parseStartAgentWorkInput({ agentName: "test-agent" });
    expect(result).toEqual(expect.objectContaining({ issueId: null }));
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
      issueId: null,
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
      issueId: null,
    });
  });

  it("accepts BLOCKED checkpoint with string blockerReason", () => {
    const result = parseCheckpointAgentWorkInput({ agentName: "test-agent", checkpoint: "BLOCKED", blockerReason: "waiting on API" });
    expect(result).toEqual({
      agentName: "test-agent",
      checkpoint: "BLOCKED",
      summary: null,
      blockerReason: "waiting on API",
      issueId: null,
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
  it("passes through an optional issueId", () => {
    const result = parseCheckpointAgentWorkInput({ agentName: "test-agent", checkpoint: "CHANGES_MADE", issueId: "issue-A" });
    expect(result).toEqual(expect.objectContaining({ agentName: "test-agent", checkpoint: "CHANGES_MADE", issueId: "issue-A" }));
  });
  it("treats a non-string issueId as absent", () => {
    const result = parseCheckpointAgentWorkInput({ agentName: "test-agent", checkpoint: "CHANGES_MADE", issueId: 42 });
    expect(result).toEqual(expect.objectContaining({ issueId: null }));
  });
  it("treats an empty-string issueId as absent", () => {
    const result = parseCheckpointAgentWorkInput({ agentName: "test-agent", checkpoint: "CHANGES_MADE", issueId: "  " });
    expect(result).toEqual(expect.objectContaining({ issueId: null }));
  });
});

describe("parseFinishAgentWorkInput", () => {
  it("returns parsed input when valid", () => {
    const result = parseFinishAgentWorkInput({ agentName: "test-agent", state: "DONE" });
    expect(result).toEqual({
      agentName: "test-agent",
      state: "DONE",
      summary: null,
      issueId: null,
    });
  });

  it("normalizes completed to DONE", () => {
    const result = parseFinishAgentWorkInput({ agentName: "test-agent", state: "completed" });
    expect(result).toEqual({
      agentName: "test-agent",
      state: "DONE",
      summary: null,
      issueId: null,
    });
  });

  it("normalizes stuck to BLOCKED", () => {
    const result = parseFinishAgentWorkInput({ agentName: "test-agent", state: "stuck" });
    expect(result).toEqual({
      agentName: "test-agent",
      state: "BLOCKED",
      summary: null,
      issueId: null,
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
      issueId: null,
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

  it("passes through an optional issueId", () => {
    const result = parseFinishAgentWorkInput({ agentName: "test-agent", state: "DONE", issueId: "issue-A" });
    expect(result).toEqual(expect.objectContaining({ agentName: "test-agent", state: "DONE", issueId: "issue-A" }));
  });
  it("treats a non-string issueId as absent", () => {
    const result = parseFinishAgentWorkInput({ agentName: "test-agent", state: "DONE", issueId: 42 });
    expect(result).toEqual(expect.objectContaining({ issueId: null }));
  });
  it("treats an empty-string issueId as absent", () => {
    const result = parseFinishAgentWorkInput({ agentName: "test-agent", state: "DONE", issueId: "  " });
    expect(result).toEqual(expect.objectContaining({ issueId: null }));
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

  // #1355: the write is the FK write that a padded id used to fail, so the
  // created row must carry the normalized id, not the raw request text.
  it("persists the normalized issueId on the created row", async () => {
    const tx = createMockTransaction();
    const parsed = parseStartAgentWorkInput({ agentName: "agent-1", issueId: " issue-1 " });
    if ("error" in parsed) throw new Error(`unexpected parse error: ${parsed.error}`);

    await startAgentWork(tx, parsed);

    expect(tx.agentWork.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ issueId: "issue-1" }) })
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

  // #1328 regression: selection must go through the shared current-claim-work
  // rule (freshest lastHeartbeatAt, then createdAt, then id) instead of an
  // unordered findFirst, so an older active sibling (e.g. a surviving BLOCKED
  // row) can never be stamped with the freshest heartbeat while the current
  // attempt stays behind it.
  it("selects the active row through the shared current-claim-work ordering rule", async () => {
    const tx = createMockTransaction();
    tx.agentWork.findFirst.mockResolvedValue({ id: "work-1", state: "IN_PROGRESS" });

    await checkpointAgentWork(tx, { agentName: "agent-1", checkpoint: "CHANGES_MADE" });

    expect(tx.agentWork.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ agentName: "agent-1" }),
        orderBy: CURRENT_CLAIM_WORK_ORDER_BY,
      })
    );
  });

  it("scopes selection to the checkpoint's issue when the request identifies one", async () => {
    const tx = createMockTransaction();
    tx.agentWork.findFirst.mockResolvedValue({ id: "work-1", state: "IN_PROGRESS" });

    await checkpointAgentWork(tx, { agentName: "agent-1", checkpoint: "CHANGES_MADE", issueId: "issue-A" });

    expect(tx.agentWork.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ agentName: "agent-1", issueId: "issue-A" }),
        orderBy: CURRENT_CLAIM_WORK_ORDER_BY,
      })
    );
  });

  it("does not scope selection by issue when the request identifies none", async () => {
    const tx = createMockTransaction();
    tx.agentWork.findFirst.mockResolvedValue({ id: "work-1", state: "IN_PROGRESS" });

    await checkpointAgentWork(tx, { agentName: "agent-1", checkpoint: "CHANGES_MADE" });

    const call = tx.agentWork.findFirst.mock.calls[0][0];
    expect(call.where).not.toHaveProperty("issueId");
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

  // #1331 regression: selection must go through the shared current-claim-work
  // rule (freshest lastHeartbeatAt, then createdAt, then id) instead of an
  // unordered findFirst, so an older active sibling (e.g. a surviving BLOCKED
  // row) can never be settled while the current attempt stays active.
  it("selects the active row through the shared current-claim-work ordering rule", async () => {
    const tx = createMockTransaction();
    tx.agentWork.findFirst.mockResolvedValue({ id: "work-1", state: "IN_PROGRESS" });

    await finishAgentWork(tx, { agentName: "agent-1", state: "DONE" });

    const call = tx.agentWork.findFirst.mock.calls[0][0];
    // Identity, not just structural equality: the selection must go through
    // the shared constant, so an inline copy of it cannot pass by accident.
    expect(call.orderBy).toBe(CURRENT_CLAIM_WORK_ORDER_BY);
    expect(call.where).toEqual({
      agentName: "agent-1",
      state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] },
    });
  });

  it("scopes selection to the finish's issue when the request identifies one", async () => {
    const tx = createMockTransaction();
    tx.agentWork.findFirst.mockResolvedValue({ id: "work-1", state: "IN_PROGRESS" });

    await finishAgentWork(tx, { agentName: "agent-1", state: "DONE", issueId: "issue-A" });

    const call = tx.agentWork.findFirst.mock.calls[0][0];
    expect(call.orderBy).toBe(CURRENT_CLAIM_WORK_ORDER_BY);
    // Exactly the agent + issue + active-state filter: no stray filter key
    // (e.g. a `runId` null filter) can slip into the scoped query unnoticed.
    expect(call.where).toEqual({
      agentName: "agent-1",
      issueId: "issue-A",
      state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] },
    });
  });

  it("does not scope selection by issue when the request identifies none", async () => {
    const tx = createMockTransaction();
    tx.agentWork.findFirst.mockResolvedValue({ id: "work-1", state: "IN_PROGRESS" });

    await finishAgentWork(tx, { agentName: "agent-1", state: "DONE" });

    const call = tx.agentWork.findFirst.mock.calls[0][0];
    // Exactly the agent + active-state filter: no issue scoping, and no
    // unexpected key smuggled into the query (#1316 review).
    expect(call.where).toEqual({
      agentName: "agent-1",
      state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] },
    });
    expect(call.where).not.toHaveProperty("issueId");
  });

  it("settles the current attempt and leaves an older active sibling untouched", async () => {
    // The older BLOCKED sibling is FIRST in the pool: an unordered findFirst
    // lands on it, the shared ordering rule lands on the current row.
    const older = {
      id: "work-old",
      agentName: "agent-1",
      issueId: "issue-A",
      state: "BLOCKED",
      lastHeartbeatAt: new Date("2026-01-01T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const current = {
      id: "work-current",
      agentName: "agent-1",
      issueId: "issue-A",
      state: "IN_PROGRESS",
      summary: "",
      lastHeartbeatAt: new Date("2026-01-02T00:00:00.000Z"),
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    // A terminal row carries the FRESHEST heartbeat: the finish must skip it
    // (only CLAIMED/IN_PROGRESS/BLOCKED rows are active work) and settle the
    // current attempt instead.
    const alreadyDone = {
      id: "work-done",
      agentName: "agent-1",
      issueId: "issue-A",
      state: "DONE",
      summary: "earlier attempt",
      lastHeartbeatAt: new Date("2026-01-03T00:00:00.000Z"),
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    };
    const tx = createRowBackedTransaction([older, current, alreadyDone]);

    await finishAgentWork(tx, { agentName: "agent-1", state: "DONE", issueId: "issue-A", summary: "final" });

    expect(current.state).toBe("DONE");
    expect(current.summary).toBe("final");
    expect(older.state).toBe("BLOCKED");
    expect(alreadyDone.summary).toBe("earlier attempt");
  });

  it("never settles another issue's active row", async () => {
    // The other issue's row is FIRST in the pool and carries the fresher
    // heartbeat, so only the issue scoping keeps it out of the finish.
    const otherIssue = {
      id: "work-b",
      agentName: "agent-1",
      issueId: "issue-B",
      state: "IN_PROGRESS",
      lastHeartbeatAt: new Date("2026-01-02T00:00:00.000Z"),
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const identified = {
      id: "work-a",
      agentName: "agent-1",
      issueId: "issue-A",
      state: "IN_PROGRESS",
      lastHeartbeatAt: new Date("2026-01-01T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const tx = createRowBackedTransaction([otherIssue, identified]);

    await finishAgentWork(tx, { agentName: "agent-1", state: "DONE", issueId: "issue-A" });

    expect(identified.state).toBe("DONE");
    expect(otherIssue.state).toBe("IN_PROGRESS");
  });

  it("does not fall back to another issue's row when the identified issue has none", async () => {
    const otherIssue = {
      id: "work-b",
      agentName: "agent-1",
      issueId: "issue-B",
      state: "IN_PROGRESS",
      lastHeartbeatAt: new Date("2026-01-02T00:00:00.000Z"),
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const tx = createRowBackedTransaction([otherIssue]);

    const result = await finishAgentWork(tx, { agentName: "agent-1", state: "DONE", issueId: "issue-A" });

    expect(result).toBeNull();
    expect(otherIssue.state).toBe("IN_PROGRESS");
    expect(tx.agentWork.update).not.toHaveBeenCalled();
  });
});

describe("releaseStaleWork", () => {
  it("marks work as STALE when heartbeat is old", async () => {
    const tx = createMockTransaction();
    const oldDate = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    tx.agentWork.findMany.mockResolvedValue([{ id: "stale-work", state: "IN_PROGRESS", lastHeartbeatAt: oldDate }]);

    const result = await releaseStaleWork(tx, 5 * 60 * 1000); // 5 minute threshold

    expect(result).toHaveLength(1);
    // Per-state gate (#1316): heartbeat-gated CLAIMED/IN_PROGRESS rows, and
    // BLOCKED rows gated on the park deadline only — a parked BLOCKED row
    // (future expiry) is never selected or terminalized here.
    const perStateGate = [
      {
        state: { in: ["CLAIMED", "IN_PROGRESS"] },
        OR: [{ lastHeartbeatAt: { lt: expect.any(Date) } }, { leaseExpiresAt: { lt: expect.any(Date) } }],
      },
      {
        state: "BLOCKED",
        OR: [{ leaseExpiresAt: { lt: expect.any(Date) } }, { leaseExpiresAt: null }],
      },
    ];
    expect(tx.agentWork.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: perStateGate } }),
    );
    expect(tx.agentWork.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: perStateGate }),
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

// Sorts rows exactly like `orderBy` does in the database: the keys apply IN
// ORDER; `Date`s compare by instant, strings lexically. A key or direction
// this helper does not implement throws, so a selection rule change in
// production cannot silently read as "pool order won".
function compareRows(orderBy: unknown) {
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
}

/**
 * A transaction client over a real row pool: `agentWork.findFirst` honors
 * `where.agentName`, `where.issueId` and `where.state.in`, and honors the
 * `orderBy` array, so a selection that ignores either cannot pass by
 * accident — an unordered pick and the shared freshest-active pick disagree
 * here and the test observes which row was actually settled.
 */
function createRowBackedTransaction(rows: any[]) {
  const agentWork = {
    findUnique: vi.fn(),
    findFirst: vi.fn(async ({ where, orderBy }: any) => {
      if (where.state !== undefined && !Array.isArray(where.state?.in)) {
        throw new Error(`test fake: unsupported where.state shape ${JSON.stringify(where.state)}`);
      }
      // Only the modeled filter keys are honored: a key this fake does not
      // model would be silently ignored, so a selection that filters on
      // something else could pass by accident.
      for (const key of Object.keys(where)) {
        if (!["agentName", "issueId", "state"].includes(key)) {
          throw new Error(`test fake: unsupported where key ${key}`);
        }
      }
      const matches = rows.filter(
        (row) =>
          row.agentName === where.agentName &&
          (where.issueId === undefined || row.issueId === where.issueId) &&
          (!where.state?.in || where.state.in.includes(row.state)),
      );
      if (matches.length === 0) return null;
      if (orderBy) matches.sort(compareRows(orderBy));
      return matches[0];
    }),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(async ({ where, data }: any) => {
      const row = rows.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error(`test fake: no AgentWork row with id ${where.id}`);
      Object.assign(row, data);
      return row;
    }),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
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
          // Return data based on what's been mocked — simulate state + notIn filtering
          const mockData = (mockPrisma.agentWork as any)._mockData;
          if (mockData) {
            result = [...mockData];
            if (where?.state?.in) {
              result = result.filter((w: any) => where.state.in.includes(w.state));
            }
            if (where?.issueId !== undefined) {
              result = result.filter((w: any) => w.issueId === where.issueId);
            }
            if (where?.agentName?.notIn) {
              result = result.filter((w: any) => !where.agentName.notIn.includes(w.agentName));
            }
            if (where?.staleClaimReleasePending === false) {
              // Prisma equality over a non-nullable Boolean (schema default
              // false): fixture rows without the field stand for database
              // rows whose marker is false, a true marker never matches.
              result = result.filter((w: any) => (w.staleClaimReleasePending ?? false) === false);
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

  /**
   * SQL stand-in for the fenced delete's `where`: a conjunct the fence omits
   * simply does not constrain the match. A fence that carried only the state
   * family and the pending boundary would therefore still consume a row whose
   * owner changed after the scan — the tests pin the ownership conjuncts
   * separately so the omission cannot pass silently.
   */
  function fencedWhereMatches(where: any, row: any): boolean {
    if (!row) return false;
    if (where.id !== undefined && where.id !== row.id) return false;
    if (where.issueId !== undefined && where.issueId !== row.issueId) return false;
    if (where.agentName !== undefined && where.agentName !== row.agentName) return false;
    if (where.state?.in && !where.state.in.includes(row.state)) return false;
    if (where.staleClaimReleasePending === false && (row.staleClaimReleasePending ?? false) !== false) return false;
    return true;
  }

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
      { id: "stale-1", issueId: "issue-1", state: "IN_PROGRESS", agentName: "crashed-agent" },
    ];
    mockPrisma.agentWork.deleteMany.mockResolvedValue({ count: 1 });

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1", "org/repo");
    expect(result).toBe(1);
    expect(mockPrisma.agentWork.deleteMany).toHaveBeenCalledWith({
      where: {
        id: "stale-1",
        issueId: "issue-1",
        agentName: "crashed-agent",
        state: { in: ["CLAIMED", "IN_PROGRESS"] },
        staleClaimReleasePending: false,
      },
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

  it("never releases a BLOCKED row through the claim-path cleanup (#1316, #1334)", async () => {
    // A parked claim's settled row is BLOCKED and its parked AgentWork row has
    // no matching active Lease once the ownership TTL elapses; the claim path
    // must leave it to the park-gated sweep, not delete it here.
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");
    mockPrisma.lease.findMany.mockResolvedValue([]);
    (mockPrisma.agentWork as any)._mockData = [
      { id: "parked-1", issueId: "issue-1", state: "BLOCKED", agentName: "parked-agent" },
    ];

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1", "org/repo");
    expect(result).toBe(0);
    expect(mockPrisma.agentWork.deleteMany).not.toHaveBeenCalled();
  });

  /**
   * SQL-3VL evaluation of the protecting-lease clause
   * (`expiredAt > now OR retryAfter > now`): a running park protects its
   * agent's active-shaped rows even after the ownership TTL lapsed; a NULL
   * comparison column satisfies neither arm.
   */
  function matchesProtectingLeaseWhere(
    lease: { expiredAt: Date; retryAfter: Date | null },
    where: { issueId: string; OR: Array<Record<string, any>> },
  ): boolean {
    return where.OR.some((arm) => {
      for (const [field, cond] of Object.entries(arm)) {
        const value = (lease as any)[field] as Date | null;
        if (value === null || value === undefined) return false;
        if (cond?.gt !== undefined && !(value.getTime() > cond.gt.getTime())) return false;
      }
      return true;
    });
  }

  function leaseQuerySeeLeases(leases: Array<{ agentName: string; expiredAt: Date; retryAfter: Date | null }>) {
    mockPrisma.lease.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(leases.filter((l) => matchesProtectingLeaseWhere(l, where))),
    );
  }

  it("a running park (renewal externalWait) keeps the parked agent's IN_PROGRESS row alive through the cleanup (#1316, #1334)", async () => {
    // The claim path used to key "active" on expiredAt alone, so a park
    // longer than the renew TTL — the row still CLAIMED/IN_PROGRESS, the
    // wait deadline still running — lost its row to deleteMany while the
    // sweeper deliberately holds off. The park must decide here too.
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");
    leaseQuerySeeLeases([
      { agentName: "parked-agent", expiredAt: new Date(Date.now() - 5 * 60_000), retryAfter: new Date(Date.now() + 30 * 60_000) },
    ]);
    (mockPrisma.agentWork as any)._mockData = [
      { id: "parked-work-1", issueId: "issue-1", state: "IN_PROGRESS", agentName: "parked-agent" },
    ];

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1", "org/repo");
    expect(result).toBe(0);
    expect(mockPrisma.agentWork.deleteMany).not.toHaveBeenCalled();
  });

  it("an elapsed park no longer protects the agent's active-shaped row (marker spent, normal cleanup)", async () => {
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");
    leaseQuerySeeLeases([
      { agentName: "parked-agent", expiredAt: new Date(Date.now() - 5 * 60_000), retryAfter: new Date(Date.now() - 60_000) },
    ]);
    (mockPrisma.agentWork as any)._mockData = [
      { id: "parked-work-1", issueId: "issue-1", state: "IN_PROGRESS", agentName: "parked-agent" },
    ];
    mockPrisma.agentWork.deleteMany.mockResolvedValue({ count: 1 });

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1", "org/repo");
    expect(result).toBe(1);
    expect(mockPrisma.agentWork.deleteMany).toHaveBeenCalledWith({
      where: {
        id: "parked-work-1",
        issueId: "issue-1",
        agentName: "parked-agent",
        state: { in: ["CLAIMED", "IN_PROGRESS"] },
        staleClaimReleasePending: false,
      },
    });
  });

  it("does not release work whose agent has an active lease", async () => {
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");
    mockPrisma.lease.findMany.mockResolvedValue([{ agentName: "active-agent" }]);
    (mockPrisma.agentWork as any)._mockData = [
      { id: "active-1", issueId: "issue-1", state: "IN_PROGRESS", agentName: "active-agent" },
    ];

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1", "org/repo");
    expect(result).toBe(0);
  });

  it("never considers a row that belongs to another issue (#1350)", async () => {
    // The scan is scoped to the target issue: a stale-shaped row of a
    // different issue is never a candidate here, and the fenced delete pins
    // the same issue the scan matched.
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");
    mockPrisma.lease.findMany.mockResolvedValue([]);
    (mockPrisma.agentWork as any)._mockData = [
      { id: "other-issue-1", issueId: "issue-2", state: "IN_PROGRESS", agentName: "crashed-agent", staleClaimReleasePending: false },
    ];

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1", "org/repo");
    expect(result).toBe(0);
    expect(mockPrisma.agentWork.deleteMany).not.toHaveBeenCalled();
  });

  it("never deletes a row still owed a claim release (#1350)", async () => {
    // The sweep's pending-release boundary (`activeStateFamilies` canon): a
    // row the sweep marked still owes its claim release. A marked STALE row is
    // excluded by the state filter; an active-shaped row carrying the marker
    // is excluded by the boundary conjunct itself. Either way the release is
    // retired by the sweep's retry arm, never dropped here.
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");
    mockPrisma.lease.findMany.mockResolvedValue([]);
    (mockPrisma.agentWork as any)._mockData = [
      { id: "owed-stale-1", issueId: "issue-1", state: "STALE", agentName: "crashed-agent", staleClaimReleasePending: true },
      { id: "owed-active-1", issueId: "issue-1", state: "IN_PROGRESS", agentName: "crashed-agent-2", staleClaimReleasePending: true },
    ];

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1", "org/repo");
    expect(result).toBe(0);
    expect(mockPrisma.agentWork.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("the fenced delete refuses a row that became owed a release after the scan (#1350)", async () => {
    // The delete re-checks the SAME boundary conjuncts the scan matched on
    // (the sweep's CAS practice). Here the concurrent write pins the pending
    // marker mid-flight, so the fence must consume nothing and no audit row
    // may claim a deletion that did not happen. Defence in depth: the sweep —
    // the only writer that SETS the marker — takes the per-issue mutation
    // guard, so it cannot interleave with the claim path in production; the
    // reachable pending shape is one that ARRIVES pending (the test above).
    // The fence must hold for that shape all the same.
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");
    mockPrisma.lease.findMany.mockResolvedValue([]);
    (mockPrisma.agentWork as any)._mockData = [
      { id: "raced-1", issueId: "issue-1", state: "IN_PROGRESS", agentName: "returned-agent", staleClaimReleasePending: false },
    ];

    let firstDelete = false;
    mockPrisma.agentWork.deleteMany.mockImplementation(({ where }: any) => {
      const rows = (mockPrisma.agentWork as any)._mockData as any[];
      if (!firstDelete) {
        firstDelete = true;
        // The concurrent write lands after the scan returned the row.
        rows[0].staleClaimReleasePending = true;
      }
      // Evaluate the fenced where against the row's CURRENT shape (SQL 3VL
      // stand-in): a where carrying the pending boundary must not match a
      // row whose marker is now true.
      const row = rows.find((r: any) => r.id === where.id);
      if (row && fencedWhereMatches(where, row)) {
        rows.splice(rows.indexOf(row), 1);
        return Promise.resolve({ count: 1 });
      }
      return Promise.resolve({ count: 0 });
    });

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1", "org/repo");
    expect(result).toBe(0);
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    const row = ((mockPrisma.agentWork as any)._mockData as any[])[0];
    expect(row.id).toBe("raced-1");
  });

  it("the fenced delete refuses a row reassigned to another agent after the scan (#1350)", async () => {
    // The fence must carry the scanned OWNERSHIP fields, not only the state
    // family and the pending boundary: a row reassigned to another agent
    // between the scan and the delete keeps its id, state and marker, so a
    // fence that omits the owner would delete the row out from under its new
    // owner. The delete must consume nothing and leave the row for whoever
    // now owns it.
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");
    mockPrisma.lease.findMany.mockResolvedValue([]);
    (mockPrisma.agentWork as any)._mockData = [
      { id: "reassigned-1", issueId: "issue-1", state: "IN_PROGRESS", agentName: "original-agent", staleClaimReleasePending: false },
    ];

    let firstDelete = false;
    mockPrisma.agentWork.deleteMany.mockImplementation(({ where }: any) => {
      const rows = (mockPrisma.agentWork as any)._mockData as any[];
      if (!firstDelete) {
        firstDelete = true;
        // The concurrent reassignment lands after the scan returned the row.
        rows[0].agentName = "new-owner-agent";
      }
      const row = rows.find((r: any) => r.id === where.id);
      if (row && fencedWhereMatches(where, row)) {
        rows.splice(rows.indexOf(row), 1);
        return Promise.resolve({ count: 1 });
      }
      return Promise.resolve({ count: 0 });
    });

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1", "org/repo");
    expect(result).toBe(0);
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    // The fence pins the OWNER the scan saw, so a later reassignment misses it.
    expect(mockPrisma.agentWork.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "reassigned-1", issueId: "issue-1", agentName: "original-agent" }),
    });
    const row = ((mockPrisma.agentWork as any)._mockData as any[])[0];
    expect(row.id).toBe("reassigned-1");
    expect(row.agentName).toBe("new-owner-agent");
  });

  it("the fenced delete refuses a row whose state changed after the scan (#1350)", async () => {
    // The fence must carry the executing STATE FAMILY as well: the operator
    // agent-work routes (release / release-all) settle a row to RELEASED
    // without touching the pending marker, so a row settled after the scan
    // keeps its id, owner and marker. A fence that dropped the state conjunct
    // would delete it; the fence must consume nothing and leave the settled
    // row alone.
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");
    mockPrisma.lease.findMany.mockResolvedValue([]);
    (mockPrisma.agentWork as any)._mockData = [
      { id: "settled-1", issueId: "issue-1", state: "IN_PROGRESS", agentName: "settled-agent", staleClaimReleasePending: false },
    ];

    let firstDelete = false;
    mockPrisma.agentWork.deleteMany.mockImplementation(({ where }: any) => {
      const rows = (mockPrisma.agentWork as any)._mockData as any[];
      if (!firstDelete) {
        firstDelete = true;
        // The concurrent settle lands after the scan returned the row.
        rows[0].state = "RELEASED";
      }
      const row = rows.find((r: any) => r.id === where.id);
      if (row && fencedWhereMatches(where, row)) {
        rows.splice(rows.indexOf(row), 1);
        return Promise.resolve({ count: 1 });
      }
      return Promise.resolve({ count: 0 });
    });

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1", "org/repo");
    expect(result).toBe(0);
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    // The fence pins the executing state family the scan saw.
    expect(mockPrisma.agentWork.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "settled-1", state: { in: ["CLAIMED", "IN_PROGRESS"] } }),
    });
    const row = ((mockPrisma.agentWork as any)._mockData as any[])[0];
    expect(row.id).toBe("settled-1");
    expect(row.state).toBe("RELEASED");
  });

  it("the audit names only the rows the fence actually consumed (#1350)", async () => {
    // Mixed case: one candidate is consumed, the other is refused because its
    // state changed between the scan and the delete. The returned count and
    // the audit's id list must report the consumed row ONLY — an accounting
    // that reported the scanned ids would claim a deletion that did not
    // happen, which is exactly the dishonest shape this fix removed.
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");
    mockPrisma.lease.findMany.mockResolvedValue([]);
    (mockPrisma.agentWork as any)._mockData = [
      { id: "consumed-1", issueId: "issue-1", state: "IN_PROGRESS", agentName: "agent-a", staleClaimReleasePending: false },
      { id: "refused-1", issueId: "issue-1", state: "IN_PROGRESS", agentName: "agent-b", staleClaimReleasePending: false },
    ];

    mockPrisma.agentWork.deleteMany.mockImplementation(({ where }: any) => {
      const rows = (mockPrisma.agentWork as any)._mockData as any[];
      const row = rows.find((r: any) => r.id === where.id);
      if (row && row.id === "refused-1") {
        // The concurrent settle lands between the scan and this delete.
        row.state = "RELEASED";
      }
      if (row && fencedWhereMatches(where, row)) {
        rows.splice(rows.indexOf(row), 1);
        return Promise.resolve({ count: 1 });
      }
      return Promise.resolve({ count: 0 });
    });

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1", "org/repo");
    expect(result).toBe(1);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    const notes = mockPrisma.auditLog.create.mock.calls[0][0].data.notes as string;
    expect(notes).toContain("Deleted 1 stale AgentWork record");
    expect(notes).toContain("consumed-1");
    expect(notes).not.toContain("refused-1");
    // The refused row survives, in the shape its concurrent writer gave it.
    const survivor = ((mockPrisma.agentWork as any)._mockData as any[])[0];
    expect(survivor.id).toBe("refused-1");
    expect(survivor.state).toBe("RELEASED");
  });

  it("the fenced delete refuses a row whose issue changed after the scan (#1350)", async () => {
    // The fence pins the ISSUE the scan matched, next to the owner, the state
    // family and the pending boundary. No current writer moves an AgentWork
    // row between issues, so this conjunct is defensive — but it is part of
    // the fence, and dropping it must not pass silently: a fence without it
    // would consume a row that no longer belongs to the issue being claimed.
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");
    mockPrisma.lease.findMany.mockResolvedValue([]);
    (mockPrisma.agentWork as any)._mockData = [
      { id: "moved-1", issueId: "issue-1", state: "IN_PROGRESS", agentName: "crashed-agent", staleClaimReleasePending: false },
    ];

    let firstDelete = false;
    mockPrisma.agentWork.deleteMany.mockImplementation(({ where }: any) => {
      const rows = (mockPrisma.agentWork as any)._mockData as any[];
      if (!firstDelete) {
        firstDelete = true;
        // The concurrent move lands after the scan returned the row.
        rows[0].issueId = "issue-2";
      }
      const row = rows.find((r: any) => r.id === where.id);
      if (row && fencedWhereMatches(where, row)) {
        rows.splice(rows.indexOf(row), 1);
        return Promise.resolve({ count: 1 });
      }
      return Promise.resolve({ count: 0 });
    });

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1", "org/repo");
    expect(result).toBe(0);
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    const row = ((mockPrisma.agentWork as any)._mockData as any[])[0];
    expect(row.id).toBe("moved-1");
    expect(row.issueId).toBe("issue-2");
  });

  it("deletes and audits in one transaction, and surfaces an audit failure (#1350)", async () => {
    // "A deletion is never left without its audit row" is a transaction-level
    // invariant: the deletes and the audit row must go through the SAME
    // transaction client, and an audit write that fails must surface the
    // failure instead of the cleanup reporting a successful deletion. What
    // this pins is the SHAPE (one transaction, the delete before the audit,
    // no swallowed audit failure); the real rollback — an aborted transaction
    // leaving the row and its `AgentWorkHistory` cascade intact — needs a
    // live PostgreSQL and is NOT covered by CI's Database integration job
    // (it runs a fixed file list that does not include this path).
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");

    const outerDelete = vi.fn();
    const outerAudit = vi.fn();
    const txDelete = vi.fn().mockResolvedValue({ count: 1 });
    const txAudit = vi.fn().mockResolvedValue({ id: "log-1" });
    const tx = { agentWork: { deleteMany: txDelete }, auditLog: { create: txAudit } };
    const scopedPrisma: any = {
      lease: { findMany: vi.fn().mockResolvedValue([]) },
      agentWork: {
        // The fake returns the candidate regardless of the scan's where; the
        // row carries a realistic shape so the fixture does not read as
        // scan-behaviour coverage.
        findMany: vi.fn().mockResolvedValue([
          { id: "tx-1", issueId: "issue-1", state: "IN_PROGRESS", agentName: "crashed-agent" },
        ]),
        deleteMany: outerDelete,
      },
      auditLog: { create: outerAudit },
      $transaction: vi.fn(async (fn: any) => fn(tx)),
    };

    const result = await findAndReleaseStaleAgentWorkForIssue(scopedPrisma, "issue-1", "org/repo");
    expect(result).toBe(1);
    expect(scopedPrisma.$transaction).toHaveBeenCalledTimes(1);
    // The delete and the audit row both went through the TRANSACTION client.
    expect(txDelete).toHaveBeenCalledTimes(1);
    expect(txAudit).toHaveBeenCalledTimes(1);
    expect(outerDelete).not.toHaveBeenCalled();
    expect(outerAudit).not.toHaveBeenCalled();
    // The audit row is written after the deletion it accounts for.
    expect(txDelete.mock.invocationCallOrder[0]).toBeLessThan(txAudit.mock.invocationCallOrder[0]);

    // A failing audit write must surface, not be swallowed: the caller must
    // not be told the cleanup succeeded.
    txAudit.mockRejectedValueOnce(new Error("audit write failed"));
    await expect(findAndReleaseStaleAgentWorkForIssue(scopedPrisma, "issue-1", "org/repo")).rejects.toThrow(
      "audit write failed",
    );
  });
});
