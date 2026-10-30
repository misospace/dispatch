import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

const { BOUND_SAFFRON_TOKEN, BOUND_KNOCK_TOKEN, UNBOUND_WORKER_TOKEN } = vi.hoisted(() => ({
  BOUND_SAFFRON_TOKEN: "worker-saffron-token",
  BOUND_KNOCK_TOKEN: "worker-knock-token",
  UNBOUND_WORKER_TOKEN: "unbound-worker-token",
}));

vi.mock("@/lib/dispatch-env", () =>
  makeDispatchEnvMock(mockToken, {
    // Legacy UNBOUND worker token (no agent binding).
    "unbound-worker-token": "worker",
  }, {
    // BOUND worker credentials via DISPATCH_WORKER_TOKENS-style bindings.
    "worker-saffron-token": "saffron",
    "worker-knock-token": "knock",
  }),
);

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    findMany: vi.fn().mockResolvedValue([]),
    auditCreate: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    agentExecution: {
      findUnique: mocks.findUnique,
      create: mocks.create,
      updateMany: mocks.updateMany,
      findMany: mocks.findMany,
    },
    auditLog: {
      create: mocks.auditCreate,
    },
  },
}));

import { GET, POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";

const OBSERVATIONS_URL = "http://localhost/api/agent-work/observations";

function postRequest(body: unknown, token = mockToken) {
  return POST(authedRequest(OBSERVATIONS_URL, { method: "POST", body, token }));
}

function getRequest(token = mockToken) {
  return GET(authedRequest(OBSERVATIONS_URL, { token }));
}

/**
 * An EXACT Courier (#637) wire body — the contract-guard shape. Everything
 * is exactly what the merged Go client posts.
 */
function courierBody(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    idempotencyKey: "execution/run-abc/running/1793000000000",
    agent: "saffron",
    source: "courier-harness",
    run: { uid: "run-abc", namespace: "courier", name: "run-1" },
    work: { itemId: "issue-42", identity: "issue-42", mode: "resolve-issue", type: "implement" },
    state: "running",
    observedAt: "2026-10-30T12:00:00.000Z",
    ...overrides,
  };
}

