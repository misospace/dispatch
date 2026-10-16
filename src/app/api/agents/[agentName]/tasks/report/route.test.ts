import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock(mockToken, { "test-worker-token": "worker" }, { "bound-token": "alpha" }));

const { mocks, mockAgentRun, mockDedupe, prFixResolveMock, closeResolveMock, prismaMock, getLiveIssueLabelsMock } = vi.hoisted(() => {
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
    issueLifecycleEvent: {
      create: vi.fn().mockResolvedValue({ id: "evt-1" }),
      upsert: vi.fn().mockResolvedValue({ id: "evt-1" }),
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
    closeResolveMock: vi.fn().mockResolvedValue({
      matched: true,
      action: "closed",
      reason: "issue closed after the close policy was satisfied",
      reasons: [],
      repoFullName: "org/repo",
      issueNumber: 42,
      headSha: "abc123",
      evidenceDigest: "digest",
      criteria: [{ criterion: "Login redirects", path: "src/auth/login.ts" }],
    }),
    mocks: {
      repoFindUnique: prismaMock.repository.findUnique,
      issueFindUnique: prismaMock.issue.findUnique,
    },
    prismaMock,
    getLiveIssueLabelsMock: vi.fn(),
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
  MAX_EVIDENCE_LENGTH: 2000,
}));

vi.mock("@/lib/report-close", () => ({
  resolveAlreadyDoneFromAgentReport: closeResolveMock,
}));

vi.mock("@/lib/claim-gate", () => ({
  getLiveIssueLabels: getLiveIssueLabelsMock,
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

  it("rejects retired groom task reports", async () => {
    const res = await postRequest({ taskType: "groom", outcome: "issue_updated" });
    expect(res.status).toBe(400);
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
      "already_addressed",
      "handed-off",
      "waiting-external",
    ];

    for (const outcome of validOutcomes) {
      const res = await postRequest({ taskType: "implement", outcome });
      expect(res.status).toBe(200);
    }
  });

  it("accepts all valid taskTypes", async () => {
    const validTaskTypes = ["implement", "followup-pr"];

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

  it("forwards trimmed evidence to the pr-fix resolver for an already_addressed report", async () => {
    const res = await postRequest({
      taskType: "followup-pr",
      outcome: "already_addressed",
      repoFullName: "o/r",
      pullRequestNumber: 5,
      evidence: "  already addressed in commit abc123  ",
      prFixItem: { id: "item-1", generation: 1 },
    });
    expect(res.status).toBe(200);
    expect(prFixResolveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "already_addressed",
        evidence: "already addressed in commit abc123",
      }),
    );
  });

  it("ignores evidence on a non-already_addressed outcome so it stays out of the payload", async () => {
    const res = await postRequest({
      taskType: "followup-pr",
      outcome: "pr_updated",
      repoFullName: "o/r",
      pullRequestNumber: 5,
      evidence: "should be ignored",
      prFixItem: { id: "item-1", generation: 1 },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Evidence is scoped to already_addressed before the resolver sees it and
    // before the idempotency hash is computed, so it must be absent here.
    expect(body.report.evidence).toBeUndefined();
    const arg = prFixResolveMock.mock.calls.at(-1)?.[0];
    expect(arg.evidence).toBeUndefined();
  });

  it("returns 400 when evidence exceeds MAX_EVIDENCE_LENGTH for an already_addressed report", async () => {
    const res = await postRequest({
      taskType: "followup-pr",
      outcome: "already_addressed",
      repoFullName: "o/r",
      pullRequestNumber: 5,
      evidence: "x".repeat(2001),
      prFixItem: { id: "item-1", generation: 1 },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/2000/);
  });

  it("returns 400 when evidence is present but not a string", async () => {
    const res = await postRequest({
      taskType: "followup-pr",
      outcome: "already_addressed",
      repoFullName: "o/r",
      pullRequestNumber: 5,
      evidence: 123,
      prFixItem: { id: "item-1", generation: 1 },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/evidence must be a string/);
  });
});

describe("POST /api/agents/[agentName]/tasks/report — structured block outcome (#1218)", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
  });

  const blockedReport = {
    taskType: "followup-pr",
    outcome: "blocked",
    repoFullName: "o/r",
    pullRequestNumber: 5,
    prFixItem: { id: "item-1", generation: 1 },
  };

  it("passes a human_decision blockReason and decision payload through to the resolver", async () => {
    const decision = { question: "Which behavior?", options: ["keep", "change"], evidence: "see thread" };
    const res = await postRequest({
      ...blockedReport,
      blockReason: "human_decision",
      decision,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.blockReason).toBe("human_decision");
    expect(body.report.decision).toEqual(decision);
    expect(prFixResolveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "blocked",
        blockReason: "human_decision",
        decision,
      }),
    );
  });

  it("accepts a blocked report without a blockReason (bare give-up → parked)", async () => {
    const res = await postRequest({ ...blockedReport });

    expect(res.status).toBe(200);
    expect(prFixResolveMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "blocked", blockReason: undefined }),
    );
  });

  it("returns 400 for an invalid blockReason", async () => {
    const res = await postRequest({ ...blockedReport, blockReason: "not-a-real-outcome" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/blockReason/);
    expect(mockAgentRun.create).not.toHaveBeenCalled();
    expect(prFixResolveMock).not.toHaveBeenCalled();
  });

  it("returns 400 when blockReason is not a string", async () => {
    const res = await postRequest({ ...blockedReport, blockReason: 42 });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/blockReason/);
  });

  it("returns 400 when decision is not a non-array object", async () => {
    const asString = await postRequest({ ...blockedReport, decision: "nope" });
    expect(asString.status).toBe(400);
    expect((await asString.json()).error).toMatch(/decision must be an object/);

    const asArray = await postRequest({ ...blockedReport, decision: ["a", "b"] });
    expect(asArray.status).toBe(400);
    expect((await asArray.json()).error).toMatch(/decision must be an object/);
  });

  it("returns 400 when decision fields are malformed", async () => {
    const badQuestion = await postRequest({ ...blockedReport, decision: { question: 123 } });
    expect(badQuestion.status).toBe(400);
    expect((await badQuestion.json()).error).toMatch(/decision\.question/);

    const badOptions = await postRequest({ ...blockedReport, decision: { options: "not-an-array" } });
    expect(badOptions.status).toBe(400);
    expect((await badOptions.json()).error).toMatch(/decision\.options/);

    const nonStringOptions = await postRequest({ ...blockedReport, decision: { options: ["ok", 5] } });
    expect(nonStringOptions.status).toBe(400);
    expect((await nonStringOptions.json()).error).toMatch(/decision\.options/);

    const badEvidence = await postRequest({ ...blockedReport, decision: { evidence: 5 } });
    expect(badEvidence.status).toBe(400);
    expect((await badEvidence.json()).error).toMatch(/decision\.evidence/);
  });

  it("normalizes a valid decision payload (trims strings, drops empty options)", async () => {
    const res = await postRequest({
      ...blockedReport,
      blockReason: "human_decision",
      decision: { question: "  Which?  ", options: ["  A  ", "", "B"], evidence: "  ctx  " },
    });

    expect(res.status).toBe(200);
    expect(prFixResolveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: { question: "Which?", options: ["A", "B"], evidence: "ctx" },
      }),
    );
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

