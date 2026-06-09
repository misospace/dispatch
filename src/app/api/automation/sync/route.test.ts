import { describe, expect, it, vi, beforeEach } from "vitest";

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => ({
  isAuthorizedAgentToken: vi.fn((token) => token === mockToken),
  isAuthorizedBearerToken: vi.fn((token) => token === mockToken),
  getAcceptedAgentTokens: vi.fn(() => [mockToken]),
  resetCaches: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  getTrackedRepos: vi.fn().mockResolvedValue([]),
  parseExcludedLabels: vi.fn().mockReturnValue([]),
}));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    syncLockFindUnique: vi.fn().mockResolvedValue(null),
    syncLockDelete: vi.fn().mockResolvedValue(undefined),
    syncLockDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    transactionFn: vi.fn(async (fn: any) => {
      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return runId;
    }),
    upsert: vi.fn().mockResolvedValue({ id: "ar-1", fullName: "org/repo" }),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    syncLock: {
      findUnique: mocks.syncLockFindUnique,
      delete: mocks.syncLockDelete,
      deleteMany: mocks.syncLockDeleteMany,
    },
    $transaction: mocks.transactionFn,
    automationRepo: {
      upsert: mocks.upsert,
    },
    githubWorkflow: {
      upsert: mocks.upsert,
      findMany: mocks.findMany,
      create: mocks.create,
    },
    githubWorkflowRun: {
      upsert: mocks.upsert,
      findUnique: vi.fn().mockResolvedValue(null),
    },
    githubWorkflowJob: {
      upsert: mocks.upsert,
    },
    githubRelease: {
      upsert: mocks.upsert,
    },
    githubPullRequest: {
      upsert: mocks.upsert,
    },
    githubPackage: {
      upsert: mocks.upsert,
    },
    automationEvent: {
      create: mocks.create,
    },
  },
}));

import { POST } from "./route";

describe("POST /api/automation/sync — auth", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(new Request("http://localhost/api/automation/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(new Request("http://localhost/api/automation/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(401);
  });

  it("returns 200 when valid token is provided (no repos to sync)", async () => {
    const res = await POST(new Request("http://localhost/api/automation/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(200);
  });
});
