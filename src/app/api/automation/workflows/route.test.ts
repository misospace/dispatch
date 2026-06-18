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
    workflowFindMany: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    githubWorkflow: { findMany: mocks.workflowFindMany },
  },
}));

import { GET } from "./route";

function request(urlString: string) {
  return new Request(urlString, { headers: {} });
}

describe("GET /api/automation/workflows", () => {
  // NOTE: This route is intentionally unauthenticated. It returns GitHub
  // workflow data to any caller. In production deployments behind a firewall or
  // auth gateway this is acceptable; in open deployments consider adding auth.
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workflowFindMany.mockResolvedValue([]);
  });

  it("returns workflows without authentication", async () => {
    mocks.workflowFindMany.mockResolvedValue([
      { id: "wf-1", name: "CI", _count: { runs: 5 } },
    ]);

    const res = await GET(request("http://localhost/api/automation/workflows"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toMatchObject({ id: "wf-1", name: "CI" });
  });

  it("returns empty array when no workflows exist", async () => {
    const res = await GET(request("http://localhost/api/automation/workflows"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("orders by name ascending", async () => {
    await GET(request("http://localhost/api/automation/workflows"));

    const call = mocks.workflowFindMany.mock.calls[0][0];
    expect(call.orderBy).toEqual({ name: "asc" });
  });

  it("filters by repo when repo param is provided", async () => {
    await GET(request("http://localhost/api/automation/workflows?repo=org/repo"));

    const call = mocks.workflowFindMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ repo: { fullName: "org/repo" } });
  });

  it("includes run count and latest run", async () => {
    await GET(request("http://localhost/api/automation/workflows"));

    const call = mocks.workflowFindMany.mock.calls[0][0];
    expect(call.include._count).toEqual({ select: { runs: true } });
    expect(call.include.runs.take).toBe(1);
  });

  it("returns 500 on database error", async () => {
    mocks.workflowFindMany.mockRejectedValue(new Error("db connection lost"));

    const res = await GET(request("http://localhost/api/automation/workflows"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch workflows");
  });
});
