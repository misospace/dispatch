import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { resetAuthCaches } from "@/lib/auth";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findIssue: vi.fn().mockResolvedValue(null),
    findFirstIssue: vi.fn().mockResolvedValue(null),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    createAuditLog: vi.fn().mockResolvedValue({ id: "log-1" }),
    removeIssueLabel: vi.fn().mockResolvedValue(undefined),
    addIssueLabel: vi.fn().mockResolvedValue(undefined),
    auth: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      findUnique: mocks.findIssue,
      findFirst: mocks.findFirstIssue,
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
}));

vi.mock("@/lib/auth-next", () => ({
  auth: mocks.auth,
}));

import { POST } from "./route";

function groomRequest(payload: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/issues/groom", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify(payload),
    })
  );
}

function mockIssue(extra?: Record<string, unknown>) {
  mocks.findIssue.mockResolvedValue({
    id: "issue-1",
    number: 42,
    labels: ["status/backlog", "priority/p2"],
    repository: { fullName: "misospace/dispatch" },
    ...extra,
  });
  mocks.updateIssue.mockResolvedValue({
    id: "issue-1",
    number: 42,
    labels: ["status/backlog", "priority/p2"],
    ...extra,
  });
}

describe("POST /api/issues/groom — auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstIssue.mockResolvedValue(null);
    process.env.DISPATCH_AGENT_TOKEN = "test-token";
    process.env.DISPATCH_AUTH_MODE = "disabled";
  });

  afterEach(() => {
    delete process.env.DISPATCH_AGENT_TOKEN;
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.DISPATCH_AUTH_USERNAME;
    delete process.env.DISPATCH_AUTH_PASSWORD;
    resetAuthCaches();
  });

  it("allows all requests when auth mode is disabled", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 1, action: "promote_to_ready" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/issues/groom — validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstIssue.mockResolvedValue(null);
    process.env.DISPATCH_AGENT_TOKEN = "test-token";
    process.env.DISPATCH_AUTH_MODE = "disabled";
  });

  afterEach(() => {
    delete process.env.DISPATCH_AGENT_TOKEN;
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.DISPATCH_AUTH_USERNAME;
    delete process.env.DISPATCH_AUTH_PASSWORD;
    resetAuthCaches();
  });

  it("rejects missing required fields", async () => {
    const res = await groomRequest({ action: "promote_to_ready" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Missing required fields");
  });

  it("rejects invalid JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/groom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("rejects non-object body", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/groom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify("string"),
      })
    );
    expect(res.status).toBe(400);
  });

  it("rejects invalid action", async () => {
    mockIssue();
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 1, action: "invalid" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid action");
  });

  it("returns 404 when issue not found", async () => {
    mocks.findIssue.mockResolvedValue(null);
    const res = await groomRequest({ issueId: "nonexistent", repoFullName: "r/r", issueNumber: 1, action: "promote_to_ready" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });
});

describe("POST /api/issues/groom — actor resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstIssue.mockResolvedValue(null);
    process.env.DISPATCH_AGENT_TOKEN = "test-token";
    process.env.DISPATCH_AUTH_MODE = "disabled";
    mockIssue();
    mocks.updateIssue.mockResolvedValue({ id: "issue-1", number: 42, labels: ["status/backlog"] });
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  afterEach(() => {
    delete process.env.DISPATCH_AGENT_TOKEN;
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.DISPATCH_AUTH_USERNAME;
    delete process.env.DISPATCH_AUTH_PASSWORD;
    resetAuthCaches();
  });

  it("defaults actor to 'agent' when no actor or agentName supplied", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" });
    expect(res.status).toBe(200);
    expect(mocks.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actor: "agent" }) }));
  });

  it("uses actor when provided", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready", actor: "my-agent" });
    expect(res.status).toBe(200);
    expect(mocks.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actor: "my-agent" }) }));
  });

  it("uses agentName as fallback when actor is not provided", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready", agentName: "fallback" });
    expect(res.status).toBe(200);
    expect(mocks.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actor: "fallback" }) }));
  });

  it("prefers actor over agentName when both are provided", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready", actor: "primary", agentName: "secondary" });
    expect(res.status).toBe(200);
    const call = mocks.createAuditLog.mock.calls[0][0];
    expect(call.data.actor).toBe("primary");
  });

  it("returns 400 when actor is not a string", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready", actor: 123 as unknown as string });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("'actor'/'agentName' must be a string");
  });

  it("returns 400 when actor is empty", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready", actor: "" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("'actor'/'agentName' must not be empty after trimming");
  });

  it("returns 400 when actor is whitespace only", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready", actor: "   " });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("'actor'/'agentName' must not be empty after trimming");
  });

  it("returns 400 when actor exceeds 100 characters", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready", actor: "a".repeat(101) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("'actor'/'agentName' must be at most 100 characters");
  });

  it("trims actor value before storing", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready", actor: "  trimmed  " });
    expect(res.status).toBe(200);
    const call = mocks.createAuditLog.mock.calls[0][0];
    expect(call.data.actor).toBe("trimmed");
  });
});

