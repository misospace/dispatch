import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    authorizeRequest: vi.fn(),
    enforceRateLimit: vi.fn(),
    findMany: vi.fn(),
  },
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

vi.mock("@/lib/prisma", () => ({ prisma: { groomerPendingReply: { findMany: mocks.findMany } } }));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: mocks.enforceRateLimit }));

import { GET } from "./route";

function request(url = "http://localhost/api/groomer/pending-replies") {
  return new Request(url, { method: "GET" });
}

describe("GET /api/groomer/pending-replies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeRequest.mockResolvedValue({ authorized: true, type: "basic", actor: "operator" });
    mocks.enforceRateLimit.mockReturnValue(null);
    mocks.findMany.mockResolvedValue([{ id: "reply-1", commentBody: "Proposed reply", trustContext: {} }]);
  });

  it("requires authorization", async () => {
    mocks.authorizeRequest.mockResolvedValue({ authorized: false });
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("returns the rate limiter response without listing when limited", async () => {
    const limited = new Response("Too many requests", { status: 429 });
    mocks.enforceRateLimit.mockReturnValue(limited);

    const response = await GET(request());

    expect(response).toBe(limited);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith("groomer-reply-list:operator", { limit: 30, windowMs: 10_000 });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("lists newest pending replies with filters and a bounded limit", async () => {
    const response = await GET(request("http://localhost/api/groomer/pending-replies?repoFullName=org/repo&limit=500"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: "reply-1", commentBody: "Proposed reply", trustContext: {} }]);
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { status: "pending", repoFullName: "org/repo" },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });

  it("accepts status and clamps limits at the low end", async () => {
    await GET(request("http://localhost/api/groomer/pending-replies?status=posted&limit=0"));
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "posted" }, take: 1 }));
  });
});
