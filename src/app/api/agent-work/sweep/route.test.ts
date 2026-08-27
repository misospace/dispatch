import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN, authedRequest, makeDispatchEnvMock } from "@/test/route-helpers";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  sweepStaleWork: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ authorizeRequest: mocks.authorizeRequest }));
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
  mocks.authorizeRequest.mockResolvedValue({ authorized: true, type: "bearer", actor: "scheduler" });
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
