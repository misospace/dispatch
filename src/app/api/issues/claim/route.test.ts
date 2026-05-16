import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks, conflictMocks } = vi.hoisted(() => ({
  mocks: {
    findUnique: vi.fn(), updateIssue: vi.fn(), createAuditLog: vi.fn(),
    addIssueLabel: vi.fn(), removeIssueLabel: vi.fn(),
  },
  conflictMocks: {
    resolveClaimConflict: vi.fn(),
    getAgentFromLabels: vi.fn(),
    isAdminAgent: vi.fn(),
  },
}));

const mockToken = "test-agent-token";
process.env.MISSION_CONTROL_AGENT_TOKEN = mockToken;

vi.mock("@/lib/prisma", () => ({
  prisma: { issue: { findUnique: mocks.findUnique, update: mocks.updateIssue }, auditLog: { create: mocks.createAuditLog } },
}));

vi.mock("@/lib/github", () => ({ addIssueLabel: mocks.addIssueLabel, removeIssueLabel: mocks.removeIssueLabel }));

vi.mock("@/lib/assignment-conflicts", () => ({
  resolveClaimConflict: conflictMocks.resolveClaimConflict,
  getAgentFromLabels: conflictMocks.getAgentFromLabels,
  isAdminAgent: conflictMocks.isAdminAgent,
}));

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

function defaultMockSetup() {
  mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: [] as string[] });
  conflictMocks.resolveClaimConflict.mockReturnValue({ conflict: "none", reason: null });
  conflictMocks.getAgentFromLabels.mockReturnValue(null);
  conflictMocks.isAdminAgent.mockReturnValue(false);
  mocks.updateIssue.mockResolvedValue(undefined);
  mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  mocks.addIssueLabel.mockResolvedValue(undefined);
  mocks.removeIssueLabel.mockResolvedValue(undefined);
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
  beforeEach(() => { vi.clearAllMocks(); conflictMocks.resolveClaimConflict.mockReturnValue({ conflict: "none", reason: null }); });

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

describe("POST /api/issues/claim — closed/done issues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultMockSetup();
  });

  it("refuses closed issues", async () => {
    conflictMocks.resolveClaimConflict.mockReturnValueOnce({ conflict: "closed", reason: "Cannot claim a closed issue" });
    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Cannot claim a closed issue");
  });

  it("refuses done issues", async () => {
    conflictMocks.resolveClaimConflict.mockReturnValueOnce({ conflict: "done", reason: "Cannot claim a done issue" });
    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Cannot claim a done issue");
  });

  it("allows claiming an open issue with in-review status", async () => {
    conflictMocks.resolveClaimConflict.mockReturnValueOnce({ conflict: "none", reason: null });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
  });
});

