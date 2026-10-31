import { describe, expect, it, vi, afterEach } from "vitest";
import {
  AGENT_EXECUTION_LIVENESS_MS,
  AGENT_EXECUTION_LIST_LIMIT,
  AGENT_EXECUTION_RECENT_TERMINAL_MS,
  AGENT_EXECUTION_STATES,
  AGENT_EXECUTION_WORK_TYPES,
  AgentExecutionDeps,
  AgentExecutionError,
  DEFAULT_AGENT_EXECUTION_RETENTION_MS,
  TERMINAL_AGENT_EXECUTION_STATES,
  applyExecutionObservation,
  deriveExecutionStaleness,
  getAgentExecutionRetentionMs,
  listActiveExecutions,
  pruneTerminalExecutions,
  reportExecutionObservation,
  resolveObservedAt,
  validateExecutionObservation,
  type ExecutionObservationInput,
  type ExistingExecutionRow,
} from "./agent-executions";

const NOW = new Date("2026-10-30T12:00:00.000Z");

/** An EXACT Courier (#637) wire body. */
function wireBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    idempotencyKey: "execution/run-abc/running/1793000000000",
    agent: "saffron",
    source: "courier-harness",
    run: { uid: "run-abc", namespace: "courier", name: "run-1" },
    work: { itemId: "issue-42", identity: "issue-42", mode: "resolve-issue", type: "implement" },
    state: "running",
    observedAt: "2026-10-30T11:59:00.000Z",
    ...overrides,
  };
}

function observationInput(overrides: Record<string, unknown> = {}): ExecutionObservationInput {
  return validateExecutionObservation(wireBody(overrides));
}

function existingRow(overrides: Partial<ExistingExecutionRow> = {}): ExistingExecutionRow {
  return {
    id: "exec-1",
    agentName: "saffron",
    source: "courier-harness",
    executionId: "run-abc",
    workType: "implement",
    workRefUrl: null,
    workItemId: "issue-42",
    workIdentity: "issue-42",
    mode: "resolve-issue",
    runNamespace: "courier",
    runName: "run-1",
    pullRequestNumber: null,
    executionState: "RUNNING",
    startedAt: new Date("2026-10-30T11:00:00.000Z"),
    lastObservedAt: new Date("2026-10-30T11:59:00.000Z"),
    endedAt: null,
    summary: null,
    idempotencyKey: "execution/run-abc/running/1793000000000",
    ...overrides,
  };
}

