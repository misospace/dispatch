import { describe, expect, it, vi } from "vitest";
import {
  AGENT_EXECUTION_CAPABILITY,
  AGENT_EXECUTION_LIVENESS_MS,
  AGENT_EXECUTION_LIST_LIMIT,
  AGENT_EXECUTION_RECENT_TERMINAL_MS,
  AgentExecutionError,
  TERMINAL_AGENT_EXECUTION_STATES,
  applyExecutionReport,
  deriveExecutionStaleness,
  listActiveExecutions,
  recordExecutionReport,
  resolveObservedAt,
  validateExecutionReport,
  type ExistingExecutionRow,
  type ExecutionReportInput,
} from "./agent-executions";

const NOW = new Date("2026-10-30T12:00:00.000Z");

function reportInput(overrides: Partial<ExecutionReportInput> = {}): ExecutionReportInput {
  return {
    agentName: "saffron",
    source: "courier-harness",
    executionId: "attempt-1",
    workType: "implement",
    executionState: "RUNNING",
    revision: 1,
    ...overrides,
  };
}

function existingRow(overrides: Partial<ExistingExecutionRow> = {}): ExistingExecutionRow {
  return {
    id: "exec-1",
    agentName: "saffron",
    source: "courier-harness",
    executionId: "attempt-1",
    workType: "implement",
    workRefUrl: null,
    issueId: null,
    executionState: "RUNNING",
    startedAt: new Date("2026-10-30T11:00:00.000Z"),
    lastObservedAt: new Date("2026-10-30T11:59:00.000Z"),
    endedAt: null,
    summary: null,
    revision: 1,
    ...overrides,
  };
}

describe("vocabularies and constants", () => {
  it("exposes the capability descriptor", () => {
    expect(AGENT_EXECUTION_CAPABILITY).toEqual({ name: "agent-executions", protocolVersion: 1 });
  });

  it("derives terminal states from the full state vocabulary", () => {
    expect(TERMINAL_AGENT_EXECUTION_STATES).toEqual(["SUCCEEDED", "FAILED", "CANCELLED"]);
  });

  it("uses the settled liveness windows", () => {
    expect(AGENT_EXECUTION_LIVENESS_MS).toBe(15 * 60_000);
    expect(AGENT_EXECUTION_RECENT_TERMINAL_MS).toBe(24 * 60 * 60_000);
  });
});

describe("deriveExecutionStaleness", () => {
  it("reports live at exactly the liveness boundary", () => {
    expect(
      deriveExecutionStaleness(new Date(NOW.getTime() - AGENT_EXECUTION_LIVENESS_MS), NOW),
    ).toBe("live");
  });

  it("reports stale just past the liveness boundary", () => {
    expect(
      deriveExecutionStaleness(new Date(NOW.getTime() - AGENT_EXECUTION_LIVENESS_MS - 1), NOW),
    ).toBe("stale");
  });

  it("reports live for a fresh observation", () => {
    expect(deriveExecutionStaleness(new Date(NOW.getTime() - 1_000), NOW)).toBe("live");
  });
});

describe("resolveObservedAt", () => {
  it("accepts a parseable past observedAt", () => {
    const ts = new Date(NOW.getTime() - 5_000).toISOString();
    expect(resolveObservedAt(ts, NOW)).toEqual(new Date(ts));
  });

  it("falls back to now for a future observedAt", () => {
    const ts = new Date(NOW.getTime() + 60_000).toISOString();
    expect(resolveObservedAt(ts, NOW)).toEqual(NOW);
  });

  it("falls back to now when absent or unparseable", () => {
    expect(resolveObservedAt(null, NOW)).toEqual(NOW);
    expect(resolveObservedAt("not-a-date", NOW)).toEqual(NOW);
  });
});

