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

  it("never releases a BLOCKED row through the claim-path cleanup (#1316, #1334)", async () => {
    // A parked claim's settled row is BLOCKED and its parked AgentWork row has
    // no matching active Lease once the ownership TTL elapses; the claim path
    // must leave it to the park-gated sweep, not delete it here.
    const { findAndReleaseStaleAgentWorkForIssue } = await import("./agent-work");
    mockPrisma.lease.findMany.mockResolvedValue([]);
    (mockPrisma.agentWork as any)._mockData = [
      { id: "parked-1", state: "BLOCKED", agentName: "parked-agent" },
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
      { id: "parked-work-1", state: "IN_PROGRESS", agentName: "parked-agent" },
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
      { id: "parked-work-1", state: "IN_PROGRESS", agentName: "parked-agent" },
    ];

    const result = await findAndReleaseStaleAgentWorkForIssue(mockPrisma, "issue-1", "org/repo");
    expect(result).toBe(1);
    expect(mockPrisma.agentWork.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["parked-work-1"] } },
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
