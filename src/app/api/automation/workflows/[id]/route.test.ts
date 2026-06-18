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
    workflowFindUnique: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    githubWorkflow: { findUnique: mocks.workflowFindUnique },
  },
}));

import { GET } from "./route";

function request(urlString: string) {
  return new Request(urlString, { headers: {} });
}

describe("GET /api/automation/workflows/[id]", () => {
  // NOTE: This route is intentionally unauthenticated. It returns a single
  // GitHub workflow by ID to any caller. In production deployments behind a
  // firewall or auth gateway this is acceptable.
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workflowFindUnique.mockResolvedValue(null);
  });

  it("returns 400 when id query param is missing", async () => {
    const res = await GET(request("http://localhost/api/automation/workflows/wf-1"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Workflow ID required");
  });

  it("returns workflow when id is provided", async () => {
    mocks.workflowFindUnique.mockResolvedValue({
      id: "wf-1",
      name: "CI",
      repo: { fullName: "org/repo" },
      runs: [],
    });

    const res = await GET(request("http://localhost/api/automation/workflows/wf-1?id=wf-1"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: "wf-1", name: "CI" });
  });

  it("returns 404 when workflow not found", async () => {
    mocks.workflowFindUnique.mockResolvedValue(null);

    const res = await GET(request("http://localhost/api/automation/workflows/wf-1?id=nonexistent"));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Workflow not found");
  });

  it("includes repo and runs relations", async () => {
    await GET(request("http://localhost/api/automation/workflows/wf-1?id=wf-1"));

    const call = mocks.workflowFindUnique.mock.calls[0][0];
    expect(call.include.repo).toBe(true);
    expect(call.include.runs.take).toBe(20);
  });

  it("returns 500 on database error", async () => {
    mocks.workflowFindUnique.mockRejectedValue(new Error("db connection lost"));

    const res = await GET(request("http://localhost/api/automation/workflows/wf-1?id=wf-1"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch workflow");
  });
});
