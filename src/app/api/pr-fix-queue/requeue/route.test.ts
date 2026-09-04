import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks } = vi.hoisted(() => ({
  mocks: {
    parseRequeuePrFixInput: vi.fn(),
    requeuePrFixItem: vi.fn().mockResolvedValue({ id: "fix-1" }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

vi.mock("@/lib/pr-fix-queue", () => ({
  parseRequeuePrFixInput: mocks.parseRequeuePrFixInput,
  requeuePrFixItem: mocks.requeuePrFixItem,
}));

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";

// Cast Request as NextRequest for type compatibility in tests
function asNextRequest(r: Request): any { return r; }

function postRequest(body: unknown, includeAuth = true) {
  return POST(asNextRequest(authedRequest("http://localhost/api/pr-fix-queue/requeue", { method: "POST", body, includeAuth })));
}

describe("POST /api/pr-fix-queue/requeue", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.parseRequeuePrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, note: null, isPrMergedOrClosed: false });
    mocks.requeuePrFixItem.mockResolvedValue({ id: "fix-1", status: "QUEUED", lane: "NORMAL" });
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
      asNextRequest(new Request("http://localhost/api/pr-fix-queue/requeue", {
        method: "POST",
        headers,
        body: JSON.stringify({ repo: "org/repo", pr: 42 }),
      })),
    );

    expect(res.status).toBe(401);
  });

  it("returns 400 on malformed JSON", async () => {
    const res = await POST(
      asNextRequest(new Request("http://localhost/api/pr-fix-queue/requeue", {
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
    expect(body.error).toBe("Invalid JSON");
  });

  it("delegates validation errors from parseRequeuePrFixInput", async () => {
    mocks.parseRequeuePrFixInput.mockReturnValue({ error: "Missing required field: repo" });

    const res = await postRequest({ pr: 42 });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required field: repo");
    expect(mocks.requeuePrFixItem).not.toHaveBeenCalled();
  });

  it("requeues the item and returns it on success", async () => {
    mocks.requeuePrFixItem.mockResolvedValue({ id: "fix-1", status: "QUEUED", lane: "NORMAL" });

    const res = await postRequest({ repo: "org/repo", pr: 42, note: "retry after infra fix" });

    expect(res.status).toBe(200);
    expect(mocks.requeuePrFixItem).toHaveBeenCalled();
    const body = await res.json();
    expect(body.item).toMatchObject({ id: "fix-1", status: "QUEUED", lane: "NORMAL" });
  });

  it("returns 404 when item not found", async () => {
    mocks.requeuePrFixItem.mockResolvedValue(null);

    const res = await postRequest({ repo: "org/repo", pr: 42 });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("pr-fix item not found");
  });

  it("returns 400 when requeue is refused (e.g. upstream PR merged)", async () => {
    mocks.requeuePrFixItem.mockRejectedValue(new Error("Cannot requeue: upstream PR is merged or closed"));

    const res = await postRequest({ repo: "org/repo", pr: 42 });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Cannot requeue: upstream PR is merged or closed");
  });

  it("unauthorized request does not call requeuePrFixItem", async () => {
    await postRequest({ repo: "org/repo", pr: 42 }, false);

    expect(mocks.requeuePrFixItem).not.toHaveBeenCalled();
  });
});
