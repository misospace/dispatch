import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks, mockAgentRun, mockDedupe, prFixResolveMock, prismaMock } = vi.hoisted(() => {
  const mockAgentRun = {
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
  };
  const mockDedupe = {
    create: vi.fn().mockResolvedValue({
      id: "claim-1",
      agentName: "test-agent",
      idempotencyKey: "key-1",
      payloadHash: "hash-1",
      agentRunId: null,
      prFixResolution: null,
    }),
    findUnique: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({}),
  };
  const prismaMock: any = {
    agentRun: mockAgentRun,
    repository: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    issue: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    // `tasks/report` resolves a queued pr-fix item when the agent reports
    // back on PR coordinates. Tests that send `repoFullName` +
    // `pullRequestNumber` should keep the pr-fix queue empty by default;
    // tests that want the resolution path can override per-test.
    prFixQueueItem: {
      findUnique: vi.fn(async () => null),
    },
    agentReportDedupe: mockDedupe,
    $transaction: (fn: any) => fn(prismaMock),
  };
  return {
    mockAgentRun,
    mockDedupe,
    prFixResolveMock: vi.fn().mockResolvedValue({
      matched: false,
      action: "none",
      itemId: null,
      reason: "no matching pr-fix queue item",
    }),
    mocks: {
      repoFindUnique: prismaMock.repository.findUnique,
      issueFindUnique: prismaMock.issue.findUnique,
    },
    prismaMock,
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// Real Prisma error shape so the `instanceof` check in the route triggers.
vi.mock("@prisma/client", () => ({
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code: string;
      clientVersion: string;
      constructor(message: string, opts: { code: string; clientVersion?: string }) {
        super(message);
        this.code = opts.code;
        this.clientVersion = opts.clientVersion ?? "test";
      }
    },
  },
}));

vi.mock("@/lib/pr-fix-queue", () => ({
  resolvePrFixFromAgentReport: prFixResolveMock,
}));

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { Prisma } from "@prisma/client";

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

describe("POST /api/agents/[agentName]/tasks/report — idempotencyKey", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
  });

  const keyedBody = {
    taskType: "followup-pr",
    outcome: "pr_updated",
    repoFullName: "org/repo",
    pullRequestNumber: 12,
    summary: "pushed the fix",
    idempotencyKey: "worker-run-1:report",
  };

  function p2002(): Error {
    return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
  }

  it("reports without idempotencyKey keep at-least-once behavior", async () => {
    const body = { taskType: "implement", outcome: "pr_opened" };

    const first = await postRequest(body);
    const second = await postRequest(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // No key → no claim, and repeated reports create repeated AgentRuns.
    expect(mockDedupe.create).not.toHaveBeenCalled();
    expect(mockAgentRun.create).toHaveBeenCalledTimes(2);
    expect((await first.json()).duplicate).toBeUndefined();
    expect((await second.json()).duplicate).toBeUndefined();
  });

  it("rejects a non-string or empty idempotencyKey without side effects", async () => {
    const badType = await postRequest({ taskType: "implement", outcome: "pr_opened", idempotencyKey: 42 });
    expect(badType.status).toBe(400);
    expect((await badType.json()).error).toBe("idempotencyKey must be a non-empty string");
    const empty = await postRequest({ taskType: "implement", outcome: "pr_opened", idempotencyKey: "  " });
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toBe("idempotencyKey must be a non-empty string");
    const tooLong = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      idempotencyKey: "k".repeat(201),
    });
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error).toBe("idempotencyKey must be at most 200 characters");

    expect(mockAgentRun.create).not.toHaveBeenCalled();
    expect(mockDedupe.create).not.toHaveBeenCalled();
    expect(prFixResolveMock).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace from an idempotencyKey before claiming", async () => {
    const res = await postRequest({
      ...keyedBody,
      idempotencyKey: "  worker-run-1:report  ",
    });

    expect(res.status).toBe(200);
    expect(mockDedupe.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ idempotencyKey: "worker-run-1:report" }),
    });
  });

  it("a retry with the untrimmed form of the same key is recognized as a duplicate", async () => {
    await postRequest({ ...keyedBody, idempotencyKey: "  worker-run-1:report  " });
    const payloadHash = mockDedupe.create.mock.calls[0][0].data.payloadHash;

    mockDedupe.create.mockRejectedValueOnce(p2002());
    mockDedupe.findUnique.mockResolvedValueOnce({
      id: "claim-1",
      agentName: "test-agent",
      idempotencyKey: "worker-run-1:report",
      payloadHash,
      agentRunId: "run-1",
      prFixResolution: null,
    });

    const retry = await postRequest({ ...keyedBody, idempotencyKey: "worker-run-1:report" });

    expect(retry.status).toBe(200);
    expect((await retry.json()).duplicate).toBe(true);
  });

  it("payload key order does not change identity: a reordered retry is a duplicate, not a conflict", async () => {
    await postRequest(keyedBody);
    const payloadHash = mockDedupe.create.mock.calls[0][0].data.payloadHash;

    mockDedupe.create.mockRejectedValueOnce(p2002());
    mockDedupe.findUnique.mockResolvedValueOnce({
      id: "claim-1",
      agentName: "test-agent",
      idempotencyKey: "worker-run-1:report",
      payloadHash,
      agentRunId: "run-1",
      prFixResolution: null,
    });

    // Same logical report, different JSON key order in the request body.
    const reordered = {
      idempotencyKey: "worker-run-1:report",
      summary: "pushed the fix",
      pullRequestNumber: 12,
      repoFullName: "org/repo",
      outcome: "pr_updated",
      taskType: "followup-pr",
    };
    const retry = await postRequest(reordered);

    expect(retry.status).toBe(200);
    const body = await retry.json();
    expect(body.duplicate).toBe(true);
    expect(body.agentRunId).toBe("run-1");
  });

  it("first report with a key claims the key, creates one AgentRun, and runs PR-fix resolution", async () => {
    const res = await postRequest(keyedBody);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBeUndefined();

    expect(mockDedupe.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agentName: "test-agent",
        idempotencyKey: "worker-run-1:report",
        payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    });
    expect(mockAgentRun.create).toHaveBeenCalledTimes(1);
    expect(prFixResolveMock).toHaveBeenCalledTimes(1);
    // The claim is stamped with the AgentRun id inside the same transaction.
    expect(mockDedupe.update).toHaveBeenCalledWith({
      where: { id: "claim-1" },
      data: { agentRunId: "run-1" },
    });
  });

  it("identical retry returns success with the original agentRunId and stored resolution", async () => {
    const first = await postRequest(keyedBody);
    expect(first.status).toBe(200);
    const payloadHash = mockDedupe.create.mock.calls[0][0].data.payloadHash;

    // Simulate the retry hitting the committed claim from the first report.
    mockDedupe.create.mockRejectedValueOnce(p2002());
    mockDedupe.findUnique.mockResolvedValueOnce({
      id: "claim-1",
      agentName: "test-agent",
      idempotencyKey: "worker-run-1:report",
      payloadHash,
      agentRunId: "run-1",
      prFixResolution: { matched: true, action: "fixed", itemId: 7, reason: "pr merge state verified" },
    });

    const retry = await postRequest(keyedBody);

    expect(retry.status).toBe(200);
    const body = await retry.json();
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBe(true);
    expect(body.agentRunId).toBe("run-1");
    expect(body.prFixResolution).toEqual({
      matched: true,
      action: "fixed",
      itemId: 7,
      reason: "pr merge state verified",
    });
  });

  it("a retry creates no second AgentRun", async () => {
    await postRequest(keyedBody);
    const payloadHash = mockDedupe.create.mock.calls[0][0].data.payloadHash;
    mockDedupe.create.mockRejectedValueOnce(p2002());
    mockDedupe.findUnique.mockResolvedValueOnce({
      id: "claim-1",
      agentName: "test-agent",
      idempotencyKey: "worker-run-1:report",
      payloadHash,
      agentRunId: "run-1",
      prFixResolution: null,
    });

    await postRequest(keyedBody);

    expect(mockAgentRun.create).toHaveBeenCalledTimes(1);
  });

  it("a retry does not repeat PR-fix resolution side effects", async () => {
    await postRequest(keyedBody);
    expect(prFixResolveMock).toHaveBeenCalledTimes(1);

    const payloadHash = mockDedupe.create.mock.calls[0][0].data.payloadHash;
    mockDedupe.create.mockRejectedValueOnce(p2002());
    mockDedupe.findUnique.mockResolvedValueOnce({
      id: "claim-1",
      agentName: "test-agent",
      idempotencyKey: "worker-run-1:report",
      payloadHash,
      agentRunId: "run-1",
      prFixResolution: null,
    });

    const retry = await postRequest(keyedBody);
    expect(retry.status).toBe(200);

    expect(prFixResolveMock).toHaveBeenCalledTimes(1);
    const body = await retry.json();
    // No stored resolution → explicit skip marker, never a re-run.
    expect(body.prFixResolution.action).toBe("skipped");
    expect(body.prFixResolution.reason).toContain("not re-run");
  });

  it("concurrent same-key submissions create exactly one logical report", async () => {
    // The winner claims the key; the loser hits the unique constraint and
    // reads back the winner's committed claim.
    let winnerData: any;
    mockDedupe.create
      .mockImplementationOnce(async ({ data }: any) => {
        winnerData = data;
        return {
          id: "claim-1",
          agentName: data.agentName,
          idempotencyKey: data.idempotencyKey,
          payloadHash: data.payloadHash,
          agentRunId: null,
          prFixResolution: null,
        };
      })
      .mockImplementationOnce(() => Promise.reject(p2002()));
    mockDedupe.findUnique.mockImplementationOnce(async () => ({
      id: "claim-1",
      agentName: "test-agent",
      idempotencyKey: "worker-run-1:report",
      payloadHash: winnerData.payloadHash,
      agentRunId: "run-1",
      prFixResolution: null,
    }));

    const [winner, loser] = await Promise.all([
      postRequest(keyedBody),
      postRequest(keyedBody),
    ]);

    expect(winner.status).toBe(200);
    expect(loser.status).toBe(200);
    const winnerBody = await winner.json();
    const loserBody = await loser.json();
    expect(mockAgentRun.create).toHaveBeenCalledTimes(1);
    expect(loserBody.duplicate).toBe(true);
    expect(loserBody.agentRunId).toBe("run-1");
    expect(winnerBody.agentRunId).toBe("run-1");
  });

  it("a claim without a recorded agentRunId is rejected as a conflict, never re-run", async () => {
    // Defensive guard: while the claim and the AgentRun commit together this
    // is unreachable, a future refactor that decouples them must fail loudly
    // instead of silently re-running the report.
    mockDedupe.create.mockRejectedValueOnce(p2002());
    // The create call is recorded (with the route-computed hash) before
    // findUnique runs, so read the hash back at invocation time.
    mockDedupe.findUnique.mockImplementationOnce(async () => ({
      id: "claim-1",
      agentName: "test-agent",
      idempotencyKey: "worker-run-1:report",
      payloadHash: mockDedupe.create.mock.calls[0]?.[0]?.data?.payloadHash,
      agentRunId: null,
      prFixResolution: null,
    }));

    const res = await postRequest(keyedBody);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("no recorded result");
    expect(mockAgentRun.create).not.toHaveBeenCalled();
    expect(prFixResolveMock).not.toHaveBeenCalled();
  });

  it("same key with a different payload is rejected as a conflict", async () => {
    mockDedupe.create.mockRejectedValueOnce(p2002());
    mockDedupe.findUnique.mockResolvedValueOnce({
      id: "claim-1",
      agentName: "test-agent",
      idempotencyKey: "worker-run-1:report",
      payloadHash: "hash-of-a-different-payload",
      agentRunId: "run-1",
      prFixResolution: null,
    });

    const res = await postRequest(keyedBody);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("different report payload");
    // No second AgentRun and no side effects for a conflicting payload.
    expect(mockAgentRun.create).not.toHaveBeenCalled();
    expect(prFixResolveMock).not.toHaveBeenCalled();
  });

  it("different keys produce independent reports", async () => {
    mockAgentRun.create
      .mockResolvedValueOnce({ id: "run-1" })
      .mockResolvedValueOnce({ id: "run-2" });

    const first = await postRequest({ ...keyedBody, idempotencyKey: "key-a" });
    const second = await postRequest({ ...keyedBody, idempotencyKey: "key-b" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mockDedupe.create).toHaveBeenCalledTimes(2);
    expect(mockAgentRun.create).toHaveBeenCalledTimes(2);
    expect((await first.json()).agentRunId).toBe("run-1");
    expect((await second.json()).agentRunId).toBe("run-2");
  });

  it("different agents may use the same opaque key without colliding", async () => {
    mockAgentRun.create
      .mockResolvedValueOnce({ id: "run-1" })
      .mockResolvedValueOnce({ id: "run-2" });

    const first = await postRequest({ ...keyedBody, idempotencyKey: "shared-key" }, "agent-one");
    const second = await postRequest({ ...keyedBody, idempotencyKey: "shared-key" }, "agent-two");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mockDedupe.create).toHaveBeenCalledTimes(2);
    const claimedAgents = mockDedupe.create.mock.calls.map((c: any) => c[0].data.agentName);
    expect(claimedAgents).toEqual(["agent-one", "agent-two"]);
    expect(mockAgentRun.create).toHaveBeenCalledTimes(2);
  });

  it("a failed resolution-store update returns a structured 500; the retry still dedupes to the skip marker", async () => {
    // The claim + AgentRun transaction commits (first update), then the
    // resolution persistence fails: the report itself is durable, so this
    // response fails with a structured 5xx and the worker retries into the
    // duplicate branch.
    mockDedupe.update
      .mockResolvedValueOnce({}) // in-transaction agentRunId stamp
      .mockRejectedValueOnce(new Error("db hiccup"));

    const first = await postRequest(keyedBody);

    expect(first.status).toBe(500);
    expect((await first.json()).error).toBe("Failed to report task");
    expect(mockAgentRun.create).toHaveBeenCalledTimes(1);

    mockDedupe.create.mockRejectedValueOnce(p2002());
    mockDedupe.findUnique.mockResolvedValueOnce({
      id: "claim-1",
      agentName: "test-agent",
      idempotencyKey: "worker-run-1:report",
      payloadHash: mockDedupe.create.mock.calls[0][0].data.payloadHash,
      agentRunId: "run-1",
      prFixResolution: null,
    });

    const retry = await postRequest(keyedBody);

    expect(retry.status).toBe(200);
    const body = await retry.json();
    expect(body.duplicate).toBe(true);
    expect(body.agentRunId).toBe("run-1");
    expect(body.prFixResolution.action).toBe("skipped");
    // No second AgentRun and no repeated resolution despite the failed store.
    expect(mockAgentRun.create).toHaveBeenCalledTimes(1);
    expect(prFixResolveMock).toHaveBeenCalledTimes(1);
  });

  it("an AgentRun write failure on the no-key path returns a structured 500", async () => {
    mockAgentRun.create.mockRejectedValueOnce(new Error("db down"));

    const res = await postRequest({ taskType: "implement", outcome: "pr_opened" });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to report task");
  });

  it("a resolver failure on the keyed path returns a structured 500 and records the claim", async () => {
    // The claim + AgentRun transaction commits, then the resolver throws:
    // the report is durable; the response must still be a structured 5xx.
    prFixResolveMock.mockRejectedValueOnce(new Error("github unreachable"));

    const res = await postRequest(keyedBody);

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to report task");
    expect(mockAgentRun.create).toHaveBeenCalledTimes(1);
    // The committed claim still identifies the report for the worker's retry.
    expect(mockDedupe.update).toHaveBeenCalledWith({
      where: { id: "claim-1" },
      data: { agentRunId: "run-1" },
    });
  });
});

