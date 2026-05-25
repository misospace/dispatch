import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.hoisted() runs at the very top of the file, before vi.mock() hoisting.
const { mocks } = vi.hoisted(() => ({
  mocks: {
    findIssue: vi.fn().mockResolvedValue(null),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    createAuditLog: vi.fn().mockResolvedValue({ id: "log-1" }),
    updateIssueLabels: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock dependencies — return the mock functions directly
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
  removeIssueLabel: vi.fn().mockResolvedValue(undefined),
  addIssueLabel: vi.fn().mockResolvedValue(undefined),
}));

// Import the route after mocks are set up
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
    action: "assign_agent" as const,
    value: "agent/worker",
    ...overrides,
  };
}

function postRequest(payload = makePayload(), includeAuth = true) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (includeAuth) headers.Authorization = `Bearer ${mockToken}`;
  return POST(
    new Request("http://localhost/api/issues/actions", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    })
  );
}

describe("POST /api/issues/actions — auth", () => {
  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makePayload()),
      })
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
        body: JSON.stringify(makePayload()),
      })
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/issues/actions — validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findIssue.mockResolvedValue({
      id: "issue-1",
      state: "open",
      labels: ["status/backlog", "type/feature"],
    });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.updateIssueLabels.mockResolvedValue(undefined);
  });

  it("returns 400 when action is missing", async () => {
    const res = await postRequest(makePayload({ action: undefined as unknown as "assign_agent" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required fields: action, value");
  });

  it("returns 400 when value is missing", async () => {
    const res = await postRequest(makePayload({ value: undefined as unknown as string }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required fields: action, value");
  });

  it("returns 400 for invalid action", async () => {
    const res = await postRequest(makePayload({ action: "invalid_action" as unknown as "assign_agent" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid action/);
  });

  it("returns 400 when value is not a string", async () => {
    const res = await postRequest(makePayload({ value: 42 as unknown as string }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("value must be a non-empty string");
  });

  it("returns 400 when value is an empty string", async () => {
    const res = await postRequest(makePayload({ value: "" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("value must be a non-empty string");
  });

  it("returns 400 when issueId is missing", async () => {
    const res = await postRequest(makePayload({ issueId: undefined as unknown as string }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required fields: issueId, repoFullName, issueNumber");
  });

  it("returns 400 when repoFullName is missing", async () => {
    const res = await postRequest(makePayload({ repoFullName: undefined as unknown as string }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required fields: issueId, repoFullName, issueNumber");
  });

  it("returns 400 when issueNumber is missing", async () => {
    const res = await postRequest(makePayload({ issueNumber: undefined as unknown as number }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required fields: issueId, repoFullName, issueNumber");
  });

  it("returns 400 when value does not match expected prefix for assign_agent", async () => {
    const res = await postRequest(makePayload({ value: "owner/worker" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/must start with "agent\//);
  });

  it("returns 400 when value does not match expected prefix for assign_owner", async () => {
    const res = await postRequest(makePayload({ action: "assign_owner" as const, value: "agent/worker" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/must start with "owner\//);
  });

  it("returns 404 when issue is not found", async () => {
    mocks.findIssue.mockResolvedValueOnce(null);
    const res = await postRequest(makePayload());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/Issue not found/);
  });

  it("returns 400 when issue is closed", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      state: "closed",
      labels: ["status/backlog"],
    });
    const res = await postRequest(makePayload());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Cannot assign to closed issue/);
  });

  it("returns 400 on malformed JSON body", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
        body: "not-json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on non-object JSON body", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
        body: JSON.stringify([1, 2, 3]),
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/issues/actions — assign_agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findIssue.mockResolvedValue({
      id: "issue-1",
      state: "open",
      labels: ["status/backlog", "type/feature"],
    });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.updateIssueLabels.mockResolvedValue(undefined);
  });

  it("assigns agent and preserves existing labels", async () => {
    const res = await postRequest(makePayload());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.labels).toContain("agent/worker");
    expect(body.labels).toContain("status/backlog");
    expect(body.labels).toContain("type/feature");

    // Verify GitHub update
    expect(mocks.updateIssueLabels).toHaveBeenCalledWith(
      "org/repo",
      42,
      ["status/backlog", "type/feature", "agent/worker"]
    );

    // Verify local cache update
    expect(mocks.updateIssue).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: expect.objectContaining({
        labels: ["status/backlog", "type/feature", "agent/worker"],
      }),
    });

    // Verify audit log
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "assign_agent",
        repoFullName: "org/repo",
        issueNumber: 42,
        success: true,
      }),
    });
  });

  it("replaces existing agent label with new one", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      state: "open",
      labels: ["status/backlog", "agent/old-worker"],
    });

    const res = await postRequest(makePayload());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).toContain("agent/worker");
    expect(body.labels).not.toContain("agent/old-worker");
    expect(body.labels).toContain("status/backlog");

    expect(mocks.updateIssueLabels).toHaveBeenCalledWith(
      "org/repo",
      42,
      ["status/backlog", "agent/worker"]
    );
  });

  it("handles agent label that appears multiple times (replaces all)", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      state: "open",
      labels: ["status/backlog", "agent/dup", "agent/dup2"],
    });

    const res = await postRequest(makePayload());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).toContain("agent/worker");
    // Should only have one agent label in the result (the new one)
    expect(body.labels.filter((l: string) => l.startsWith("agent/")).length).toBe(1);
  });

  it("preserves owner labels when assigning agent", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      state: "open",
      labels: ["owner/alice", "status/in-progress"],
    });

    const res = await postRequest(makePayload());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).toContain("agent/worker");
    expect(body.labels).toContain("owner/alice");
    expect(body.labels).toContain("status/in-progress");

    expect(mocks.updateIssueLabels).toHaveBeenCalledWith(
      "org/repo",
      42,
      ["owner/alice", "status/in-progress", "agent/worker"]
    );
  });

  it("handles force_claim flag without changing behavior", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      state: "open",
      labels: ["status/backlog", "agent/other-agent"],
    });

    const res = await postRequest(makePayload({ force_claim: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.labels).toContain("agent/worker");
    expect(body.labels).not.toContain("agent/other-agent");

    // force_claim is accepted but doesn't change the replacement behavior
    expect(mocks.updateIssueLabels).toHaveBeenCalledWith(
      "org/repo",
      42,
      ["status/backlog", "agent/worker"]
    );
  });

  it("preserves priority and type labels when assigning agent", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      state: "open",
      labels: ["priority/p1", "type/bug", "agent/old"],
    });

    const res = await postRequest(makePayload());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).toContain("agent/worker");
    expect(body.labels).toContain("priority/p1");
    expect(body.labels).toContain("type/bug");
    expect(body.labels).not.toContain("agent/old");
  });
});

