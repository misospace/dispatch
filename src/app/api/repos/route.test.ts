import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks } = vi.hoisted(() => ({
  mocks: {
    repositoryFindMany: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    repository: { findMany: mocks.repositoryFindMany },
  },
}));

import { GET } from "./route";

describe("GET /api/repos", () => {
  const authed = () => authedRequest("http://localhost/api/repos");

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.repositoryFindMany.mockResolvedValue([]);
  });

  it("401s an unauthenticated request", async () => {
    const res = await GET(new Request("http://localhost/api/repos"));
    expect(res.status).toBe(401);
  });

  it("returns repos to an authenticated caller", async () => {
    mocks.repositoryFindMany.mockResolvedValue([
      { id: "r1", fullName: "org/repo1", enabled: true },
      { id: "r2", fullName: "org/repo2", enabled: true },
    ]);

    const res = await GET(authed());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({ fullName: "org/repo1" });
  });

  it("returns empty array when no repos exist", async () => {
    mocks.repositoryFindMany.mockResolvedValue([]);

    const res = await GET(authed());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("orders by fullName ascending", async () => {
    await GET(authed());

    const call = mocks.repositoryFindMany.mock.calls[0][0];
    expect(call.orderBy).toEqual({ fullName: "asc" });
  });

  it("returns 500 on database error", async () => {
    mocks.repositoryFindMany.mockRejectedValue(new Error("db connection lost"));

    const res = await GET(authed());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch repositories");
  });
});
