import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN, authedRequest, makeDispatchEnvMock } from "@/test/route-helpers";
import { resetRateLimits } from "@/lib/rate-limit";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  sweepStaleWork: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authorizeRequest: mocks.authorizeRequest,
  authErrorResponse: vi.fn((auth: { forbidden?: boolean }) =>
    new Response(JSON.stringify({ error: auth.forbidden ? "Forbidden" : "Unauthorized" }), {
      status: auth.forbidden ? 403 : 401,
      headers: { "content-type": "application/json" },
    }),
  ),
}));
vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/sync-lock", () => ({
  acquireLock: mocks.acquireLock,
  releaseLock: mocks.releaseLock,
}));
vi.mock("@/lib/stale-work", () => ({
  DEFAULT_STALE_WORK_MAX_AGE_MS: 300000,
  DEFAULT_STALE_WORK_BATCH_SIZE: 50,
  sweepStaleWork: mocks.sweepStaleWork,
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  // The rate limiter keeps module-global state — reset it so the per-credential
  // window never leaks between tests.
  resetRateLimits();
  mocks.authorizeRequest.mockResolvedValue({ authorized: true, type: "bearer", actor: "scheduler", throttleKey: "test-cred" });
  mocks.acquireLock.mockResolvedValue({ locked: true, runId: "run-1" });
  mocks.sweepStaleWork.mockResolvedValue({ examined: 1, released: 1, skipped: 0, errors: [] });
  mocks.releaseLock.mockResolvedValue(undefined);
});

describe("POST /api/agent-work/sweep", () => {
  it("requires authentication", async () => {
    mocks.authorizeRequest.mockResolvedValue({ authorized: false });

    const res = await POST(new Request("http://localhost/api/agent-work/sweep", { method: "POST" }));

    expect(res.status).toBe(401);
    expect(mocks.acquireLock).not.toHaveBeenCalled();
  });

  it("returns 409 when another sweep holds the lock", async () => {
    mocks.acquireLock.mockResolvedValue({ locked: false });

    const res = await POST(authedRequest("http://localhost/api/agent-work/sweep", { method: "POST", token: TEST_AGENT_TOKEN }));

    expect(res.status).toBe(409);
    expect(mocks.releaseLock).not.toHaveBeenCalled();
    expect(mocks.sweepStaleWork).not.toHaveBeenCalled();
  });

  it("sweeps and releases the lock", async () => {
    const res = await POST(authedRequest("http://localhost/api/agent-work/sweep", { method: "POST", token: TEST_AGENT_TOKEN }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, examined: 1, released: 1 });
    expect(mocks.acquireLock).toHaveBeenCalledWith("stale-work");
    expect(mocks.sweepStaleWork).toHaveBeenCalledWith(expect.anything(), 300000, 50);
    expect(mocks.releaseLock).toHaveBeenCalledWith("run-1");
  });

  it("releases the lock when the sweep fails", async () => {
    mocks.sweepStaleWork.mockRejectedValue(new Error("GitHub unavailable"));

    const res = await POST(authedRequest("http://localhost/api/agent-work/sweep", { method: "POST", token: TEST_AGENT_TOKEN }));

    expect(res.status).toBe(500);
    expect(mocks.releaseLock).toHaveBeenCalledWith("run-1");
  });
});

describe("POST /api/agent-work/sweep — rate limit", () => {
  it("returns 429 after exceeding the rate limit (6 per 60s) without acquiring the lock", async () => {
    for (let i = 0; i < 6; i++) {
      const res = await POST(authedRequest("http://localhost/api/agent-work/sweep", { method: "POST", token: TEST_AGENT_TOKEN }));
      expect(res.status).toBe(200);
    }

    const res = await POST(authedRequest("http://localhost/api/agent-work/sweep", { method: "POST", token: TEST_AGENT_TOKEN }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: "Rate limit exceeded" });
    // The rejected request never acquired the lock or swept.
    expect(mocks.acquireLock).toHaveBeenCalledTimes(6);
    expect(mocks.sweepStaleWork).toHaveBeenCalledTimes(6);
  });

  it("keeps an independent window for a second credential (#1322)", async () => {
    for (let i = 0; i < 6; i++) {
      const res = await POST(authedRequest("http://localhost/api/agent-work/sweep", { method: "POST", token: TEST_AGENT_TOKEN }));
      expect(res.status).toBe(200);
    }
    const throttled = await POST(authedRequest("http://localhost/api/agent-work/sweep", { method: "POST", token: TEST_AGENT_TOKEN }));
    expect(throttled.status).toBe(429);

    // A different credential (different auth.throttleKey) still sweeps: the
    // window is keyed on the credential-derived identity, not shared globally.
    mocks.authorizeRequest.mockResolvedValue({ authorized: true, type: "bearer", actor: "scheduler", throttleKey: "test-cred-2" });
    const res = await POST(authedRequest("http://localhost/api/agent-work/sweep", { method: "POST", token: TEST_AGENT_TOKEN }));
    expect(res.status).toBe(200);
    expect(mocks.acquireLock).toHaveBeenCalledTimes(7);
  });
});
