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
    issueFindMany: vi.fn(),
    prFixFindMany: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.issueFindMany },
    prFixQueueItem: { findMany: mocks.prFixFindMany },
  },
  asPrFixQueueClient: (client: any) => client,
}));

import { GET } from "./route";
import { resetAuthCaches } from "@/lib/auth";

const TEST_AGENT = "test-agent";

function makeRequest(urlString: string, includeAuth = true) {
  const headers: Record<string, string> = {};
  if (includeAuth) headers.Authorization = `Bearer ${mockToken}`;
  return GET(new Request(urlString, { headers }), {
    params: Promise.resolve({ agentName: TEST_AGENT }),
  });
}

describe("GET /api/agents/[agentName]/work-summary — auth", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.issueFindMany.mockResolvedValue([]);
    mocks.prFixFindMany.mockResolvedValue([]);
  });

  it("returns 401 when no auth header is present", async () => {
    const res = await makeRequest(
      `http://localhost/api/agents/${TEST_AGENT}/work-summary`,
      false,
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 for bad bearer token", async () => {
    const headers: Record<string, string> = { Authorization: "Bearer wrong-token" };
    const res = await GET(
      new Request(`http://localhost/api/agents/${TEST_AGENT}/work-summary`, { headers }),
      { params: Promise.resolve({ agentName: TEST_AGENT }) },
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("authorized request preserves existing summary response", async () => {
    mocks.issueFindMany.mockResolvedValue([]);
    mocks.prFixFindMany.mockResolvedValue([]);

    const res = await makeRequest(
      `http://localhost/api/agents/${TEST_AGENT}/work-summary`,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentName).toBe(TEST_AGENT);
    expect(body.issues).toHaveProperty("normal");
    expect(body.prFixes).toHaveProperty("normal");
  });

  it("unauthorized request does not call prisma.issue.findMany", async () => {
    await makeRequest(
      `http://localhost/api/agents/${TEST_AGENT}/work-summary`,
      false,
    );

    expect(mocks.issueFindMany).not.toHaveBeenCalled();
  });

  it("unauthorized request does not call listQueuedPrFixItems", async () => {
    await makeRequest(
      `http://localhost/api/agents/${TEST_AGENT}/work-summary`,
      false,
    );

    expect(mocks.prFixFindMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/agents/[agentName]/work-summary", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.issueFindMany.mockResolvedValue([]);
    mocks.prFixFindMany.mockResolvedValue([]);
  });

  it("returns agent name and empty lane counts when no issues or PR fixes exist", async () => {
    const res = await makeRequest(
      `http://localhost/api/agents/${TEST_AGENT}/work-summary`,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentName).toBe(TEST_AGENT);
    expect(body.issues).toEqual({
      normal: { queued: 0, inProgress: 0 },
      escalated: { queued: 0, inProgress: 0 },
      backlog: { queued: 0, inProgress: 0 },
    });
    expect(body.prFixes).toEqual({
      normal: { total: 0, blocked: 0 },
      escalated: { total: 0, blocked: 0 },
      needsHuman: { total: 0, blocked: 0 },
    });
  });

  it("counts issues by lane and status", async () => {
    mocks.issueFindMany.mockResolvedValue([
      { labels: ["status/ready"], currentLane: "normal" },
      { labels: ["status/ready"], currentLane: "normal" },
      { labels: [], currentLane: "normal" },
      { labels: ["status/in-progress"], currentLane: "normal" },
      { labels: ["status/in-review"], currentLane: "normal" },
      { labels: ["status/ready"], currentLane: "escalated" },
      { labels: ["status/in-progress"], currentLane: "escalated" },
      { labels: ["status/backlog"], currentLane: "backlog" },
    ]);

    const res = await makeRequest(
      `http://localhost/api/agents/${TEST_AGENT}/work-summary`,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issues.normal).toEqual({ queued: 3, inProgress: 2 });
    expect(body.issues.escalated).toEqual({ queued: 1, inProgress: 1 });
    expect(body.issues.backlog).toEqual({ queued: 1, inProgress: 0 });
  });

  it("treats no status label as queued", async () => {
    mocks.issueFindMany.mockResolvedValue([
      { labels: ["priority/p1"], currentLane: "normal" },
      { labels: ["type/bug"], currentLane: "normal" },
    ]);

    const res = await makeRequest(
      `http://localhost/api/agents/${TEST_AGENT}/work-summary`,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issues.normal.queued).toBe(2);
  });

  it("counts PR fix queue items by lane", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      { lane: "NORMAL", status: "QUEUED" },
      { lane: "NORMAL", status: "QUEUED" },
      { lane: "ESCALATED", status: "QUEUED" },
      { lane: "NEEDS_HUMAN", status: "BLOCKED" },
      { lane: "NEEDS_HUMAN", status: "BLOCKED" },
      { lane: "NORMAL", status: "BLOCKED" },
    ]);

    const res = await makeRequest(
      `http://localhost/api/agents/${TEST_AGENT}/work-summary`,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prFixes.normal).toEqual({ total: 3, blocked: 1 });
    expect(body.prFixes.escalated).toEqual({ total: 1, blocked: 0 });
    expect(body.prFixes.needsHuman).toEqual({ total: 2, blocked: 2 });
  });

  it("defaults missing lane to NORMAL for PR fixes", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      { lane: null, status: "QUEUED" },
    ]);

    const res = await makeRequest(
      `http://localhost/api/agents/${TEST_AGENT}/work-summary`,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prFixes.normal.total).toBe(1);
  });

  it("defaults missing lane to normal for issues", async () => {
    mocks.issueFindMany.mockResolvedValue([
      { labels: ["status/ready"], currentLane: null },
    ]);

    const res = await makeRequest(
      `http://localhost/api/agents/${TEST_AGENT}/work-summary`,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issues.normal.queued).toBe(1);
  });

  it("counts issues with status/done as queued since they are still open in the DB", async () => {
    mocks.issueFindMany.mockResolvedValue([
      { labels: ["status/done"], currentLane: "normal" },
    ]);

    const res = await makeRequest(
      `http://localhost/api/agents/${TEST_AGENT}/work-summary`,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issues.normal.queued).toBe(1);
  });

  it("returns 500 on database error", async () => {
    mocks.issueFindMany.mockRejectedValue(new Error("connection refused"));

    const res = await makeRequest(
      `http://localhost/api/agents/${TEST_AGENT}/work-summary`,
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch work summary");
  });
});
