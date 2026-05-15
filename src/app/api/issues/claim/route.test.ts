import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUnique: vi.fn(), updateIssue: vi.fn(), createAuditLog: vi.fn(),
    addIssueLabel: vi.fn(), removeIssueLabel: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { issue: { findUnique: mocks.findUnique, update: mocks.updateIssue }, auditLog: { create: mocks.createAuditLog } },
}));

vi.mock("@/lib/github", () => ({ addIssueLabel: mocks.addIssueLabel, removeIssueLabel: mocks.removeIssueLabel }));

import { POST } from "./route";

function makePayload(o = {}) { return { issueId: "issue-1", repoFullName: "org/repo", issueNumber: 42, agentName: "test-agent", ...o }; }

describe("POST /api/issues/claim — validation", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.findUnique.mockResolvedValue(null); });

  it("returns 400 when agentName is missing", async () => {
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(makePayload({agentName: undefined})) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required fields: issueId, repoFullName, issueNumber, agentName");
  });

  it("returns 400 when agentName is not a string", async () => {
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(makePayload({agentName: 123})) }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when repoFullName is missing", async () => {
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(makePayload({repoFullName: undefined})) }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when issueNumber is missing", async () => {
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(makePayload({issueNumber: undefined})) }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json"}, body: "not-json" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-object body", async () => {
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify([1,2,3]) }));
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
    mocks.removeIssueLabel.mockResolvedValue(undefined);
  });

  it("adds agent label and moves to in-progress for a fresh claim", async () => {
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(makePayload()) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "status/in-progress");
    expect(mocks.createAuditLog).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "claim_issue", success: true, actor: "test-agent" }) });
  });

  it("refuses closed issues", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "closed", labels: [] as string[] });
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(makePayload()) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Cannot claim a closed issue");
  });

  it("refuses done issues", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["status/done"] });
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(makePayload()) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Cannot claim a done issue");
  });

  it("returns 409 when already assigned to another agent without force", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["agent/other-agent"] });
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(makePayload()) }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already assigned to other-agent");
  });

  it("force claims by removing old agent label when force=true", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["agent/other-agent", "status/in-progress"] });
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(makePayload({ force: true })) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mocks.removeIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/other-agent");
    expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "agent/test-agent");
  });

  it("returns 404 when issue not found in local cache", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(makePayload()) }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Issue not found in local cache");
  });

  it("writes failure audit log when GitHub API fails", async () => {
    mocks.addIssueLabel.mockRejectedValueOnce(new Error("github 500"));
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(makePayload()) }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("github 500");
    expect(mocks.createAuditLog).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "claim_issue", success: false, errorMessage: "github 500" }) });
  });

  it("does not add status/in-progress if already has a status label", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", state: "open", labels: ["status/in-review"] });
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(makePayload()) }));
    expect(res.status).toBe(200);
    expect(mocks.addIssueLabel).toHaveBeenCalledTimes(1);
  });

  it("updates local cache with new labels after claim", async () => {
    const res = await POST(new Request("http://localhost/api/issues/claim", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(makePayload()) }));
    expect(res.status).toBe(200);
    expect(mocks.updateIssue).toHaveBeenCalledWith({ where: { id: "issue-1" }, data: expect.objectContaining({ labels: expect.arrayContaining(["agent/test-agent", "status/in-progress"]) }) });
  });
});