describe("validateExecutionReport", () => {
  it("accepts a minimal valid report", () => {
    const input = validateExecutionReport(reportInput());
    expect(input.agentName).toBe("saffron");
    expect(input.revision).toBe(1);
  });

  it("rejects a non-object body", () => {
    expect(() => validateExecutionReport(null)).toThrow(AgentExecutionError);
    expect(() => validateExecutionReport([])).toThrow(AgentExecutionError);
    expect(() => validateExecutionReport("x")).toThrow(AgentExecutionError);
  });

  it("rejects missing or oversized agentName", () => {
    expect(() => validateExecutionReport(reportInput({ agentName: "" }))).toThrow(/agentName/);
    expect(() => validateExecutionReport(reportInput({ agentName: "a".repeat(101) }))).toThrow(/agentName/);
  });

  it("rejects missing or oversized executionId", () => {
    expect(() => validateExecutionReport(reportInput({ executionId: " " }))).toThrow(/executionId/);
    expect(() => validateExecutionReport(reportInput({ executionId: "e".repeat(201) }))).toThrow(/executionId/);
  });

  it("rejects unknown workType and executionState with invalid_report", () => {
    try {
      validateExecutionReport(reportInput({ workType: "deploy" }));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentExecutionError);
      expect((error as AgentExecutionError).code).toBe("invalid_report");
      expect((error as AgentExecutionError).status).toBe(400);
      expect((error as AgentExecutionError).message).toMatch(/workType/);
    }
    try {
      validateExecutionReport(reportInput({ executionState: "PAUSED" }));
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as AgentExecutionError).code).toBe("invalid_report");
      expect((error as AgentExecutionError).message).toMatch(/executionState/);
    }
  });

  it("rejects a non-http(s) workRefUrl", () => {
    try {
      validateExecutionReport(reportInput({ workRefUrl: "repo:org/repo#42" }));
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as AgentExecutionError).message).toMatch(/workRefUrl/);
    }
  });

  it("rejects non-integer or negative revision", () => {
    expect(() => validateExecutionReport(reportInput({ revision: -1 }))).toThrow(/revision/);
    expect(() => validateExecutionReport(reportInput({ revision: 1.5 }))).toThrow(/revision/);
    expect(() => validateExecutionReport(reportInput({ revision: "3" as unknown as number }))).toThrow(/revision/);
  });

  it("rejects a revision that would overflow the INTEGER column", () => {
    for (const revision of [2 ** 31, 2 ** 31 - 1 + 1, Number.MAX_SAFE_INTEGER]) {
      try {
        validateExecutionReport(reportInput({ revision }));
        throw new Error(`should have thrown for ${revision}`);
      } catch (error) {
        expect(error).toBeInstanceOf(AgentExecutionError);
        expect((error as AgentExecutionError).code).toBe("invalid_report");
        expect((error as AgentExecutionError).status).toBe(400);
        expect((error as AgentExecutionError).message).toMatch(/revision/);
      }
    }
    // Boundary: 2**31 - 1 itself is accepted.
    expect(validateExecutionReport(reportInput({ revision: 2 ** 31 - 1 })).revision).toBe(2 ** 31 - 1);
  });

  it("rejects oversized summary", () => {
    expect(() => validateExecutionReport(reportInput({ summary: "s".repeat(2001) }))).toThrow(/summary/);
  });

  it("rejects unparseable observedAt and startedAt", () => {
    expect(() => validateExecutionReport(reportInput({ observedAt: "nope" }))).toThrow(/observedAt/);
    expect(() => validateExecutionReport(reportInput({ startedAt: "nope" }))).toThrow(/startedAt/);
  });
});

