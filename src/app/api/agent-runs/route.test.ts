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
    agentRunFindMany: vi.fn().mockResolvedValue([]),
    agentRunCreate: vi.fn().mockResolvedValue({ id: "run-1" }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    agentRun: {
      findMany: mocks.agentRunFindMany,
      create: mocks.agentRunCreate,
    },
  },
}));

import { GET, POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";

function getRequest(urlString: string, includeAuth = true) {
  const headers: Record<string, string> = {};
  if (includeAuth) headers.Authorization = `Bearer ${mockToken}`;
  return new Request(urlString, { headers });
}

function postRequest(body: unknown, includeAuth = true) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (includeAuth) headers.Authorization = `Bearer ${mockToken}`;
  return POST(
    new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

describe("GET /api/agent-runs", () => {
  // NOTE: This route is intentionally unauthenticated. It returns agent run
  // history to any caller. In production deployments behind a firewall or auth
  // gateway this is acceptable; in open deployments consider adding auth.
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentRunFindMany.mockResolvedValue([]);
  });

  it("401s an unauthenticated request", async () => {
    const res = await GET(getRequest("http://localhost/api/agent-runs", false));
    expect(res.status).toBe(401);
  });

  it("returns agent runs to an authenticated caller", async () => {
    mocks.agentRunFindMany.mockResolvedValue([
      { id: "run-1", agentName: "saffron", status: "completed" },
    ]);

    const res = await GET(getRequest("http://localhost/api/agent-runs"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toMatchObject({ id: "run-1" });
  });

  it("defaults to limit 50", async () => {
    await GET(getRequest("http://localhost/api/agent-runs"));

    const call = mocks.agentRunFindMany.mock.calls[0][0];
    expect(call.take).toBe(50);
  });

  it("respects custom limit parameter", async () => {
    await GET(getRequest("http://localhost/api/agent-runs?limit=10"));

    const call = mocks.agentRunFindMany.mock.calls[0][0];
    expect(call.take).toBe(10);
  });

  it("orders by createdAt descending", async () => {
    await GET(getRequest("http://localhost/api/agent-runs"));

    const call = mocks.agentRunFindMany.mock.calls[0][0];
    expect(call.orderBy).toEqual({ createdAt: "desc" });
  });

  it("returns 500 on database error", async () => {
    mocks.agentRunFindMany.mockRejectedValue(new Error("db connection lost"));

    const res = await GET(getRequest("http://localhost/api/agent-runs"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch agent runs");
  });
});

describe("POST /api/agent-runs", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.agentRunCreate.mockResolvedValue({
      id: "run-1",
      agentName: "saffron",
      runType: "implement",
      status: "completed",
      startedAt: new Date(),
      finishedAt: null,
      summary: null,
      errorMessage: null,
      touchedIssueUrls: [],
      issueId: null,
      outcome: null,
    });
  });

  it("returns 401 when no auth header is present", async () => {
    const res = await postRequest({ agentName: "saffron", runType: "implement", status: "completed", startedAt: new Date().toISOString() }, false);

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
      new Request("http://localhost/api/agent-runs", {
        method: "POST",
        headers,
        body: JSON.stringify({ agentName: "saffron", runType: "implement", status: "completed", startedAt: new Date().toISOString() }),
      }),
    );

    expect(res.status).toBe(401);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await postRequest({});

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required fields");
  });

  it("creates agent run on success", async () => {
    const res = await postRequest({
      agentName: "saffron",
      runType: "implement",
      status: "completed",
      startedAt: new Date().toISOString(),
    });

    expect(res.status).toBe(201);
    expect(mocks.agentRunCreate).toHaveBeenCalled();
  });

  it("returns 500 on database error", async () => {
    mocks.agentRunCreate.mockRejectedValue(new Error("db connection lost"));

    const res = await postRequest({
      agentName: "saffron",
      runType: "implement",
      status: "completed",
      startedAt: new Date().toISOString(),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to create agent run");
  });
});
