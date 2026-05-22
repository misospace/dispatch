import { describe, expect, it, vi, beforeEach } from "vitest";

const mockAgentWork = {
  findMany: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  asAgentWorkClient: (client: any) => ({
    agentWork: mockAgentWork,
    agentWorkHistory: {},
    $transaction: vi.fn(),
  }),
}));

import { GET as handleActiveWork } from "./route";

function makeActiveWorkRequest(agentName: string) {
  return handleActiveWork(
    new Request(`http://localhost/api/agents/${agentName}/active-work`),
    { params: Promise.resolve({ agentName }) }
  );
}

describe("GET /api/agents/:agentName/active-work", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns active work for the agent", async () => {
    mockAgentWork.findMany.mockResolvedValue([
      {
        id: "work-1",
        agentName: "test-agent",
        state: "IN_PROGRESS",
        checkpoint: "CHANGES_MADE",
        issueId: "issue-abc",
        branch: "feat/my-feature",
        lastHeartbeatAt: new Date(),
      },
    ]);

    const res = await makeActiveWorkRequest("test-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].id).toBe("work-1");
  });

  it("returns empty array when no active work", async () => {
    mockAgentWork.findMany.mockResolvedValue([]);

    const res = await makeActiveWorkRequest("unknown-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  it("only returns active states (CLAIMED, IN_PROGRESS, BLOCKED)", async () => {
    mockAgentWork.findMany.mockResolvedValue([]);

    await makeActiveWorkRequest("test-agent");

    expect(mockAgentWork.findMany).toHaveBeenCalledWith({
      where: {
        agentName: "test-agent",
        state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] },
      },
      orderBy: { lastHeartbeatAt: "desc" },
    });
  });
});
