import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks } = vi.hoisted(() => ({
  mocks: {
    auditLogFindMany: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { findMany: mocks.auditLogFindMany },
  },
}));

import { GET } from "./route";

function request(urlString: string, includeAuth = true) {
  return authedRequest(urlString, { includeAuth });
}

describe("GET /api/audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auditLogFindMany.mockResolvedValue([]);
  });

  it("401s an unauthenticated request", async () => {
    const res = await GET(request("http://localhost/api/audit", false));
    expect(res.status).toBe(401);
  });

  it("returns audit logs to an authenticated caller", async () => {
    mocks.auditLogFindMany.mockResolvedValue([
      { id: "log-1", actor: "agent", action: "move_issue", createdAt: new Date() },
    ]);

    const res = await GET(request("http://localhost/api/audit"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toMatchObject({ id: "log-1" });
  });

  it("returns empty array when no logs exist", async () => {
    mocks.auditLogFindMany.mockResolvedValue([]);

    const res = await GET(request("http://localhost/api/audit"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("defaults to limit 50", async () => {
    await GET(request("http://localhost/api/audit"));

    const call = mocks.auditLogFindMany.mock.calls[0][0];
    expect(call.take).toBe(50);
  });

  it("respects custom limit parameter", async () => {
    await GET(request("http://localhost/api/audit?limit=10"));

    const call = mocks.auditLogFindMany.mock.calls[0][0];
    expect(call.take).toBe(10);
  });

  it("filters by repo when repo param is provided", async () => {
    await GET(request("http://localhost/api/audit?repo=org/repo"));

    const call = mocks.auditLogFindMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ repoFullName: "org/repo" });
  });

  it("orders by createdAt descending", async () => {
    await GET(request("http://localhost/api/audit"));

    const call = mocks.auditLogFindMany.mock.calls[0][0];
    expect(call.orderBy).toEqual({ createdAt: "desc" });
  });

  it("includes issue and repository relations", async () => {
    await GET(request("http://localhost/api/audit"));

    const call = mocks.auditLogFindMany.mock.calls[0][0];
    expect(call.include).toEqual({ issue: { include: { repository: true } } });
  });

  it("returns 500 on database error", async () => {
    mocks.auditLogFindMany.mockRejectedValue(new Error("db connection lost"));

    const res = await GET(request("http://localhost/api/audit"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch audit logs");
  });
});
