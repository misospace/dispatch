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
  prisma: {},
  asAgentWorkClient: (client: any) => ({
    agentWork: mockAgentWork,
    agentWorkHistory: mockAgentWorkHistory,
    $transaction: mockTransaction,
  }),
}));

vi.mock("@/lib/dispatch-env", () => ({
  isAuthorizedAgentToken: vi.fn((token: string | null | undefined) => token === "test-token"),
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
    expect(body.error).toBe("Missing required field: agentName");
  });

  it("returns 400 when state is missing", async () => {
    const res = await makeFinishRequest({ agentName: "test-agent" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required field: state");
  });

  it("returns 400 when state is invalid", async () => {
    const res = await makeFinishRequest({
      agentName: "test-agent",
      state: "INVALID_STATE",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid state value");
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
});
