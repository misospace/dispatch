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

// The helper's `bindings` map is token -> agentName; give the bound tokens
// their agents here (kept separate from the mock factory call above so the
// shape is obvious).
const BOUND_TOKENS: Record<string, string> = {
  "worker-saffron-token": "saffron",
  "worker-knock-token": "knock",
};

function postRequest(body: unknown, token = mockToken) {
  return POST(authedRequest("http://localhost/api/agent-executions", { method: "POST", body, token }));
}

function getRequest(token = mockToken) {
  return GET(authedRequest("http://localhost/api/agent-executions", { token }));
}

function validBody(overrides: Record<string, unknown> = {}) {
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

describe("GET /api/agent-executions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    resetAuthCaches();
    delete process.env.DISPATCH_AUTH_MODE;
    mocks.findMany.mockResolvedValue([]);
  });

  it("401s an unauthenticated request", async () => {
    const res = await GET(authedRequest("http://localhost/api/agent-executions", { includeAuth: false }));
    expect(res.status).toBe(401);
  });

  it("403s a bound worker token (GET is maintainer-tier; the consumer is the operator Agents page)", async () => {
    const res = await getRequest(BOUND_SAFFRON_TOKEN);
    expect(res.status).toBe(403);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("returns the capability descriptor plus executions", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "exec-1",
        agentName: "saffron",
        source: "courier-harness",
        executionId: "attempt-1",
        workType: "implement",
        workRefUrl: null,
        issueId: null,
        executionState: "RUNNING",
        startedAt: new Date("2026-10-30T11:00:00.000Z"),
        lastObservedAt: new Date(Date.now() - 1_000),
        endedAt: null,
        summary: null,
        revision: 1,
        createdAt: new Date("2026-10-30T11:00:00.000Z"),
        updatedAt: new Date("2026-10-30T11:00:00.000Z"),
      },
    ]);

    const res = await getRequest();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.capability).toEqual({ name: "agent-executions", protocolVersion: 1 });
    expect(Array.isArray(body.executions)).toBe(true);
    expect(body.executions[0]).toMatchObject({ id: "exec-1", staleness: "live" });
  });
});

describe("POST /api/agent-executions auth matrix", () => {
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
      authedRequest("http://localhost/api/agent-executions", { method: "POST", body: validBody(), includeAuth: false }),
    );
    expect(res.status).toBe(401);
  });

  it("lets a maintainer report for any agent", async () => {
    const res = await postRequest(validBody({ agentName: "knock" }), mockToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, created: true });
    expect(body.duplicate).toBeUndefined();
    expect(mocks.create).toHaveBeenCalled();
  });

  it("lets a bound worker report for its own agent", async () => {
    const res = await postRequest(validBody(), BOUND_SAFFRON_TOKEN);
    expect(res.status).toBe(200);
    expect(mocks.create).toHaveBeenCalled();
  });

  it("403s a bound worker reporting for another agent", async () => {
    const res = await postRequest(validBody({ agentName: "knock" }), BOUND_SAFFRON_TOKEN);
    expect(res.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("403s the unbound legacy worker token", async () => {
    const res = await postRequest(validBody(), UNBOUND_WORKER_TOKEN);
    expect(res.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/agent-executions validation and fencing", () => {
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
      new Request("http://localhost/api/agent-executions", {
        method: "POST",
        headers: { Authorization: `Bearer ${mockToken}`, "Content-Type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 with the error code for validation failures", async () => {
    const res = await postRequest(validBody({ executionState: "PAUSED" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/executionState/);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-http(s) workRefUrl", async () => {
    const res = await postRequest(validBody({ workRefUrl: "repo:org/repo#42" }));
    expect(res.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("returns 409 stale_report for an out-of-order revision", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "exec-1",
      agentName: "saffron",
      source: "courier-harness",
      executionId: "attempt-1",
      workType: "implement",
      workRefUrl: null,
      issueId: null,
      executionState: "RUNNING",
      startedAt: null,
      lastObservedAt: new Date(),
      endedAt: null,
      summary: null,
      revision: 5,
    });
    const res = await postRequest(validBody({ revision: 4 }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("stale_report");
  });

  it("returns 409 execution_terminal for a post-terminal rewrite", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "exec-1",
      agentName: "saffron",
      source: "courier-harness",
      executionId: "attempt-1",
      workType: "implement",
      workRefUrl: null,
      issueId: null,
      executionState: "SUCCEEDED",
      startedAt: null,
      lastObservedAt: new Date(),
      endedAt: new Date(),
      summary: null,
      revision: 3,
    });
    const res = await postRequest(validBody({ executionState: "FAILED", revision: 4 }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("execution_terminal");
  });

  it("answers an idempotent replay with duplicate: true and no write", async () => {
    const lastObservedAt = new Date(Date.now() - 5_000);
    mocks.findUnique.mockResolvedValue({
      id: "exec-1",
      agentName: "saffron",
      source: "courier-harness",
      executionId: "attempt-1",
      workType: "implement",
      workRefUrl: null,
      issueId: null,
      executionState: "SUCCEEDED",
      startedAt: null,
      lastObservedAt,
      endedAt: lastObservedAt,
      summary: null,
      revision: 3,
    });
    const res = await postRequest(validBody({ executionState: "SUCCEEDED", revision: 3 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, duplicate: true, created: false });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("returns 500 on a database error", async () => {
    mocks.create.mockRejectedValue(new Error("db connection lost"));
    const res = await postRequest(validBody());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to record agent execution report");
  });

  it("still succeeds when the best-effort audit write fails", async () => {
    mocks.auditCreate.mockRejectedValue(new Error("audit db down"));
    const res = await postRequest(validBody());
    expect(res.status).toBe(200);
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "agent_execution_report" }),
      }),
    );
  });
});
