import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUnique: vi.fn(), updateIssue: vi.fn(), createAuditLog: vi.fn(),
    addIssueLabel: vi.fn(), removeIssueLabel: vi.fn(),
    leaseFindMany: vi.fn(), leaseDeleteMany: vi.fn(),
    leaseFindUnique: vi.fn(), leaseFindUniqueOrThrow: vi.fn(),
    leaseCreate: vi.fn(), leaseUpdate: vi.fn(), leaseDelete: vi.fn(), leaseFindFirst: vi.fn(),
  },
}));

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findUnique: mocks.findUnique, update: mocks.updateIssue },
    auditLog: { create: mocks.createAuditLog },
    lease: { 
      findMany: mocks.leaseFindMany, 
      deleteMany: mocks.leaseDeleteMany, 
      findUnique: mocks.leaseFindUnique,
      findUniqueOrThrow: mocks.leaseFindUniqueOrThrow,
      create: mocks.leaseCreate,
      update: mocks.leaseUpdate,
      delete: mocks.leaseDelete,
      findFirst: mocks.leaseFindFirst,
    },
  },
}));

vi.mock("@/lib/github", () => ({ addIssueLabel: mocks.addIssueLabel, removeIssueLabel: mocks.removeIssueLabel }));

import { POST } from "./route";

function makePayload(o = {}) { return { issueId: "issue-1", repoFullName: "org/repo", issueNumber: 42, agentName: "test-agent", ...o }; }
function makeRequest(overrides = {}, extraHeaders = {}) {
  const payload = typeof overrides === "object" && !Array.isArray(overrides) ? { ...makePayload(), ...overrides } : overrides;
  return new Request("http://localhost/api/issues/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}`, ...extraHeaders },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/issues/claim — auth", () => {
  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(makePayload()) }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json", Authorization: "Bearer wrong-token"}, body: JSON.stringify(makePayload()) }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/issues/claim — validation", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.findUnique.mockResolvedValue(null); mocks.leaseFindMany.mockResolvedValue([]); mocks.leaseDeleteMany.mockResolvedValue({ count: 0 });
    mocks.leaseFindUnique.mockResolvedValue(null);
    mocks.leaseFindUniqueOrThrow.mockResolvedValue({ id: "l-1", agentName: "test-agent", issueId: "issue-1", checkpoint: "issue_claimed", branch: null, prUrl: null, expiredAt: new Date(Date.now() + 60000), renewedAt: new Date(), createdAt: new Date() });
    mocks.leaseCreate.mockResolvedValue({ id: "l-1", agentName: "test-agent", issueId: "issue-1", checkpoint: "issue_claimed", branch: null, prUrl: null, expiredAt: new Date(Date.now() + 60000), renewedAt: new Date(), createdAt: new Date() });
    mocks.leaseUpdate.mockResolvedValue({ id: "l-1", agentName: "test-agent", issueId: "issue-1", checkpoint: "issue_claimed", branch: null, prUrl: null, expiredAt: new Date(Date.now() + 60000), renewedAt: new Date(), createdAt: new Date() });
    mocks.leaseDelete.mockResolvedValue({ id: "l-1" });
    mocks.leaseFindFirst.mockResolvedValue(null); });

  it("returns 400 when agentName is missing", async () => {
    const res = await POST(makeRequest(makePayload({agentName: undefined})));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required fields: issueId, repoFullName, issueNumber, agentName");
  });

  it("returns 400 when agentName is not a string", async () => {
    const res = await POST(makeRequest(makePayload({agentName: 123})));
    expect(res.status).toBe(400);
  });

  it("returns 400 when repoFullName is missing", async () => {
    const res = await POST(makeRequest(makePayload({repoFullName: undefined})));
    expect(res.status).toBe(400);
  });

  it("returns 400 when issueNumber is missing", async () => {
    const res = await POST(makeRequest(makePayload({issueNumber: undefined})));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json", Authorization: `Bearer ${mockToken}`}, body: "not-json" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-object body", async () => {
    const res = await POST(makeRequest([1,2,3]));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/issues/claim — business logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: [] as string[] });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.leaseFindMany.mockResolvedValue([]);
    mocks.leaseDeleteMany.mockResolvedValue({ count: 0 });
    mocks.removeIssueLabel.mockResolvedValue(undefined);
    mocks.leaseFindMany.mockResolvedValue([]);
    mocks.leaseDeleteMany.mockResolvedValue({ count: 0 });
  });

  it("adds agent label and moves a fresh claim to in-progress", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-progress");
    expect(body.labels).toContain("status/in-progress");
    expect(mocks.createAuditLog).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "claim_issue", success: true, actor: "test-agent" }) });
  });

  it("refuses closed issues", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "closed", labels: [] as string[] });
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Cannot claim a closed issue");
  });

  it("refuses done issues", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["status/done"] });
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Cannot claim a done issue");
  });

  it("returns 409 when already assigned to another agent without force", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["agent/other-agent"] });
    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already assigned to other-agent");
  });

  it("force claims by removing old agent label when force=true", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["agent/other-agent"] });
    const res = await POST(makeRequest({ force: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/other-agent");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
  });

  it("logs error when force claim label removal fails but continues", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockReturnValue();
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["agent/other-agent"] });
    mocks.removeIssueLabel.mockRejectedValueOnce(new Error("github 500"));
    const res = await POST(makeRequest({ force: true }));
    expect(res.status).toBe(200);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to remove stale agent label agent/other-agent"), expect.any(Error));
    consoleSpy.mockRestore();
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
    expect(mocks.createAuditLog).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "claim_issue", success: false, errorMessage: "github 500" }) });
  });

  it("replaces an existing status label with in-progress", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["status/in-review"] });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-review");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-progress");
  });

  it("updates local cache with agent label after claim", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(mocks.updateIssue).toHaveBeenCalledWith({ where: { id: "issue-1" }, data: expect.objectContaining({ labels: expect.arrayContaining(["agent/test-agent", "status/in-progress"]) }) });
  });

  it("adds agent and in-progress labels regardless of force when no status exists", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: [] as string[] });
    const res = await POST(makeRequest({ force: false }));
    expect(res.status).toBe(200);
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-progress");
  });
});