describe("POST /api/issues/groom — promote_to_ready", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstIssue.mockResolvedValue(null);
    process.env.DISPATCH_AGENT_TOKEN = "test-token";
    process.env.DISPATCH_AUTH_MODE = "disabled";
    mockIssue({ labels: ["status/backlog", "priority/p2"] });
    mocks.updateIssue.mockResolvedValue({ id: "issue-1", number: 42, labels: ["status/ready", "priority/p2"] });
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  afterEach(() => {
    delete process.env.DISPATCH_AGENT_TOKEN;
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.DISPATCH_AUTH_USERNAME;
    delete process.env.DISPATCH_AUTH_PASSWORD;
    resetAuthCaches();
  });

  it("removes backlog and adds ready label", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" });
    expect(res.status).toBe(200);

    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("misospace/dispatch", 42, "status/backlog");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("misospace/dispatch", 42, "status/ready");
  });

  it("updates lastSyncedAt", async () => {
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" });
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.lastSyncedAt).toBeDefined();
  });

  it("writes audit log with correct action", async () => {
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "issue_groomed_promote" }) })
    );
  });

  it("writes audit log with before/after labels", async () => {
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" });
    const call = mocks.createAuditLog.mock.calls[0][0];
    expect(call.data.beforeLabels).toContain("status/backlog");
    expect(call.data.afterLabels).toContain("status/ready");
    expect(call.data.afterLabels).not.toContain("status/backlog");
  });

  it("stores groomedAt and groomedBy", async () => {
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready", actor: "groomer" });
    expect(mocks.updateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ groomedAt: expect.any(Date), groomedBy: "groomer" }) })
    );
  });

  it("includes optional groomingSummary in audit log", async () => {
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready", groomingSummary: "Looks good to me" });
    const call = mocks.createAuditLog.mock.calls[0][0];
    expect(call.data.notes).toBe("Looks good to me");
  });

  it("returns updated labels in response", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" });
    const body = await res.json();
    expect(body.labels).toContain("status/ready");
    expect(body.labels).not.toContain("status/backlog");
  });

  it("clears all reason fields on promote", async () => {
    mockIssue({
      labels: ["status/backlog"],
      notReadyReason: "old reason",
      blockedReason: "old block",
      needsInfoReason: "old info",
    });
    mocks.updateIssue.mockResolvedValue({ id: "issue-1", number: 42, labels: ["status/ready"] });
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" });
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.notReadyReason).toBeNull();
    expect(call.data.blockedReason).toBeNull();
    expect(call.data.needsInfoReason).toBeNull();
  });

  it("handles issue with no existing status label", async () => {
    mockIssue({ labels: ["priority/p1"] });
    mocks.updateIssue.mockResolvedValue({ id: "issue-1", number: 42, labels: ["status/ready", "priority/p1"] });
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" });
    expect(res.status).toBe(200);
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("misospace/dispatch", 42, "status/ready");
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("handles issue already on status/ready (no-op labels)", async () => {
    mockIssue({ labels: ["status/ready", "priority/p1"] });
    mocks.updateIssue.mockResolvedValue({ id: "issue-1", number: 42, labels: ["status/ready", "priority/p1"] });
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" });
    expect(res.status).toBe(200);
    expect(mocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(mocks.addIssueLabel).not.toHaveBeenCalled();
  });

  it("handles issue with different status label (e.g. in-progress)", async () => {
    mockIssue({ labels: ["status/in-progress", "priority/p1"] });
    mocks.updateIssue.mockResolvedValue({ id: "issue-1", number: 42, labels: ["status/ready", "priority/p1"] });
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" });
    expect(res.status).toBe(200);
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("misospace/dispatch", 42, "status/in-progress");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("misospace/dispatch", 42, "status/ready");
  });
});

describe("POST /api/issues/groom — escalate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstIssue.mockResolvedValue(null);
    process.env.DISPATCH_AGENT_TOKEN = "test-token";
    process.env.DISPATCH_AUTH_MODE = "disabled";
    mockIssue({ labels: ["status/in-progress"] });
    mocks.updateIssue.mockResolvedValue({ id: "issue-1", number: 42, labels: ["status/in-progress"] });
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  afterEach(() => {
    delete process.env.DISPATCH_AGENT_TOKEN;
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.DISPATCH_AUTH_USERNAME;
    delete process.env.DISPATCH_AUTH_PASSWORD;
    resetAuthCaches();
  });

  it("sets currentLane to escalated", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "escalate" });
    expect(res.status).toBe(200);
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.currentLane).toBe("escalated");
  });

  it("sets nextGroomingAction hint", async () => {
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "escalate" });
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.nextGroomingAction).toBe("Implement or decompose into actionable sub-tasks");
  });

  it("updates lastSyncedAt", async () => {
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "escalate" });
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.lastSyncedAt).toBeDefined();
  });

  it("writes audit log with correct action", async () => {
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "escalate" });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "issue_groomed_escalate" }) })
    );
  });

  it("clears reason fields", async () => {
    mockIssue({ notReadyReason: "old", blockedReason: "old", needsInfoReason: "old" });
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "escalate" });
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.notReadyReason).toBeNull();
    expect(call.data.blockedReason).toBeNull();
    expect(call.data.needsInfoReason).toBeNull();
  });
});