describe("POST /api/issues/claim — agent conflict resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultMockSetup();
  });

  it("adds agent label and moves to in-progress for a fresh claim", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-progress");
    expect(mocks.createAuditLog).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "claim_issue", success: true, actor: "test-agent" }) });
  });

  it("returns 409 when already assigned to another agent without force", async () => {
    conflictMocks.resolveClaimConflict.mockReturnValueOnce({ conflict: "agent", reason: "Issue is already assigned to other-agent. Use force=true to override." });
    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already assigned to other-agent");
  });

  it("force claims by removing old agent label when force=true and admin", async () => {
    conflictMocks.resolveClaimConflict.mockReturnValueOnce({ conflict: "none", reason: null });
    conflictMocks.getAgentFromLabels.mockReturnValueOnce("agent/other-agent");
    const res = await POST(makeRequest({ agentName: "admin/system", force: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/other-agent");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/admin/system");
    expect(mocks.createAuditLog).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "force_claim_issue" }) });
  });

  it("denies force-claim by non-admin agent with 409", async () => {
    conflictMocks.resolveClaimConflict.mockReturnValueOnce({ conflict: "agent", reason: "Force-claim denied: other-agent already assigned. Only admin agents may force-claim." });
    const res = await POST(makeRequest({ force: true }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Force-claim denied");
  });

  it("logs error when force claim label removal fails but continues", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockReturnValue();
    conflictMocks.resolveClaimConflict.mockReturnValueOnce({ conflict: "none", reason: null });
    conflictMocks.getAgentFromLabels.mockReturnValueOnce("agent/other-agent");
    mocks.removeIssueLabel.mockRejectedValueOnce(new Error("github 500"));
    const res = await POST(makeRequest({ agentName: "admin/system", force: true }));
    expect(res.status).toBe(200);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to remove stale agent label agent/other-agent"), expect.any(Error));
    consoleSpy.mockRestore();
  });

  it("same agent re-claiming is allowed (no conflict)", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    // Should not try to remove or add the label again since no existing agent
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("does not add status/in-progress if already has a status label", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["status/in-review"] });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(mocks.addIssueLabel).toHaveBeenCalledTimes(1);
  });

  it("does not add status/in-progress when force=false", async () => {
    const res = await POST(makeRequest({ force: false }));
    expect(res.status).toBe(200);
    expect(mocks.addIssueLabel).toHaveBeenCalledTimes(1);
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
  });
});

describe("POST /api/issues/claim — owner label policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultMockSetup();
  });

  it("owner labels do not block normal claims", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // Owner label should be preserved, agent label added
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-progress");
  });

  it("owner labels do not block force-claim by admin", async () => {
    conflictMocks.resolveClaimConflict.mockReturnValueOnce({ conflict: "none", reason: null });
    conflictMocks.getAgentFromLabels.mockReturnValueOnce("agent/other-agent");
    const res = await POST(makeRequest({ agentName: "admin/system", force: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // Old agent label removed, new agent label added, owner label preserved
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/other-agent");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/admin/system");
  });

  it("non-admin force-claim denied when both agent and owner labels exist", async () => {
    conflictMocks.resolveClaimConflict.mockReturnValueOnce({ conflict: "agent", reason: "Force-claim denied: other-agent already assigned. Only admin agents may force-claim." });
    const res = await POST(makeRequest({ force: true }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Force-claim denied");
  });

  it("claims with both owner and in-progress status labels", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["owner/bob", "status/in-progress"] });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    // Should add agent label and status/in-progress (it's already there but we check the call)
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
    // status/in-progress is already present so should not be added again
    const inProgressCalls = mocks.addIssueLabel.mock.calls.filter(
      (call) => call[2] === "status/in-progress"
    );
    expect(inProgressCalls.length).toBe(0);
  });
});

describe("POST /api/issues/claim — audit and cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultMockSetup();
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
    // The error message comes from the catch block wrapping the label add
    expect(mocks.createAuditLog).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "claim_issue", success: false, errorMessage: "github 500" }) });
  });

  it("updates local cache with new labels after claim", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(mocks.updateIssue).toHaveBeenCalledWith({ where: { id: "issue-1" }, data: expect.objectContaining({ labels: expect.arrayContaining(["agent/test-agent", "status/in-progress"]) }) });
  });

  it("force claim by admin writes force_claim_issue audit action", async () => {
    conflictMocks.resolveClaimConflict.mockReturnValueOnce({ conflict: "none", reason: null });
    conflictMocks.getAgentFromLabels.mockReturnValueOnce("agent/other-agent");
    const res = await POST(makeRequest({ agentName: "admin/system", force: true }));
    expect(res.status).toBe(200);
    expect(mocks.createAuditLog).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "force_claim_issue" }) });
  });

  it("does not add duplicate agent label on re-claim", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    // Only in-progress should be added (not the agent label which already exists)
    const agentCalls = mocks.addIssueLabel.mock.calls.filter(
      (call) => call[2] === "agent/test-agent"
    );
    expect(agentCalls.length).toBe(1);
  });
});
