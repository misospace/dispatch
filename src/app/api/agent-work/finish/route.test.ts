import { describe, expect, it, vi, beforeEach } from "vitest";
import { makeDispatchEnvMock } from "@/test/route-helpers";
import { resetRateLimits } from "@/lib/rate-limit";

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

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock("test-token", {}, { "bound-token": "alpha", "bound-finish-agent": "test-agent" }));

import { POST as handleFinish } from "./route";

// The rate limiter keeps module-global state — reset it so the per-credential
// window never leaks between tests.
beforeEach(() => {
  resetRateLimits();
});

function makeFinishRequest(
  payload: Record<string, unknown>,
  token = "test-token",
  extraHeaders: Record<string, string> = {},
) {
  return handleFinish(
    new Request("http://localhost/api/agent-work/finish", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...extraHeaders,
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

  // #1331: a finish that identifies an issue must say which issue it looked
  // for — the agent's other issues' work is never settled as a fallback.
  it("returns 404 naming the identified issue when that issue has no active work", async () => {
    mockAgentWork.findFirst.mockResolvedValue(null);

    const res = await makeFinishRequest({
      agentName: "test-agent",
      state: "DONE",
      issueId: "GH_issue_abc123",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("No active work found for agent (issueId: GH_issue_abc123)");
    expect(mockAgentWork.update).not.toHaveBeenCalled();
  });

  // #1331: the parsed issueId must reach the selection query — a route that
  // stopped forwarding it would silently degrade a scoped finish to an
  // unscoped one (the agent's freshest active row) while every other test
  // still passes.
  it("scopes the selection query to the identified issue", async () => {
    const res = await makeFinishRequest({
      agentName: "test-agent",
      state: "DONE",
      issueId: "GH_issue_abc123",
    });
    expect(res.status).toBe(200);
    expect(mockAgentWork.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          agentName: "test-agent",
          issueId: "GH_issue_abc123",
          state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] },
        },
      })
    );
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

describe("POST /api/agent-work/finish — rate limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
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

  it("returns 429 after exceeding the rate limit (30 per 10s) without mutating work", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await makeFinishRequest({ agentName: "test-agent", state: "DONE" });
      expect(res.status).toBe(200);
    }

    const res = await makeFinishRequest({ agentName: "test-agent", state: "DONE" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: "Rate limit exceeded" });
    // The rejected request performed no work mutation.
    expect(mockAgentWork.update).toHaveBeenCalledTimes(30);
  });

  it("keeps an independent window for a second credential (#1322)", async () => {
    // Primary requests carry the same x-agent-name the second credential is
    // bound to, so a limiter regressing to the self-reported actor (or a
    // shared bucket) collapses both credentials into one window and 429s here.
    for (let i = 0; i < 30; i++) {
      const res = await makeFinishRequest(
        { agentName: "test-agent", state: "DONE" },
        "test-token",
        { "x-agent-name": "test-agent" },
      );
      expect(res.status).toBe(200);
    }
    const throttled = await makeFinishRequest(
      { agentName: "test-agent", state: "DONE" },
      "test-token",
      { "x-agent-name": "test-agent" },
    );
    expect(throttled.status).toBe(429);

    // A different credential finishing the same agent's work still succeeds:
    // the window is keyed on the credential-derived throttleKey, never a
    // shared or body-supplied agent-name bucket.
    const res = await makeFinishRequest({ agentName: "test-agent", state: "DONE" }, "bound-finish-agent");
    expect(res.status).toBe(200);
    expect(mockAgentWork.update).toHaveBeenCalledTimes(31);
  });
});

describe("POST /api/agent-work/finish — bound worker scope (#1129)", () => {
  it("denies a bound worker finishing another agent's work", async () => {
    const res = await handleFinish(
      new Request("http://localhost/api/agent-work/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer bound-token" },
        body: JSON.stringify({ agentName: "bravo", state: "DONE" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(mockAgentWork.update).not.toHaveBeenCalled();
  });
});
