import { describe, expect, it, vi, beforeEach } from "vitest";
import { makeDispatchEnvMock } from "@/test/route-helpers";

const mockAgentWork = {
  create: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
};

const mockAgentWorkHistory = {
  create: vi.fn(),
};

const mockTransaction = vi.fn((fn: (tx: any) => Promise<any>) => fn({
  agentWork: mockAgentWork,
  agentWorkHistory: mockAgentWorkHistory,
}));

const { mockIssueFindUnique } = vi.hoisted(() => ({ mockIssueFindUnique: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      create: vi.fn(async () => ({ id: "audit-1" })),
    },
    issue: {
      findUnique: mockIssueFindUnique,
    },
  },
  asAgentWorkClient: (client: any) => ({
    agentWork: mockAgentWork,
    agentWorkHistory: mockAgentWorkHistory,
    $transaction: mockTransaction,
  }),
}));

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock("test-token", {}, { "bound-token": "alpha" }));

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
    mockAgentWork.findMany.mockResolvedValue([]);
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
    mockAgentWork.findMany.mockResolvedValueOnce([
      {
        id: "old-work-1",
        agentName: "test-agent",
        issueId: "issue-abc",
        state: "IN_PROGRESS",
      },
    ]);

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

  // #1605: the queue never offers an excluded issue and the claim refuses it
  // by id; start is the last door where an AgentWork row could still attach.
  it("refuses an issue whose cached labels match DISPATCH_EXCLUDED_LABELS", async () => {
    process.env.DISPATCH_EXCLUDED_LABELS = "wontfix, hold";
    try {
      mockIssueFindUnique.mockResolvedValue({ id: "issue-abc", labels: ["wontfix"] });
      const res = await makeStartRequest({ agentName: "test-agent", issueId: "issue-abc" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("DISPATCH_EXCLUDED_LABELS");
      expect(mockAgentWork.create).not.toHaveBeenCalled();
    } finally {
      delete process.env.DISPATCH_EXCLUDED_LABELS;
    }
  });

  it("starts work when the cached labels do not match the excluded set", async () => {
    process.env.DISPATCH_EXCLUDED_LABELS = "wontfix";
    try {
      mockIssueFindUnique.mockResolvedValue({ id: "issue-abc", labels: ["bug", "status/ready"] });
      const res = await makeStartRequest({ agentName: "test-agent", issueId: "issue-abc" });
      expect(res.status).toBe(201);
      expect(mockAgentWork.create).toHaveBeenCalled();
    } finally {
      delete process.env.DISPATCH_EXCLUDED_LABELS;
    }
  });

  it("does not refuse an issueId missing from the cache — the request proceeds as before", async () => {
    process.env.DISPATCH_EXCLUDED_LABELS = "wontfix";
    try {
      mockIssueFindUnique.mockResolvedValue(null);
      const res = await makeStartRequest({ agentName: "test-agent", issueId: "issue-missing" });
      // The gate adds no refusal; what startAgentWork then does with an
      // uncached issueId (a real DB has an AgentWork.issueId → Issue FK) is
      // pre-existing behavior outside this gate, not asserted here.
      expect(res.status).not.toBe(400);
      expect(mockAgentWork.create).toHaveBeenCalled();
    } finally {
      delete process.env.DISPATCH_EXCLUDED_LABELS;
    }
  });

  it("reads no issue row when DISPATCH_EXCLUDED_LABELS is unset", async () => {
    const res = await makeStartRequest({ agentName: "test-agent", issueId: "issue-abc" });
    expect(res.status).toBe(201);
    expect(mockIssueFindUnique).not.toHaveBeenCalled();
  });
});

describe("POST /api/agent-work/start — bound worker scope (#1129)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("denies a bound worker starting work for another agent", async () => {
    const res = await handleStart(
      new Request("http://localhost/api/agent-work/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer bound-token" },
        body: JSON.stringify({ agentName: "bravo" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(mockAgentWork.create).not.toHaveBeenCalled();
  });
});
