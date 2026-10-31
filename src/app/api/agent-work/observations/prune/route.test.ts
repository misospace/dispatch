import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

const { BOUND_SAFFRON_TOKEN, UNBOUND_WORKER_TOKEN } = vi.hoisted(() => ({
  BOUND_SAFFRON_TOKEN: "worker-saffron-token",
  UNBOUND_WORKER_TOKEN: "unbound-worker-token",
}));

vi.mock("@/lib/dispatch-env", () =>
  makeDispatchEnvMock(mockToken, {
    // Legacy UNBOUND worker token (no agent binding).
    [UNBOUND_WORKER_TOKEN]: "worker",
  }, {
    // BOUND worker credentials via DISPATCH_WORKER_TOKENS-style bindings.
    [BOUND_SAFFRON_TOKEN]: "saffron",
  }),
);

const { mocks } = vi.hoisted(() => ({
  mocks: {
    deleteMany: vi.fn().mockResolvedValue({ count: 5 }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    agentExecution: { deleteMany: mocks.deleteMany },
  },
}));

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";

const PRUNE_URL = "http://localhost/api/agent-work/observations/prune";

function pruneRequest(token = mockToken) {
  return POST(authedRequest(PRUNE_URL, { method: "POST", token }));
}

describe("POST /api/agent-work/observations/prune — auth", () => {
  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(authedRequest(PRUNE_URL, { method: "POST", includeAuth: false }));
    expect(res.status).toBe(401);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await pruneRequest("wrong-token");
    expect(res.status).toBe(401);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("403s a bound worker token (maintainer-tier route; absent from WORKER_ALLOWLIST)", async () => {
    const res = await pruneRequest(BOUND_SAFFRON_TOKEN);
    expect(res.status).toBe(403);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("403s the unbound legacy worker token too", async () => {
    const res = await pruneRequest(UNBOUND_WORKER_TOKEN);
    expect(res.status).toBe(403);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/agent-work/observations/prune — business logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    resetAuthCaches();
    mocks.deleteMany.mockResolvedValue({ count: 3 });
    delete process.env.DISPATCH_AGENT_EXECUTION_RETENTION_MS;
  });

  it("prunes terminal rows older than the retention window and returns count + cutoff", async () => {
    const before = Date.now();
    const res = await pruneRequest();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.prunedCount).toBe(3);
    // Default retention is 7d; the cutoff is now − 7d (clock-tolerant).
    const cutoffMs = new Date(body.cutoff).getTime();
    expect(cutoffMs).toBeGreaterThanOrEqual(before - 7 * 24 * 60 * 60_000);
    expect(cutoffMs).toBeLessThanOrEqual(Date.now() - 7 * 24 * 60 * 60_000);
    const where = mocks.deleteMany.mock.calls[0][0].where;
    expect(where.executionState.in).toEqual([
      "SUCCEEDED",
      "FAILED",
      "BLOCKED",
      "BLOCKED_EXTERNAL",
      "HANDED_OFF",
    ]);
    expect(where.lastObservedAt.lt).toEqual(new Date(body.cutoff));
  });

  it("honors DISPATCH_AGENT_EXECUTION_RETENTION_MS (clamped 1h–90d)", async () => {
    process.env.DISPATCH_AGENT_EXECUTION_RETENTION_MS = String(24 * 60 * 60_000);
    const before = Date.now();
    const res = await pruneRequest();
    expect(res.status).toBe(200);
    const body = await res.json();
    const cutoffMs = new Date(body.cutoff).getTime();
    expect(cutoffMs).toBeGreaterThanOrEqual(before - 24 * 60 * 60_000);
    expect(cutoffMs).toBeLessThanOrEqual(Date.now() - 24 * 60 * 60_000);

    process.env.DISPATCH_AGENT_EXECUTION_RETENTION_MS = "1";
    const clamped = await pruneRequest();
    const clampedBody = await clamped.json();
    const clampedMs = new Date(clampedBody.cutoff).getTime();
    expect(clampedMs).toBeGreaterThanOrEqual(before - 60 * 60_000);
    expect(clampedMs).toBeLessThanOrEqual(Date.now() - 60 * 60_000);
  });
});
