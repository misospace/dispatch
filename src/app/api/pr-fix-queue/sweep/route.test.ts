import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN, authedRequest, makeDispatchEnvMock } from "@/test/route-helpers";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  reclaimStalePrFixHandouts: vi.fn(),
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
vi.mock("@/lib/prisma", () => ({
  prisma: {},
  asPrFixQueueClient: (x: unknown) => x,
}));
vi.mock("@/lib/sync-lock", () => ({
  acquireLock: mocks.acquireLock,
  releaseLock: mocks.releaseLock,
}));
vi.mock("@/lib/pr-fix-queue", () => ({
  reclaimStalePrFixHandouts: mocks.reclaimStalePrFixHandouts,
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue({ authorized: true, type: "bearer", actor: "scheduler" });
  mocks.acquireLock.mockResolvedValue({ locked: true, runId: "run-1" });
  mocks.reclaimStalePrFixHandouts.mockResolvedValue({
    examined: 2,
    reclaimed: 1,
    staled: 0,
    blocked: 0,
    skipped: 1,
    unknownState: 0,
    errors: [],
  });
  mocks.releaseLock.mockResolvedValue(undefined);
});

describe("POST /api/pr-fix-queue/sweep", () => {
  it("requires authentication", async () => {
    mocks.authorizeRequest.mockResolvedValue({ authorized: false });

    const res = await POST(new Request("http://localhost/api/pr-fix-queue/sweep", { method: "POST" }));

    expect(res.status).toBe(401);
    expect(mocks.acquireLock).not.toHaveBeenCalled();
  });

  it("returns 409 when another sweep holds the lock", async () => {
    mocks.acquireLock.mockResolvedValue({ locked: false });

    const res = await POST(authedRequest("http://localhost/api/pr-fix-queue/sweep", { method: "POST", token: TEST_AGENT_TOKEN }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: "PR-fix hand-out sweep is already running", locked: true });
    expect(mocks.releaseLock).not.toHaveBeenCalled();
    expect(mocks.reclaimStalePrFixHandouts).not.toHaveBeenCalled();
  });

  it("sweeps, passes the report through, and releases the lock", async () => {
    const res = await POST(authedRequest("http://localhost/api/pr-fix-queue/sweep", { method: "POST", token: TEST_AGENT_TOKEN }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      examined: 2,
      reclaimed: 1,
      skipped: 1,
      errors: [],
    });
    expect(mocks.acquireLock).toHaveBeenCalledWith("pr-fix-handout-sweep");
    expect(mocks.reclaimStalePrFixHandouts).toHaveBeenCalledWith(expect.anything());
    expect(mocks.releaseLock).toHaveBeenCalledWith("run-1");
  });

  it("reports success:false when the sweep records errors", async () => {
    mocks.reclaimStalePrFixHandouts.mockResolvedValue({
      examined: 1,
      reclaimed: 0,
      staled: 0,
      blocked: 0,
      skipped: 0,
      unknownState: 0,
      errors: [{ itemId: "fix-1", error: "boom" }],
    });

    const res = await POST(authedRequest("http://localhost/api/pr-fix-queue/sweep", { method: "POST", token: TEST_AGENT_TOKEN }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errors).toEqual([{ itemId: "fix-1", error: "boom" }]);
  });

  it("returns 500 and releases the lock when the sweep throws", async () => {
    mocks.reclaimStalePrFixHandouts.mockRejectedValue(new Error("GitHub unavailable"));

    const res = await POST(authedRequest("http://localhost/api/pr-fix-queue/sweep", { method: "POST", token: TEST_AGENT_TOKEN }));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("PR-fix hand-out sweep failed");
    expect(mocks.releaseLock).toHaveBeenCalledWith("run-1");
  });
});
