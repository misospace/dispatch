import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUnique: vi.fn(),
    updateIssue: vi.fn(),
    createAuditLog: vi.fn(),
    removeIssueLabel: vi.fn(),
    addIssueLabel: vi.fn(),
  },
}));

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findUnique: mocks.findUnique, update: mocks.updateIssue },
    auditLog: { create: mocks.createAuditLog },
  },
}));

vi.mock("@/lib/github", () => ({
  removeIssueLabel: mocks.removeIssueLabel,
  addIssueLabel: mocks.addIssueLabel,
}));

import { POST } from "./route";

function makePayload(o = {}) {
  return { issueId: "issue-1", repoFullName: "org/repo", issueNumber: 42, status: "in-progress", ...o };
}

function makeRequest(overrides = {}, extraHeaders = {}) {
  const payload = typeof overrides === "object" && !Array.isArray(overrides) ? { ...makePayload(), ...overrides } : overrides;
  return new Request("http://localhost/api/issues/status", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}`, ...extraHeaders },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/issues/status — auth", () => {
  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(new Request("http://localhost/api/issues/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makePayload()),
    }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(new Request("http://localhost/api/issues/status", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
      body: JSON.stringify(makePayload()),
    }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/issues/status — validation", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.findUnique.mockResolvedValue(null); });

  it("returns 400 when issueId is missing", async () => {
    const res = await POST(makeRequest({ issueId: undefined }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Missing required fields");
  });

  it("returns 400 when repoFullName is missing", async () => {
    const res = await POST(makeRequest({ repoFullName: undefined }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when issueNumber is missing", async () => {
    const res = await POST(makeRequest({ issueNumber: undefined }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when status is missing", async () => {
    const res = await POST(makeRequest({ status: undefined }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await POST(new Request("http://localhost/api/issues/status", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
      body: "not-json",
    }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-object body", async () => {
    const res = await POST(makeRequest([1, 2, 3]));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid status value", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: [] as string[] });
    const res = await POST(makeRequest({ status: "unknown-state" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid status label/);
  });

  it("accepts all valid status values", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: [] as string[] });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.removeIssueLabel.mockResolvedValue(undefined);

    for (const s of ["backlog", "in-progress", "in-review", "done"]) {
      const res = await POST(makeRequest({ status: s }));
      expect(res.status).toBe(200);
    }
  });
});

describe("POST /api/issues/status — business logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: [] as string[], number: 42, repository: { fullName: "org/repo" } });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.removeIssueLabel.mockResolvedValue(undefined);
  });

  it("adds status label when no existing status", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-progress");
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("replaces existing status label", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["status/backlog"], number: 42, repository: { fullName: "org/repo" } });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/backlog");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-progress");
  });

  it("does not call github when status is already set to the same value", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["status/in-progress"], number: 42, repository: { fullName: "org/repo" } });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("updates local cache with new labels", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(mocks.updateIssue).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: expect.objectContaining({ labels: expect.arrayContaining(["status/in-progress"]) }),
    });
  });

  it("writes audit log with success=true", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "set_status",
        success: true,
      }),
    });
  });

  it("uses agentName as actor when provided", async () => {
    const res = await POST(makeRequest({ agentName: "test-agent" }));
    expect(res.status).toBe(200);
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actor: "test-agent",
      }),
    });
  });

  it("uses actor field when provided (takes precedence over agentName)", async () => {
    const res = await POST(makeRequest({ actor: "custom-actor" }));
    expect(res.status).toBe(200);
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actor: "custom-actor",
      }),
    });
  });

  it("returns 404 when issue not found in local cache", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Issue not found in local cache");
  });

  it("writes failure audit log when GitHub API fails", async () => {
    mocks.addIssueLabel.mockRejectedValueOnce(new Error("github 500"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("github 500");
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "set_status",
        success: false,
        errorMessage: "github 500",
      }),
    });
  });

  it("fails when removing old status label fails — does not add new label or update Prisma", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["status/backlog"], number: 42, repository: { fullName: "org/repo" } });
    mocks.removeIssueLabel.mockRejectedValueOnce(new Error("github 500"));
    const consoleSpy = vi.spyOn(console, "error").mockReturnValue();
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("github 500");
    // Should not proceed to add or update
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
    expect(mocks.updateIssue).not.toHaveBeenCalled();
    // Failure audit log written
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "set_status",
        success: false,
        errorMessage: "github 500",
      }),
    });
    consoleSpy.mockRestore();
  });

  it("preserves non-status labels when replacing", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["priority/p0", "status/backlog", "type/bug"], number: 42, repository: { fullName: "org/repo" } });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).toContain("priority/p0");
    expect(body.labels).toContain("type/bug");
    expect(body.labels).toContain("status/in-progress");
  });
});
