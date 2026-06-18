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
    eventFindMany: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    automationEvent: { findMany: mocks.eventFindMany },
  },
}));

import { GET } from "./route";

function request(urlString: string) {
  return new Request(urlString, { headers: {} });
}

describe("GET /api/automation/events", () => {
  // NOTE: This route is intentionally unauthenticated. It returns automation
  // events to any caller. In production deployments behind a firewall or auth
  // gateway this is acceptable; in open deployments consider adding auth.
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventFindMany.mockResolvedValue([]);
  });

  it("returns events without authentication", async () => {
    mocks.eventFindMany.mockResolvedValue([
      { id: "evt-1", eventType: "push", createdAt: new Date() },
    ]);

    const res = await GET(request("http://localhost/api/automation/events"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toMatchObject({ id: "evt-1" });
  });

  it("returns empty array when no events exist", async () => {
    const res = await GET(request("http://localhost/api/automation/events"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("defaults to limit 50", async () => {
    await GET(request("http://localhost/api/automation/events"));

    const call = mocks.eventFindMany.mock.calls[0][0];
    expect(call.take).toBe(50);
  });

  it("respects custom limit parameter", async () => {
    await GET(request("http://localhost/api/automation/events?limit=10"));

    const call = mocks.eventFindMany.mock.calls[0][0];
    expect(call.take).toBe(10);
  });

  it("filters by repo when repo param is provided", async () => {
    await GET(request("http://localhost/api/automation/events?repo=repo-123"));

    const call = mocks.eventFindMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ repoId: "repo-123" });
  });

  it("filters by event type when type param is provided", async () => {
    await GET(request("http://localhost/api/automation/events?type=push"));

    const call = mocks.eventFindMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ eventType: "push" });
  });

  it("orders by createdAt descending", async () => {
    await GET(request("http://localhost/api/automation/events"));

    const call = mocks.eventFindMany.mock.calls[0][0];
    expect(call.orderBy).toEqual({ createdAt: "desc" });
  });

  it("includes repo relation", async () => {
    await GET(request("http://localhost/api/automation/events"));

    const call = mocks.eventFindMany.mock.calls[0][0];
    expect(call.include).toEqual({ repo: true });
  });

  it("returns 500 on database error", async () => {
    mocks.eventFindMany.mockRejectedValue(new Error("db connection lost"));

    const res = await GET(request("http://localhost/api/automation/events"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch events");
  });
});
