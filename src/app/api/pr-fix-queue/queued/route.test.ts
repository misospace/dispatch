import { describe, expect, it, vi, beforeEach } from "vitest";

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => ({
  isAuthorizedAgentToken: vi.fn((token) => token === mockToken),
  isAuthorizedBearerToken: vi.fn((token) => token === mockToken),
  getAcceptedAgentTokens: vi.fn(() => [mockToken]),
  resetCaches: vi.fn(),
}));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    prFixQueueClient: vi.fn(),
    listQueuedPrFixItems: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  asPrFixQueueClient: mocks.prFixQueueClient,
}));

vi.mock("@/lib/pr-fix-queue", () => ({
  listQueuedPrFixItems: mocks.listQueuedPrFixItems,
}));

import { GET } from "./route";
import { resetAuthCaches } from "@/lib/auth";

function request(urlString: string, includeAuth = true) {
  const headers: Record<string, string> = {};
  if (includeAuth) headers.Authorization = `Bearer ${mockToken}`;
  return new Request(urlString, { headers });
}

describe("GET /api/pr-fix-queue/queued", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.listQueuedPrFixItems.mockResolvedValue([]);
    mocks.prFixQueueClient.mockReturnValue({});
  });

  it("returns 401 when no auth header is present", async () => {
    const res = await GET(request("http://localhost/api/pr-fix-queue/queued", false));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 for bad bearer token", async () => {
    const headers: Record<string, string> = { Authorization: "Bearer wrong-token" };
    const res = await GET(new Request("http://localhost/api/pr-fix-queue/queued", { headers }));

    expect(res.status).toBe(401);
  });

  it("returns queued items when authorized", async () => {
    mocks.listQueuedPrFixItems.mockResolvedValue([
      { id: "fix-1", repo: "org/repo", pr: 42, status: "QUEUED" },
    ]);

    const res = await GET(request("http://localhost/api/pr-fix-queue/queued"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toMatchObject({ id: "fix-1" });
  });

  it("passes lane filter to listQueuedPrFixItems", async () => {
    await GET(request("http://localhost/api/pr-fix-queue/queued?lane=normal"));

    const call = mocks.listQueuedPrFixItems.mock.calls[0][1];
    expect(call.lane).toBe("normal");
  });

  it("passes includeBlocked filter", async () => {
    await GET(request("http://localhost/api/pr-fix-queue/queued?include_blocked=true"));

    const call = mocks.listQueuedPrFixItems.mock.calls[0][1];
    expect(call.includeBlocked).toBe(true);
  });

  it("returns 400 for invalid lane", async () => {
    const res = await GET(request("http://localhost/api/pr-fix-queue/queued?lane=invalid-lane"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid lane");
  });

  it("returns 500 on database error", async () => {
    mocks.listQueuedPrFixItems.mockRejectedValue(new Error("db connection lost"));

    const res = await GET(request("http://localhost/api/pr-fix-queue/queued"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to list PR fix queue");
  });

  it("unauthorized request does not call prisma", async () => {
    await GET(request("http://localhost/api/pr-fix-queue/queued", false));

    expect(mocks.listQueuedPrFixItems).not.toHaveBeenCalled();
  });
});
