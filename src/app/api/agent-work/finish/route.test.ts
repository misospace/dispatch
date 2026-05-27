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

import { POST as handleFinish } from "./route";

function makeFinishRequest(payload: Record<string, unknown>) {
  return handleFinish(
    new Request("http://localhost/api/agent-work/finish", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify(payload),
    })
  );
}

describe("POST /api/agent-work/finish", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentWork.findFirst.mockResolvedValue({
      id: "work-1",
      agentName: "test-agent",
      state: "IN_PROGRESS",
      checkpoint: "CHANGES_MADE",
    });
    mockAgentWork.update.mockResolvedValue({
      id: "work-1",
      agentName: "test-agent",
      state: "DONE",
      checkpoint: "DONE",
      summary: "All changes applied and tested",
    });
    mockAgentWorkHistory.create.mockResolvedValue({ id: "hist-1" });
  });

  it("finishes work with DONE status", async () => {
    const res = await makeFinishRequest({
      agentName: "test-agent",
      state: "DONE",
      summary: "All changes applied and tested",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("DONE");
    expect(body.summary).toBe("All changes applied and tested");
  });

  it("finishes work with BLOCKED status", async () => {
    mockAgentWork.update.mockResolvedValue({
      id: "work-1",
      agentName: "test-agent",
      state: "BLOCKED",
    });

    const res = await makeFinishRequest({
      agentName: "test-agent",
      state: "BLOCKED",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("BLOCKED");
  });

  it("returns 400 when agentName is missing", async () => {
    const res = await makeFinishRequest({ state: "DONE" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required field: agentName (string)");
  });

  it("returns 400 when state is missing", async () => {
    const res = await makeFinishRequest({ agentName: "test-agent" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("expected a string");
  });

  it("returns 400 when state is invalid", async () => {
    const res = await makeFinishRequest({
      agentName: "test-agent",
      state: "INVALID_STATE",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid state value");
    expect(body.error).toContain("INVALID_STATE");
  });

  it("returns 401 when token is invalid", async () => {
    const res = await handleFinish(
      new Request("http://localhost/api/agent-work/finish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ agentName: "test-agent", state: "DONE" }),
      })
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 404 when no active work found for agent", async () => {
    mockAgentWork.findFirst.mockResolvedValue(null);

    const res = await makeFinishRequest({
      agentName: "unknown-agent",
      state: "DONE",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("No active work found for agent");
  });

  it("returns 400 when body is null", async () => {
    const res = await handleFinish(
      new Request("http://localhost/api/agent-work/finish", {
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
    const res = await handleFinish(
      new Request("http://localhost/api/agent-work/finish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify([{ agentName: "test-agent", state: "DONE" }]),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("expected an object");
  });

  it("returns 400 when body is a string", async () => {
    const res = await handleFinish(
      new Request("http://localhost/api/agent-work/finish", {
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

  it("returns 400 when state is a nested object", async () => {
    const res = await handleFinish(
      new Request("http://localhost/api/agent-work/finish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ agentName: "test-agent", state: { nested: "DONE" } }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("expected a string");
  });

  it("returns 400 when state is a number", async () => {
    const res = await handleFinish(
      new Request("http://localhost/api/agent-work/finish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ agentName: "test-agent", state: 42 }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid state value");
  });

  it("returns 400 when agentName is an empty string", async () => {
    const res = await makeFinishRequest({ agentName: "", state: "DONE" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required field: agentName (string)");
  });

  it("returns 400 when state is an empty string", async () => {
    const res = await makeFinishRequest({ agentName: "test-agent", state: "" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Missing required field: state");
  });

  it("returns 400 when state is an array", async () => {
    const res = await handleFinish(
      new Request("http://localhost/api/agent-work/finish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ agentName: "test-agent", state: ["DONE"] }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("expected a string");
  });

  it("includes valid state values in the error message", async () => {
    const res = await makeFinishRequest({
      agentName: "test-agent",
      state: "WRONG_STATE",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("CLAIMED");
    expect(body.error).toContain("IN_PROGRESS");
    expect(body.error).toContain("WRONG_STATE");
  });

  it("accepts state with hyphens and normalizes to underscores", async () => {
    mockAgentWork.update.mockResolvedValue({
      id: "work-1",
      agentName: "test-agent",
      state: "IN_PROGRESS",
      checkpoint: "CHANGES_MADE",
    });

    const res = await handleFinish(
      new Request("http://localhost/api/agent-work/finish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ agentName: "test-agent", state: "in-progress" }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("IN_PROGRESS");
  });
});