describe("POST /api/agents/[agentName]/tasks/report — prFixItem attempt token (#1074)", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
  });

  const validReport = {
    taskType: "followup-pr",
    outcome: "pr_updated",
    repoFullName: "org/repo",
    pullRequestNumber: 10,
  };

  it("returns 200 for a report carrying a valid prFixItem token", async () => {
    const res = await postRequest({
      ...validReport,
      prFixItem: { id: "cktz-abc", generation: 2 },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.prFixItem).toEqual({ id: "cktz-abc", generation: 2 });
  });

  it("returns 400 when prFixItem is not an object", async () => {
    const res = await postRequest({ ...validReport, prFixItem: "cktz-abc" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/prFixItem must be an object/);
  });

  it("returns 400 when prFixItem is an array", async () => {
    const res = await postRequest({ ...validReport, prFixItem: ["cktz-abc"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/prFixItem must be an object/);
  });

  it("returns 400 when prFixItem.id is missing", async () => {
    const res = await postRequest({ ...validReport, prFixItem: { generation: 2 } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/prFixItem.id must be a non-empty string/);
  });

  it("returns 400 when prFixItem.id is empty/whitespace", async () => {
    const res = await postRequest({ ...validReport, prFixItem: { id: "   ", generation: 2 } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/prFixItem.id must be a non-empty string/);
  });

  it("returns 400 when prFixItem.generation is missing", async () => {
    const res = await postRequest({ ...validReport, prFixItem: { id: "cktz-abc" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/prFixItem.generation must be an integer >= 1/);
  });

  it("returns 400 when prFixItem.generation is not an integer", async () => {
    const res = await postRequest({ ...validReport, prFixItem: { id: "cktz-abc", generation: 1.5 } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/prFixItem.generation must be an integer >= 1/);
  });

  it("returns 400 when prFixItem.generation is below 1", async () => {
    const res = await postRequest({ ...validReport, prFixItem: { id: "cktz-abc", generation: 0 } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/prFixItem.generation must be an integer >= 1/);
  });

  it("validation failures with a bad prFixItem create no AgentRun and resolve nothing", async () => {
    await postRequest({ ...validReport, prFixItem: { id: "", generation: 2 } });
    expect(mockAgentRun.create).not.toHaveBeenCalled();
    expect(prFixResolveMock).not.toHaveBeenCalled();
  });

  it("passes the attempt token through to PR-fix settlement", async () => {
    const res = await postRequest({
      ...validReport,
      prFixItem: { id: "  cktz-abc  ", generation: 3 },
    });
    expect(res.status).toBe(200);
    expect(prFixResolveMock).toHaveBeenCalledTimes(1);
    expect(prFixResolveMock).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: { itemId: "cktz-abc", generation: 3 } }),
    );
  });

  it("passes a null attempt when no prFixItem is provided (legacy report)", async () => {
    const res = await postRequest(validReport);
    expect(res.status).toBe(200);
    expect(prFixResolveMock).toHaveBeenCalledTimes(1);
    expect(prFixResolveMock).toHaveBeenCalledWith(expect.objectContaining({ attempt: null }));
  });

  it("a prFixItem change alters the report payload identity (idempotency)", async () => {
    const withToken = { ...validReport, idempotencyKey: "key-a", prFixItem: { id: "cktz", generation: 1 } };
    const first = await postRequest(withToken);
    expect(first.status).toBe(200);

    // Same key, same coordinates, but a different attempt token → different
    // payload → conflict, because settlement identity differs (#1074).
    const other = { ...validReport, idempotencyKey: "key-a", prFixItem: { id: "cktz", generation: 2 } };
    mockDedupe.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    mockDedupe.findUnique.mockResolvedValueOnce({
      id: "claim-1",
      agentName: "test-agent",
      idempotencyKey: "key-a",
      payloadHash: "hash-of-a-different-payload",
      agentRunId: "run-1",
      prFixResolution: null,
    });
    const conflict = await postRequest(other);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toContain("different report payload");
  });
});

describe("POST /api/agents/[agentName]/tasks/report — late/duplicate settlement (#1074)", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
  });

  const tokenReport = {
    taskType: "followup-pr",
    outcome: "pr_updated",
    repoFullName: "org/repo",
    pullRequestNumber: 10,
    prFixItem: { id: "cktz-abc", generation: 1 },
  };

  it("first keyed report persists the settlement resolution on the dedupe row for replay", async () => {
    prFixResolveMock.mockResolvedValueOnce({
      matched: true,
      action: "fixed",
      itemId: 7,
      reason: "pr merge state verified",
      attemptGeneration: 1,
    });

    const res = await postRequest({
      ...tokenReport,
      idempotencyKey: "worker-run-9:report",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prFixResolution.action).toBe("fixed");
    // The in-transaction agentRunId stamp is the first update; the
    // resolution store is the second — this is what a retry replays.
    expect(mockDedupe.update).toHaveBeenNthCalledWith(1, {
      where: { id: "claim-1" },
      data: { agentRunId: "run-1" },
    });
    expect(mockDedupe.update).toHaveBeenNthCalledWith(2, {
      where: { agentName_idempotencyKey: { agentName: "test-agent", idempotencyKey: "worker-run-9:report" } },
      data: { prFixResolution: expect.objectContaining({ action: "fixed" }) },
    });
  });

  it("a second report with a NEW key against the now-FIXED item is skipped and the skip is stored", async () => {
    prFixResolveMock
      .mockResolvedValueOnce({
        matched: true,
        action: "fixed",
        itemId: 7,
        reason: "pr merge state verified",
        attemptGeneration: 1,
      })
      .mockResolvedValueOnce({
        matched: true,
        action: "skipped",
        itemId: 7,
        reason: "pr-fix item already FIXED",
        attemptGeneration: 1,
      });

    const first = await postRequest({
      ...tokenReport,
      idempotencyKey: "worker-run-9:report",
    });
    expect(first.status).toBe(200);

    // A different logical report (new key) for the same repo/PR lands after
    // the first one settled the item.
    const second = await postRequest({
      ...tokenReport,
      idempotencyKey: "worker-run-9:report-2",
      prFixItem: { id: "cktz-abc", generation: 2 },
    });
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.duplicate).toBeUndefined();
    expect(body.prFixResolution.action).toBe("skipped");
    expect(body.prFixResolution.reason).toContain("already FIXED");
    // The skip is persisted for the second key's future retries too.
    expect(mockDedupe.update).toHaveBeenNthCalledWith(4, {
      where: { agentName_idempotencyKey: { agentName: "test-agent", idempotencyKey: "worker-run-9:report-2" } },
      data: { prFixResolution: expect.objectContaining({ action: "skipped" }) },
    });
  });
});
