import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findIssue: vi.fn().mockResolvedValue(null),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    createAuditLog: vi.fn().mockResolvedValue({ id: "log-1" }),
    updateIssueLabels: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      findUnique: mocks.findIssue,
      update: mocks.updateIssue,
    },
    auditLog: {
      create: mocks.createAuditLog,
    },
  },
}));

vi.mock("@/lib/github", () => ({
  updateIssueLabels: mocks.updateIssueLabels,
}));

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => ({
  isAuthorizedAgentToken: vi.fn((token) => token === mockToken),
  isAuthorizedBearerToken: vi.fn((token) => token === mockToken),
  getAcceptedAgentTokens: vi.fn(() => [mockToken]),
  resetCaches: vi.fn(),
}));

import { POST } from "./route";

function makePayload(overrides = {}) {
  return {
    issueId: "issue-1",
    repoFullName: "org/repo",
    issueNumber: 42,
    action: "unassign_agent" as const,
    ...overrides,
  };
}

function postRequest(payload = makePayload(), includeAuth = true) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (includeAuth) headers.Authorization = `Bearer ${mockToken}`;
  return POST(
    new Request("http://localhost/api/issues/unassign", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    })
  );
}

describe("POST /api/issues/unassign — auth", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/unassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makePayload()),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/unassign", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
        body: JSON.stringify(makePayload()),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when action is missing (with valid auth)", async () => {
    const res = await postRequest(makePayload({ action: undefined as unknown as "unassign_agent" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Missing required fields/);
  });

  it("returns 400 when issueId is missing", async () => {
    const res = await postRequest(makePayload({ issueId: undefined as unknown as string }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Missing required fields/);
  });

  it("returns 400 when repoFullName is missing", async () => {
    const res = await postRequest(makePayload({ repoFullName: undefined as unknown as string }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Missing required fields/);
  });

  it("returns 400 when issueNumber is missing", async () => {
    const res = await postRequest(makePayload({ issueNumber: undefined as unknown as number }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Missing required fields/);
  });

  it("returns 400 for invalid action", async () => {
    const res = await postRequest(makePayload({ action: "invalid" as const }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid action/);
  });

  it("returns 400 on malformed JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/unassign", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
        body: "not-json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on non-object JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/unassign", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
        body: JSON.stringify([1, 2]),
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/issues/unassign — unassign_agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findIssue.mockResolvedValue({
      id: "issue-1",
      labels: ["status/backlog", "agent/worker"],
    });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.updateIssueLabels.mockResolvedValue(undefined);
  });

  it("removes agent label and preserves other labels", async () => {
    const res = await postRequest();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.labels).not.toContain("agent/worker");
    expect(body.labels).toContain("status/backlog");
    expect(body.removed).toContain("agent/worker");

    expect(mocks.updateIssueLabels).toHaveBeenCalledWith(
      "org/repo",
      42,
      ["status/backlog"]
    );
  });

  it("removes all agent labels when multiple exist", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      labels: ["agent/dup1", "agent/dup2", "priority/p1"],
    });

    const res = await postRequest();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).not.toContain("agent/dup1");
    expect(body.labels).not.toContain("agent/dup2");
    expect(body.labels).toContain("priority/p1");
  });

  it("preserves owner labels when unassigning agent", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      labels: ["agent/worker", "owner/alice"],
    });

    const res = await postRequest();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).not.toContain("agent/worker");
    expect(body.labels).toContain("owner/alice");
  });

  it("returns 400 when no agent label exists", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      labels: ["status/backlog", "owner/alice"],
    });

    const res = await postRequest();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/No agent label found/);
  });

  it("returns 404 when issue is not found", async () => {
    mocks.findIssue.mockResolvedValueOnce(null);

    const res = await postRequest();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/Issue not found/);
  });
});

describe("POST /api/issues/unassign — unassign_owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findIssue.mockResolvedValue({
      id: "issue-1",
      labels: ["status/in-progress", "owner/alice"],
    });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.updateIssueLabels.mockResolvedValue(undefined);
  });

  it("removes owner label and preserves other labels", async () => {
    const res = await postRequest(makePayload({ action: "unassign_owner" as const }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.labels).not.toContain("owner/alice");
    expect(body.labels).toContain("status/in-progress");

    expect(mocks.updateIssueLabels).toHaveBeenCalledWith(
      "org/repo",
      42,
      ["status/in-progress"]
    );
  });

  it("preserves agent labels when unassigning owner", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      labels: ["agent/worker", "owner/alice"],
    });

    const res = await postRequest(makePayload({ action: "unassign_owner" as const }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).toContain("agent/worker");
    expect(body.labels).not.toContain("owner/alice");
  });

  it("returns 400 when no owner label exists", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      labels: ["status/backlog", "agent/worker"],
    });

    const res = await postRequest(makePayload({ action: "unassign_owner" as const }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/No owner label found/);
  });
});

describe("POST /api/issues/unassign — error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findIssue.mockResolvedValue({
      id: "issue-1",
      labels: ["status/backlog", "agent/worker"],
    });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  it("writes AuditLog with success=false when GitHub mutation fails", async () => {
    mocks.updateIssueLabels.mockRejectedValueOnce(new Error("github 500"));

    const res = await postRequest();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("github 500");

    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "unassign_agent",
        repoFullName: "org/repo",
        issueNumber: 42,
        success: false,
        errorMessage: "github 500",
      }),
    });
  });
});