describe("POST /api/issues/groom — mark_not_ready", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstIssue.mockResolvedValue(null);
    process.env.DISPATCH_AGENT_TOKEN = "test-token";
    process.env.DISPATCH_AUTH_MODE = "disabled";
    mockIssue({ labels: ["status/backlog"] });
    mocks.updateIssue.mockResolvedValue({ id: "issue-1", number: 42, labels: ["status/backlog"] });
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  afterEach(() => {
    delete process.env.DISPATCH_AGENT_TOKEN;
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.DISPATCH_AUTH_USERNAME;
    delete process.env.DISPATCH_AUTH_PASSWORD;
    resetAuthCaches();
  });

  it("requires notReadyReason", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_not_ready" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("notReadyReason");
  });

  it("stores notReadyReason when provided", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_not_ready", notReadyReason: "Missing acceptance criteria" });
    expect(res.status).toBe(200);
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.notReadyReason).toBe("Missing acceptance criteria");
  });

  it("trims notReadyReason", async () => {
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_not_ready", notReadyReason: "  trimmed  " });
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.notReadyReason).toBe("trimmed");
  });

  it("sets nextGroomingAction based on current status", async () => {
    mockIssue({ labels: ["status/backlog"] });
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_not_ready", notReadyReason: "reason" });
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.nextGroomingAction).toBe("Revisit once the blocking condition is resolved");
  });

  it("sets different nextGroomingAction when not in backlog", async () => {
    mockIssue({ labels: ["status/ready"] });
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_not_ready", notReadyReason: "reason" });
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.nextGroomingAction).toBe("Reassess if the issue is now actionable");
  });

  it("updates lastSyncedAt", async () => {
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_not_ready", notReadyReason: "reason" });
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.lastSyncedAt).toBeDefined();
  });

  it("writes audit log with correct action", async () => {
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_not_ready", notReadyReason: "reason" });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "issue_groomed_not_ready" }) })
    );
  });

  it("clears blockedReason and needsInfoReason", async () => {
    mockIssue({ blockedReason: "old block", needsInfoReason: "old info" });
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_not_ready", notReadyReason: "reason" });
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.blockedReason).toBeNull();
    expect(call.data.needsInfoReason).toBeNull();
  });
});

