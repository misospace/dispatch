import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMockWithSafeEqual, authedRequest } from "@/test/route-helpers";

const { WORKER_TOKEN } = vi.hoisted(() => ({ WORKER_TOKEN: "worker-token" }));

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () =>
  makeDispatchEnvMockWithSafeEqual(mockToken, { [WORKER_TOKEN]: "worker" }),
);

const { mocks } = vi.hoisted(() => ({
  mocks: {
    prFixQueueClient: vi.fn(),
    parseMarkPrFixInput: vi.fn(),
    markPrFixItem: vi.fn().mockResolvedValue({ mutated: true, item: { id: "fix-1" } }),
    auditLogCreate: vi.fn().mockResolvedValue({ id: "log-1" }),
    isPrFixRepoArchived: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { create: mocks.auditLogCreate },
  },
  asPrFixQueueClient: mocks.prFixQueueClient,
}));

vi.mock("@/lib/pr-fix-queue", () => ({
  parseMarkPrFixInput: mocks.parseMarkPrFixInput,
  markPrFixItem: mocks.markPrFixItem,
  isPrFixRepoArchived: mocks.isPrFixRepoArchived,
}));

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";

function postRequest(body: unknown, includeAuth = true) {
  return POST(authedRequest("http://localhost/api/pr-fix-queue/mark", { method: "POST", body, includeAuth }));
}

