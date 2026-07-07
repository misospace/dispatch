import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks, mockAgentRun } = vi.hoisted(() => ({
  mockAgentRun: {
    create: vi.fn().mockResolvedValue({
      id: "run-1",
      agentName: "test-agent",
      runType: "implement",
      status: "completed",
      startedAt: new Date(),
      finishedAt: new Date(),
      summary: null,
      errorMessage: null,
      touchedIssueUrls: [],
    }),
  },
  mocks: {
    repoFindUnique: vi.fn().mockResolvedValue(null),
    issueFindUnique: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    agentRun: mockAgentRun,
    repository: {
      findUnique: mocks.repoFindUnique,
    },
    issue: {
      findUnique: mocks.issueFindUnique,
    },
  },
}));

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";

function postRequest(body: unknown, agentName = "test-agent", includeAuth = true) {
  return POST(
    authedRequest(`http://localhost/api/agents/${agentName}/tasks/report`, {
      method: "POST",
      body,
      includeAuth,
    }),
    { params: Promise.resolve({ agentName }) },
  );
}

describe("POST /api/agents/[agentName]/tasks/report — auth", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
  });

  it("returns 401 when no authorization header is provided", async () => {
    const res = await postRequest(
      { taskType: "implement", outcome: "pr_opened" },
      "test-agent",
      false,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(
      new Request("http://localhost/api/agents/test-agent/tasks/report", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ taskType: "implement", outcome: "pr_opened" }),
      }),
      { params: Promise.resolve({ agentName: "test-agent" }) },
    );
    expect(res.status).toBe(401);
  });

  it("accepts valid Bearer auth with correct token", async () => {
    const res = await postRequest({ taskType: "implement", outcome: "pr_opened" });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/agents/[agentName]/tasks/report — validation", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
  });

  it("returns 200 for a valid implement report", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      repoFullName: "org/repo",
      issueNumber: 42,
      pullRequestNumber: 10,
      pullRequestUrl: "https://github.com/org/repo/pull/10",
      summary: "Implemented the feature",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.report.taskType).toBe("implement");
    expect(body.report.outcome).toBe("pr_opened");
  });

  it("returns 200 for a valid followup-pr report", async () => {
    const res = await postRequest({
      taskType: "followup-pr",
      outcome: "pr_updated",
      repoFullName: "org/repo",
      pullRequestNumber: 10,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.report.taskType).toBe("followup-pr");
    expect(body.report.outcome).toBe("pr_updated");
  });

  it("returns 200 for a valid groom report", async () => {
    const res = await postRequest({
      taskType: "groom",
      outcome: "issue_updated",
      repoFullName: "org/repo",
      issueNumber: 42,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.report.taskType).toBe("groom");
    expect(body.report.outcome).toBe("issue_updated");
  });

  it("returns 200 with minimal valid payload", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "no_changes_needed",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await POST(
      new Request("http://localhost/api/agents/test-agent/tasks/report", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mockToken}`,
        },
        body: "not-json",
      }),
      { params: Promise.resolve({ agentName: "test-agent" }) },
    );

    expect(res.status).toBe(400);
  });

  it("returns 400 when body is not an object", async () => {
    const res = await postRequest("string-body");
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is null", async () => {
    const res = await postRequest(null);
    expect(res.status).toBe(400);
  });

  it("returns 400 when taskType is missing", async () => {
    const res = await postRequest({ outcome: "pr_opened" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/taskType/i);
  });

  it("returns 400 when taskType is invalid", async () => {
    const res = await postRequest({ taskType: "unknown-type", outcome: "pr_opened" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/taskType/i);
  });

  it("returns 400 when outcome is missing", async () => {
    const res = await postRequest({ taskType: "implement" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/outcome/i);
  });

  it("returns 400 when outcome is invalid", async () => {
    const res = await postRequest({ taskType: "implement", outcome: "unknown-outcome" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/outcome/i);
  });

  it("returns 400 when issueNumber is not a number", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      issueNumber: "not-a-number",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when pullRequestNumber is not a number", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      pullRequestNumber: "not-a-number",
    });
    expect(res.status).toBe(400);
  });

  it("returns 200 when issueNumber is a valid number", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      issueNumber: 42,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.issueNumber).toBe(42);
  });

  it("returns 200 when pullRequestNumber is a valid number", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      pullRequestNumber: 10,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.pullRequestNumber).toBe(10);
  });

  it("accepts all valid outcomes", async () => {
    const validOutcomes = [
      "pr_opened",
      "pr_updated",
      "issue_updated",
      "issue_closed",
      "blocked",
      "failed",
      "no_changes_needed",
    ];

    for (const outcome of validOutcomes) {
      const res = await postRequest({ taskType: "implement", outcome });
      expect(res.status).toBe(200);
    }
  });

  it("accepts all valid taskTypes", async () => {
    const validTaskTypes = ["implement", "followup-pr", "groom"];

    for (const taskType of validTaskTypes) {
      const res = await postRequest({ taskType, outcome: "no_changes_needed" });
      expect(res.status).toBe(200);
    }
  });

  it("returns 400 when repoFullName is not a string", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      repoFullName: 123,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when pullRequestUrl is not a string", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      pullRequestUrl: 123,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when summary is not a string", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      summary: true,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when error is not a string", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "failed",
      error: 500,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when issueNumber is a decimal", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      issueNumber: 42.5,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when pullRequestNumber is a decimal", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      pullRequestNumber: 10.7,
    });
    expect(res.status).toBe(400);
  });

  it("does not echo secrets or auth data", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("authorization");
    expect(body).not.toHaveProperty("bearer");
  });

  it("does not require harness-specific fields", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect("harness" in body).toBe(false);
    expect("workflowRepo" in body).toBe(false);
  });
});

describe("POST /api/agents/[agentName]/tasks/report — AgentRun persistence", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
  });

  it("authorized valid report creates an AgentRun", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      repoFullName: "org/repo",
      issueNumber: 42,
      pullRequestUrl: "https://github.com/org/repo/pull/10",
      summary: "Implemented the feature",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.agentRunId).toBe("run-1");

    expect(mockAgentRun.create).toHaveBeenCalledTimes(1);
    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.agentName).toBe("test-agent");
    expect(call.runType).toBe("implement");
    expect(call.status).toBe("completed");
    expect(call.summary).toBe("Implemented the feature");
  });

  it("issue report links issueId when matching repo + issue number exists", async () => {
    mocks.repoFindUnique.mockResolvedValue({ id: "repo-1" });
    mocks.issueFindUnique.mockResolvedValue({ id: "issue-42" });

    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      repoFullName: "org/repo",
      issueNumber: 42,
    });

    expect(res.status).toBe(200);

    // Verify repository lookup
    expect(mocks.repoFindUnique).toHaveBeenCalledWith({
      where: { fullName: "org/repo" },
      select: { id: true },
    });
    expect(mocks.issueFindUnique).toHaveBeenCalledWith({
      where: { repositoryId_number: { repositoryId: "repo-1", number: 42 } },
      select: { id: true },
    });

    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.issueId).toBe("issue-42");
  });

  it("PR-only report stores touched PR URL", async () => {
    const res = await postRequest({
      taskType: "followup-pr",
      outcome: "pr_updated",
      repoFullName: "org/repo",
      pullRequestNumber: 10,
    });

    expect(res.status).toBe(200);

    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.touchedIssueUrls).toContain("https://github.com/org/repo/pull/10");
    expect(call.issueId).toBeNull();
  });

  it("report with pullRequestUrl stores that URL", async () => {
    const res = await postRequest({
      taskType: "followup-pr",
      outcome: "pr_updated",
      pullRequestUrl: "https://github.com/org/repo/pull/10",
    });

    expect(res.status).toBe(200);

    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.touchedIssueUrls).toContain("https://github.com/org/repo/pull/10");
  });

  it("report with both issue and PR stores both URLs", async () => {
    mocks.repoFindUnique.mockResolvedValue({ id: "repo-1" });
    mocks.issueFindUnique.mockResolvedValue({ id: "issue-42" });

    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      repoFullName: "org/repo",
      issueNumber: 42,
      pullRequestUrl: "https://github.com/org/repo/pull/10",
    });

    expect(res.status).toBe(200);

    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.touchedIssueUrls).toContain("https://github.com/org/repo/issues/42");
    expect(call.touchedIssueUrls).toContain("https://github.com/org/repo/pull/10");
  });

  it("failed report maps to failed status and stores error", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "failed",
      error: "Something went wrong",
    });

    expect(res.status).toBe(200);

    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.status).toBe("failed");
    expect(call.errorMessage).toBe("Something went wrong");
  });

  it("blocked report maps to blocked status", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "blocked",
      summary: "Blocked on external dependency",
    });

    expect(res.status).toBe(200);

    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.status).toBe("blocked");
    expect(call.summary).toBe("Blocked on external dependency");
  });

  it("validation failures do not create AgentRun", async () => {
    await postRequest({ taskType: "invalid-type", outcome: "pr_opened" });
    expect(mockAgentRun.create).not.toHaveBeenCalled();

    await postRequest({ taskType: "implement", outcome: "invalid-outcome" });
    expect(mockAgentRun.create).not.toHaveBeenCalled();

    await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      issueNumber: "not-a-number",
    });
    expect(mockAgentRun.create).not.toHaveBeenCalled();
  });

  it("unauthorized requests do not create AgentRun", async () => {
    await postRequest(
      { taskType: "implement", outcome: "pr_opened" },
      "test-agent",
      false,
    );
    expect(mockAgentRun.create).not.toHaveBeenCalled();
  });

  it("response includes agentRunId", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.agentRunId).toBe("run-1");
  });

  it("response includes the route agentName", async () => {
    const res = await postRequest(
      { taskType: "implement", outcome: "pr_opened" },
      "my-special-agent",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentName).toBe("my-special-agent");
  });

  it("preserves optional fields in response", async () => {
    const res = await postRequest({
      taskType: "followup-pr",
      outcome: "blocked",
      repoFullName: "org/repo",
      issueNumber: 42,
      pullRequestNumber: 10,
      pullRequestUrl: "https://github.com/org/repo/pull/10",
      summary: "Blocked on external dependency",
      error: "Cannot proceed without API access",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.repoFullName).toBe("org/repo");
    expect(body.report.issueNumber).toBe(42);
    expect(body.report.pullRequestNumber).toBe(10);
    expect(body.report.pullRequestUrl).toBe("https://github.com/org/repo/pull/10");
    expect(body.report.summary).toBe("Blocked on external dependency");
    expect(body.report.error).toBe("Cannot proceed without API access");
  });

  it("sets issueId to null when repo not found", async () => {
    mocks.repoFindUnique.mockResolvedValue(null);

    await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      repoFullName: "nonexistent/repo",
      issueNumber: 42,
    });

    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.issueId).toBeNull();
  });

  it("sets issueId to null when issue not found in repo", async () => {
    mocks.repoFindUnique.mockResolvedValue({ id: "repo-1" });
    mocks.issueFindUnique.mockResolvedValue(null);

    await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      repoFullName: "org/repo",
      issueNumber: 999,
    });

    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.issueId).toBeNull();
  });

  it("sets issueId to null when no repoFullName or issueNumber", async () => {
    await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
    });

    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.issueId).toBeNull();
  });

  it("uses correct timestamps", async () => {
    await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
    });

    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.startedAt).toBeInstanceOf(Date);
    expect(call.finishedAt).toBeInstanceOf(Date);
  });

  it("stores empty touchedIssueUrls when no URLs available", async () => {
    await postRequest({
      taskType: "implement",
      outcome: "no_changes_needed",
    });

    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.touchedIssueUrls).toEqual([]);
  });
});