describe("applyExecutionReport", () => {
  it("creates when no row exists", () => {
    const decision = applyExecutionReport(reportInput(), null, NOW);
    expect(decision.status).toBe("created");
    expect(decision.data).toMatchObject({
      agentName: "saffron",
      executionId: "attempt-1",
      executionState: "RUNNING",
      endedAt: null,
      revision: 1,
      lastObservedAt: NOW,
    });
  });

  it("creates directly terminal with endedAt = lastObservedAt", () => {
    const decision = applyExecutionReport(
      reportInput({ executionState: "SUCCEEDED", revision: 3 }),
      null,
      NOW,
    );
    expect(decision.status).toBe("created");
    expect(decision.data?.endedAt).toEqual(NOW);
    expect(decision.data?.lastObservedAt).toEqual(NOW);
  });

  it("treats a same-revision identical replay as duplicate without mutation", () => {
    const decision = applyExecutionReport(
      reportInput({ revision: 1, startedAt: existingRow().startedAt?.toISOString() }),
      existingRow(),
      NOW,
    );
    expect(decision.status).toBe("duplicate");
    expect(decision.data).toBeUndefined();
  });

  it("rejects a conflicting same-revision report as stale_report", () => {
    try {
      applyExecutionReport(
        reportInput({ revision: 1, summary: "a different story" }),
        existingRow(),
        NOW,
      );
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentExecutionError);
      expect((error as AgentExecutionError).code).toBe("stale_report");
      expect((error as AgentExecutionError).status).toBe(409);
    }
  });

  it("rejects a lower-revision report as stale_report", () => {
    try {
      applyExecutionReport(reportInput({ revision: 0 }), existingRow({ revision: 2 }), NOW);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as AgentExecutionError).code).toBe("stale_report");
      expect((error as AgentExecutionError).status).toBe(409);
    }
  });

  it("accepts a higher-revision update including terminal transition", () => {
    const startedAt = new Date("2026-10-30T10:30:00.000Z");
    const decision = applyExecutionReport(
      reportInput({
        executionState: "FAILED",
        revision: 5,
        startedAt: startedAt.toISOString(),
        summary: "boom",
        workRefUrl: "https://github.com/org/repo/issues/7",
        issueId: "issue-7",
      }),
      existingRow({ revision: 4 }),
      NOW,
    );
    expect(decision.status).toBe("updated");
    expect(decision.data).toMatchObject({
      executionState: "FAILED",
      revision: 5,
      summary: "boom",
      endedAt: NOW,
      lastObservedAt: NOW,
      startedAt,
      workRefUrl: "https://github.com/org/repo/issues/7",
      issueId: "issue-7",
    });
  });

  it("clears endedAt on a higher-revision non-terminal update", () => {
    const decision = applyExecutionReport(
      reportInput({ executionState: "RUNNING", revision: 5 }),
      existingRow({ revision: 4, endedAt: new Date("2026-10-30T11:30:00.000Z") }),
      NOW,
    );
    expect(decision.status).toBe("updated");
    expect(decision.data?.endedAt).toBeNull();
  });

  it("fences a terminal row: identical replay is duplicate without mutation", () => {
    const endedAt = new Date("2026-10-30T11:45:00.000Z");
    const terminal = existingRow({
      executionState: "SUCCEEDED",
      endedAt,
      lastObservedAt: endedAt,
      revision: 7,
    });
    const decision = applyExecutionReport(
      reportInput({ executionState: "SUCCEEDED", revision: 7 }),
      terminal,
      NOW,
    );
    expect(decision.status).toBe("duplicate");
    expect(decision.data).toBeUndefined();
  });

  it("fences a terminal row: a differing state is rejected as execution_terminal", () => {
    const terminal = existingRow({ executionState: "SUCCEEDED", revision: 7 });
    try {
      applyExecutionReport(
        reportInput({ executionState: "FAILED", revision: 8 }),
        terminal,
        NOW,
      );
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentExecutionError);
      expect((error as AgentExecutionError).code).toBe("execution_terminal");
      expect((error as AgentExecutionError).status).toBe(409);
      expect((error as AgentExecutionError).message).toMatch(/new executionId/);
    }
  });

  it("fences a terminal row: a non-terminal state is rejected as execution_terminal", () => {
    const terminal = existingRow({ executionState: "CANCELLED", revision: 2 });
    expect(() =>
      applyExecutionReport(reportInput({ executionState: "RUNNING", revision: 9 }), terminal, NOW),
    ).toThrow(AgentExecutionError);
  });

  it("fences a terminal row: a newer-revision identical terminal report is rejected (no rewrite)", () => {
    const terminal = existingRow({ executionState: "FAILED", revision: 3 });
    try {
      applyExecutionReport(
        reportInput({ executionState: "FAILED", revision: 4, summary: "extra detail" }),
        terminal,
        NOW,
      );
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as AgentExecutionError).code).toBe("execution_terminal");
    }
  });
});

