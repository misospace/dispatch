import { describe, expect, it, vi, beforeEach } from "vitest";

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => ({
  isAuthorizedAgentToken: vi.fn((token) => token === mockToken),
}));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    deleteMany: vi.fn().mockResolvedValue({ count: 5 }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { deleteMany: mocks.deleteMany },
  },
}));

import { POST } from "./route";

describe("POST /api/issues/prune-closed — auth", () => {
  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(new Request("http://localhost/api/issues/prune-closed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(new Request("http://localhost/api/issues/prune-closed", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
    }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/issues/prune-closed — business logic", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.deleteMany.mockResolvedValue({ count: 3 }); });

  it("prunes closed issues and returns count", async () => {
    const res = await POST(new Request("http://localhost/api/issues/prune-closed", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.prunedCount).toBe(3);
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: {
        state: "closed",
        closedAt: expect.any(Object),
      },
    });
  });

  it("respects DISPATCH_CLOSED_ISSUE_RETENTION_DAYS env var", async () => {
    process.env.DISPATCH_CLOSED_ISSUE_RETENTION_DAYS = "7";
    const res = await POST(new Request("http://localhost/api/issues/prune-closed", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.retentionDays).toBe(7);
    delete process.env.DISPATCH_CLOSED_ISSUE_RETENTION_DAYS;
  });
});