describe("POST /api/issues/claim — owner label handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: [] as string[] });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.leaseFindMany.mockResolvedValue([]);
    mocks.leaseDeleteMany.mockResolvedValue({ count: 0 });
  });

  it("preserves owner labels when claiming an issue with owner/*", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["owner/alice"] });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.labels).toContain("agent/test-agent");
    expect(body.labels).toContain("owner/alice");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
  });

  it("allows claim when only owner label exists (no agent conflict)", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["owner/bob", "priority/p1"] });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.labels).toContain("agent/test-agent");
    expect(body.labels).toContain("owner/bob");
  });

  it("handles both agent and owner conflicts — refuses without force", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["agent/other-agent", "owner/alice"] });
    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already assigned to other-agent");
  });

  it("force claims when both agent and owner labels exist", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["agent/other-agent", "owner/alice", "priority/p2"] });
    const res = await POST(makeRequest({ force: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.labels).toContain("agent/test-agent");
    expect(body.labels).toContain("owner/alice");
    expect(body.labels).toContain("priority/p2");
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/other-agent");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
  });
});

describe("POST /api/issues/claim — audit trail with conflict analysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: [] as string[] });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.leaseFindMany.mockResolvedValue([]);
    mocks.leaseDeleteMany.mockResolvedValue({ count: 0 });
  });

  it("includes conflict details in audit log when agent conflict exists and force is used", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["agent/other-agent"] });
    await POST(makeRequest({ force: true }));
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "claim_issue",
        success: true,
        notes: expect.stringContaining("conflict:"),
      }),
    });
  });

  it("includes owner conflict details in audit log when owner labels exist", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["owner/alice"] });
    await POST(makeRequest());
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "claim_issue",
        success: true,
        notes: expect.stringContaining("conflict:"),
      }),
    });
  });

  it("no conflict notes when no existing assignments", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["status/backlog"] });
    await POST(makeRequest());
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "claim_issue",
        success: true,
        notes: undefined,
      }),
    });
  });
});