describe("GET /api/agent-work/observations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    resetAuthCaches();
    delete process.env.DISPATCH_AUTH_MODE;
    mocks.findMany.mockResolvedValue([]);
  });

  it("401s an unauthenticated request", async () => {
    const res = await GET(authedRequest(OBSERVATIONS_URL, { includeAuth: false }));
    expect(res.status).toBe(401);
  });

  it("403s a bound worker token (GET is maintainer-tier; the consumer is the operator Agents page)", async () => {
    const res = await getRequest(BOUND_SAFFRON_TOKEN);
    expect(res.status).toBe(403);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("403s the unbound legacy worker token on GET too", async () => {
    const res = await getRequest(UNBOUND_WORKER_TOKEN);
    expect(res.status).toBe(403);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("returns the executions list (no capability field) for a maintainer", async () => {
    mocks.findMany.mockResolvedValue([
      {
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
        lastObservedAt: new Date(Date.now() - 1_000),
        endedAt: null,
        summary: null,
        idempotencyKey: "execution/run-abc/running/1793000000000",
        createdAt: new Date("2026-10-30T11:00:00.000Z"),
        updatedAt: new Date("2026-10-30T11:00:00.000Z"),
      },
    ]);

    const res = await getRequest();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.capability).toBeUndefined();
    expect(Array.isArray(body.executions)).toBe(true);
    expect(body.executions[0]).toMatchObject({ id: "exec-1", staleness: "live" });
  });
});

describe("POST /api/agent-work/observations auth matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    resetAuthCaches();
    delete process.env.DISPATCH_AUTH_MODE;
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-1", ...data }));
  });

  it("401s an unauthenticated request", async () => {
    const res = await POST(
      authedRequest(OBSERVATIONS_URL, { method: "POST", body: courierBody(), includeAuth: false }),
    );
    expect(res.status).toBe(401);
  });

  it("accepts the EXACT Courier wire body from a maintainer (contract guard)", async () => {
    const res = await postRequest(courierBody(), mockToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, created: true });
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agentName: "saffron",
        executionId: "run-abc",
        executionState: "RUNNING",
        workItemId: "issue-42",
        mode: "resolve-issue",
        workType: "implement",
        idempotencyKey: "execution/run-abc/running/1793000000000",
      }),
    });
  });

  it("lets a maintainer report for any agent", async () => {
    const res = await postRequest(courierBody({ agent: "knock" }), mockToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, created: true });
    expect(mocks.create).toHaveBeenCalled();
  });

  it("lets a bound worker report for its own agent", async () => {
    const res = await postRequest(courierBody(), BOUND_SAFFRON_TOKEN);
    expect(res.status).toBe(200);
    expect(mocks.create).toHaveBeenCalled();
  });

  it("403s a bound worker reporting for another agent", async () => {
    const res = await postRequest(courierBody({ agent: "knock" }), BOUND_SAFFRON_TOKEN);
    expect(res.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("403s the unbound legacy worker token (no identity)", async () => {
    const res = await postRequest(courierBody(), UNBOUND_WORKER_TOKEN);
    expect(res.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/agent-work/observations validation and fencing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    resetAuthCaches();
    delete process.env.DISPATCH_AUTH_MODE;
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-1", ...data }));
  });

  it("returns 400 on invalid JSON body", async () => {
    const res = await POST(
      new Request(OBSERVATIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${mockToken}`, "Content-Type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 with the invalid_report code for validation failures", async () => {
    const res = await postRequest(courierBody({ state: "paused" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_report");
    expect(body.error).toMatch(/state/);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("returns 400 when version is not 1", async () => {
    const res = await postRequest(courierBody({ version: 2 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_report");
    expect(body.error).toMatch(/version/);
  });

  it("returns 400 for a non-http(s) pullRequestUrl", async () => {
    const res = await postRequest(courierBody({ pullRequestUrl: "repo:org/repo#42" }));
    expect(res.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("answers an idempotent replay with duplicate: true and no write", async () => {
    const key = "execution/run-abc/succeeded/1793000100000";
    mocks.findUnique.mockResolvedValue({
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
      executionState: "SUCCEEDED",
      startedAt: null,
      lastObservedAt: new Date(Date.now() - 5_000),
      endedAt: new Date(Date.now() - 5_000),
      summary: null,
      idempotencyKey: key,
    });
    const res = await postRequest(
      courierBody({
        state: "succeeded",
        idempotencyKey: key,
        observedAt: "2026-10-30T11:59:55.000Z",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, duplicate: true });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("answers a delayed older non-terminal delivery with staleIgnored: true and no write", async () => {
    mocks.findUnique.mockResolvedValue({
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
      executionState: "VERIFYING",
      startedAt: null,
      lastObservedAt: new Date("2026-10-30T12:00:30.000Z"),
      endedAt: null,
      summary: null,
      idempotencyKey: "execution/run-abc/verifying/1793000030000",
    });
    const res = await postRequest(
      courierBody({
        state: "running",
        idempotencyKey: "execution/run-abc/running/1792990000000",
        observedAt: "2026-10-30T09:13:20.000Z",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, staleIgnored: true });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("returns 409 execution_terminal for a non-terminal observation after a terminal one", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "exec-1",
      agentName: "saffron",
      source: "courier-harness",
      executionId: "run-abc",
      workType: "implement",
      workRefUrl: null,
      workItemId: "issue-42",
      workIdentity: null,
      mode: "resolve-issue",
      runNamespace: "courier",
      runName: "run-1",
      pullRequestNumber: null,
      executionState: "SUCCEEDED",
      startedAt: null,
      lastObservedAt: new Date(),
      endedAt: new Date(),
      summary: null,
      idempotencyKey: "execution/run-abc/succeeded/1793000100000",
    });
    const res = await postRequest(
      courierBody({ state: "verifying", idempotencyKey: "execution/run-abc/verifying/1793000200000" }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("execution_terminal");
  });

  it("returns 500 on a database error", async () => {
    mocks.create.mockRejectedValue(new Error("db connection lost"));
    const res = await postRequest(courierBody());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to record agent execution observation");
  });

  it("still succeeds when the best-effort audit write fails", async () => {
    mocks.auditCreate.mockRejectedValue(new Error("audit db down"));
    const res = await postRequest(courierBody());
    expect(res.status).toBe(200);
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "agent_execution_report" }),
      }),
    );
  });
});

describe("POST /api/agent-work/observations per-item error vocabulary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    resetAuthCaches();
    delete process.env.DISPATCH_AUTH_MODE;
    mocks.findUnique.mockResolvedValue(null);
  });

  // Courier latches bare 404/405/501 as "route unsupported" for the whole
  // process, so per-item failures must NEVER use those statuses.
  it("never answers a per-item failure with 404/405/501", async () => {
    const perItemBodies: unknown[] = [
      // Invalid bodies → 400.
      "{not json",
      { version: 2 },
      { version: 1, agent: "", source: "s", run: { uid: "r" }, work: { itemId: "i" }, state: "running", observedAt: "2026-10-30T12:00:00.000Z" },
      courierBody({ state: "paused" }),
      courierBody({ work: { itemId: "i", mode: "m", type: "deploy" } }),
      courierBody({ pullRequestUrl: "ftp://example.com/pr" }),
    ];
    for (const body of perItemBodies) {
      const res =
        typeof body === "string"
          ? await POST(
              new Request(OBSERVATIONS_URL, {
                method: "POST",
                headers: { Authorization: `Bearer ${mockToken}`, "Content-Type": "application/json" },
                body,
              }),
            )
          : await postRequest(body);
      expect(res.status).toBe(400);
      expect([404, 405, 501]).not.toContain(res.status);
    }

    // Fenced conflicts → 409.
    mocks.findUnique.mockResolvedValue({
      id: "exec-1",
      agentName: "saffron",
      source: "courier-harness",
      executionId: "run-abc",
      workType: null,
      workRefUrl: null,
      workItemId: "issue-42",
      workIdentity: null,
      mode: "resolve-issue",
      runNamespace: "courier",
      runName: "run-1",
      pullRequestNumber: null,
      executionState: "FAILED",
      startedAt: null,
      lastObservedAt: new Date(),
      endedAt: new Date(),
      summary: null,
      idempotencyKey: "execution/run-abc/failed/1793000200000",
    });
    const fenced = await postRequest(
      courierBody({ state: "running", idempotencyKey: "execution/run-abc/running/1793000300000" }),
    );
    expect(fenced.status).toBe(409);
    expect([404, 405, 501]).not.toContain(fenced.status);
    const body = await fenced.json();
    expect(body.code).toBe("execution_terminal");
  });
});