describe("POST /api/issues/groom — mark_needs_info", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstIssue.mockResolvedValue(null);
    process.env.DISPATCH_AGENT_TOKEN = "test-token";
    process.env.DISPATCH_AUTH_MODE = "disabled";
    mockIssue({ labels: ["status/backlog"] });
    mocks.updateIssue.mockResolvedValue({ id: "issue-1", number: 42, labels: ["status/backlog"] });
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  afterEach(() => {
    delete process.env.DISPATCH_AGENT_TOKEN;
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.DISPATCH_AUTH_USERNAME;
    delete process.env.DISPATCH_AUTH_PASSWORD;
    resetAuthCaches();
  });

  it("requires needsInfoReason", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_needs_info" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("needsInfoReason");
  });

  it("stores needsInfoReason when provided", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_needs_info", needsInfoReason: "Need reproduction steps" });
    expect(res.status).toBe(200);
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.needsInfoReason).toBe("Need reproduction steps");
  });

  it("sets nextGroomingAction hint", async () => {
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_needs_info", needsInfoReason: "reason" });
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.nextGroomingAction).toBe("Request missing information from the issue author or assignee");
  });

  it("updates lastSyncedAt", async () => {
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_needs_info", needsInfoReason: "reason" });
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.lastSyncedAt).toBeDefined();
  });

  it("writes audit log with correct action", async () => {
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_needs_info", needsInfoReason: "reason" });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "issue_groomed_needs_info" }) })
    );
  });

  it("clears notReadyReason and blockedReason", async () => {
    mockIssue({ notReadyReason: "old", blockedReason: "old" });
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_needs_info", needsInfoReason: "reason" });
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.notReadyReason).toBeNull();
    expect(call.data.blockedReason).toBeNull();
  });
});

describe("POST /api/issues/groom — mark_blocked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstIssue.mockResolvedValue(null);
    process.env.DISPATCH_AGENT_TOKEN = "test-token";
    process.env.DISPATCH_AUTH_MODE = "disabled";
    mockIssue({ labels: ["status/backlog"] });
    mocks.updateIssue.mockResolvedValue({ id: "issue-1", number: 42, labels: ["status/backlog"] });
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  afterEach(() => {
    delete process.env.DISPATCH_AGENT_TOKEN;
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.DISPATCH_AUTH_USERNAME;
    delete process.env.DISPATCH_AUTH_PASSWORD;
    resetAuthCaches();
  });

  it("requires blockedReason", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_blocked" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("blockedReason");
  });

  it("stores blockedReason when provided", async () => {
    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_blocked", blockedReason: "Waiting on API team" });
    expect(res.status).toBe(200);
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.blockedReason).toBe("Waiting on API team");
  });

  it("sets nextGroomingAction hint", async () => {
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_blocked", blockedReason: "reason" });
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.nextGroomingAction).toBe("Resolve the blocking dependency");
  });

  it("updates lastSyncedAt", async () => {
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_blocked", blockedReason: "reason" });
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.lastSyncedAt).toBeDefined();
  });

  it("writes audit log with correct action", async () => {
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_blocked", blockedReason: "reason" });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "issue_groomed_blocked" }) })
    );
  });

  it("clears notReadyReason and needsInfoReason", async () => {
    mockIssue({ notReadyReason: "old", needsInfoReason: "old" });
    await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "mark_blocked", blockedReason: "reason" });
    const call = mocks.updateIssue.mock.calls[0][0];
    expect(call.data.notReadyReason).toBeNull();
    expect(call.data.needsInfoReason).toBeNull();
  });
});

describe("POST /api/issues/groom — error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstIssue.mockResolvedValue(null);
    process.env.DISPATCH_AGENT_TOKEN = "test-token";
    process.env.DISPATCH_AUTH_MODE = "disabled";
  });

  afterEach(() => {
    delete process.env.DISPATCH_AGENT_TOKEN;
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.DISPATCH_AUTH_USERNAME;
    delete process.env.DISPATCH_AUTH_PASSWORD;
    resetAuthCaches();
  });

  it("writes audit log on DB error", async () => {
    mocks.findIssue.mockResolvedValue({ id: "i1", number: 42, labels: ["status/backlog"], repository: { fullName: "r/r" } });
    mocks.updateIssue.mockRejectedValue(new Error("DB connection failed"));
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });

    const res = await groomRequest({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" });
    expect(res.status).toBe(500);

    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ success: false, errorMessage: "DB connection failed" }),
      })
    );
  });
});

