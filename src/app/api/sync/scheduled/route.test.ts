import { describe, expect, it, vi, beforeEach } from "vitest";

const mockToken = "test-agent-token";

function createPrismaMock() {
  let transactionRunId: string | null = null;

  return {
    get transactionRunId() { return transactionRunId; },
    prisma: {
      syncLock: {
        findUnique: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      issueSyncRun: {
        create: vi.fn().mockImplementation(async () => {
          const id = `run-${Date.now()}`;
          transactionRunId = id;
          return { id, status: "running", syncType: "scheduled" };
        }),
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
      },
      $transaction: vi.fn(async (fn: (tx: any) => Promise<string>) => {
        const tx = {
          syncLock: {
            findUnique: vi.fn(),
            create: vi.fn().mockResolvedValue({ id: "global" }),
          },
          issueSyncRun: {
            create: vi.fn().mockImplementation(async () => {
              const id = `run-${Date.now()}`;
              transactionRunId = id;
              return { id, status: "running", syncType: "scheduled" };
            }),
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
  };
}

function setupModules(prismaMock: ReturnType<typeof createPrismaMock>, githubMock: ReturnType<typeof createGithubMock>, configMock: ReturnType<typeof createConfigMock>) {
  process.env.DISPATCH_AGENT_TOKEN = mockToken;

  vi.doMock("@/lib/prisma", () => ({ prisma: prismaMock.prisma }));
  vi.doMock("@/lib/github", () => githubMock);
  vi.doMock("@/lib/config", () => configMock);
}

function makeRequest(body?: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  return new Request("http://localhost/api/sync/scheduled", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${mockToken}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body ?? {}),
  });
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

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
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
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.startedAt).toBeDefined();
    expect(body.finishedAt).toBeDefined();
  });
});
