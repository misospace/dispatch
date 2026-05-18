import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findFirstIssue: vi.fn().mockResolvedValue(null),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    createAuditLog: vi.fn().mockResolvedValue({ id: "log-1" }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      findFirst: mocks.findFirstIssue,
      update: mocks.updateIssue,
    },
    auditLog: {
      create: mocks.createAuditLog,
    },
  },
}));

// Store the original env so we can restore it
const originalAgentToken = process.env.DISPATCH_AGENT_TOKEN;

import { POST } from "./route";

function decomposeRequest(payload: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/issues/actions/decompose", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify(payload),
    })
  );
}

describe("POST /api/issues/actions/decompose — actor attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DISPATCH_AGENT_TOKEN = "test-token";
    mocks.findFirstIssue.mockResolvedValue({
      id: "issue-1",
      number: 66,
      labels: ["priority/p1"],
    });
    mocks.updateIssue.mockResolvedValue({
      id: "issue-1",
      decomposed: true,
      decomposedAt: new Date(),
      decomposedBy: "example-agent",
      decomposedNote: null,
      followUpUrls: [],
    });
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  afterEach(() => {
    process.env.DISPATCH_AGENT_TOKEN = originalAgentToken;
  });

  it("defaults actor to 'agent' when no actor or agentName supplied", async () => {
    const res = await decomposeRequest({
      repo: "misospace/mission-control",
      issueNumber: 66,
      decomposed: true,
    });
    expect(res.status).toBe(200);

    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actor: "agent" }) })
    );
    expect(mocks.updateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ decomposedBy: "agent" }),
      })
    );
  });

  it("uses actor when provided", async () => {
    const res = await decomposeRequest({
      repo: "misospace/mission-control",
      issueNumber: 66,
      decomposed: true,
      actor: "example-agent",
    });
    expect(res.status).toBe(200);

    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actor: "example-agent" }) })
    );
    expect(mocks.updateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ decomposedBy: "example-agent" }),
      })
    );
  });

  it("uses agentName as fallback when actor is not provided", async () => {
    const res = await decomposeRequest({
      repo: "misospace/mission-control",
      issueNumber: 66,
      decomposed: true,
      agentName: "fallback-agent",
    });
    expect(res.status).toBe(200);

    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actor: "fallback-agent" }) })
    );
    expect(mocks.updateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ decomposedBy: "fallback-agent" }),
      })
    );
  });

  it("prefers actor over agentName when both are provided", async () => {
    const res = await decomposeRequest({
      repo: "misospace/mission-control",
      issueNumber: 66,
      decomposed: true,
      actor: "primary-agent",
      agentName: "secondary-agent",
    });
    expect(res.status).toBe(200);

    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actor: "primary-agent" }) })
    );
    expect(mocks.updateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ decomposedBy: "primary-agent" }),
      })
    );
  });

  it("returns 400 when actor is not a string", async () => {
    const res = await decomposeRequest({
      repo: "misospace/mission-control",
      issueNumber: 66,
      decomposed: true,
      actor: 123 as unknown as string,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("'actor'/'agentName' must be a string");
  });

  it("returns 400 when actor is empty string", async () => {
    const res = await decomposeRequest({
      repo: "misospace/mission-control",
      issueNumber: 66,
      decomposed: true,
      actor: "",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("'actor'/'agentName' must not be empty after trimming");
  });

  it("returns 400 when actor is whitespace only", async () => {
    const res = await decomposeRequest({
      repo: "misospace/mission-control",
      issueNumber: 66,
      decomposed: true,
      actor: "   ",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("'actor'/'agentName' must not be empty after trimming");
  });

  it("returns 400 when actor exceeds 100 characters", async () => {
    const res = await decomposeRequest({
      repo: "misospace/mission-control",
      issueNumber: 66,
      decomposed: true,
      actor: "a".repeat(101),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("'actor'/'agentName' must be at most 100 characters");
  });

  it("trims actor value before storing", async () => {
    const res = await decomposeRequest({
      repo: "misospace/mission-control",
      issueNumber: 66,
      decomposed: true,
      actor: "  trimmed-agent  ",
    });
    expect(res.status).toBe(200);

    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actor: "trimmed-agent" }) })
    );
  });
});

describe("POST /api/issues/actions/decompose — reactivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DISPATCH_AGENT_TOKEN = "test-token";
    mocks.findFirstIssue.mockResolvedValue({
      id: "issue-1",
      number: 66,
      labels: ["priority/p1"],
    });
    mocks.updateIssue.mockResolvedValue({
      id: "issue-1",
      decomposed: false,
      decomposedAt: null,
      decomposedBy: null,
      decomposedNote: null,
      followUpUrls: [],
    });
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  afterEach(() => {
    process.env.DISPATCH_AGENT_TOKEN = originalAgentToken;
  });

  it("stores null decomposedBy when reactivating (decomposed=false)", async () => {
    const res = await decomposeRequest({
      repo: "misospace/mission-control",
      issueNumber: 66,
      decomposed: false,
      actor: "example-agent",
    });
    expect(res.status).toBe(200);

    expect(mocks.updateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ decomposedBy: null }),
      })
    );
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "issue_reactivated" }) })
    );
  });
});