function expectInvalidReport(fn: () => unknown, pattern: RegExp) {
  try {
    fn();
    throw new Error("should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentExecutionError);
    expect((error as AgentExecutionError).code).toBe("invalid_report");
    expect((error as AgentExecutionError).status).toBe(400);
    expect((error as AgentExecutionError).message).toMatch(pattern);
  }
}

// ---------------------------------------------------------------------------
// Vocabularies and constants
// ---------------------------------------------------------------------------

describe("vocabularies and constants", () => {
  it("exposes the full 8-state vocabulary (Courier wire mapped to stored uppercase)", () => {
    expect(AGENT_EXECUTION_STATES).toEqual([
      "RUNNING",
      "VERIFYING",
      "AWAITING_REVIEW",
      "SUCCEEDED",
      "FAILED",
      "BLOCKED",
      "BLOCKED_EXTERNAL",
      "HANDED_OFF",
    ]);
  });

  it("derives the terminal-state fence set (state-kind fencing)", () => {
    expect(TERMINAL_AGENT_EXECUTION_STATES).toEqual([
      "SUCCEEDED",
      "FAILED",
      "BLOCKED",
      "BLOCKED_EXTERNAL",
      "HANDED_OFF",
    ]);
  });

  it("exposes the work-type vocabulary (pr_fix kept as legacy-accepted)", () => {
    expect(AGENT_EXECUTION_WORK_TYPES).toEqual(["implement", "pr_fix", "followup-pr"]);
  });

  it("uses the settled liveness windows", () => {
    expect(AGENT_EXECUTION_LIVENESS_MS).toBe(15 * 60_000);
    expect(AGENT_EXECUTION_RECENT_TERMINAL_MS).toBe(24 * 60 * 60_000);
    expect(AGENT_EXECUTION_LIST_LIMIT).toBe(200);
  });

  it("derives staleness from the last observation (informational only)", () => {
    expect(deriveExecutionStaleness(new Date(NOW.getTime() - 1), NOW)).toBe("live");
    expect(deriveExecutionStaleness(new Date(NOW.getTime() - AGENT_EXECUTION_LIVENESS_MS), NOW)).toBe("live");
    expect(
      deriveExecutionStaleness(new Date(NOW.getTime() - AGENT_EXECUTION_LIVENESS_MS - 1), NOW),
    ).toBe("stale");
  });
});

// ---------------------------------------------------------------------------
// Validation (Courier wire contract)
// ---------------------------------------------------------------------------

describe("validateExecutionObservation", () => {
  it("validates and normalizes an EXACT Courier wire body (contract guard)", () => {
    expect(validateExecutionObservation(wireBody())).toEqual({
      agentName: "saffron",
      idempotencyKey: "execution/run-abc/running/1793000000000",
      source: "courier-harness",
      runUid: "run-abc",
      runNamespace: "courier",
      runName: "run-1",
      workItemId: "issue-42",
      workIdentity: "issue-42",
      workMode: "resolve-issue",
      workType: "implement",
      executionState: "RUNNING",
      observedAt: "2026-10-30T11:59:00.000Z",
      pullRequestNumber: null,
      pullRequestUrl: null,
    } satisfies ExecutionObservationInput);
  });

  it("maps every Courier wire state to the stored uppercase vocabulary", () => {
    const expected: Record<string, string> = {
      running: "RUNNING",
      verifying: "VERIFYING",
      "awaiting-review": "AWAITING_REVIEW",
      succeeded: "SUCCEEDED",
      failed: "FAILED",
      blocked: "BLOCKED",
      "blocked-external": "BLOCKED_EXTERNAL",
      "handed-off": "HANDED_OFF",
    };
    for (const [wire, stored] of Object.entries(expected)) {
      expect(validateExecutionObservation(wireBody({ state: wire })).executionState).toBe(stored);
    }
  });

  it("rejects version !== 1", () => {
    expectInvalidReport(() => validateExecutionObservation(wireBody({ version: 2 })), /version/);
    expectInvalidReport(() => validateExecutionObservation(wireBody({ version: "1" })), /version/);
    const { version: _omitted, ...noVersion } = wireBody();
    expectInvalidReport(() => validateExecutionObservation(noVersion), /version/);
  });

  it("rejects missing/blank required fields", () => {
    expectInvalidReport(() => validateExecutionObservation(wireBody({ agent: "" })), /agent/);
    expectInvalidReport(() => validateExecutionObservation(wireBody({ agent: undefined })), /agent/);
    expectInvalidReport(() => validateExecutionObservation(wireBody({ source: "  " })), /source/);
    expectInvalidReport(
      () => validateExecutionObservation(wireBody({ idempotencyKey: "" })),
      /idempotencyKey/,
    );
    expectInvalidReport(
      () => validateExecutionObservation(wireBody({ run: { namespace: "n" } })),
      /run\.uid/,
    );
    expectInvalidReport(
      () => validateExecutionObservation(wireBody({ work: { identity: "i" } })),
      /work\.itemId/,
    );
    expectInvalidReport(() => validateExecutionObservation(wireBody({ state: undefined })), /state/);
    expectInvalidReport(
      () => validateExecutionObservation(wireBody({ observedAt: undefined })),
      /observedAt/,
    );
  });

  it("rejects a non-object body, run, or work", () => {
    expectInvalidReport(() => validateExecutionObservation(null), /JSON object/);
    expectInvalidReport(() => validateExecutionObservation([wireBody()]), /JSON object/);
    expectInvalidReport(() => validateExecutionObservation(wireBody({ run: "run-abc" })), /run/);
    expectInvalidReport(() => validateExecutionObservation(wireBody({ work: 7 })), /work/);
  });

  it("rejects an unknown wire state", () => {
    expectInvalidReport(() => validateExecutionObservation(wireBody({ state: "PAUSED" })), /state/);
    expectInvalidReport(() => validateExecutionObservation(wireBody({ state: "RUNNING" })), /state/);
  });

  it("rejects an invalid work.type but accepts implement/pr_fix/followup-pr and a missing type", () => {
    expectInvalidReport(
      () => validateExecutionObservation(wireBody({ work: { itemId: "i", mode: "m", type: "deploy" } })),
      /work\.type/,
    );
    expect(
      validateExecutionObservation(wireBody({ work: { itemId: "i", mode: "m", type: "followup-pr" } }))
        .workType,
    ).toBe("followup-pr");
    expect(
      validateExecutionObservation(wireBody({ work: { itemId: "i", mode: "m", type: "pr_fix" } })).workType,
    ).toBe("pr_fix");
    // Mode-only case: no `type` present.
    const modeOnly = validateExecutionObservation(wireBody({ work: { itemId: "i", mode: "resolve-issue" } }));
    expect(modeOnly.workType).toBeNull();
    expect(modeOnly.workMode).toBe("resolve-issue");
  });

  it("rejects a non-http(s) pullRequestUrl and a non-positive pullRequestNumber", () => {
    expectInvalidReport(
      () => validateExecutionObservation(wireBody({ pullRequestUrl: "repo:org/repo#42" })),
      /pullRequestUrl/,
    );
    expectInvalidReport(
      () => validateExecutionObservation(wireBody({ pullRequestNumber: 0 })),
      /pullRequestNumber/,
    );
    expectInvalidReport(
      () => validateExecutionObservation(wireBody({ pullRequestNumber: -1 })),
      /pullRequestNumber/,
    );
    expectInvalidReport(
      () => validateExecutionObservation(wireBody({ pullRequestNumber: 1.5 })),
      /pullRequestNumber/,
    );
    expect(
      validateExecutionObservation(wireBody({ pullRequestNumber: 42 })).pullRequestNumber,
    ).toBe(42);
  });

  it("rejects an unparseable observedAt", () => {
    expectInvalidReport(
      () => validateExecutionObservation(wireBody({ observedAt: "nope" })),
      /observedAt/,
    );
  });

  it("enforces the documented length bounds", () => {
    expectInvalidReport(() => validateExecutionObservation(wireBody({ agent: "a".repeat(101) })), /agent/);
    expect(
      validateExecutionObservation(wireBody({ agent: "a".repeat(100) })).agentName,
    ).toBe("a".repeat(100));
    expectInvalidReport(
      () => validateExecutionObservation(wireBody({ idempotencyKey: "k".repeat(301) })),
      /idempotencyKey/,
    );
    expectInvalidReport(() => validateExecutionObservation(wireBody({ source: "s".repeat(201) })), /source/);
    expectInvalidReport(
      () => validateExecutionObservation(wireBody({ run: { uid: "u".repeat(201) } })),
      /run\.uid/,
    );
    expectInvalidReport(
      () => validateExecutionObservation(wireBody({ run: { uid: "u", namespace: "n".repeat(201) } })),
      /run\.namespace/,
    );
    expectInvalidReport(
      () => validateExecutionObservation(wireBody({ run: { uid: "u", name: "n".repeat(201) } })),
      /run\.name/,
    );
    expectInvalidReport(
      () => validateExecutionObservation(wireBody({ work: { itemId: "i".repeat(201) } })),
      /work\.itemId/,
    );
    expectInvalidReport(
      () => validateExecutionObservation(wireBody({ work: { itemId: "i", identity: "d".repeat(301) } })),
      /work\.identity/,
    );
    expectInvalidReport(
      () => validateExecutionObservation(wireBody({ work: { itemId: "i", mode: "m".repeat(101) } })),
      /work\.mode/,
    );
    expectInvalidReport(
      () => validateExecutionObservation(wireBody({ pullRequestUrl: `https://x.test/${"p".repeat(2000)}` })),
      /pullRequestUrl/,
    );
  });
});

// ---------------------------------------------------------------------------
// observedAt resolution
// ---------------------------------------------------------------------------

describe("resolveObservedAt", () => {
  it("accepts a parseable past timestamp", () => {
    expect(resolveObservedAt("2026-10-30T11:59:00.000Z", NOW)).toEqual(
      new Date("2026-10-30T11:59:00.000Z"),
    );
  });

  it("clamps a future timestamp to now", () => {
    expect(resolveObservedAt("2026-10-30T12:00:01.000Z", NOW)).toEqual(NOW);
  });

  it("falls back to now for unparseable/missing values", () => {
    expect(resolveObservedAt("nope", NOW)).toEqual(NOW);
    expect(resolveObservedAt(null, NOW)).toEqual(NOW);
    expect(resolveObservedAt(undefined, NOW)).toEqual(NOW);
  });
});

// ---------------------------------------------------------------------------
// Upsert decision
// ---------------------------------------------------------------------------

describe("applyExecutionObservation", () => {
  it("creates when no row exists (non-terminal: endedAt null)", () => {
    const decision = applyExecutionObservation(observationInput(), null, NOW);
    expect(decision.status).toBe("created");
    expect(decision.data).toMatchObject({
      agentName: "saffron",
      executionId: "run-abc",
      executionState: "RUNNING",
      startedAt: new Date("2026-10-30T11:59:00.000Z"),
      lastObservedAt: new Date("2026-10-30T11:59:00.000Z"),
      endedAt: null,
      summary: null,
      idempotencyKey: "execution/run-abc/running/1793000000000",
      workItemId: "issue-42",
      workIdentity: "issue-42",
      mode: "resolve-issue",
      workType: "implement",
      runNamespace: "courier",
      runName: "run-1",
      pullRequestNumber: null,
    });
  });

  it("creates terminal-first with endedAt = observedAt", () => {
    const decision = applyExecutionObservation(
      observationInput({ state: "succeeded", idempotencyKey: "execution/run-abc/succeeded/1793000000000" }),
      null,
      NOW,
    );
    expect(decision.status).toBe("created");
    expect(decision.data?.endedAt).toEqual(new Date("2026-10-30T11:59:00.000Z"));
    expect(decision.data?.startedAt).toEqual(new Date("2026-10-30T11:59:00.000Z"));
  });

  it("carries the wire pullRequestUrl into workRefUrl and pullRequestNumber", () => {
    const decision = applyExecutionObservation(
      observationInput({
        pullRequestNumber: 1495,
        pullRequestUrl: "https://github.com/org/repo/pull/1495",
      }),
      null,
      NOW,
    );
    expect(decision.data).toMatchObject({
      workRefUrl: "https://github.com/org/repo/pull/1495",
      pullRequestNumber: 1495,
    });
  });

  it("treats a byte-identical delivery (same idempotencyKey) as duplicate without mutation", () => {
    const decision = applyExecutionObservation(observationInput(), existingRow(), NOW);
    expect(decision.status).toBe("duplicate");
    expect(decision.data).toBeUndefined();
  });

  it("replays an identical terminal delivery as duplicate — the idempotencyKey check comes BEFORE the terminal fence", () => {
    const endedAt = new Date("2026-10-30T11:59:30.000Z");
    const terminal = existingRow({
      executionState: "SUCCEEDED",
      endedAt,
      lastObservedAt: endedAt,
      idempotencyKey: "execution/run-abc/succeeded/1793000100000",
    });
    const decision = applyExecutionObservation(
      observationInput({ state: "succeeded", idempotencyKey: "execution/run-abc/succeeded/1793000100000" }),
      terminal,
      NOW,
    );
    expect(decision.status).toBe("duplicate");
    expect(decision.data).toBeUndefined();
  });

  it("fences a non-terminal observation against a terminal row as execution_terminal (409)", () => {
    const terminal = existingRow({
      executionState: "FAILED",
      endedAt: new Date("2026-10-30T11:59:30.000Z"),
      idempotencyKey: "execution/run-abc/failed/1793000100000",
    });
    try {
      applyExecutionObservation(
        observationInput({ idempotencyKey: "execution/run-abc/running/1793000200000" }),
        terminal,
        NOW,
      );
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentExecutionError);
      expect((error as AgentExecutionError).code).toBe("execution_terminal");
      expect((error as AgentExecutionError).status).toBe(409);
    }
  });

  it("accepts terminal → terminal refinement, keeping the original endedAt and startedAt", () => {
    const startedAt = new Date("2026-10-30T11:00:00.000Z");
    const endedAt = new Date("2026-10-30T11:59:30.000Z");
    const terminal = existingRow({
      executionState: "SUCCEEDED",
      startedAt,
      lastObservedAt: endedAt,
      endedAt,
      idempotencyKey: "execution/run-abc/succeeded/1793000100000",
    });
    const decision = applyExecutionObservation(
      observationInput({
        state: "failed",
        idempotencyKey: "execution/run-abc/failed/1793000200000",
        observedAt: "2026-10-30T11:59:45.000Z",
      }),
      terminal,
      NOW,
    );
    expect(decision.status).toBe("updated");
    expect(decision.data).toMatchObject({
      executionState: "FAILED",
      lastObservedAt: new Date("2026-10-30T11:59:45.000Z"),
      idempotencyKey: "execution/run-abc/failed/1793000200000",
      source: "courier-harness",
      workType: "implement",
    });
    // The first terminal observation stays the end time.
    expect(decision.data?.endedAt).toBeUndefined();
    expect(decision.data?.startedAt).toBeUndefined();
  });

  it("applies a newer non-terminal observation on a non-terminal row (no endedAt)", () => {
    const decision = applyExecutionObservation(
      observationInput({
        state: "verifying",
        idempotencyKey: "execution/run-abc/verifying/1793000060000",
        observedAt: "2026-10-30T11:59:30.000Z",
      }),
      existingRow({ lastObservedAt: new Date("2026-10-30T11:59:00.000Z") }),
      NOW,
    );
    expect(decision.status).toBe("updated");
    expect(decision.data).toMatchObject({
      executionState: "VERIFYING",
      lastObservedAt: new Date("2026-10-30T11:59:30.000Z"),
      endedAt: null,
      idempotencyKey: "execution/run-abc/verifying/1793000060000",
    });
  });

  it("applies a terminal transition on a non-terminal row with endedAt = observedAt", () => {
    const decision = applyExecutionObservation(
      observationInput({
        state: "handed-off",
        idempotencyKey: "execution/run-abc/handed-off/1793000060000",
        observedAt: "2026-10-30T11:59:30.000Z",
      }),
      existingRow({ lastObservedAt: new Date("2026-10-30T11:59:00.000Z") }),
      NOW,
    );
    expect(decision.status).toBe("updated");
    expect(decision.data).toMatchObject({
      executionState: "HANDED_OFF",
      endedAt: new Date("2026-10-30T11:59:30.000Z"),
    });
  });

  it("applies an OLDER-dated terminal delivery on a non-terminal row (state kind fences, not the clock)", () => {
    const decision = applyExecutionObservation(
      observationInput({
        state: "failed",
        idempotencyKey: "execution/run-abc/failed/1792900000000",
        observedAt: "2026-10-30T08:00:00.000Z",
      }),
      existingRow({ lastObservedAt: new Date("2026-10-30T11:59:00.000Z") }),
      NOW,
    );
    expect(decision.status).toBe("updated");
    expect(decision.data).toMatchObject({
      executionState: "FAILED",
      // endedAt is the terminal observation's own time; lastObservedAt never
      // regresses (staleness display stays monotonic).
      endedAt: new Date("2026-10-30T08:00:00.000Z"),
      lastObservedAt: new Date("2026-10-30T11:59:00.000Z"),
    });
  });

  it("does not regress lastObservedAt on a terminal → terminal refinement with an older-dated delivery", () => {
    const endedAt = new Date("2026-10-30T11:59:30.000Z");
    const terminal = existingRow({
      executionState: "FAILED",
      lastObservedAt: endedAt,
      endedAt,
      idempotencyKey: "execution/run-abc/failed/1793000100000",
    });
    const decision = applyExecutionObservation(
      observationInput({
        state: "failed",
        idempotencyKey: "execution/run-abc/failed/1792900000000",
        observedAt: "2026-10-30T08:00:00.000Z",
      }),
      terminal,
      NOW,
    );
    expect(decision.status).toBe("updated");
    expect(decision.data?.lastObservedAt).toEqual(endedAt);
  });

  it("applies an EQUAL observedAt non-terminal observation (>= ordering)", () => {
    const same = "2026-10-30T11:59:00.000Z";
    const decision = applyExecutionObservation(
      observationInput({
        state: "awaiting-review",
        idempotencyKey: "execution/run-abc/awaiting-review/1793000000000",
        observedAt: same,
      }),
      existingRow({ lastObservedAt: new Date(same) }),
      NOW,
    );
    expect(decision.status).toBe("updated");
    expect(decision.data?.executionState).toBe("AWAITING_REVIEW");
  });  it("acknowledges an older non-terminal delivery as staleIgnored with NO mutation", () => {
    const decision = applyExecutionObservation(
      observationInput({
        idempotencyKey: "execution/run-abc/running/1792990000000",
        observedAt: "2026-10-30T09:00:00.000Z",
      }),
      existingRow({ lastObservedAt: new Date("2026-10-30T11:59:00.000Z") }),
      NOW,
    );
    expect(decision.status).toBe("staleIgnored");
    expect(decision.data).toBeUndefined();
  });

  it("clamps a future observedAt to now before ordering", () => {
    const decision = applyExecutionObservation(
      observationInput({
        observedAt: "2026-10-30T13:00:00.000Z",
        idempotencyKey: "execution/run-abc/verifying/1793000000000",
      }),
      existingRow({ lastObservedAt: new Date("2026-10-30T11:59:00.000Z") }),
      NOW,
    );
    expect(decision.status).toBe("updated");
    expect(decision.data?.lastObservedAt).toEqual(NOW);
  });
});

