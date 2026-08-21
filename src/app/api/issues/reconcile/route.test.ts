import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks } = vi.hoisted(() => ({
  mocks: {
    acquireLock: vi.fn().mockResolvedValue({ locked: true, runId: "test-run" }),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    auditLogFindMany: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { findMany: mocks.auditLogFindMany },
  },
}));

vi.mock("@/lib/sync-lock", () => ({
  acquireLock: mocks.acquireLock,
  releaseLock: mocks.releaseLock,
}));

import { GET, POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";

function request(urlString: string, includeAuth = true) {
  return authedRequest(urlString, { includeAuth });
}

describe("POST /api/issues/reconcile", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.acquireLock.mockResolvedValue({ locked: true, runId: "test-run" });
    mocks.releaseLock.mockResolvedValue(undefined);
  });

  it("returns 409 when another reconciliation holds the lock", async () => {
    mocks.acquireLock.mockResolvedValue({ locked: false });

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ locked: true });
    expect(mocks.acquireLock).toHaveBeenCalledWith("reconcile");
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });
});

describe("GET /api/issues/reconcile", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.acquireLock.mockResolvedValue({ locked: true, runId: "test-run" });
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.auditLogFindMany.mockResolvedValue([]);
  });

  it("returns 401 when no auth header is present", async () => {
    const res = await GET(request("http://localhost/api/issues/reconcile", false));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 for bad bearer token", async () => {
    const headers: Record<string, string> = { Authorization: "Bearer wrong-token" };
    const res = await GET(new Request("http://localhost/api/issues/reconcile", { headers }));

    expect(res.status).toBe(401);
  });

  it("returns reconciliation status when authorized", async () => {
    mocks.auditLogFindMany.mockResolvedValue([
      {
        id: "log-1",
        actor: "reconciler",
        action: "reconcile_add_label",
        repoFullName: "org/repo",
        issueNumber: 42,
        notes: "health check",
        success: true,
        beforeLabels: [],
        afterLabels: ["status/ready"],
        createdAt: new Date(),
      },
    ]);

    const res = await GET(request("http://localhost/api/issues/reconcile"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lastRuns).toBeDefined();
    expect(Array.isArray(body.lastRuns)).toBe(true);
  });

  it("limits recent logs to 10", async () => {
    await GET(request("http://localhost/api/issues/reconcile"));

    const call = mocks.auditLogFindMany.mock.calls[0][0];
    expect(call.take).toBe(10);
  });

  it("filters by reconciler actor", async () => {
    await GET(request("http://localhost/api/issues/reconcile"));

    const call = mocks.auditLogFindMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ actor: "reconciler" });
  });

  it("returns 500 on database error", async () => {
    mocks.auditLogFindMany.mockRejectedValue(new Error("db connection lost"));

    const res = await GET(request("http://localhost/api/issues/reconcile"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch status");
  });

  it("unauthorized request does not call prisma", async () => {
    await GET(request("http://localhost/api/issues/reconcile", false));

    expect(mocks.auditLogFindMany).not.toHaveBeenCalled();
  });
});
