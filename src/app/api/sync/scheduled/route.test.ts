import { describe, expect, it, vi, beforeEach } from "vitest";

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

// Mock modules before importing the route
vi.mock("@/lib/prisma", () => ({
  prisma: {
    syncLock: {
      findUnique: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    issueSyncRun: {
      create: vi.fn().mockResolvedValue({ id: "run-1" }),
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
          create: vi.fn().mockResolvedValue({ id: "run-1" }),
        },
      };
      return fn(tx);
    }),
  },
}));

vi.mock("@/lib/github", () => ({
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
}));

vi.mock("@/lib/config", () => ({
  getSyncRepos: vi.fn().mockResolvedValue([
    { id: "repo-1", fullName: "org/repo" },
  ]),
  getTrackedRepos: vi.fn().mockResolvedValue(["org/repo"]),
}));

const { POST } = await import("./route");

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

describe("POST /api/sync/scheduled — auth", () => {
  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(new Request("http://localhost/api/sync/scheduled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
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
    vi.clearAllMocks();
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
  });
});

describe("POST /api/sync/scheduled — validation", () => {
  it("returns 400 for invalid JSON body", async () => {
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

describe("POST /api/sync/scheduled — locking", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 409 when a sync is already running", async () => {
    const { prisma } = await import("@/lib/prisma");
    const mockFindUnique = vi.mocked(prisma.syncLock.findUnique);
    mockFindUnique.mockResolvedValue({
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
    const { prisma } = await import("@/lib/prisma");
    const mockFindUnique = vi.mocked(prisma.syncLock.findUnique);
    mockFindUnique.mockResolvedValue({
      id: "global",
      syncRunId: "sync-run-old",
      acquiredAt: new Date(Date.now() - 31 * 60 * 1000), // 31 min ago
    });

    const res = await POST(makeRequest());
    // Should succeed (200) since the lock is stale and was cleared
    expect(res.status).toBe(200);
  });
});

describe("POST /api/sync/scheduled — sync behavior", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("syncs issues by default", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.issues).toBeDefined();
    expect(body.issues.repos).toBe(1);
  });

  it("does not sync automation by default", async () => {
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.automation).toBeUndefined();
  });

  it("syncs automation when requested", async () => {
    const res = await POST(makeRequest({ automation: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.automation).toBeDefined();
  });

  it("can disable issue sync", async () => {
    const res = await POST(makeRequest({ issues: false }));
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.issues).toBeUndefined();
  });

  it("includes startedAt and finishedAt in response", async () => {
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.startedAt).toBeDefined();
    expect(body.finishedAt).toBeDefined();
  });
});