describe("POST /api/pr-fix-queue/mark", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.prFixQueueClient.mockReturnValue({});
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "DONE" });
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "DONE" } });
    mocks.auditLogCreate.mockResolvedValue({ id: "log-1" });
    mocks.isPrFixRepoArchived.mockResolvedValue(false);
  });

  it("returns 401 when no auth header is present", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, status: "DONE" }, false);

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
      new Request("http://localhost/api/pr-fix-queue/mark", {
        method: "POST",
        headers,
        body: JSON.stringify({ repo: "org/repo", pr: 42, status: "DONE" }),
      }),
    );

    expect(res.status).toBe(401);
  });

  it("returns 400 on malformed JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/pr-fix-queue/mark", {
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

  it("delegates validation errors from parseMarkPrFixInput", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ error: "repo is required" });

    const res = await postRequest({});

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("repo is required");
  });

  it("returns 400 for a bearer mark without a generation (#1074)", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, status: "DONE" });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("generation is required for agent/bridge marks (#1074)");
    expect(mocks.markPrFixItem).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("marks item and creates audit log on success (bearer with generation)", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({
      repo: "org/repo", pr: 42, status: "DONE", expectedGeneration: 2,
    });
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "DONE" } });

    const res = await postRequest({ repo: "org/repo", pr: 42, status: "DONE", generation: 2 });

    expect(res.status).toBe(200);
    expect(mocks.markPrFixItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ expectedGeneration: 2 }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });

  it("allows an operator mark without a generation (disabled mode)", async () => {
    process.env.DISPATCH_AUTH_MODE = "disabled";
    resetAuthCaches();
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "DONE" } });

    const res = await postRequest({ repo: "org/repo", pr: 42, status: "DONE" }, false);

    expect(res.status).toBe(200);
    // No expectedGeneration on the input: the operator mark is unconditional.
    expect(mocks.markPrFixItem).toHaveBeenCalledWith(expect.anything(), {
      repo: "org/repo", pr: 42, status: "DONE",
    });
  });

  it("allows an operator mark without a generation (basic mode)", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "op";
    process.env.DISPATCH_AUTH_PASSWORD = "op-pass";
    resetAuthCaches();
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "DONE" } });

    const res = await POST(
      new Request("http://localhost/api/pr-fix-queue/mark", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from("op:op-pass").toString("base64")}`,
        },
        body: JSON.stringify({ repo: "org/repo", pr: 42, status: "DONE" }),
      }),
    );

    expect(res.status).toBe(200);
    // No expectedGeneration on the input: the operator mark is unconditional.
    expect(mocks.markPrFixItem).toHaveBeenCalledWith(expect.anything(), {
      repo: "org/repo", pr: 42, status: "DONE",
    });
  });

  it("returns 404 when item not found", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({
      repo: "org/repo", pr: 42, status: "DONE", expectedGeneration: 2,
    });
    mocks.markPrFixItem.mockResolvedValue({ mutated: false, reason: "not-found" });

    const res = await postRequest({ repo: "org/repo", pr: 42, status: "DONE", generation: 2 });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("PR fix queue item not found");
  });

  it("returns 500 on database error", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({
      repo: "org/repo", pr: 42, status: "DONE", expectedGeneration: 2,
    });
    mocks.markPrFixItem.mockRejectedValue(new Error("db connection lost"));

    const res = await postRequest({ repo: "org/repo", pr: 42, status: "DONE", generation: 2 });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to mark PR fix queue item");
  });

  it("unauthorized request does not call prisma", async () => {
    await postRequest({ repo: "org/repo", pr: 42, status: "DONE" }, false);

    expect(mocks.markPrFixItem).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  // The item moved to a newer attempt between the caller's read and this
  // write: the generation-conditional write matched nothing.
  it("returns 409 when the expected generation no longer matches the item", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({
      repo: "org/repo", pr: 42, status: "DONE", expectedGeneration: 2,
    });
    mocks.markPrFixItem.mockResolvedValue({ mutated: false, reason: "generation-mismatch" });

    const res = await postRequest({ repo: "org/repo", pr: 42, status: "DONE", generation: 2 });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("generation mismatch");
    expect(body.error).toContain("2");
    // A skipped mark is not audited as a mutation.
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("refuses a mark back to QUEUED for an archived repo (#1106)", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "QUEUED", expectedGeneration: 1 });
    mocks.isPrFixRepoArchived.mockResolvedValue(true);

    const res = await postRequest({ repo: "org/repo", pr: 42, status: "QUEUED", generation: 1 });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Cannot requeue: repository is archived");
    expect(mocks.markPrFixItem).not.toHaveBeenCalled();
  });

  it("does not look up archived state for non-QUEUED marks (#1106)", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "BLOCKED", expectedGeneration: 1 });

    const res = await postRequest({ repo: "org/repo", pr: 42, status: "BLOCKED", generation: 1 });

    expect(res.status).toBe(200);
    expect(mocks.isPrFixRepoArchived).not.toHaveBeenCalled();
  });
});

describe("POST /api/pr-fix-queue/mark — worker tier (#1111)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prFixQueueClient.mockReturnValue({});
    mocks.auditLogCreate.mockResolvedValue({ id: "log-1" });
    mocks.isPrFixRepoArchived.mockResolvedValue(false);
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "FIXED" } });
  });

  function workerPost(body: unknown) {
    return POST(
      authedRequest("http://localhost/api/pr-fix-queue/mark", {
        method: "POST",
        body,
        token: WORKER_TOKEN,
        headers: { "x-agent-name": "worker-agent" },
      }),
    );
  }

  it("allows a worker to mark an item FIXED with a generation", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "FIXED", expectedGeneration: 2 });
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "FIXED" } });

    const res = await workerPost({ repo: "org/repo", pr: 42, status: "FIXED", generation: 2 });

    expect(res.status).toBe(200);
    expect(mocks.markPrFixItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "FIXED", expectedGeneration: 2 }),
    );
  });

  it("returns 403 when a worker marks an item QUEUED", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "QUEUED", expectedGeneration: 2 });

    const res = await workerPost({ repo: "org/repo", pr: 42, status: "QUEUED", generation: 2 });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Marking an item QUEUED or IGNORED requires a maintainer token");
    expect(mocks.markPrFixItem).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "pr_fix_mark",
        success: false,
        errorMessage: "Marking an item QUEUED or IGNORED requires a maintainer token",
      }),
    });
  });

  it("returns 403 when a worker marks an item IGNORED", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "IGNORED", expectedGeneration: 2 });

    const res = await workerPost({ repo: "org/repo", pr: 42, status: "IGNORED", generation: 2 });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Marking an item QUEUED or IGNORED requires a maintainer token");
    expect(mocks.markPrFixItem).not.toHaveBeenCalled();
  });

  it("allows a maintainer to mark an item QUEUED", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "QUEUED", expectedGeneration: 2 });
    mocks.isPrFixRepoArchived.mockResolvedValue(false);
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "QUEUED" } });

    const res = await postRequest({ repo: "org/repo", pr: 42, status: "QUEUED", generation: 2 });

    expect(res.status).toBe(200);
    expect(mocks.markPrFixItem).toHaveBeenCalled();
  });
});
