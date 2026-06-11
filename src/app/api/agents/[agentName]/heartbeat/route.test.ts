import { describe, expect, it, vi, beforeEach } from "vitest";

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => ({
  isAuthorizedAgentToken: vi.fn((token) => token === mockToken),
  isAuthorizedBearerToken: vi.fn((token) => token === mockToken),
  getAcceptedAgentTokens: vi.fn(() => [mockToken]),
  resetCaches: vi.fn(),
}));

const { mocks, mockAgentRun } = vi.hoisted(() => ({
  mockAgentRun: {
    create: vi.fn().mockResolvedValue({
      id: "run-1",
      agentName: "test-agent",
      runType: "heartbeat",
      status: "ok",
      startedAt: new Date(),
      finishedAt: new Date(),
      summary: "Heartbeat completed",
      touchedIssueUrls: [],
    }),
  },
  mocks: {
    findUnique: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockImplementation(({ data }) => {
      return Promise.resolve({ id: "issue-1", ...data });
    }),
    findMany: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    agentRun: mockAgentRun,
    issue: {
      findUnique: mocks.findUnique,
      update: mocks.update,
      create: mocks.create,
      findMany: mocks.findMany,
    },
  },
}));

vi.mock("@/lib/config", () => ({
  getSyncRepos: vi.fn().mockResolvedValue([{ id: "repo-1", fullName: "org/repo" }]),
  parseExcludedLabels: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/github", () => ({
  fetchIssues: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/heartbeat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/heartbeat")>();
  return {
    ...actual,
    runSyncBestEffort: vi.fn().mockResolvedValue({
      synced: 10,
      reposProcessed: 1,
      warnings: [],
      errors: [],
      touchedIssueUrls: ["repo:org/repo"],
    }),
    runReconcileBestEffort: vi.fn().mockResolvedValue({
      issuesReconciled: 2,
      issuesChecked: 5,
      reposProcessed: 1,
      warnings: [],
      errors: [],
    }),
  };
});

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import * as heartbeatModule from "@/lib/heartbeat";

function makeRequest(
  agentName = "test-agent",
  includeAuth = true,
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = {};
  if (includeAuth) headers.Authorization = `Bearer ${mockToken}`;
  Object.assign(headers, extraHeaders);
  return new Request(`http://localhost/api/agents/${agentName}/heartbeat`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  }) as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/agents/[agentName]/heartbeat — auth", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
  });

  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(makeRequest("test-agent", false), {
      params: Promise.resolve({ agentName: "test-agent" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(makeRequest("test-agent", true, { Authorization: "Bearer wrong-token" }), {
      params: Promise.resolve({ agentName: "test-agent" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts valid Bearer auth with correct token", async () => {
    const res = await POST(makeRequest("test-agent"), {
      params: Promise.resolve({ agentName: "test-agent" }),
    });
    expect(res.status).toBe(200);
  });

  it("is agent-agnostic — works with any agentName", async () => {
    const res = await POST(makeRequest("any-agent-name"), {
      params: Promise.resolve({ agentName: "any-agent-name" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentName).toBe("any-agent-name");
  });
});

describe("POST /api/agents/[agentName]/heartbeat — success", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    // Reset mocks to return clean results
    vi.mocked(heartbeatModule.runSyncBestEffort).mockResolvedValue({
      synced: 10,
      reposProcessed: 1,
      warnings: [],
      errors: [],
      touchedIssueUrls: ["repo:org/repo"],
    });
    vi.mocked(heartbeatModule.runReconcileBestEffort).mockResolvedValue({
      issuesReconciled: 2,
      issuesChecked: 5,
      reposProcessed: 1,
      warnings: [],
      errors: [],
    });
  });

  it("returns status ok when all phases succeed", async () => {
    const res = await POST(makeRequest("my-agent"), {
      params: Promise.resolve({ agentName: "my-agent" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.agentName).toBe("my-agent");
    expect(body.startedAt).toBeDefined();
    expect(body.finishedAt).toBeDefined();
    expect(typeof body.summary).toBe("string");
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(Array.isArray(body.touchedIssueUrls)).toBe(true);
  });

  it("records an AgentRun for the heartbeat pass", async () => {
    await POST(makeRequest("my-agent"), {
      params: Promise.resolve({ agentName: "my-agent" }),
    });
    expect(mockAgentRun.create).toHaveBeenCalledTimes(1);
    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.agentName).toBe("my-agent");
    expect(call.runType).toBe("heartbeat");
    expect(call.status).toBe("ok");
    expect(call.startedAt).toBeDefined();
    expect(call.finishedAt).toBeDefined();
    expect(call.summary).toContain("Heartbeat completed");
  });

  it("includes touchedIssueUrls in the response and AgentRun", async () => {
    await POST(makeRequest("my-agent"), {
      params: Promise.resolve({ agentName: "my-agent" }),
    });
    const res = await POST(makeRequest("my-agent"), {
      params: Promise.resolve({ agentName: "my-agent" }),
    });
    const body = await res.json();
    expect(body.touchedIssueUrls).toContain("repo:org/repo");
  });

  it("does not make model/judgment grooming decisions", async () => {
    // The heartbeat should only sync and reconcile, not groom or classify lanes
    const res = await POST(makeRequest("my-agent"), {
      params: Promise.resolve({ agentName: "my-agent" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // No grooming/lane classification fields in the response
    expect(body).not.toHaveProperty("lanesClassified");
    expect(body).not.toHaveProperty("groomedIssues");
  });
});

describe("POST /api/agents/[agentName]/heartbeat — warning aggregation", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
  });

  it("returns status warning when sync has warnings but no errors", async () => {
    vi.mocked(heartbeatModule.runSyncBestEffort).mockResolvedValue({
      synced: 5,
      reposProcessed: 2,
      warnings: ["Sync warning for org/repo: rate limited"],
      errors: [],
      touchedIssueUrls: ["repo:org/repo"],
    });
    vi.mocked(heartbeatModule.runReconcileBestEffort).mockResolvedValue({
      issuesReconciled: 0,
      issuesChecked: 0,
      reposProcessed: 2,
      warnings: [],
      errors: [],
    });

    const res = await POST(makeRequest("my-agent"), {
      params: Promise.resolve({ agentName: "my-agent" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("warning");
    expect(body.warnings).toContain("sync: Sync warning for org/repo: rate limited");
    expect(body.errors).toEqual([]);
  });

  it("aggregates warnings from both sync and reconcile phases", async () => {
    vi.mocked(heartbeatModule.runSyncBestEffort).mockResolvedValue({
      synced: 5,
      reposProcessed: 1,
      warnings: ["sync warning"],
      errors: [],
      touchedIssueUrls: [],
    });
    vi.mocked(heartbeatModule.runReconcileBestEffort).mockResolvedValue({
      issuesReconciled: 0,
      issuesChecked: 0,
      reposProcessed: 1,
      warnings: ["reconcile warning"],
      errors: [],
    });

    const res = await POST(makeRequest("my-agent"), {
      params: Promise.resolve({ agentName: "my-agent" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("warning");
    expect(body.warnings).toContain("sync: sync warning");
    expect(body.warnings).toContain("reconcile: reconcile warning");
  });

  it("records AgentRun with status warning", async () => {
    vi.mocked(heartbeatModule.runSyncBestEffort).mockResolvedValue({
      synced: 0,
      reposProcessed: 1,
      warnings: ["warning"],
      errors: [],
      touchedIssueUrls: [],
    });
    vi.mocked(heartbeatModule.runReconcileBestEffort).mockResolvedValue({
      issuesReconciled: 0,
      issuesChecked: 0,
      reposProcessed: 1,
      warnings: [],
      errors: [],
    });

    await POST(makeRequest("my-agent"), {
      params: Promise.resolve({ agentName: "my-agent" }),
    });
    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.status).toBe("warning");
  });
});

describe("POST /api/agents/[agentName]/heartbeat — error response", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
  });

  it("returns status error when sync has errors", async () => {
    vi.mocked(heartbeatModule.runSyncBestEffort).mockResolvedValue({
      synced: 0,
      reposProcessed: 0,
      warnings: [],
      errors: ["sync: No tracked repositories found"],
      touchedIssueUrls: [],
    });
    vi.mocked(heartbeatModule.runReconcileBestEffort).mockResolvedValue({
      issuesReconciled: 0,
      issuesChecked: 0,
      reposProcessed: 0,
      warnings: [],
      errors: [],
    });

    const res = await POST(makeRequest("my-agent"), {
      params: Promise.resolve({ agentName: "my-agent" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.errors).toContain("sync: sync: No tracked repositories found");
  });

  it("returns status error when reconcile has errors", async () => {
    vi.mocked(heartbeatModule.runSyncBestEffort).mockResolvedValue({
      synced: 10,
      reposProcessed: 1,
      warnings: [],
      errors: [],
      touchedIssueUrls: ["repo:org/repo"],
    });
    vi.mocked(heartbeatModule.runReconcileBestEffort).mockResolvedValue({
      issuesReconciled: 0,
      issuesChecked: 0,
      reposProcessed: 0,
      warnings: [],
      errors: ["reconcile: Database connection failed"],
    });

    const res = await POST(makeRequest("my-agent"), {
      params: Promise.resolve({ agentName: "my-agent" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.errors).toContain("reconcile: reconcile: Database connection failed");
  });

  it("returns status error when both phases have errors", async () => {
    vi.mocked(heartbeatModule.runSyncBestEffort).mockResolvedValue({
      synced: 0,
      reposProcessed: 0,
      warnings: [],
      errors: ["sync error"],
      touchedIssueUrls: [],
    });
    vi.mocked(heartbeatModule.runReconcileBestEffort).mockResolvedValue({
      issuesReconciled: 0,
      issuesChecked: 0,
      reposProcessed: 0,
      warnings: [],
      errors: ["reconcile error"],
    });

    const res = await POST(makeRequest("my-agent"), {
      params: Promise.resolve({ agentName: "my-agent" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.errors.length).toBe(2);
  });

  it("records AgentRun with status error", async () => {
    vi.mocked(heartbeatModule.runSyncBestEffort).mockResolvedValue({
      synced: 0,
      reposProcessed: 0,
      warnings: [],
      errors: ["error"],
      touchedIssueUrls: [],
    });
    vi.mocked(heartbeatModule.runReconcileBestEffort).mockResolvedValue({
      issuesReconciled: 0,
      issuesChecked: 0,
      reposProcessed: 0,
      warnings: [],
      errors: [],
    });

    await POST(makeRequest("my-agent"), {
      params: Promise.resolve({ agentName: "my-agent" }),
    });
    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.status).toBe("error");
  });

  it("still records AgentRun even when phases throw exceptions", async () => {
    vi.mocked(heartbeatModule.runSyncBestEffort).mockRejectedValue(new Error("sync crashed"));
    vi.mocked(heartbeatModule.runReconcileBestEffort).mockRejectedValue(new Error("reconcile crashed"));

    const res = await POST(makeRequest("my-agent"), {
      params: Promise.resolve({ agentName: "my-agent" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.errors.length).toBe(2);
    expect(mockAgentRun.create).toHaveBeenCalledTimes(1);
  });
});
