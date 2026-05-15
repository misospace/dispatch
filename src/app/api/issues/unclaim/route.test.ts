import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUnique: vi.fn().mockResolvedValue(null),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    createAuditLog: vi.fn().mockResolvedValue({ id: "log-1" }),
    removeIssueLabel: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      findUnique: mocks.findUnique,
      update: mocks.updateIssue,
    },
    auditLog: {
      create: mocks.createAuditLog,
    },
  },
}));

vi.mock("@/lib/github", () => ({
  removeIssueLabel: mocks.removeIssueLabel,
}));

import { POST } from "./route";

function makePayload(overrides = {}) {
  return {
    issueId: "issue-1",
    repoFullName: "org/repo",
    issueNumber: 42,
    agentName: "test-agent",
    ...overrides,
  };
}

function postRequest(payload = makePayload()) {
  return POST(
    new Request("http://localhost/api/issues/unclaim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
}

describe("POST /api/issues/unclaim — validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when agentName is missing", async () => {
    const res = await postRequest(makePayload({ agentName: undefined }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required fields: issueId, repoFullName, issueNumber, agentName");
  });

  it("returns 400 when agentName is not a string", async () => {
    const res = await postRequest(makePayload({ agentName: 123 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required fields: issueId, repoFullName, issueNumber, agentName");
  });

  it("returns 400 when repoFullName is missing", async () => {
    const res = await postRequest(makePayload({ repoFullName: undefined }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when issueNumber is missing", async () => {
    const res = await postRequest(makePayload({ issueNumber: undefined }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/unclaim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-object body", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/unclaim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([1, 2, 3]),
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/issues/unclaim — business logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({
      id: "issue-1",
      state: "open",
      labels: ["agent/test-agent"],
    } as never);
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.removeIssueLabel.mockResolvedValue(undefined);
  });

  it("removes agent label and updates local cache", async () => {
    const res = await postRequest();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");

    expect(mocks.updateIssue).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: expect.objectContaining({
        labels: [],
      }),
    });

    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "unclaim_issue",
        success: true,
        actor: "test-agent",
      }),
    });
  });

  it("returns 404 when issue not found in local cache", async () => {
    mocks.findUnique.mockResolvedValueOnce(null);

    const res = await postRequest();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Issue not found in local cache");
  });

  it("returns 400 when agent is not assigned to the issue", async () => {
    mocks.findUnique.mockResolvedValueOnce({
      id: "issue-1",
      state: "open",
      labels: ["agent/other-agent"],
    } as never);

    const res = await postRequest();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Issue is not assigned to test-agent");
  });

  it("returns 400 when no agent label exists", async () => {
    mocks.findUnique.mockResolvedValueOnce({
      id: "issue-1",
      state: "open",
      labels: [],
    } as never);

    const res = await postRequest();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Issue is not assigned to test-agent");
  });

  it("writes failure audit log when GitHub API fails", async () => {
    mocks.removeIssueLabel.mockRejectedValueOnce(new Error("github 500"));

    const res = await postRequest();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("github 500");

    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "unclaim_issue",
        success: false,
        errorMessage: "github 500",
      }),
    });
  });

  it("preserves other labels when removing agent label", async () => {
    mocks.findUnique.mockResolvedValueOnce({
      id: "issue-1",
      state: "open",
      labels: ["agent/test-agent", "status/in-progress", "priority/p1"],
    } as never);

    const res = await postRequest();
    expect(res.status).toBe(200);

    expect(mocks.updateIssue).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: expect.objectContaining({
        labels: ["status/in-progress", "priority/p1"],
      }),
    });
  });
});
