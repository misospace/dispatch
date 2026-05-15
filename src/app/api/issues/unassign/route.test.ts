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
  removeIssueLabel: vi.fn().mockResolvedValue(undefined),
  addIssueLabel: vi.fn().mockResolvedValue(undefined),
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

function postRequest(payload = makePayload()) {
  return POST(
    new Request("http://localhost/api/issues/unassign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
}

describe("POST /api/issues/unassign — validation", () => {
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

  it("returns 400 when action is missing", async () => {
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

  it("returns 400 for invalid action", async () => {
    const res = await postRequest(makePayload({ action: "invalid" as unknown as "unassign_agent" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid action/);
  });

  it("returns 400 on malformed JSON body", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/unassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on non-object JSON body", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/unassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([1, 2, 3]),
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when issue is not found", async () => {
    mocks.findIssue.mockResolvedValueOnce(null);
    const res = await postRequest(makePayload());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/Issue not found/);
  });

  it("returns 400 when no agent label exists to unassign", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      labels: ["status/backlog"],
    });
    const res = await postRequest(makePayload());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/No agent label found/);
  });

  it("returns 400 when no owner label exists to unassign", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      labels: ["status/backlog"],
    });
    const res = await postRequest(makePayload({ action: "unassign_owner" as const }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/No owner label found/);
  });
});

describe("POST /api/issues/unassign — unassign_agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findIssue.mockResolvedValue({
      id: "issue-1",
      labels: ["status/backlog", "agent/worker", "type/feature"],
    });
    mocks.updateIssue.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.updateIssueLabels.mockResolvedValue(undefined);
  });

  it("removes agent label and preserves other labels", async () => {
    const res = await postRequest(makePayload());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.labels).toContain("status/backlog");
    expect(body.labels).toContain("type/feature");
    expect(body.labels).not.toContain("agent/worker");

    // Verify GitHub update
    expect(mocks.updateIssueLabels).toHaveBeenCalledWith(
      "org/repo",
      42,
      ["status/backlog", "type/feature"]
    );

    // Verify local cache update
    expect(mocks.updateIssue).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: expect.objectContaining({
        labels: ["status/backlog", "type/feature"],
      }),
    });

    // Verify audit log
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "unassign_agent",
        repoFullName: "org/repo",
        issueNumber: 42,
        success: true,
      }),
    });
  });

  it("removes all agent labels when multiple exist", async () => {
    mocks.findIssue.mockResolvedValueOnce({
      id: "issue-1",
      labels: ["status/backlog", "agent/worker", "agent/dup"],
    });

    const res = await postRequest(makePayload());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).not.toContain("agent/worker");
    expect(body.labels).not.toContain("agent/dup");
    expect(body.labels.filter((l: string) => l.startsWith("agent/")).length).toBe(0);
  });
});

describe("POST /api/issues/unassign — unassign_owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findIssue.mockResolvedValue({
      id: "issue-1",
      labels: ["status/in-progress", "owner/alice", "type/bug"],
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
    expect(body.labels).toContain("status/in-progress");
    expect(body.labels).toContain("type/bug");
    expect(body.labels).not.toContain("owner/alice");

    expect(mocks.updateIssueLabels).toHaveBeenCalledWith(
      "org/repo",
      42,
      ["status/in-progress", "type/bug"]
    );
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

    const res = await postRequest(makePayload());
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
