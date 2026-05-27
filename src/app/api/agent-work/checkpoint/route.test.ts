import { describe, expect, it, vi, beforeEach } from "vitest";

const mockAgentWork = {
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
    lease: {
      findFirst: vi.fn(async () => null),
    },
    issue: {
      findUnique: vi.fn(async () => null),
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

import { POST as handleCheckpoint } from "./route";

function makeCheckpointRequest(payload: Record<string, unknown>) {
  return handleCheckpoint(
    new Request("http://localhost/api/agent-work/checkpoint", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify(payload),
    })
  );
}

describe("POST /api/agent-work/checkpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentWork.findFirst.mockResolvedValue({
      id: "work-1",
      agentName: "test-agent",
      state: "IN_PROGRESS",
      checkpoint: "BRANCH_CREATED",
    });
    mockAgentWork.update.mockResolvedValue({
      id: "work-1",
      agentName: "test-agent",
      state: "IN_PROGRESS",
      checkpoint: "CHANGES_MADE",
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: new Date(),
    });
    mockAgentWorkHistory.create.mockResolvedValue({ id: "hist-1" });
  });

  it("updates checkpoint when valid", async () => {
    const res = await makeCheckpointRequest({
      agentName: "test-agent",
      checkpoint: "CHANGES_MADE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checkpoint).toBe("CHANGES_MADE");
  });

  it("transitions to BLOCKED state when checkpoint is BLOCKED", async () => {
    mockAgentWork.update.mockResolvedValue({
      id: "work-1",
      agentName: "test-agent",
      state: "BLOCKED",
      checkpoint: "BLOCKED",
      blockerReason: "blocked on external dependency",
    });

    const res = await makeCheckpointRequest({
      agentName: "test-agent",
      checkpoint: "BLOCKED",
      blockerReason: "blocked on external dependency",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("BLOCKED");
    expect(body.blockerReason).toBe("blocked on external dependency");
  });

  it("transitions to DONE state when checkpoint is DONE", async () => {
    mockAgentWork.update.mockResolvedValue({
      id: "work-1",
      agentName: "test-agent",
      state: "DONE",
      checkpoint: "DONE",
    });

    const res = await makeCheckpointRequest({
      agentName: "test-agent",
      checkpoint: "DONE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("DONE");
  });

  it("returns 400 when agentName is missing", async () => {
    const res = await makeCheckpointRequest({ checkpoint: "CHANGES_MADE" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required field: agentName (string)");
  });

  it("returns 400 when checkpoint is missing", async () => {
    const res = await makeCheckpointRequest({ agentName: "test-agent" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("expected a string");
  });

  it("returns 400 when checkpoint is invalid", async () => {
    const res = await makeCheckpointRequest({
      agentName: "test-agent",
      checkpoint: "INVALID_CHECKPOINT",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid checkpoint value");
    expect(body.error).toContain("INVALID_CHECKPOINT");
  });

  it("returns 401 when token is invalid", async () => {
    const res = await handleCheckpoint(
      new Request("http://localhost/api/agent-work/checkpoint", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ agentName: "test-agent", checkpoint: "CHANGES_MADE" }),
      })
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 404 when no active work found for agent", async () => {
    mockAgentWork.findFirst.mockResolvedValue(null);

    const res = await makeCheckpointRequest({
      agentName: "unknown-agent",
      checkpoint: "CHANGES_MADE",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("No active work found for agent");
  });

  it("returns 400 when body is null", async () => {
    const res = await handleCheckpoint(
      new Request("http://localhost/api/agent-work/checkpoint", {
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
    const res = await handleCheckpoint(
      new Request("http://localhost/api/agent-work/checkpoint", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify([{ agentName: "test-agent", checkpoint: "CHANGES_MADE" }]),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("expected an object");
  });

  it("returns 400 when body is a string", async () => {
    const res = await handleCheckpoint(
      new Request("http://localhost/api/agent-work/checkpoint", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify("not-an-object"),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("expected an object");
  });

  it("returns 400 when checkpoint is a nested object", async () => {
    const res = await handleCheckpoint(
      new Request("http://localhost/api/agent-work/checkpoint", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ agentName: "test-agent", checkpoint: { nested: "value" } }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("expected a string");
  });

  it("returns 400 when checkpoint is a number", async () => {
    const res = await handleCheckpoint(
      new Request("http://localhost/api/agent-work/checkpoint", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ agentName: "test-agent", checkpoint: 42 }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid checkpoint value");
  });

  it("returns 400 when agentName is an empty string", async () => {
    const res = await makeCheckpointRequest({ agentName: "", checkpoint: "CHANGES_MADE" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required field: agentName (string)");
  });

  it("returns 400 when checkpoint is an empty string", async () => {
    const res = await makeCheckpointRequest({ agentName: "test-agent", checkpoint: "" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Missing required field: checkpoint");
  });

  it("returns 400 when checkpoint is an array", async () => {
    const res = await handleCheckpoint(
      new Request("http://localhost/api/agent-work/checkpoint", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ agentName: "test-agent", checkpoint: ["CHANGES_MADE"] }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("expected a string");
  });

  it("includes valid checkpoint values in the error message", async () => {
    const res = await makeCheckpointRequest({
      agentName: "test-agent",
      checkpoint: "WRONG_VALUE",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("CLAIMED");
    expect(body.error).toContain("CHANGES_MADE");
    expect(body.error).toContain("WRONG_VALUE");
  });

  it("returns 400 when blockerReason is not a string", async () => {
    const res = await handleCheckpoint(
      new Request("http://localhost/api/agent-work/checkpoint", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ agentName: "test-agent", checkpoint: "BLOCKED", blockerReason: 123 }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("blockerReason");
  });

  it("accepts checkpoint with hyphens and normalizes to underscores", async () => {
    mockAgentWork.update.mockResolvedValue({
      id: "work-1",
      agentName: "test-agent",
      state: "IN_PROGRESS",
      checkpoint: "BRANCH_CREATED",
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: new Date(),
    });

    const res = await handleCheckpoint(
      new Request("http://localhost/api/agent-work/checkpoint", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ agentName: "test-agent", checkpoint: "branch-created" }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checkpoint).toBe("BRANCH_CREATED");
  });
});