describe("recordExecutionReport", () => {
  function makeDeps(existing: ExistingExecutionRow | null) {
    const agentExecution = {
      findUnique: vi.fn(async () => existing),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-1", ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    };
    const auditLog = { create: vi.fn(async () => ({})) };
    return { deps: { agentExecution, auditLog }, agentExecution, auditLog };
  }

  it("creates through the deps and reports created", async () => {
    const { deps, agentExecution, auditLog } = makeDeps(null);
    const result = await recordExecutionReport(deps, reportInput(), { actor: "op", now: NOW });
    expect(result.outcome.status).toBe("created");
    expect(agentExecution.create).toHaveBeenCalled();
    expect(agentExecution.updateMany).not.toHaveBeenCalled();
    expect(auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actor: "op", action: "agent_execution_report" }) }),
    );
  });

  it("returns duplicate without any write or audit", async () => {
    const { deps, agentExecution, auditLog } = makeDeps(
      existingRow({ executionState: "SUCCEEDED", endedAt: NOW, revision: 1 }),
    );
    const result = await recordExecutionReport(
      deps,
      reportInput({ executionState: "SUCCEEDED", revision: 1 }),
      { now: NOW },
    );
    expect(result.outcome.status).toBe("duplicate");
    expect(agentExecution.create).not.toHaveBeenCalled();
    expect(agentExecution.updateMany).not.toHaveBeenCalled();
    expect(auditLog.create).not.toHaveBeenCalled();
  });

  it("updates through the deps and reports updated", async () => {
    const { deps, agentExecution } = makeDeps(existingRow({ revision: 1 }));
    const result = await recordExecutionReport(
      deps,
      reportInput({ revision: 2, executionState: "RUNNING", summary: "progress" }),
      { now: NOW },
    );
    expect(result.outcome.status).toBe("updated");
    expect(agentExecution.updateMany).toHaveBeenCalledWith({
      where: { id: "exec-1", revision: 1, executionState: "RUNNING" },
      data: expect.objectContaining({ revision: 2, summary: "progress" }),
    });
  });

  it("propagates AgentExecutionError from the pure decision", async () => {
    const { deps } = makeDeps(existingRow({ revision: 3 }));
    await expect(
      recordExecutionReport(deps, reportInput({ revision: 1 }), { now: NOW }),
    ).rejects.toMatchObject({ code: "stale_report" });
  });

  it("never fails the report when the audit row write fails", async () => {
    const agentExecution = {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-1", ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    };
    const auditLog = { create: vi.fn(async () => { throw new Error("audit db down"); }) };
    const result = await recordExecutionReport(
      { agentExecution, auditLog },
      reportInput(),
      { now: NOW },
    );
    expect(result.outcome.status).toBe("created");
    expect(auditLog.create).toHaveBeenCalled();
  });

  // --- concurrent-writer / lost-race paths ---

  it("surfaces 409 stale_report when the fenced update loses the race through all attempts", async () => {
    // Every read shows a RUNNING row the decision wants to advance, and
    // every conditional write loses (count 0) — a concurrent writer keeps
    // moving the row under us.
    let attempt = 0;
    const agentExecution = {
      findUnique: vi.fn(async () => {
        attempt += 1;
        return existingRow({ revision: 10 + attempt });
      }),
      create: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 0 })),
    };
    const auditLog = { create: vi.fn() };
    await expect(
      recordExecutionReport(
        { agentExecution, auditLog },
        reportInput({ revision: 100 }),
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "stale_report", status: 409 });
    expect(agentExecution.updateMany).toHaveBeenCalledTimes(3);
    expect(agentExecution.create).not.toHaveBeenCalled();
    expect(auditLog.create).not.toHaveBeenCalled();
  });

  it("re-reads and re-decides after a lost update race: identical replay wins as duplicate", async () => {
    const loser = existingRow({ revision: 4 });
    const winner = existingRow({
      revision: 5,
      executionState: "SUCCEEDED",
      endedAt: NOW,
      lastObservedAt: NOW,
    });
    const reads = [loser, winner];
    const agentExecution = {
      findUnique: vi.fn(async () => reads.shift() ?? winner),
      create: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 0 })),
    };
    const auditLog = { create: vi.fn() };
    const result = await recordExecutionReport(
      { agentExecution, auditLog },
      reportInput({ executionState: "SUCCEEDED", revision: 5 }),
      { now: NOW },
    );
    expect(result.outcome.status).toBe("duplicate");
    expect(result.execution).toBe(winner);
    expect(agentExecution.create).not.toHaveBeenCalled();
  });

  it("re-reads and re-decides after a lost update race: the fresh row fences as execution_terminal", async () => {
    const loser = existingRow({ revision: 4 });
    const winner = existingRow({
      revision: 6,
      executionState: "FAILED",
      endedAt: NOW,
    });
    const reads = [loser, winner];
    const agentExecution = {
      findUnique: vi.fn(async () => reads.shift() ?? winner),
      create: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 0 })),
    };
    const auditLog = { create: vi.fn() };
    await expect(
      recordExecutionReport(
        { agentExecution, auditLog },
        reportInput({ revision: 5 }),
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "execution_terminal" });
  });

  it("retries once after a lost update race and succeeds on a fresh read", async () => {
    // First read: revision 4 (decision update rev 5, loses with count 0).
    // Second read: a concurrent writer committed revision 5 with an
    // identical-payload RUNNING row, so the re-decision advances to rev 6.
    const first = existingRow({ revision: 4 });
    const second = existingRow({ revision: 5, summary: "progress" });
    const reads = [first, second];
    const agentExecution = {
      findUnique: vi.fn(async () => reads.shift() ?? second),
      create: vi.fn(),
      updateMany: vi.fn()
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 }),
    };
    const auditLog = { create: vi.fn() };
    const result = await recordExecutionReport(
      { agentExecution, auditLog },
      reportInput({ revision: 6, summary: "progress" }),
      { now: NOW },
    );
    expect(result.outcome.status).toBe("updated");
    expect(agentExecution.updateMany).toHaveBeenCalledTimes(2);
    expect(auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("re-reads and re-decides after a create P2002 race: identical terminal replay wins as duplicate", async () => {
    const winner = existingRow({
      executionState: "SUCCEEDED",
      endedAt: NOW,
      lastObservedAt: NOW,
      revision: 1,
    });
    const agentExecution = {
      findUnique: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner),
      create: vi.fn(async () => {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }),
      updateMany: vi.fn(),
    };
    const auditLog = { create: vi.fn() };
    const result = await recordExecutionReport(
      { agentExecution, auditLog },
      reportInput({ executionState: "SUCCEEDED", revision: 1 }),
      { now: NOW },
    );
    expect(result.outcome.status).toBe("duplicate");
    expect(result.execution).toBe(winner);
    expect(agentExecution.updateMany).not.toHaveBeenCalled();
  });

  it("re-reads and re-decides after a create P2002 race: the winner's row fences as execution_terminal", async () => {
    const winner = existingRow({
      executionState: "CANCELLED",
      endedAt: NOW,
      revision: 9,
    });
    const agentExecution = {
      findUnique: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner),
      create: vi.fn(async () => {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }),
      updateMany: vi.fn(),
    };
    const auditLog = { create: vi.fn() };
    await expect(
      recordExecutionReport(
        { agentExecution, auditLog },
        reportInput({ revision: 1 }),
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "execution_terminal" });
  });

  it("does not swallow a non-P2002 create failure", async () => {
    const agentExecution = {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => {
        throw new Error("db connection lost");
      }),
      updateMany: vi.fn(),
    };
    const auditLog = { create: vi.fn() };
    await expect(
      recordExecutionReport({ agentExecution, auditLog }, reportInput(), { now: NOW }),
    ).rejects.toThrow("db connection lost");
    expect(agentExecution.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("listActiveExecutions", () => {
  function makeListDeps(rows: ExistingExecutionRow[]) {
    const findMany = vi.fn(
      async (_args: { where: Record<string, unknown>; orderBy: Record<string, string>; take: number }) => rows,
    );
    return { deps: { agentExecution: { findMany } }, findMany };
  }

  it("filters terminal rows older than the recent-terminal window via the query", async () => {
    const { deps, findMany } = makeListDeps([]);
    await listActiveExecutions(deps, NOW);
    const args = findMany.mock.calls[0][0];
    expect(args.where.OR).toEqual([
      { executionState: { notIn: ["SUCCEEDED", "FAILED", "CANCELLED"] } },
      { lastObservedAt: { gte: new Date(NOW.getTime() - AGENT_EXECUTION_RECENT_TERMINAL_MS) } },
    ]);
    expect(args.orderBy).toEqual({ lastObservedAt: "desc" });
  });

  it("bounds the list at the display cap", async () => {
    const { deps, findMany } = makeListDeps([]);
    await listActiveExecutions(deps, NOW);
    expect(findMany.mock.calls[0][0].take).toBe(AGENT_EXECUTION_LIST_LIMIT);
  });

  it("annotates staleness for live and stale rows", async () => {
    const rows = [
      existingRow({ id: "live", executionId: "live", lastObservedAt: new Date(NOW.getTime() - 60_000) }),
      existingRow({ id: "stale", executionId: "stale", lastObservedAt: new Date(NOW.getTime() - AGENT_EXECUTION_LIVENESS_MS - 60_000) }),
    ];
    const { deps } = makeListDeps(rows);
    const result = await listActiveExecutions(deps, NOW);
    expect(result.map((r) => r.staleness)).toEqual(["live", "stale"]);
  });

  it("includes a recently-terminal row annotated live", async () => {
    const ended = new Date(NOW.getTime() - 30_000);
    const { deps } = makeListDeps([
      existingRow({ id: "done", executionId: "done", executionState: "SUCCEEDED", endedAt: ended, lastObservedAt: ended }),
    ]);
    const result = await listActiveExecutions(deps, NOW);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ executionState: "SUCCEEDED", staleness: "live" });
  });
});
