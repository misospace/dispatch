import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUnique: vi.fn().mockResolvedValue(null),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    createAuditLog: vi.fn().mockResolvedValue({ id: "log-1" }),
    removeIssueLabel: vi.fn().mockResolvedValue(undefined),
    addIssueLabel: vi.fn().mockResolvedValue(undefined),
    updateIssueLabels: vi.fn().mockResolvedValue(undefined),
    releaseLeaseByAgentAndIssue: vi.fn().mockResolvedValue(undefined),
    releaseAgentWorkByAgentAndIssue: vi.fn().mockResolvedValue(0),
  },
}));

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

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
  addIssueLabel: mocks.addIssueLabel,
  updateIssueLabels: mocks.updateIssueLabels,
}));

vi.mock("@/lib/lease", () => ({
  releaseLeaseByAgentAndIssue: mocks.releaseLeaseByAgentAndIssue,
  releaseAgentWorkByAgentAndIssue: mocks.releaseAgentWorkByAgentAndIssue,
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

function postRequest(payload = makePayload(), extraHeaders = {}) {
  return POST(
    new Request("http://localhost/api/issues/unclaim", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}`, ...extraHeaders },
      body: JSON.stringify(payload),
    })
  );
}

describe("POST /api/issues/unclaim — auth", () => {
  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/unclaim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makePayload()),
      })
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/unclaim", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
        body: JSON.stringify(makePayload()),
      })
    );
    expect(res.status).toBe(401);
  });
});

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
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
        body: "not-json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-object body", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/unclaim", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
        body: JSON.stringify([1, 2, 3]),
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/issues/unclaim — agent self-unclaim (regression)", () => {
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
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.updateIssueLabels.mockResolvedValue(undefined);
    mocks.releaseLeaseByAgentAndIssue.mockResolvedValue(undefined);
    mocks.releaseAgentWorkByAgentAndIssue.mockResolvedValue(0);
  });

  it("removes agent label and writes unclaim_issue audit with agent actor", async () => {
    const res = await postRequest();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");

    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "unclaim_issue",
        success: true,
        actor: "test-agent",
      }),
    });
  });

  it("agent self-unclaim does NOT call releaseAgentWorkByAgentAndIssue", async () => {
    const res = await postRequest();
    expect(res.status).toBe(200);
    expect(mocks.releaseAgentWorkByAgentAndIssue).not.toHaveBeenCalled();
    expect(mocks.releaseLeaseByAgentAndIssue).toHaveBeenCalledWith("test-agent", "issue-1");
  });
});

describe("POST /api/issues/unclaim — operator path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({
      id: "issue-1",
      state: "open",
      labels: ["agent/test-agent", "status/in-progress"],
    } as never);
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.removeIssueLabel.mockResolvedValue(undefined);
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.updateIssueLabels.mockResolvedValue(undefined);
    mocks.releaseLeaseByAgentAndIssue.mockResolvedValue(undefined);
    mocks.releaseAgentWorkByAgentAndIssue.mockResolvedValue(1);
  });

  function basicAuthRequest() {
    const credentials = Buffer.from("alice:hunter2").toString("base64");
    return POST(
      new Request("http://localhost/api/issues/unclaim", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify(makePayload()),
      })
    );
  }

  async function withBasicAuth<T>(fn: () => Promise<T>): Promise<T> {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "alice";
    process.env.DISPATCH_AUTH_PASSWORD = "hunter2";
    const { resetAuthCaches } = await import("@/lib/auth");
    resetAuthCaches();
    try {
      return await fn();
    } finally {
      delete process.env.DISPATCH_AUTH_MODE;
      delete process.env.DISPATCH_AUTH_USERNAME;
      delete process.env.DISPATCH_AUTH_PASSWORD;
      resetAuthCaches();
    }
  }

  it("operator unclaim releases the lease via releaseLeaseByAgentAndIssue", async () => {
    await withBasicAuth(async () => {
      const res = await basicAuthRequest();
      expect(res.status).toBe(200);
      expect(mocks.releaseLeaseByAgentAndIssue).toHaveBeenCalledWith("test-agent", "issue-1");
    });
  });

  it("operator unclaim calls releaseAgentWorkByAgentAndIssue", async () => {
    await withBasicAuth(async () => {
      const res = await basicAuthRequest();
      expect(res.status).toBe(200);
      expect(mocks.releaseAgentWorkByAgentAndIssue).toHaveBeenCalledWith("test-agent", "issue-1");
    });
  });

  it("operator unclaim flips status/in-progress to status/ready on GitHub and in cache", async () => {
    await withBasicAuth(async () => {
      const res = await basicAuthRequest();
      expect(res.status).toBe(200);

      expect(mocks.updateIssueLabels).toHaveBeenCalledWith(
        "org/repo",
        42,
        expect.arrayContaining(["status/ready"]),
      );
      expect(mocks.updateIssueLabels).toHaveBeenCalledWith(
        "org/repo",
        42,
        expect.not.arrayContaining(["status/in-progress"]),
      );
      expect(mocks.updateIssue).toHaveBeenCalledWith({
        where: { id: "issue-1" },
        data: expect.objectContaining({
          labels: expect.arrayContaining(["status/ready"]),
        }),
      });
    });
  });

  it("operator unclaim writes unclaim_issue_by_operator audit with operator actor and notes", async () => {
    await withBasicAuth(async () => {
      const res = await basicAuthRequest();
      expect(res.status).toBe(200);

      expect(mocks.createAuditLog).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "unclaim_issue_by_operator",
          success: true,
          actor: "alice",
          notes: expect.stringContaining("test-agent"),
        }),
      });
    });
  });
});

describe("POST /api/issues/unclaim — guards", () => {
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
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.updateIssueLabels.mockResolvedValue(undefined);
    mocks.releaseLeaseByAgentAndIssue.mockResolvedValue(undefined);
    mocks.releaseAgentWorkByAgentAndIssue.mockResolvedValue(0);
  });

  it("returns 404 when issue not found in local cache", async () => {
    mocks.findUnique.mockResolvedValueOnce(null);

    const res = await postRequest();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Issue not found in local cache");
  });

  it("refuses to unclaim closed issues", async () => {
    mocks.findUnique.mockResolvedValueOnce({
      id: "issue-1",
      state: "closed",
      labels: ["agent/test-agent"],
    } as never);

    const res = await postRequest();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Cannot unclaim a closed issue");
  });

  it("refuses to unclaim done issues", async () => {
    mocks.findUnique.mockResolvedValueOnce({
      id: "issue-1",
      state: "open",
      labels: ["agent/test-agent", "status/done"],
    } as never);

    const res = await postRequest();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Cannot unclaim a done issue");
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
    mocks.updateIssueLabels.mockRejectedValueOnce(new Error("github 500"));

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
      labels: ["agent/test-agent", "priority/p1"],
    } as never);

    const res = await postRequest();
    expect(res.status).toBe(200);

    expect(mocks.updateIssue).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: expect.objectContaining({
        labels: ["priority/p1"],
      }),
    });
  });
});