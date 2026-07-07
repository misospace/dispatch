import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks } = vi.hoisted(() => ({
  mocks: {
    prFixQueueClient: vi.fn(),
    parseEnqueuePrFixInput: vi.fn(),
    enqueuePrFixItem: vi.fn().mockResolvedValue({ id: "fix-1" }),
    auditLogCreate: vi.fn().mockResolvedValue({ id: "log-1" }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { create: mocks.auditLogCreate },
  },
  asPrFixQueueClient: mocks.prFixQueueClient,
}));

vi.mock("@/lib/pr-fix-queue", () => ({
  parseEnqueuePrFixInput: mocks.parseEnqueuePrFixInput,
  enqueuePrFixItem: mocks.enqueuePrFixItem,
}));

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";

function postRequest(body: unknown, includeAuth = true) {
  return POST(authedRequest("http://localhost/api/pr-fix-queue/enqueue", { method: "POST", body, includeAuth }));
}

describe("POST /api/pr-fix-queue/enqueue", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.prFixQueueClient.mockReturnValue({});
    mocks.parseEnqueuePrFixInput.mockReturnValue({ repo: "org/repo", pr: 42 });
    mocks.enqueuePrFixItem.mockResolvedValue({ id: "fix-1", lane: "NORMAL" });
    mocks.auditLogCreate.mockResolvedValue({ id: "log-1" });
  });

  it("returns 401 when no auth header is present", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42 }, false);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 for bad bearer token", async () => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: "Bearer wrong-token",
    };
    const res = await POST(
      new Request("http://localhost/api/pr-fix-queue/enqueue", {
        method: "POST",
        headers,
        body: JSON.stringify({ repo: "org/repo", pr: 42 }),
      }),
    );

    expect(res.status).toBe(401);
  });

  it("returns 400 on malformed JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/pr-fix-queue/enqueue", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mockToken}`,
        },
        body: "not-json",
      }),
    );

    expect(res.status).toBe(400);
  });

  it("delegates validation errors from parseEnqueuePrFixInput", async () => {
    mocks.parseEnqueuePrFixInput.mockReturnValue({ error: "repo is required" });

    const res = await postRequest({});

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("repo is required");
  });

  it("enqueues item and creates audit log on success", async () => {
    mocks.enqueuePrFixItem.mockResolvedValue({ id: "fix-1", lane: "NORMAL", reason: "test" });

    const res = await postRequest({ repo: "org/repo", pr: 42, reason: "test" });

    expect(res.status).toBe(200);
    expect(mocks.enqueuePrFixItem).toHaveBeenCalled();
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });

  it("returns 500 on database error", async () => {
    mocks.enqueuePrFixItem.mockRejectedValue(new Error("db connection lost"));

    const res = await postRequest({ repo: "org/repo", pr: 42, reason: "test" });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to enqueue PR fix item");
  });

  it("unauthorized request does not call prisma", async () => {
    await postRequest({ repo: "org/repo", pr: 42 }, false);

    expect(mocks.enqueuePrFixItem).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });
});