describe("POST /api/agents/[agentName]/tasks/report — startedAt (#1120)", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
  });

  it("stores a valid worker-reported startedAt as the run start (duration > 0)", async () => {
    const startInstant = new Date(Date.now() - 60 * 60 * 1000);
    const startedAtIso = startInstant.toISOString();
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      startedAt: startedAtIso,
    });

    expect(res.status).toBe(200);
    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.startedAt).toBeInstanceOf(Date);
    expect(call.startedAt.getTime()).toBe(startInstant.getTime());
    expect(call.finishedAt).toBeInstanceOf(Date);
    expect(call.finishedAt.getTime()).toBeGreaterThanOrEqual(call.startedAt.getTime());
    expect(call.finishedAt.getTime() - call.startedAt.getTime()).toBeGreaterThan(0);
  });

  it("falls back to the report time when startedAt is missing (startedAt ≈ finishedAt)", async () => {
    const before = Date.now();
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
    });
    const after = Date.now();

    expect(res.status).toBe(200);
    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.startedAt).toBeInstanceOf(Date);
    expect(call.finishedAt).toBeInstanceOf(Date);
    // Same instant: both collapse to the report time.
    expect(call.startedAt.getTime()).toBe(call.finishedAt.getTime());
    expect(call.finishedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(call.finishedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("falls back to the report time when startedAt is a malformed string", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      startedAt: "not-a-date",
    });

    expect(res.status).toBe(200);
    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.startedAt.getTime()).toBe(call.finishedAt.getTime());
  });

  it("falls back to the report time when startedAt is a number (no 400)", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      startedAt: 123,
    });

    expect(res.status).toBe(200);
    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.startedAt.getTime()).toBe(call.finishedAt.getTime());
  });

  it("falls back to the report time when startedAt is an object (no 400)", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      startedAt: {},
    });

    expect(res.status).toBe(200);
    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.startedAt.getTime()).toBe(call.finishedAt.getTime());
  });

  it("falls back to the report time when startedAt is an empty string", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      startedAt: "",
    });

    expect(res.status).toBe(200);
    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.startedAt.getTime()).toBe(call.finishedAt.getTime());
  });

  it("falls back to the report time when startedAt is in the future", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      startedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    expect(res.status).toBe(200);
    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.startedAt.getTime()).toBe(call.finishedAt.getTime());
  });

  it("falls back to the report time when startedAt is older than 24h", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });

    expect(res.status).toBe(200);
    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.startedAt.getTime()).toBe(call.finishedAt.getTime());
  });

  it("accepts a startedAt ~23h old (24h bound is not over-eager)", async () => {
    const startInstant = new Date(Date.now() - 23 * 60 * 60 * 1000);
    const startedAtIso = startInstant.toISOString();
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      startedAt: startedAtIso,
    });

    expect(res.status).toBe(200);
    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.startedAt.getTime()).toBe(startInstant.getTime());
    expect(call.finishedAt.getTime() - call.startedAt.getTime()).toBeGreaterThan(0);
  });

  it("echoes the normalized startedAt in the response for a valid value", async () => {
    const startInstant = new Date(Date.now() - 60 * 60 * 1000);
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      startedAt: startInstant.toISOString(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.startedAt).toBe(startInstant.toISOString());
  });

  it("omits startedAt from the response when the value is invalid", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      startedAt: "not-a-date",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.startedAt).toBeUndefined();
  });

  it("reports differing only by startedAt hash to distinct idempotency payload hashes", async () => {
    const base = {
      taskType: "implement",
      outcome: "pr_opened",
      idempotencyKey: "worker-run-1:report",
    };
    const first = await postRequest({
      ...base,
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const second = await postRequest({
      ...base,
      startedAt: new Date(Date.now() - 120 * 60 * 60 * 1000).toISOString(),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mockDedupe.create).toHaveBeenCalledTimes(2);
    const hashA = mockDedupe.create.mock.calls[0][0].data.payloadHash;
    const hashB = mockDedupe.create.mock.calls[1][0].data.payloadHash;
    expect(hashA).not.toBe(hashB);
  });

  it("falls back to the report time for malformed formats (bare-year, date-only, locale string)", async () => {
    const malformedFormats = ["2026", "2026-10-02", "10/02/2026 12:00"];

    for (const startedAt of malformedFormats) {
      const res = await postRequest({
        taskType: "implement",
        outcome: "pr_opened",
        startedAt,
      });

      expect(res.status).toBe(200);
      const call = mockAgentRun.create.mock.calls.at(-1)![0].data;
      expect(call.startedAt).toBeInstanceOf(Date);
      expect(call.finishedAt).toBeInstanceOf(Date);
      // Malformed → collapsed to the report time: within ~2s of finishedAt.
      expect(Math.abs(call.startedAt.getTime() - call.finishedAt.getTime())).toBeLessThan(2000);
      // And the response must not echo the malformed value.
      const body = await res.json();
      expect(body.report.startedAt).toBeUndefined();
    }
  });

  it("accepts a python-isoformat offset (+00:00) as a valid startedAt", async () => {
    const startInstant = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const pythonIso = startInstant.toISOString().replace("Z", "+00:00");
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      startedAt: pythonIso,
    });

    expect(res.status).toBe(200);
    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.startedAt).toBeInstanceOf(Date);
    expect(call.startedAt.getTime()).toBe(startInstant.getTime());
  });

  it("accepts a non-zero UTC offset (+05:30) and stores the normalized UTC instant", async () => {
    const startInstant = new Date(Date.now() - 2 * 60 * 60 * 1000);
    // Same instant rendered in a +05:30 zone: shift the UTC clock by the
    // offset and tag the reading with it.
    const shifted = new Date(startInstant.getTime() + 5.5 * 60 * 60 * 1000);
    const startedAt = shifted.toISOString().replace("Z", "+05:30");
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      startedAt,
    });

    expect(res.status).toBe(200);
    const call = mockAgentRun.create.mock.calls[0][0].data;
    expect(call.startedAt).toBeInstanceOf(Date);
    // Proves TZ conversion, not just acceptance: the stored instant equals
    // the UTC reading, not the +05:30 clock reading.
    expect(call.startedAt.toISOString()).toBe(startInstant.toISOString());
  });

  it("accepts a startedAt exactly 24h old (24h bound is inclusive)", async () => {
    const T0 = new Date("2026-10-03T12:00:00Z").getTime();
    const startedAtIso = new Date(T0 - 24 * 60 * 60 * 1000).toISOString();

    vi.useFakeTimers({ now: T0 });
    try {
      const res = await postRequest({
        taskType: "implement",
        outcome: "pr_opened",
        startedAt: startedAtIso,
      });

      expect(res.status).toBe(200);
      const call = mockAgentRun.create.mock.calls[0][0].data;
      expect(call.startedAt).toBeInstanceOf(Date);
      expect(call.startedAt.getTime()).toBe(T0 - 24 * 60 * 60 * 1000);
      // Accepted: the run kept the worker-reported start, not the report
      // time (a fallback would collapse startedAt onto finishedAt).
      expect(call.startedAt.getTime()).not.toBe(call.finishedAt.getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("an identical-body retry keeps the same payload hash across the 24h boundary (duplicate, not 409)", async () => {
    const T0 = new Date("2026-10-03T12:00:00Z").getTime();
    const startedAtIso = new Date(T0 - 23 * 60 * 60 * 1000).toISOString();
    const body = {
      taskType: "implement",
      outcome: "issue_updated",
      idempotencyKey: "key-stability",
      startedAt: startedAtIso,
    };

    vi.useFakeTimers({ now: T0 });
    try {
      const first = await postRequest(body);
      expect(first.status).toBe(200);
      const payloadHash = mockDedupe.create.mock.calls[0][0].data.payloadHash;

      // 25h later: the same startedAt string is now 48h old and no longer
      // accepted, so the validated report changes — but the RAW-body hash
      // must stay the same, so the retry dedupes instead of 409ing.
      vi.setSystemTime(T0 + 25 * 60 * 60 * 1000);

      mockDedupe.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
        }),
      );
      mockDedupe.findUnique.mockResolvedValueOnce({
        id: "claim-1",
        agentName: "test-agent",
        idempotencyKey: "key-stability",
        payloadHash,
        agentRunId: "run-1",
        prFixResolution: null,
      });

      const retry = await postRequest(body);

      expect(retry.status).toBe(200);
      expect(retry.status).not.toBe(409);
      const retryBody = await retry.json();
      expect(retryBody.duplicate).toBe(true);
      expect(retryBody.agentRunId).toBe("run-1");
    } finally {
      vi.useRealTimers();
    }
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

  it.each(["implement", "followup-pr"])("persists %s handoff identity without duplicate lifecycle writes", async (taskType) => {
    mocks.repoFindUnique.mockResolvedValueOnce({ id: "repo-1" });
    mocks.issueFindUnique.mockResolvedValueOnce({ id: "issue-42" });
    const body = { ...keyedBody, taskType, outcome: "handed-off", issueNumber: 42, pullRequestUrl: "https://github.com/org/repo/pull/12" };
    const first = await postRequest(body);
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson.report).toMatchObject({ outcome: "handed-off", issueNumber: 42, pullRequestNumber: 12, pullRequestUrl: body.pullRequestUrl });
    expect(firstJson.report.repoFullName).toBe("org/repo");
    expect(mockAgentRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        runType: taskType,
        status: "handed-off",
        issueId: "issue-42",
        finishedAt: expect.any(Date),
        touchedIssueUrls: ["https://github.com/org/repo/issues/42", body.pullRequestUrl],
      }),
    }));
    expect(prFixResolveMock).toHaveBeenCalledTimes(1);
    expect(prFixResolveMock.mock.calls[0][0].outcome).toBe("handed-off");

    const payloadHash = mockDedupe.create.mock.calls[0][0].data.payloadHash;
    mockDedupe.create.mockRejectedValueOnce(p2002());
    mockDedupe.findUnique.mockResolvedValueOnce({
      id: "claim-1", agentName: "test-agent", idempotencyKey: body.idempotencyKey,
      payloadHash, agentRunId: "run-1", prFixResolution: firstJson.prFixResolution,
    });
    const retry = await postRequest(body);
    expect(retry.status).toBe(200);
    const retryJson = await retry.json();
    expect(retryJson.duplicate).toBe(true);
    expect(retryJson.agentRunId).toBe(firstJson.agentRunId);
    expect(retryJson.prFixResolution).toEqual(firstJson.prFixResolution);
    expect(mockAgentRun.create).toHaveBeenCalledTimes(1);
    expect(prFixResolveMock).toHaveBeenCalledTimes(1);
  });

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