describe("POST /api/issues/groom — auth modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstIssue.mockResolvedValue(null);
    resetAuthCaches();
    mocks.findIssue.mockResolvedValue({
      id: "issue-1",
      number: 42,
      labels: ["status/backlog"],
      repository: { fullName: "misospace/dispatch" },
    });
    mocks.updateIssue.mockResolvedValue({ id: "issue-1", number: 42, labels: ["status/ready"] });
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  afterEach(() => {
    delete process.env.DISPATCH_AGENT_TOKEN;
    delete process.env.DISPATCH_AUTH_MODE;
    delete process.env.DISPATCH_AUTH_USERNAME;
    delete process.env.DISPATCH_AUTH_PASSWORD;
    resetAuthCaches();
  });

  it("rejects unauthenticated request in legacy mode (no token, no auth mode)", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/groom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId: "i1", repoFullName: "r/r", issueNumber: 1, action: "promote_to_ready" }),
      })
    );
    expect(res.status).toBe(401);
  });

  it("accepts valid bearer token in basic mode", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";

    const res = await POST(
      new Request("http://localhost/api/issues/groom", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer agent-token",
          "x-agent-name": "worker-1",
        },
        body: JSON.stringify({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" }),
      })
    );
    expect(res.status).toBe(200);
  });

  it("accepts Basic Auth in basic mode", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";

    const res = await POST(
      new Request("http://localhost/api/issues/groom", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Basic b3BlcmF0b3I6czNjcmV0",
        },
        body: JSON.stringify({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" }),
      })
    );
    expect(res.status).toBe(200);
  });

  it("rejects wrong Basic Auth credentials in basic mode", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";

    const res = await POST(
      new Request("http://localhost/api/issues/groom", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Basic d3Jvbmc6Y3JlZA==",
        },
        body: JSON.stringify({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" }),
      })
    );
    expect(res.status).toBe(401);
  });

  it("accepts OIDC session auth in oidc mode", async () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    mocks.auth.mockResolvedValue({ user: { email: "alice@example.com", name: "Alice" } });

    const res = await POST(
      new Request("http://localhost/api/issues/groom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" }),
      })
    );
    expect(res.status).toBe(200);
  });

  it("rejects unauthenticated OIDC request with no session", async () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    mocks.auth.mockResolvedValue(null);

    const res = await POST(
      new Request("http://localhost/api/issues/groom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" }),
      })
    );
    expect(res.status).toBe(401);
  });

  it("writes groomedBy from authenticated operator in basic mode (Basic Auth)", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";

    await POST(
      new Request("http://localhost/api/issues/groom", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Basic b3BlcmF0b3I6czNjcmV0",
        },
        body: JSON.stringify({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" }),
      })
    );

    const updateCall = mocks.updateIssue.mock.calls[0][0];
    expect(updateCall.data.groomedBy).toBe("operator");

    const auditCall = mocks.createAuditLog.mock.calls[0][0];
    expect(auditCall.data.actor).toBe("operator");
  });

  it("writes groomedBy from bearer actor in basic mode", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";

    await POST(
      new Request("http://localhost/api/issues/groom", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer agent-token",
          "x-agent-name": "worker-1",
        },
        body: JSON.stringify({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" }),
      })
    );

    const updateCall = mocks.updateIssue.mock.calls[0][0];
    expect(updateCall.data.groomedBy).toBe("worker-1");

    const auditCall = mocks.createAuditLog.mock.calls[0][0];
    expect(auditCall.data.actor).toBe("worker-1");
  });

  it("writes groomedBy from OIDC session actor", async () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    mocks.auth.mockResolvedValue({ user: { email: "alice@example.com", name: "Alice" } });

    await POST(
      new Request("http://localhost/api/issues/groom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready" }),
      })
    );

    const updateCall = mocks.updateIssue.mock.calls[0][0];
    expect(updateCall.data.groomedBy).toBe("alice@example.com");

    const auditCall = mocks.createAuditLog.mock.calls[0][0];
    expect(auditCall.data.actor).toBe("alice@example.com");
  });

  it("body actor is ignored when authenticated operator exists (basic mode)", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";

    await POST(
      new Request("http://localhost/api/issues/groom", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Basic b3BlcmF0b3I6czNjcmV0",
        },
        body: JSON.stringify({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready", actor: "body-agent" }),
      })
    );

    const updateCall = mocks.updateIssue.mock.calls[0][0];
    expect(updateCall.data.groomedBy).toBe("operator");

    const auditCall = mocks.createAuditLog.mock.calls[0][0];
    expect(auditCall.data.actor).toBe("operator");
  });

  it("falls back to body actor when auth provides no specific actor (disabled mode)", async () => {
    process.env.DISPATCH_AUTH_MODE = "disabled";

    await POST(
      new Request("http://localhost/api/issues/groom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId: "i1", repoFullName: "r/r", issueNumber: 42, action: "promote_to_ready", actor: "body-agent" }),
      })
    );

    const updateCall = mocks.updateIssue.mock.calls[0][0];
    expect(updateCall.data.groomedBy).toBe("body-agent");

    const auditCall = mocks.createAuditLog.mock.calls[0][0];
    expect(auditCall.data.actor).toBe("body-agent");
  });
});