// ---------------------------------------------------------------------------
// Race-safe application (injected deps)
// ---------------------------------------------------------------------------

function makeDeps(overrides: {
  findUnique?: AgentExecutionDeps["agentExecution"]["findUnique"];
  create?: AgentExecutionDeps["agentExecution"]["create"];
  updateMany?: AgentExecutionDeps["agentExecution"]["updateMany"];
  auditCreate?: AgentExecutionDeps["auditLog"]["create"];
} = {}) {
  const findUnique = overrides.findUnique ?? vi.fn(async () => null);
  const create =
    overrides.create ??
    vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-1", ...data }));
  const updateMany = overrides.updateMany ?? vi.fn(async () => ({ count: 1 }));
  const auditCreate = overrides.auditCreate ?? vi.fn(async () => ({}));
  return {
    deps: {
      agentExecution: { findUnique, create, updateMany },
      auditLog: { create: auditCreate },
    },
    mocks: { findUnique, create, updateMany, auditCreate },
  };
}

describe("reportExecutionObservation", () => {
  it("creates a row and writes the best-effort audit", async () => {
    const { deps, mocks } = makeDeps();
    const result = await reportExecutionObservation(deps, observationInput(), { actor: "saffron", now: NOW });
    expect(result.outcome.status).toBe("created");
    expect(mocks.create).toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "agent_execution_report", actor: "saffron" }),
      }),
    );
  });

  it("replays a duplicate without writing or auditing", async () => {
    const { deps, mocks } = makeDeps({ findUnique: vi.fn(async () => existingRow()) });
    const result = await reportExecutionObservation(deps, observationInput(), { now: NOW });
    expect(result.outcome.status).toBe("duplicate");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("acknowledges a stale observation without writing or auditing", async () => {
    const { deps, mocks } = makeDeps({ findUnique: vi.fn(async () => existingRow()) });
    const result = await reportExecutionObservation(
      deps,
      observationInput({ observedAt: "2026-10-30T09:00:00.000Z", idempotencyKey: "execution/run-abc/running/1792990000000" }),
      { now: NOW },
    );
    expect(result.outcome.status).toBe("staleIgnored");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("updates via a conditional updateMany fenced on the idempotency key", async () => {
    const existing = existingRow();
    const { deps, mocks } = makeDeps({ findUnique: vi.fn(async () => existing) });
    const result = await reportExecutionObservation(
      deps,
      observationInput({
        state: "verifying",
        idempotencyKey: "execution/run-abc/verifying/1793000060000",
        observedAt: "2026-10-30T12:01:00.000Z",
      }),
      { now: NOW },
    );
    expect(result.outcome.status).toBe("updated");
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "exec-1", idempotencyKey: existing.idempotencyKey },
      data: expect.objectContaining({ executionState: "VERIFYING" }),
    });
    expect(mocks.auditCreate).toHaveBeenCalled();
  });

  it("re-reads and re-decides when the fenced update loses the race (count 0)", async () => {
    const loser = existingRow();
    const winner = existingRow({
      executionState: "FAILED",
      endedAt: NOW,
      idempotencyKey: "execution/run-abc/failed/1793000100000",
    });
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(loser)
      .mockResolvedValueOnce(winner);
    // Second decision: identical terminal delivery to the winner → duplicate.
    const { deps, mocks } = makeDeps({ findUnique, updateMany: vi.fn(async () => ({ count: 0 })) });
    const result = await reportExecutionObservation(
      deps,
      observationInput({ state: "failed", idempotencyKey: "execution/run-abc/failed/1793000100000" }),
      { now: NOW },
    );
    expect(result.outcome.status).toBe("duplicate");
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("surfaces stale_report (409) after the bounded retry budget is exhausted", async () => {
    const existing = existingRow();
    const { deps, mocks } = makeDeps({
      findUnique: vi.fn(async () => existing),
      updateMany: vi.fn(async () => ({ count: 0 })),
    });
    try {
      await reportExecutionObservation(
        deps,
        observationInput({
          state: "verifying",
          idempotencyKey: "execution/run-abc/verifying/1793000060000",
          observedAt: "2026-10-30T12:01:00.000Z",
        }),
        { now: NOW },
      );
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentExecutionError);
      expect((error as AgentExecutionError).code).toBe("stale_report");
      expect((error as AgentExecutionError).status).toBe(409);
    }
    expect(mocks.updateMany).toHaveBeenCalledTimes(3);
  });

  it("re-reads and re-decides when the create loses the unique-constraint race (P2002)", async () => {
    const winner = existingRow({
      executionState: "FAILED",
      endedAt: NOW,
      idempotencyKey: "execution/run-abc/failed/1793000100000",
    });
    const create = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }))
      .mockRejectedValueOnce(new Error("should not create again"));
    const { deps, mocks } = makeDeps({
      create,
      findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(winner),
    });
    const result = await reportExecutionObservation(
      deps,
      observationInput({ state: "failed", idempotencyKey: "execution/run-abc/failed/1793000100000" }),
      { now: NOW },
    );
    expect(result.outcome.status).toBe("duplicate");
    expect(create).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("bubbles a genuine database error", async () => {
    const { deps } = makeDeps({ create: vi.fn(async () => { throw new Error("db connection lost"); }) });
    await expect(
      reportExecutionObservation(deps, observationInput(), { now: NOW }),
    ).rejects.toThrow("db connection lost");
  });

  it("propagates the terminal fence (execution_terminal) through the write path", async () => {
    const { deps } = makeDeps({
      findUnique: vi.fn(async () =>
        existingRow({
          executionState: "HANDED_OFF",
          endedAt: NOW,
          idempotencyKey: "execution/run-abc/handed-off/1793000100000",
        }),
      ),
    });
    await expect(
      reportExecutionObservation(
        deps,
        observationInput({ idempotencyKey: "execution/run-abc/running/1793000200000" }),
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "execution_terminal", status: 409 });
  });
});

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