describe("POST /api/agents/[agentName]/tasks/report — capacity exhaustion handoff", () => {
  const validReport = { taskType: "followup-pr", outcome: "pr_updated", repoFullName: "org/repo", pullRequestNumber: 10 };

  it("requires a recognized capacity identifier and issued PR-fix attempt token", async () => {
    const missingCapacity = await postRequest({ ...validReport, taskType: "followup-pr", outcome: "capacity-exhausted", prFixItem: { id: "item-1", generation: 1, handoutToken: "hnd_deadbeef00" } });
    expect(missingCapacity.status).toBe(400);
    const missingAttempt = await postRequest({ ...validReport, taskType: "followup-pr", outcome: "capacity-exhausted", capacity: "provider/model" });
    expect(missingAttempt.status).toBe(400);
    // #1256 review: the per-hand-out receipt token is a hard gate for this
    // outcome — (id, generation) alone cannot identify the exact hand-out.
    const missingReceipt = await postRequest({ ...validReport, taskType: "followup-pr", outcome: "capacity-exhausted", capacity: "provider/model", prFixItem: { id: "item-1", generation: 1 } });
    expect(missingReceipt.status).toBe(400);
    expect((await missingReceipt.json()).error).toMatch(/handoutToken/);
  });

  it("passes the normalized capacity and issued attempt token to the resolver", async () => {
    const response = await postRequest({
      ...validReport, taskType: "followup-pr", outcome: "capacity-exhausted",
      capacity: "  provider/model  ", prFixItem: { id: "item-1", generation: 2, handoutToken: "  hnd_deadbeef00  " },
    });
    expect(response.status).toBe(200);
    expect(prFixResolveMock).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "capacity-exhausted", capacity: "provider/model",
      attempt: { itemId: "item-1", generation: 2, handoutToken: "hnd_deadbeef00" },
    }));
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

  it.each(["implement", "followup-pr"] as const)("accepts waiting-external for %s and records a neutral run", async (taskType) => {
    const body = { ...validReport, taskType, outcome: "waiting-external", error: "missing prerequisite: X", ...(taskType === "followup-pr" ? { prFixItem: { id: "cktz-abc", generation: 2 } } : {}) };
    const res = await postRequest(body);
    expect(res.status).toBe(200);
    expect(prFixResolveMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "waiting-external", error: "missing prerequisite: X", attempt: taskType === "followup-pr" ? { itemId: "cktz-abc", generation: 2 } : null }));
    expect(mockAgentRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "waiting-external" }) }));
  });

  it("passes a structured externalWait contract through to the queue resolver (#1250)", async () => {
    const externalWait = { kind: "upstream_pr", ref: "org/deps#7", evidence: "upstream PR open", trigger: { kind: "merged" } };
    const body = { ...validReport, taskType: "followup-pr" as const, outcome: "waiting-external", error: "missing prerequisite: X", externalWait, prFixItem: { id: "cktz-abc", generation: 2 } };
    const res = await postRequest(body);
    expect(res.status).toBe(200);
    expect(prFixResolveMock).toHaveBeenCalledWith(expect.objectContaining({ externalWait }));
  });

  it("400s when externalWait is not an object (#1250)", async () => {
    const res = await postRequest({ ...validReport, outcome: "waiting-external", externalWait: "upstream", prFixItem: { id: "cktz-abc", generation: 2 } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/externalWait must be an object/);
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

describe("POST /api/agents/[agentName]/tasks/report — bound worker scope (#1129)", () => {
  beforeEach(() => {
    resetAuthCaches();
    vi.clearAllMocks();
  });

  it("denies a bound worker reporting for another agent", async () => {
    const res = await POST(
      authedRequest("http://localhost/api/agents/bravo/tasks/report", {
        method: "POST",
        token: "bound-token",
        body: { taskType: "implement", outcome: "pr_opened" },
      }),
      { params: Promise.resolve({ agentName: "bravo" }) },
    );
    expect(res.status).toBe(403);
    expect(mockAgentRun.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/agents/[agentName]/tasks/report — hard cutover (#1129)", () => {
  beforeEach(() => {
    resetAuthCaches();
    vi.clearAllMocks();
  });

  it("denies an unbound legacy worker token", async () => {
    const res = await POST(
      authedRequest("http://localhost/api/agents/alpha/tasks/report", {
        method: "POST",
        token: "test-worker-token",
        body: { taskType: "implement", outcome: "pr_opened" },
      }),
      { params: Promise.resolve({ agentName: "alpha" }) },
    );
    expect(res.status).toBe(403);
    expect(mockAgentRun.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/agents/[agentName]/tasks/report — already_done close (#1143)", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
  });

  const groundedCriterion = {
    criterion: "Login redirects after password reset",
    path: "src/auth/login.ts",
    excerpt: 'return session.returnTo ?? "/";',
  };

  const validBody = {
    taskType: "implement",
    outcome: "already_done",
    repoFullName: "org/repo",
    issueNumber: 42,
    idempotencyKey: "worker-run-1:already_done",
    close: { criteria: [groundedCriterion] },
  };

  function p2002(): Error {
    return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
  }

  it.each([
    { taskType: "followup-pr", prFixItem: undefined },
    { taskType: "followup-pr", prFixItem: { id: "item-1", generation: 1 } },
    { taskType: "implement", prFixItem: { id: "item-1", generation: 1 } },
  ])("rejects already_done for $taskType with invalid task/token combination before side effects", async ({ taskType, prFixItem }) => {
    const res = await postRequest({ ...validBody, taskType, ...(prFixItem ? { prFixItem } : {}) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/only valid for implement reports without prFixItem/);
    expect(mockAgentRun.create).not.toHaveBeenCalled();
    expect(mockDedupe.create).not.toHaveBeenCalled();
    expect(prFixResolveMock).not.toHaveBeenCalled();
    expect(closeResolveMock).not.toHaveBeenCalled();
  });

  it("returns 400 when already_done has no idempotencyKey", async () => {
    const { idempotencyKey: _omit, ...body } = validBody;
    const res = await postRequest(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/idempotencyKey/);
    expect(closeResolveMock).not.toHaveBeenCalled();
  });

  it("returns 400 when already_done has no repoFullName/issueNumber", async () => {
    const { repoFullName: _r, issueNumber: _i, ...body } = validBody;
    const res = await postRequest(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/repoFullName and issueNumber/);
  });

  it("returns 400 when close is missing", async () => {
    const { close: _c, ...body } = validBody;
    const res = await postRequest(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/close must be an object/);
  });

  it("returns 400 when close.criteria is empty", async () => {
    const res = await postRequest({ ...validBody, close: { criteria: [] } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/close.criteria must have between/);
  });

  it("returns 400 when close.criteria exceeds the limit", async () => {
    const criteria = Array.from({ length: 13 }, () => groundedCriterion);
    const res = await postRequest({ ...validBody, close: { criteria } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/close.criteria must have between/);
  });

  it("returns 400 when a criterion item is not an object", async () => {
    const res = await postRequest({ ...validBody, close: { criteria: ["nope"] } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/close.criteria\[0\] must be an object/);
  });

  it("returns 400 when a criterion path is not a repository file path", async () => {
    const res = await postRequest({
      ...validBody,
      close: { criteria: [{ ...groundedCriterion, path: "not a path!" }] },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/path must be a repository file path/);
  });

  it("returns 400 when a criterion has no criterion text", async () => {
    const res = await postRequest({
      ...validBody,
      close: { criteria: [{ ...groundedCriterion, criterion: "   " }] },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/criterion must be a non-empty string/);
  });

  it("returns 400 when a criterion excerpt is not a string", async () => {
    const res = await postRequest({
      ...validBody,
      close: { criteria: [{ ...groundedCriterion, excerpt: 123 }] },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/excerpt must be a non-empty string/);
  });

  it("returns 200 and runs the close resolver for a valid already_done report", async () => {
    const res = await postRequest({ ...validBody, evidence: "  shipped in abc123  " });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.closeResolution).toEqual(
      expect.objectContaining({ action: "closed", repoFullName: "org/repo", issueNumber: 42 }),
    );
    expect(closeResolveMock).toHaveBeenCalledTimes(1);
    const arg = closeResolveMock.mock.calls[0][0];
    expect(arg).toEqual(
      expect.objectContaining({
        repoFullName: "org/repo",
        issueNumber: 42,
        actor: "test-agent",
        criteria: [groundedCriterion],
        evidence: "shipped in abc123",
        client: prismaMock,
      }),
    );
  });

  it("persists the close resolution on the idempotency claim", async () => {
    await postRequest(validBody);
    expect(mockDedupe.update).toHaveBeenCalledWith({
      where: { agentName_idempotencyKey: { agentName: "test-agent", idempotencyKey: validBody.idempotencyKey } },
      data: { closeResolution: expect.objectContaining({ action: "closed" }) },
    });
  });

  it("replays the stored close resolution on an idempotent retry without re-closing", async () => {
    const first = await postRequest(validBody);
    const payloadHash = mockDedupe.create.mock.calls[0][0].data.payloadHash;
    expect(first.status).toBe(200);

    mockDedupe.create.mockRejectedValueOnce(p2002());
    mockDedupe.findUnique.mockResolvedValueOnce({
      id: "claim-1",
      agentName: "test-agent",
      idempotencyKey: validBody.idempotencyKey,
      payloadHash,
      agentRunId: "run-1",
      prFixResolution: null,
      closeResolution: {
        matched: true,
        action: "closed",
        reason: "issue closed after the close policy was satisfied",
        reasons: [],
        repoFullName: "org/repo",
        issueNumber: 42,
        headSha: "abc123",
        evidenceDigest: "digest",
        criteria: [{ criterion: "Login redirects", path: "src/auth/login.ts" }],
      },
    });

    const retry = await postRequest(validBody);
    expect(retry.status).toBe(200);
    const body = await retry.json();
    expect(body.duplicate).toBe(true);
    expect(body.closeResolution.action).toBe("closed");
    // The close resolver ran only for the first report, never the replay.
    expect(closeResolveMock).toHaveBeenCalledTimes(1);
  });

  it("settles followup-pr already_addressed with its generation token", async () => {
    const res = await postRequest({
      taskType: "followup-pr",
      outcome: "already_addressed",
      repoFullName: "o/r",
      pullRequestNumber: 5,
      evidence: "done",
      prFixItem: { id: "item-1", generation: 2 },
    });
    expect(res.status).toBe(200);
    expect(prFixResolveMock).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "already_addressed",
      attempt: { itemId: "item-1", generation: 2 },
    }));
  });

  it("does not route already_addressed through the close resolver", async () => {
    const res = await postRequest({
      taskType: "followup-pr",
      outcome: "already_addressed",
      repoFullName: "o/r",
      pullRequestNumber: 5,
      evidence: "done",
      prFixItem: { id: "item-1", generation: 1 },
    });
    expect(res.status).toBe(200);
    expect(prFixResolveMock).toHaveBeenCalledTimes(1);
    expect(closeResolveMock).not.toHaveBeenCalled();
  });

  it("does not route already_done through PR-fix settlement (no PR coordinates)", async () => {
    await postRequest(validBody);
    // The route still calls the shared resolver, which no-ops for already_done;
    // the important guarantee is that the close resolver ran and no pr-fix
    // side effects were attempted (no PR coordinates here).
    expect(prFixResolveMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "already_done" }));
    expect(closeResolveMock).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when repoFullName is not an owner/repo slug", async () => {
    const res = await postRequest({ ...validBody, repoFullName: "not a repo" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/owner\/repo slug/);
    expect(closeResolveMock).not.toHaveBeenCalled();
  });

  it("reports an honest skipped close resolution when the first attempt's outcome was not persisted", async () => {
    // First attempt: the AgentRun/claim commit, the PR-fix resolution
    // persists, then the close-resolution persistence fails, so the response
    // is a structured 5xx.
    mockDedupe.update
      .mockResolvedValueOnce({}) // in-transaction agentRunId stamp
      .mockResolvedValueOnce({}) // prFixResolution persistence
      .mockRejectedValueOnce(new Error("db hiccup")); // closeResolution persistence

    const first = await postRequest(validBody);
    expect(first.status).toBe(500);

    // Retry with the same key lands in the duplicate branch with no stored
    // closeResolution: the route must NOT claim a close and must NOT re-run it.
    mockDedupe.create.mockRejectedValueOnce(p2002());
    mockDedupe.findUnique.mockResolvedValueOnce({
      id: "claim-1",
      agentName: "test-agent",
      idempotencyKey: validBody.idempotencyKey,
      payloadHash: mockDedupe.create.mock.calls[0][0].data.payloadHash,
      agentRunId: "run-1",
      prFixResolution: null,
      closeResolution: null,
    });

    const retry = await postRequest(validBody);
    expect(retry.status).toBe(200);
    const body = await retry.json();
    expect(body.duplicate).toBe(true);
    expect(body.closeResolution.action).toBe("skipped");
    expect(body.closeResolution.reason).toContain("not re-run");
    // The close resolver ran only for the first attempt.
    expect(closeResolveMock).toHaveBeenCalledTimes(1);
  });

  it("lets a maintainer-tier caller submit already_done (audit actor is the path agent)", async () => {
    const res = await postRequest(validBody, "operator-agent");
    expect(res.status).toBe(200);
    expect(closeResolveMock).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "operator-agent", repoFullName: "org/repo", issueNumber: 42 }),
    );
  });

  it("does not pass boundAgent to the resolver for a maintainer-tier caller (no extra constraint)", async () => {
    // #1143 review of #1219 P1: maintainer / OIDC / basic / auth-disabled
    // callers leave `boundAgent` undefined so the apply-time freshness re-
    // check's independent bound-agent check is a no-op. Only the snapshot-
    // vs-final labels diff applies.
    const res = await postRequest(validBody, "operator-agent");
    expect(res.status).toBe(200);
    expect(closeResolveMock.mock.calls[0][0].boundAgent).toBeUndefined();
  });
});

describe("POST /api/agents/[agentName]/tasks/report — bound worker scope on already_done close (#1143 review of #1219)", () => {
  const BOUND = "bound-token";
  const boundBody = {
    taskType: "implement",
    outcome: "already_done",
    repoFullName: "org/repo",
    issueNumber: 42,
    idempotencyKey: "worker-run-bound:already_done",
    close: {
      criteria: [
        {
          criterion: "Login redirects after password reset",
          path: "src/auth/login.ts",
          excerpt: 'return session.returnTo ?? "/";',
        },
      ],
    },
  };

  function setupTrackedIssue() {
    // The default tracked state: the issue exists in Dispatch's cache with a
    // known id. Both `resolveIssueId` calls (the route's pre-AgentRun one and
    // the gate's) succeed. Override per-test to model an untracked issue.
    prismaMock.repository.findUnique.mockReset().mockResolvedValue({ id: "repo-1" });
    prismaMock.issue.findUnique.mockReset().mockResolvedValue({ id: "issue-42" });
    // #1143 review: re-establish default AgentReportDedupe/AgentRun behavior
    // so prior tests' `mockReset()` doesn't leave later requests returning
    // undefined (which becomes a 500 from the route's outer catch).
    mockDedupe.create.mockReset().mockResolvedValue({
      id: "claim-1",
      agentName: "test-agent",
      idempotencyKey: "key-1",
      payloadHash: "hash-1",
      agentRunId: null,
      prFixResolution: null,
    });
    mockDedupe.findUnique.mockReset().mockResolvedValue(null);
    mockDedupe.update.mockReset().mockResolvedValue({});
    getLiveIssueLabelsMock.mockReset();
  }

  function setupUntrackedIssue() {
    prismaMock.repository.findUnique.mockReset().mockResolvedValue(null);
    prismaMock.issue.findUnique.mockReset().mockResolvedValue(null);
  }

  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    setupTrackedIssue();
  });

  function workerRequest(body: unknown, agentName = "alpha") {
    return POST(
      authedRequest(`http://localhost/api/agents/${agentName}/tasks/report`, {
        method: "POST",
        token: BOUND,
        body,
      }),
      { params: Promise.resolve({ agentName }) },
    );
  }

  it("lets a bound worker close an issue live-assigned to it", async () => {
    getLiveIssueLabelsMock.mockReset().mockResolvedValueOnce(["agent/alpha", "priority/p1", "status/backlog"]);
    const res = await workerRequest(boundBody);
    expect(res.status).toBe(200);
    expect(getLiveIssueLabelsMock).toHaveBeenCalledWith("org/repo", 42);
    expect(closeResolveMock).toHaveBeenCalledTimes(1);
    // #1143 review of #1219 P1: the resolver receives the bound agent so the
    // apply-time freshness re-check independently enforces that the FINAL
    // live labels still assign the issue to agent/alpha — closing the
    // snapshot/final-read TOCTOU window the gate alone leaves open.
    expect(closeResolveMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ boundAgent: "alpha" }),
    );
  });

  it("denies (403) a bound worker closing an issue live-assigned to a different agent", async () => {
    getLiveIssueLabelsMock.mockReset().mockResolvedValueOnce(["agent/bravo", "priority/p1", "status/backlog"]);
    const res = await workerRequest(boundBody);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/agent "alpha" and may only close issues live-assigned/);
    // The close resolver must not run; the gate denies before it ever would.
    // (The in-transaction claim-update still runs for the AgentRun commit —
    // that's the durable idempotency claim, not a close write.)
    expect(closeResolveMock).not.toHaveBeenCalled();
    // No closeResolution persistence may follow a denial.
    expect(mockDedupe.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ closeResolution: expect.anything() }) }),
    );
  });

  it("denies (403) a bound worker closing an issue with no live agent label", async () => {
    getLiveIssueLabelsMock.mockReset().mockResolvedValueOnce(["priority/p1", "status/backlog"]);
    const res = await workerRequest(boundBody);
    expect(res.status).toBe(403);
    expect(closeResolveMock).not.toHaveBeenCalled();
  });

  it("denies (403) a bound worker closing an issue Dispatch does not track", async () => {
    setupUntrackedIssue();
    const res = await workerRequest(boundBody);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/not tracked/);
    expect(getLiveIssueLabelsMock).not.toHaveBeenCalled();
    expect(closeResolveMock).not.toHaveBeenCalled();
  });

  it("denies (503) when the live GitHub label fetch fails (fail closed)", async () => {
    getLiveIssueLabelsMock.mockReset().mockRejectedValue(new Error("github down"));
    const res = await workerRequest(boundBody);
    expect(res.status).toBe(503);
    expect(closeResolveMock).not.toHaveBeenCalled();
  });

  it("denies (403) an unbound legacy worker token from any already_done close", async () => {
    setupTrackedIssue();
    const res = await POST(
      authedRequest("http://localhost/api/alpha/tasks/report", {
        method: "POST",
        token: "test-worker-token",
        body: boundBody,
      }),
      { params: Promise.resolve({ agentName: "alpha" }) },
    );
    // Falls under the 403 from enforceWorkerAgentScope — an unbound token
    // cannot even act for "alpha", so the route short-circuits before the
    // already_done-specific scope check.
    expect(res.status).toBe(403);
    expect(closeResolveMock).not.toHaveBeenCalled();
  });

  it("bypasses the scope gate on idempotent replay (replays stored closed result)", async () => {
    // First request passes the gate, close resolver runs, dedupe persists the
    // closed resolution.
    getLiveIssueLabelsMock.mockReset().mockResolvedValue(["agent/alpha", "priority/p1", "status/backlog"]);
    const first = await workerRequest(boundBody);
    expect(first.status).toBe(200);
    expect(getLiveIssueLabelsMock).toHaveBeenCalledTimes(1);
    expect(closeResolveMock).toHaveBeenCalledTimes(1);

    const firstPayloadHash = mockDedupe.create.mock.calls[0][0].data.payloadHash;

    // Retry: simulate P2002 + findUnique returns the prior dedupe row with
    // the stored close resolution. The gate must NOT re-fire on replay.
    mockDedupe.create.mockReset().mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    mockDedupe.findUnique.mockReset().mockResolvedValueOnce({
      id: "claim-1",
      agentName: "alpha",
      idempotencyKey: boundBody.idempotencyKey,
      payloadHash: firstPayloadHash,
      agentRunId: "run-1",
      prFixResolution: null,
      closeResolution: {
        matched: true,
        action: "closed",
        reason: "issue closed after the close policy was satisfied",
        reasons: [],
        repoFullName: "org/repo",
        issueNumber: 42,
        headSha: "abc123",
        evidenceDigest: "digest",
        criteria: [{ criterion: "Login redirects", path: "src/auth/login.ts" }],
      },
    });

    const retry = await workerRequest(boundBody);
    expect(retry.status).toBe(200);
    const body = await retry.json();
    expect(body.duplicate).toBe(true);
    expect(body.closeResolution.action).toBe("closed");
    // Critical: the gate must not re-fetch live labels and the close resolver
    // must not re-fire on replay.
    expect(getLiveIssueLabelsMock).toHaveBeenCalledTimes(1);
    expect(closeResolveMock).toHaveBeenCalledTimes(1);
  });

  it("reports an honest skipped close on replay when the first attempt was denied at the gate", async () => {
    // First request: tracked but assigned to bravo — gate denies with 403,
    // but the dedupe commit ($transaction) still lands and stores no close
    // resolution. Idempotent replay must re-emit an honest "skipped" rather
    // than re-running the gate or the resolver.
    getLiveIssueLabelsMock.mockReset().mockResolvedValueOnce(["agent/bravo", "priority/p1", "status/backlog"]);
    const first = await workerRequest(boundBody);
    expect(first.status).toBe(403);
    expect(getLiveIssueLabelsMock).toHaveBeenCalledTimes(1);
    expect(closeResolveMock).not.toHaveBeenCalled();

    const firstPayloadHash = mockDedupe.create.mock.calls[0][0].data.payloadHash;

    mockDedupe.create.mockReset().mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    mockDedupe.findUnique.mockReset().mockResolvedValueOnce({
      id: "claim-1",
      agentName: "alpha",
      idempotencyKey: boundBody.idempotencyKey,
      payloadHash: firstPayloadHash,
      agentRunId: "run-1",
      prFixResolution: null,
      closeResolution: null,
    });

    const retry = await workerRequest(boundBody);
    expect(retry.status).toBe(200);
    const body = await retry.json();
    expect(body.duplicate).toBe(true);
    expect(body.closeResolution.action).toBe("skipped");
    expect(body.closeResolution.reason).toContain("not re-run");
    // The duplicate branch must NOT re-fire the gate or run the resolver.
    expect(getLiveIssueLabelsMock).toHaveBeenCalledTimes(1);
    expect(closeResolveMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/agents/[agentName]/tasks/report — lifecycle evidence (#1202)", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mockAgentRun.create.mockResolvedValue({
      id: "run-1",
      agentName: "test-agent",
      runType: "implement",
      status: "failed",
      startedAt: new Date(),
      finishedAt: new Date(),
      summary: null,
      errorMessage: null,
      touchedIssueUrls: [],
    });
    // A cached issue, so the report resolves to an issueId to attach evidence to.
    mocks.issueFindUnique.mockResolvedValue({ id: "issue-1" });
  });

  it("records a failed attempt as its own lifecycle fact", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "failed",
      repoFullName: "org/repo",
      issueNumber: 42,
      error: "tests failed",
    });

    expect(res.status).toBe(200);
    expect(prismaMock.issueLifecycleEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        issueId: "issue-1",
        repoFullName: "org/repo",
        issueNumber: 42,
        kind: "attempt_failed",
        source: "agent-report",
        actor: "test-agent",
        agentName: "test-agent",
        sourceEventId: "agent-run:run-1",
        metadata: { outcome: "failed", error: "tests failed" },
      }),
    });
  });

  it("records nothing for an ordinary successful report", async () => {
    const res = await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      repoFullName: "org/repo",
      issueNumber: 42,
    });

    expect(res.status).toBe(200);
    expect(prismaMock.issueLifecycleEvent.create).not.toHaveBeenCalled();
  });

  it("records nothing when the report could not resolve a cached issue", async () => {
    mocks.issueFindUnique.mockResolvedValue(null);

    const res = await postRequest({
      taskType: "implement",
      outcome: "blocked",
      repoFullName: "org/repo",
      issueNumber: 42,
    });

    expect(res.status).toBe(200);
    expect(prismaMock.issueLifecycleEvent.create).not.toHaveBeenCalled();
  });

  it("keeps the report successful when the evidence write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    prismaMock.issueLifecycleEvent.create.mockRejectedValueOnce(new Error("db down"));

    const res = await postRequest({
      taskType: "implement",
      outcome: "failed",
      repoFullName: "org/repo",
      issueNumber: 42,
    });

    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
  });
});
