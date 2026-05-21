import { describe, expect, it, vi, beforeEach } from "vitest";

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => ({
  isAuthorizedAgentToken: vi.fn((token) => token === mockToken),
}));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUnique: vi.fn().mockResolvedValue(null),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "log-1" }) },
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    githubWorkflowRun: { findUnique: mocks.findUnique },
    githubWorkflow: { findUnique: vi.fn().mockResolvedValue({ id: "gw-1", workflowId: "123" }) },
    auditLog: mocks.auditLog,
  },
}));

vi.mock("@/lib/github", () => ({
  rerunWorkflow: vi.fn().mockResolvedValue(undefined),
  triggerWorkflowDispatch: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "./route";

describe("POST /api/automation/runs/[runId] — auth", () => {
  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(new Request("http://localhost/api/automation/runs?runId=123&repo=org/repo&action=rerun", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(new Request("http://localhost/api/automation/runs?runId=123&repo=org/repo&action=rerun", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
    }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/automation/runs/[runId] — validation", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 400 when runId is missing", async () => {
    const res = await POST(new Request("http://localhost/api/automation/runs?repo=org/repo&action=rerun", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
    }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when repo is missing", async () => {
    const res = await POST(new Request("http://localhost/api/automation/runs?runId=123&action=rerun", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
    }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when run not found", async () => {
    mocks.findUnique.mockResolvedValueOnce(null);
    const res = await POST(new Request("http://localhost/api/automation/runs?runId=999&repo=org/repo&action=rerun", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
    }));
    expect(res.status).toBe(404);
  });

  it("returns 200 for rerun action", async () => {
    mocks.findUnique.mockResolvedValueOnce({ id: "wr-1", workflowId: "gw-1" });
    const res = await POST(new Request("http://localhost/api/automation/runs?runId=123&repo=org/repo&action=rerun", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("returns 200 for dispatch action", async () => {
    mocks.findUnique.mockResolvedValueOnce({ id: "wr-1", workflowId: "gw-1" });
    const res = await POST(new Request("http://localhost/api/automation/runs?runId=123&repo=org/repo&action=dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("writes audit log on success", async () => {
    mocks.findUnique.mockResolvedValueOnce({ id: "wr-1", workflowId: "gw-1" });
    await POST(new Request("http://localhost/api/automation/runs?runId=123&repo=org/repo&action=rerun", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
    }));
    expect(mocks.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "workflow_rerun",
        repoFullName: "org/repo",
        success: true,
      }),
    });
  });
});