describe("listActiveExecutions", () => {
  function makeListDeps(rows: ExistingExecutionRow[]) {
    const findMany = vi.fn(
      async (_args: { where: Record<string, unknown>; orderBy: Record<string, string>; take: number }) => rows,
    );
    return { deps: { agentExecution: { findMany } }, findMany };
  }

  it("lists non-terminal rows of any age plus recent terminal rows, newest first, capped", async () => {
    const { deps, findMany } = makeListDeps([]);
    await listActiveExecutions(deps, NOW);
    const args = findMany.mock.calls[0][0];
    expect(args.where.OR).toEqual([
      {
        executionState: {
          notIn: ["SUCCEEDED", "FAILED", "BLOCKED", "BLOCKED_EXTERNAL", "HANDED_OFF"],
        },
      },
      { lastObservedAt: { gte: new Date(NOW.getTime() - AGENT_EXECUTION_RECENT_TERMINAL_MS) } },
    ]);
    expect(args.orderBy).toEqual({ lastObservedAt: "desc" });
    expect(args.take).toBe(AGENT_EXECUTION_LIST_LIMIT);
  });

  it("annotates each row with display staleness", async () => {
    const rows = [
      existingRow({ id: "recent", lastObservedAt: new Date(NOW.getTime() - 1_000) }),
      existingRow({ id: "aged", lastObservedAt: new Date(NOW.getTime() - AGENT_EXECUTION_LIVENESS_MS - 1) }),
    ];
    const { deps } = makeListDeps(rows);
    const result = await listActiveExecutions(deps, NOW);
    expect(result.map((r) => [r.id, r.staleness])).toEqual([
      ["recent", "live"],
      ["aged", "stale"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Retention prune (#1499)
// ---------------------------------------------------------------------------

describe("getAgentExecutionRetentionMs", () => {
  const original = process.env.DISPATCH_AGENT_EXECUTION_RETENTION_MS;

  afterEach(() => {
    if (original === undefined) delete process.env.DISPATCH_AGENT_EXECUTION_RETENTION_MS;
    else process.env.DISPATCH_AGENT_EXECUTION_RETENTION_MS = original;
  });

  it("defaults to 7d — well past the 24h recent-terminal display window", () => {
    expect(DEFAULT_AGENT_EXECUTION_RETENTION_MS).toBe(7 * 24 * 60 * 60_000);
    delete process.env.DISPATCH_AGENT_EXECUTION_RETENTION_MS;
    expect(getAgentExecutionRetentionMs()).toBe(7 * 24 * 60 * 60_000);
  });

  it("honors DISPATCH_AGENT_EXECUTION_RETENTION_MS inside the clamp range", () => {
    process.env.DISPATCH_AGENT_EXECUTION_RETENTION_MS = String(24 * 60 * 60_000);
    expect(getAgentExecutionRetentionMs()).toBe(24 * 60 * 60_000);
  });

  it("clamps 1h–90d and falls back to the default on garbage", () => {
    process.env.DISPATCH_AGENT_EXECUTION_RETENTION_MS = "1";
    expect(getAgentExecutionRetentionMs()).toBe(60 * 60_000);
    process.env.DISPATCH_AGENT_EXECUTION_RETENTION_MS = String(365 * 24 * 60 * 60_000);
    expect(getAgentExecutionRetentionMs()).toBe(90 * 24 * 60 * 60_000);
    process.env.DISPATCH_AGENT_EXECUTION_RETENTION_MS = "7d";
    expect(getAgentExecutionRetentionMs()).toBe(7 * 24 * 60 * 60_000);
  });
});

describe("pruneTerminalExecutions", () => {
  function makePruneDeps(count = 3) {
    const deleteMany = vi.fn(async (_args: { where: Record<string, unknown> }) => ({ count }));
    return { deps: { agentExecution: { deleteMany } }, deleteMany };
  }

  it("fences the delete on the terminal state set and the retention cutoff", async () => {
    const { deps, deleteMany } = makePruneDeps(0);
    const result = await pruneTerminalExecutions(deps, { now: NOW, retentionMs: 24 * 60 * 60_000 });
    expect(result.prunedCount).toBe(0);
    expect(result.cutoff).toEqual(new Date(NOW.getTime() - 24 * 60 * 60_000));
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        executionState: { in: ["SUCCEEDED", "FAILED", "BLOCKED", "BLOCKED_EXTERNAL", "HANDED_OFF"] },
        lastObservedAt: { lt: new Date(NOW.getTime() - 24 * 60 * 60_000) },
      },
    });
  });

  it("defaults the retention to the env-derived window and now to the clock", async () => {
    const { deps, deleteMany } = makePruneDeps(5);
    const result = await pruneTerminalExecutions(deps);
    expect(result.prunedCount).toBe(5);
    const where = deleteMany.mock.calls[0][0].where as {
      executionState: { in: string[] };
      lastObservedAt: { lt: Date };
    };
    expect(where.executionState.in).toEqual([...TERMINAL_AGENT_EXECUTION_STATES]);
    // now is the real clock; cutoff must be exactly retention behind it.
    expect(Date.now() - where.lastObservedAt.lt.getTime()).toBeGreaterThanOrEqual(
      DEFAULT_AGENT_EXECUTION_RETENTION_MS,
    );
  });

  it("returns the deleted count from the injected surface", async () => {
    const { deps } = makePruneDeps(42);
    const result = await pruneTerminalExecutions(deps, { now: NOW, retentionMs: 60_000 });
    expect(result.prunedCount).toBe(42);
  });
});