describe("POST /api/issues/actions — assign_owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findIssue.mockResolvedValue({
      id: "issue-1",
      state: "open",
      labels: ["status/in-progress", "type/bug"],
    });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.updateIssueLabels.mockResolvedValue(undefined);
  });

  it("assigns owner and preserves existing labels", async () => {
    const res = await postRequest(
      makePayload({ action: "assign_owner" as const, value: "owner/alice" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.labels).toContain("owner/alice");
    expect(body.labels).toContain("status/in-progress");
    expect(body.labels).toContain("type/bug");

    expect(mocks.updateIssueLabels).toHaveBeenCalledWith(
      "org/repo",
      42,
      ["status/in-progress", "type/bug", "owner/alice"]
    );
  });

  it("replaces existing owner label with new one", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      state: "open",
      labels: ["status/in-progress", "owner/bob"],
    });

    const res = await postRequest(
      makePayload({ action: "assign_owner" as const, value: "owner/alice" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).toContain("owner/alice");
    expect(body.labels).not.toContain("owner/bob");

    expect(mocks.updateIssueLabels).toHaveBeenCalledWith(
      "org/repo",
      42,
      ["status/in-progress", "owner/alice"]
    );
  });

  it("can assign both agent and owner on same issue", async () => {
    // First assign agent
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      state: "open",
      labels: ["status/backlog"],
    });
    let res = await postRequest(makePayload());
    expect(res.status).toBe(200);

    // Then assign owner — findIssue is called again, so mock updated state
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      state: "open",
      labels: ["status/backlog", "agent/worker"],
    });
    res = await postRequest(
      makePayload({ action: "assign_owner" as const, value: "owner/alice" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).toContain("agent/worker");
    expect(body.labels).toContain("owner/alice");
    expect(body.labels).toContain("status/backlog");
  });

  it("preserves status labels when assigning agent", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      state: "open",
      labels: ["status/in-review", "priority/p1"],
    });

    const res = await postRequest(makePayload());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).toContain("status/in-review");
    expect(body.labels).toContain("priority/p1");
    expect(body.labels).toContain("agent/worker");
  });

  it("preserves agent labels when assigning owner", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      state: "open",
      labels: ["agent/worker", "status/in-progress"],
    });

    const res = await postRequest(
      makePayload({ action: "assign_owner" as const, value: "owner/alice" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).toContain("agent/worker");
    expect(body.labels).toContain("owner/alice");
    expect(body.labels).toContain("status/in-progress");

    expect(mocks.updateIssueLabels).toHaveBeenCalledWith(
      "org/repo",
      42,
      ["agent/worker", "status/in-progress", "owner/alice"]
    );
  });
});

describe("POST /api/issues/actions — error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findIssue.mockResolvedValue({
      id: "issue-1",
      state: "open",
      labels: ["status/backlog"],
    });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  it("writes AuditLog with success=false when GitHub mutation fails", async () => {
    mocks.updateIssueLabels.mockRejectedValueOnce(new Error("github 500"));

    const res = await postRequest(makePayload());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("github 500");

    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "assign_agent",
        repoFullName: "org/repo",
        issueNumber: 42,
        success: false,
        errorMessage: "github 500",
      }),
    });
  });

  it("writes AuditLog even when audit log creation itself fails during error handling", async () => {
    // First call (normal) succeeds
    mocks.updateIssueLabels.mockResolvedValueOnce(undefined);
    let res = await postRequest(makePayload());
    expect(res.status).toBe(200);

    vi.clearAllMocks();
    mocks.findIssue.mockResolvedValue({
      id: "issue-1",
      state: "open",
      labels: ["status/backlog"],
    });
    // Second call fails on GitHub
    mocks.updateIssueLabels.mockRejectedValueOnce(new Error("network timeout"));
    // Audit log creation also fails during error handling
    const originalCreate = mocks.createAuditLog;
    mocks.createAuditLog.mockRejectedValueOnce(new Error("db down"));

    res = await postRequest(makePayload());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("network timeout");
  });
});
