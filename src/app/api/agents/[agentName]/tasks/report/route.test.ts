import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    issueFindMany: vi.fn(),
    issueUpdate: vi.fn(),
    prFixUpdate: vi.fn(),
    leaseDelete: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      findMany: mocks.issueFindMany,
      update: mocks.issueUpdate,
    },
    prFixQueueItem: {
      update: mocks.prFixUpdate,
    },
    lease: {
      delete: mocks.leaseDelete,
    },
  },
}));

import { POST } from "./route";

function postRequest(body: unknown, agentName = "test-agent") {
  return POST(
    new Request(`http://localhost/api/agents/${agentName}/tasks/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ agentName }) },
  );
}

describe("POST /api/agents/[agentName]/tasks/report", () => {
  beforeEach(() => {
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
    expect(body.agentName).toBe("test-agent");
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
        headers: { "Content-Type": "application/json" },
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

  it("response includes the route agentName", async () => {
    const res = await postRequest(
      { taskType: "implement", outcome: "pr_opened" },
      "my-special-agent",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentName).toBe("my-special-agent");
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

  it("does not mutate issue state", async () => {
    await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
      repoFullName: "org/repo",
      issueNumber: 42,
    });

    expect(mocks.issueUpdate).not.toHaveBeenCalled();
  });

  it("does not mutate PR-fix queue state", async () => {
    await postRequest({
      taskType: "followup-pr",
      outcome: "pr_updated",
      repoFullName: "org/repo",
      pullRequestNumber: 10,
    });

    expect(mocks.prFixUpdate).not.toHaveBeenCalled();
  });

  it("does not release leases", async () => {
    await postRequest({
      taskType: "implement",
      outcome: "pr_opened",
    });

    expect(mocks.leaseDelete).not.toHaveBeenCalled();
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
});
