import { describe, expect, it, vi, beforeEach } from "vitest";

const mockAgentWork = {
  create: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
};

const mockAgentWorkHistory = {
  create: vi.fn(),
};

const mockTransaction = vi.fn((fn: (tx: any) => Promise<any>) => fn({
  agentWork: mockAgentWork,
  agentWorkHistory: mockAgentWorkHistory,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      create: vi.fn(async () => ({ id: "audit-1" })),
    },
  },
  asAgentWorkClient: (client: any) => ({
    agentWork: mockAgentWork,
    agentWorkHistory: mockAgentWorkHistory,
    $transaction: mockTransaction,
  }),
}));

vi.mock("@/lib/dispatch-env", () => ({
  isAuthorizedAgentToken: vi.fn((token: string | null | undefined) => token === "test-token"),
  isAuthorizedBearerToken: vi.fn((token: string | null | undefined) => token === "test-token"),
  getAcceptedAgentTokens: vi.fn(() => ["test-token"]),
  resetCaches: vi.fn(),
}));

import { POST as handleStart } from "./route";

function makeStartRequest(payload: Record<string, unknown>) {
  return handleStart(
    new Request("http://localhost/api/agent-work/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify(payload),
    })
  );
}

describe("POST /api/agent-work/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentWork.findFirst.mockResolvedValue(null);
    mockAgentWork.create.mockImplementation((args: any) => {
      const data = args.data || {};
      return Promise.resolve({
        id: "work-1",
        agentName: data.agentName || "test-agent",
        issueId: data.issueId ?? null,
        runId: data.runId ?? null,
        state: "CLAIMED",
        checkpoint: "CLAIMED",
        branch: data.branch ?? null,
        leaseExpiresAt: new Date(),
        lastHeartbeatAt: new Date(),
        summary: null,
        blockerReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });
    mockAgentWorkHistory.create.mockResolvedValue({ id: "hist-1" });
  });

  it("creates work with status 201 when agentName is provided", async () => {
    const res = await makeStartRequest({ agentName: "test-agent" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agentName).toBe("test-agent");
    expect(body.state).toBe("CLAIMED");
  });

  it("includes issueId and branch when provided", async () => {
    const res = await makeStartRequest({
      agentName: "test-agent",
      issueId: "issue-abc",
      branch: "feat/my-feature",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.issueId).toBe("issue-abc");
    expect(body.branch).toBe("feat/my-feature");
  });

  it("returns 400 when agentName is missing", async () => {
    const res = await makeStartRequest({});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required field: agentName (string)");
  });

  it("returns 401 when token is invalid", async () => {
    const res = await handleStart(
      new Request("http://localhost/api/agent-work/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ agentName: "test-agent" }),
      })
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("releases existing active work on the same issue before creating new work", async () => {
    mockAgentWork.findFirst.mockResolvedValueOnce({
      id: "old-work-1",
      agentName: "test-agent",
      issueId: "issue-abc",
      state: "IN_PROGRESS",
    });

    const res = await makeStartRequest({
      agentName: "test-agent",
      issueId: "issue-abc",
    });
    expect(res.status).toBe(201);

    expect(mockAgentWork.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "old-work-1" },
        data: expect.objectContaining({ state: "RELEASED" }),
      })
    );
  });

  it("returns 400 when body is null", async () => {
    const res = await handleStart(
      new Request("http://localhost/api/agent-work/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify(null),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("expected an object");
  });

  it("returns 400 when body is an array", async () => {
    const res = await handleStart(
      new Request("http://localhost/api/agent-work/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify([{ agentName: "test-agent" }]),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("expected an object");
  });

  it("returns 400 when agentName is empty string", async () => {
    const res = await makeStartRequest({ agentName: "" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required field: agentName (string)");
  });
});
