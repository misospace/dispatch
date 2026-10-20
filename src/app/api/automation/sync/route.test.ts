import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock } from "@/test/route-helpers";
import { resetRateLimits } from "@/lib/rate-limit";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

vi.mock("@/lib/config", () => ({
  getTrackedRepos: vi.fn().mockResolvedValue([]),
  parseExcludedLabels: vi.fn().mockReturnValue([]),
}));

const { mocks, mockTxClient } = vi.hoisted(() => ({
  mockTxClient: {
    syncLock: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "lock-1" }),
    },
    issueSyncRun: {
      create: vi.fn().mockResolvedValue({ id: "run-1", status: "running", syncType: "automation" }),
    },
  },
  mocks: {
    syncLockFindUnique: vi.fn().mockResolvedValue(null),
    syncLockCreate: vi.fn().mockResolvedValue({ id: "lock-1" }),
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
      create: mocks.syncLockCreate,
      delete: mocks.syncLockDelete,
      deleteMany: mocks.syncLockDeleteMany,
    },
    issueSyncRun: {
      create: vi.fn().mockResolvedValue({ id: "run-1", status: "running", syncType: "automation" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    automationSyncRun: {
      create: vi.fn().mockResolvedValue({ id: "auto-run-1" }),
      update: vi.fn().mockResolvedValue(undefined),
    },
    automationRepo: {
      upsert: mocks.upsert,
      update: vi.fn().mockResolvedValue({ id: "repo-1" }),
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
    githubPackage: {
      upsert: mocks.upsert,
    },
    githubPullRequest: {
      upsert: mocks.upsert,
    },
    automationEvent: {
      create: mocks.create,
    },
    $transaction: mocks.transactionFn,
  },
  asPrFixQueueClient: (client: unknown): unknown => client,
}));

vi.mock("@/lib/github", () => ({
  fetchRepo: vi.fn().mockResolvedValue({
    name: "test",
    owner: { login: "test" },
    default_branch: "main",
  }),
  fetchWorkflows: vi.fn().mockResolvedValue([]),
  fetchRecentRunsAllWorkflows: vi.fn().mockResolvedValue([]),
  fetchReleases: vi.fn().mockResolvedValue([]),
  fetchPullRequests: vi.fn().mockResolvedValue([]),
  fetchLatestCommit: vi.fn().mockResolvedValue({ sha: "abc123" }),
  fetchPackages: vi.fn().mockResolvedValue([]),
}));

import { POST } from "./route";

// The rate limiter keeps module-global state — reset it so the per-actor
// window never leaks between tests. This clears the window of the statically
// imported route; the rate-limit suite re-imports the limiter from the fresh
// registry to clear the dynamically imported route's window.
beforeEach(() => {
  resetRateLimits();
});

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

describe("POST /api/automation/sync — rate limit", () => {
  let acquireLock: ReturnType<typeof vi.fn>;
  let releaseLock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    acquireLock = vi.fn().mockResolvedValue({ locked: true, runId: "run-1" });
    releaseLock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/sync-lock", () => ({ acquireLock, releaseLock }));
    vi.resetModules();
    // The route is imported dynamically from a fresh module registry, so it
    // gets a fresh limiter instance — reset THAT instance's window, not the
    // one the file-level static import holds.
    const { resetRateLimits: resetFreshRateLimits } = await import("@/lib/rate-limit");
    resetFreshRateLimits();
  });

  afterEach(() => {
    vi.doUnmock("@/lib/sync-lock");
  });

  it("returns 429 after exceeding the rate limit (30 per 60s)", async () => {
    const { POST: POSTRateLimited } = await import("./route");

    for (let i = 0; i < 30; i++) {
      const res = await POSTRateLimited(new Request("http://localhost/api/automation/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
        body: JSON.stringify({}),
      }));
      expect(res.status).toBe(200);
    }

    const res = await POSTRateLimited(new Request("http://localhost/api/automation/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: "Rate limit exceeded" });
    // The 31st request is rejected before the automation lock is acquired.
    expect(acquireLock).toHaveBeenCalledTimes(30);
  });
});
