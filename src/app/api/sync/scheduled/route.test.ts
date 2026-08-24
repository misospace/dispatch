import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, authedRequest } from "@/test/route-helpers";

function createPrismaMock() {
  let transactionRunId: string | null = null;

  const syncLockFindUnique = vi.fn();
  const syncLockDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const syncLockCreate = vi.fn().mockResolvedValue({ id: "global" });
  // Atomic claim used by acquireLock's UPDATE ... WHERE flow. Default
  // count 0 routes acquisition down the insert path, like an absent row.
  const syncLockUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  const issueSyncRunCreate = vi.fn().mockImplementation(async () => {
    const id = `run-${Date.now()}`;
    transactionRunId = id;
    return { id, status: "running", syncType: "scheduled" };
  });

  return {
    get transactionRunId() { return transactionRunId; },
    prisma: {
      syncLock: {
        findUnique: syncLockFindUnique,
        delete: vi.fn().mockResolvedValue(undefined),
        deleteMany: syncLockDeleteMany,
        create: syncLockCreate,
        updateMany: syncLockUpdateMany,
      },
      issueSyncRun: {
        create: issueSyncRunCreate,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      automationRepo: {
        upsert: vi.fn().mockResolvedValue({ id: "ar-1", fullName: "org/repo" }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      automationSyncRun: {
        create: vi.fn().mockResolvedValue({ id: "asr-1" }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      githubWorkflow: {
        upsert: vi.fn().mockResolvedValue(undefined),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: "gw-1" }),
      },
      githubWorkflowRun: {
        upsert: vi.fn().mockResolvedValue(undefined),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      githubWorkflowJob: {
        upsert: vi.fn().mockResolvedValue(undefined),
      },
      githubRelease: {
        upsert: vi.fn().mockResolvedValue(undefined),
      },
      githubPullRequest: {
        upsert: vi.fn().mockResolvedValue(undefined),
      },
      githubPackage: {
        upsert: vi.fn().mockResolvedValue(undefined),
      },
      automationEvent: {
        create: vi.fn().mockResolvedValue(undefined),
      },
      issue: {
        findUnique: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue(undefined),
        findMany: vi.fn().mockResolvedValue([]),
        aggregate: vi.fn().mockResolvedValue({ _max: { lastSyncedAt: null } }),
      },
      $transaction: vi.fn(async (fn: (tx: any) => Promise<string>) => {
        // The tx delegates share the outer mocks so tests can observe and
        // steer the in-transaction claim (updateMany) and insert (create).
        const tx = {
          syncLock: {
            findUnique: syncLockFindUnique,
            create: syncLockCreate,
            updateMany: syncLockUpdateMany,
          },
          issueSyncRun: {
            create: issueSyncRunCreate,
          },
        };
        return fn(tx);
      }),
    },
  };
}

function createGithubMock() {
  return {
    fetchIssues: vi.fn().mockResolvedValue([]),
    syncStatusLabels: vi.fn(),
    fetchIssue: vi.fn().mockResolvedValue({
      number: 1,
      state: "open",
      labels: [],
      closed_at: null,
    }),
    fetchRepo: vi.fn().mockResolvedValue({
      name: "test-repo",
      owner: { login: "test-owner" },
      default_branch: "main",
    }),
    fetchWorkflows: vi.fn().mockResolvedValue([]),
    fetchRecentRunsAllWorkflows: vi.fn().mockResolvedValue([]),
    fetchReleases: vi.fn().mockResolvedValue([]),
    fetchPullRequests: vi.fn().mockResolvedValue([]),
    fetchPackages: vi.fn().mockResolvedValue([]),
    fetchLatestCommit: vi.fn().mockResolvedValue(null),
    fetchRunJobs: vi.fn().mockResolvedValue([]),
  };
}

function createConfigMock() {
  return {
    getSyncRepos: vi.fn().mockResolvedValue([
      { id: "repo-1", fullName: "org/repo" },
    ]),
    getTrackedRepos: vi.fn().mockResolvedValue(["org/repo"]),
    parseExcludedLabels: vi.fn().mockReturnValue([]),
  };
}

function setupModules(prismaMock: ReturnType<typeof createPrismaMock>, githubMock: ReturnType<typeof createGithubMock>, configMock: ReturnType<typeof createConfigMock>) {
  process.env.DISPATCH_AGENT_TOKEN = mockToken;

  vi.doMock("@/lib/prisma", () => ({ prisma: prismaMock.prisma }));
  vi.doMock("@/lib/github", () => githubMock);
  vi.doMock("@/lib/config", () => configMock);
}

function makeRequest(body?: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  return authedRequest("http://localhost/api/sync/scheduled", { method: "POST", body: body ?? {}, headers: extraHeaders });
}

// ---------------------------------------------------------------------------
// Auth tests
// ---------------------------------------------------------------------------

describe("POST /api/sync/scheduled — auth", () => {
  let prismaMock: ReturnType<typeof createPrismaMock>;
  let githubMock: ReturnType<typeof createGithubMock>;
  let configMock: ReturnType<typeof createConfigMock>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = createPrismaMock();
    githubMock = createGithubMock();
    configMock = createConfigMock();
    setupModules(prismaMock, githubMock, configMock);
  });

  it("returns 401 when no authorization header is provided", async () => {
    const { POST } = await import("./route");
    const res = await POST(new Request("http://localhost/api/sync/scheduled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const { POST } = await import("./route");
    const res = await POST(new Request("http://localhost/api/sync/scheduled", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(401);
  });

  it("returns 200 when correct token is provided", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe("POST /api/sync/scheduled — validation", () => {
  let prismaMock: ReturnType<typeof createPrismaMock>;
  let githubMock: ReturnType<typeof createGithubMock>;
  let configMock: ReturnType<typeof createConfigMock>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = createPrismaMock();
    githubMock = createGithubMock();
    configMock = createConfigMock();
    setupModules(prismaMock, githubMock, configMock);
  });

  it("returns 400 for invalid JSON body", async () => {
    const { POST } = await import("./route");
    const res = await POST(new Request("http://localhost/api/sync/scheduled", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mockToken}`,
      },
      body: "not-json",
    }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for null body", async () => {
    const { POST } = await import("./route");
    const res = await POST(new Request("http://localhost/api/sync/scheduled", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mockToken}`,
      },
      body: JSON.stringify(null),
    }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for primitive body", async () => {
    const { POST } = await import("./route");
    const res = await POST(new Request("http://localhost/api/sync/scheduled", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mockToken}`,
      },
      body: JSON.stringify(42),
    }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Locking tests
// ---------------------------------------------------------------------------

describe("POST /api/sync/scheduled — locking", () => {
  let prismaMock: ReturnType<typeof createPrismaMock>;
  let githubMock: ReturnType<typeof createGithubMock>;
  let configMock: ReturnType<typeof createConfigMock>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = createPrismaMock();
    githubMock = createGithubMock();
    configMock = createConfigMock();
    setupModules(prismaMock, githubMock, configMock);
  });

  it("returns 409 when a sync is already running", async () => {
    const { POST } = await import("./route");
    prismaMock.prisma.syncLock.findUnique.mockResolvedValue({
      id: "global",
      syncRunId: "sync-run-123",
      acquiredAt: new Date(),
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("already running");
  });

  it("allows sync when existing lock is stale (>30 min)", async () => {
    const { POST } = await import("./route");
    prismaMock.prisma.syncLock.findUnique.mockResolvedValue({
      id: "global",
      syncRunId: "sync-run-old",
      acquiredAt: new Date(Date.now() - 31 * 60 * 1000), // 31 min ago
    });
    // The atomic conditional claim takes the stale row over in place
    // (no delete + re-create anymore).
    prismaMock.prisma.syncLock.updateMany.mockResolvedValue({ count: 1 });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(prismaMock.prisma.syncLock.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "global" }),
        data: expect.objectContaining({ syncRunId: expect.any(String) }),
      }),
    );
    expect(prismaMock.prisma.syncLock.delete).not.toHaveBeenCalled();
  });

  it("releases lock by deleting the row on normal completion", async () => {
    const { POST } = await import("./route");
    prismaMock.prisma.syncLock.findUnique.mockResolvedValue(null);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    // deleteMany should have been called to remove the lock row
    expect(prismaMock.prisma.syncLock.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "global" }),
      }),
    );
  });

  it("releases lock by deleting the row on failure", async () => {
    const { POST } = await import("./route");
    prismaMock.prisma.syncLock.findUnique.mockResolvedValue(null);
    configMock.getSyncRepos.mockRejectedValue(new Error("DB connection failed"));

    const res = await POST(makeRequest());
    expect(res.status).toBe(500);

    // Lock should be released via deleteMany even on failure
    expect(prismaMock.prisma.syncLock.deleteMany).toHaveBeenCalled();
  });

  it("allows second run after normal lock release", async () => {
    const { POST } = await import("./route");
    prismaMock.prisma.syncLock.findUnique.mockResolvedValue(null);

    const res1 = await POST(makeRequest());
    expect(res1.status).toBe(200);

    // Second call: fresh mocks from resetModules, findUnique returns null (no lock)
    vi.resetModules();
    prismaMock = createPrismaMock();
    githubMock = createGithubMock();
    configMock = createConfigMock();
    setupModules(prismaMock, githubMock, configMock);

    const { POST: POST2 } = await import("./route");
    const res2 = await POST2(makeRequest());
    expect(res2.status).toBe(200);
  });

  it("marks IssueSyncRun as completed on normal finish", async () => {
    const { POST } = await import("./route");
    prismaMock.prisma.syncLock.findUnique.mockResolvedValue(null);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    // updateMany should have been called with status: "completed"
    expect(prismaMock.prisma.issueSyncRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "completed" }),
      }),
    );
  });

  it("marks IssueSyncRun as failed on error", async () => {
    const { POST } = await import("./route");
    prismaMock.prisma.syncLock.findUnique.mockResolvedValue(null);
    configMock.getSyncRepos.mockRejectedValue(new Error("connection refused"));

    const res = await POST(makeRequest());
    expect(res.status).toBe(500);

    // updateMany should have been called with status: "failed"
    expect(prismaMock.prisma.issueSyncRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Sync behavior tests
// ---------------------------------------------------------------------------

describe("POST /api/sync/scheduled — sync behavior", () => {
  let prismaMock: ReturnType<typeof createPrismaMock>;
  let githubMock: ReturnType<typeof createGithubMock>;
  let configMock: ReturnType<typeof createConfigMock>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = createPrismaMock();
    githubMock = createGithubMock();
    configMock = createConfigMock();
    setupModules(prismaMock, githubMock, configMock);
  });

  it("syncs issues by default", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.issues).toBeDefined();
    expect(body.issues.repos).toBe(1);
  });

  it("fetches closed issues too, so closed=>done enforcement can run (#521 regression)", async () => {
    const { POST } = await import("./route");
    const github = await import("@/lib/github");
    await POST(makeRequest());
    expect(github.fetchIssues).toHaveBeenCalledWith(expect.any(String), { includeClosed: true });
  });

  it("does not sync automation by default", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.automation).toBeUndefined();
  });

  it("syncs automation when requested", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeRequest({ automation: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.automation).toBeDefined();
  });

  it("can disable issue sync", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeRequest({ issues: false }));
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.issues).toBeUndefined();
  });

  it("includes startedAt and finishedAt in response", async () => {
    const { POST } = await import("./route");
    prismaMock.prisma.syncLock.findUnique.mockResolvedValue(null);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.startedAt).toBeDefined();
    expect(body.finishedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Closed issue reconciliation tests
// ---------------------------------------------------------------------------

describe("POST /api/sync/scheduled — closed issue reconciliation", () => {
  let prismaMock: ReturnType<typeof createPrismaMock>;
  let githubMock: ReturnType<typeof createGithubMock>;
  let configMock: ReturnType<typeof createConfigMock>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = createPrismaMock();
    githubMock = createGithubMock();
    configMock = createConfigMock();
    setupModules(prismaMock, githubMock, configMock);
  });

  it("reconciles a closed GitHub issue cached as status/in-review to status/done", async () => {
    const { POST } = await import("./route");
    prismaMock.prisma.syncLock.findUnique.mockResolvedValue(null);

    prismaMock.prisma.issue.findMany.mockResolvedValue([
      { id: "issue-1", number: 42, labels: ["status/in-review", "type/bug"], state: "open" },
    ]);

    githubMock.fetchIssue.mockResolvedValue({
      number: 42,
      state: "closed",
      closed_at: "2025-01-15T10:00:00Z",
      labels: [],
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.closedIssueReconcile).toBeDefined();
    expect(body.closedIssueReconcile.issuesReconciled).toBe(1);
    expect(prismaMock.prisma.issue.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "issue-1" },
        data: expect.objectContaining({
          state: "closed",
          labels: expect.arrayContaining(["status/done"]),
        }),
      }),
    );
  });

  it("reconciles a closed GitHub issue cached as status/ready to status/done", async () => {
    const { POST } = await import("./route");
    prismaMock.prisma.syncLock.findUnique.mockResolvedValue(null);

    prismaMock.prisma.issue.findMany.mockResolvedValue([
      { id: "issue-2", number: 99, labels: ["status/ready", "type/feature"], state: "closed" },
    ]);

    githubMock.fetchIssue.mockResolvedValue({
      number: 99,
      state: "closed",
      closed_at: null,
      labels: [],
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.closedIssueReconcile.issuesReconciled).toBe(1);
    expect(prismaMock.prisma.issue.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "issue-2" },
        data: expect.objectContaining({
          state: "closed",
          labels: expect.arrayContaining(["status/done"]),
        }),
      }),
    );
  });

  it("leaves open issues that are still open on GitHub", async () => {
    const { POST } = await import("./route");
    prismaMock.prisma.syncLock.findUnique.mockResolvedValue(null);

    prismaMock.prisma.issue.findMany.mockResolvedValue([
      { id: "issue-3", number: 10, labels: ["status/in-progress"], state: "open" },
    ]);

    githubMock.fetchIssue.mockResolvedValue({
      number: 10,
      state: "open",
      labels: ["status/in-progress"],
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.closedIssueReconcile.issuesReconciled).toBe(0);
    expect(prismaMock.prisma.issue.update).not.toHaveBeenCalled();
  });

  it("skips issues without active status labels", async () => {
    const { POST } = await import("./route");
    prismaMock.prisma.syncLock.findUnique.mockResolvedValue(null);

    prismaMock.prisma.issue.findMany.mockResolvedValue([
      { id: "issue-4", number: 5, labels: ["type/bug"], state: "open" },
    ]);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.closedIssueReconcile.issuesChecked).toBe(0);
  });

  it("preserves agent/* labels during reconciliation", async () => {
    const { POST } = await import("./route");
    prismaMock.prisma.syncLock.findUnique.mockResolvedValue(null);

    prismaMock.prisma.issue.findMany.mockResolvedValue([
      { id: "issue-5", number: 7, labels: ["status/in-progress", "agent/alpha"], state: "open" },
    ]);

    githubMock.fetchIssue.mockResolvedValue({
      number: 7,
      state: "closed",
      closed_at: "2025-06-01T12:00:00Z",
      labels: [],
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(prismaMock.prisma.issue.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "issue-5" },
        data: expect.objectContaining({
          labels: expect.arrayContaining(["agent/alpha", "status/done"]),
        }),
      }),
    );
  });

  it("includes closedIssueReconcile in response when reconciliation runs", async () => {
    const { POST } = await import("./route");
    prismaMock.prisma.syncLock.findUnique.mockResolvedValue(null);

    prismaMock.prisma.issue.findMany.mockResolvedValue([]);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.closedIssueReconcile).toBeDefined();
    expect(body.closedIssueReconcile.issuesChecked).toBe(0);
  });
});
