import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks } = vi.hoisted(() => ({
  mocks: {
    parseAckPrFixHandoutInput: vi.fn(),
    ackPrFixHandout: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  asPrFixQueueClient: (x: unknown) => x,
}));

vi.mock("@/lib/pr-fix-queue", () => ({
  parseAckPrFixHandoutInput: mocks.parseAckPrFixHandoutInput,
  ackPrFixHandout: mocks.ackPrFixHandout,
}));

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";

// Cast Request as NextRequest for type compatibility in tests
function asNextRequest(r: Request): any { return r; }

function postRequest(body: unknown, includeAuth = true) {
  return POST(asNextRequest(authedRequest("http://localhost/api/pr-fix-queue/ack", { method: "POST", body, includeAuth })));
}

describe("POST /api/pr-fix-queue/ack", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
    mocks.parseAckPrFixHandoutInput.mockReturnValue({ repo: "org/repo", pr: 42, generation: 2, agentName: null });
    mocks.ackPrFixHandout.mockResolvedValue({ acknowledged: true, item: { id: "fix-1", generation: 2 } });
  });

  it("returns 401 when no auth header is present", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 2 }, false);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 for bad bearer token", async () => {
    const res = await POST(
      asNextRequest(new Request("http://localhost/api/pr-fix-queue/ack", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ repo: "org/repo", pr: 42, generation: 2 }),
      })),
    );

    expect(res.status).toBe(401);
  });

  it("returns 400 on malformed JSON", async () => {
    const res = await POST(
      asNextRequest(new Request("http://localhost/api/pr-fix-queue/ack", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mockToken}`,
        },
        body: "not-json",
      })),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON body");
  });

  it("delegates validation errors from parseAckPrFixHandoutInput", async () => {
    mocks.parseAckPrFixHandoutInput.mockReturnValue({ error: "generation must be an integer >= 1" });

    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 0 });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("generation must be an integer >= 1");
    expect(mocks.ackPrFixHandout).not.toHaveBeenCalled();
  });

  it("acknowledges the hand-out and returns the item", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 2 });

    expect(res.status).toBe(200);
    expect(mocks.ackPrFixHandout).toHaveBeenCalledWith(
      expect.anything(),
      { repo: "org/repo", pr: 42, generation: 2, agentName: null },
    );
    const body = await res.json();
    expect(body).toEqual({ acknowledged: true, item: { id: "fix-1", generation: 2 } });
  });

  it("is idempotent on a repeated acknowledgement (200, no error)", async () => {
    mocks.ackPrFixHandout.mockResolvedValue({ acknowledged: false, reason: "already-acknowledged" });

    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 2 });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ acknowledged: true, alreadyAcknowledged: true });
  });

  it("returns 404 when the item is not found", async () => {
    mocks.ackPrFixHandout.mockResolvedValue({ acknowledged: false, reason: "not-found" });

    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 2 });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("pr-fix item not found");
  });

  it("returns 409 on a generation mismatch", async () => {
    mocks.ackPrFixHandout.mockResolvedValue({ acknowledged: false, reason: "generation-mismatch" });

    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 2 });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("PR fix queue item generation mismatch");
    expect(body.reason).toBe("generation-mismatch");
  });

  it("returns 409 when the item is not QUEUED", async () => {
    mocks.ackPrFixHandout.mockResolvedValue({ acknowledged: false, reason: "not-queued" });

    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 2 });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("PR fix queue item is not QUEUED");
    expect(body.reason).toBe("not-queued");
  });

  it("returns 500 when the acknowledgement throws", async () => {
    mocks.ackPrFixHandout.mockRejectedValue(new Error("db connection lost"));

    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 2 });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to acknowledge pr-fix hand-out");
  });

  it("unauthorized request does not call ackPrFixHandout", async () => {
    await postRequest({ repo: "org/repo", pr: 42, generation: 2 }, false);

    expect(mocks.ackPrFixHandout).not.toHaveBeenCalled();
  });
});
