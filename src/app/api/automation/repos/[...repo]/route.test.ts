import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";
import { resetRateLimits } from "@/lib/rate-limit";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUniqueAutomationRepo: vi.fn(),
    deleteAutomationRepo: vi.fn().mockResolvedValue(undefined),
    updateManyRepository: vi.fn().mockResolvedValue({ count: 1 }),
    createAuditLog: vi.fn().mockResolvedValue({ id: "log-1" }),

    githubWorkflowRunCount: vi.fn().mockResolvedValue(0),
    automationSyncRunFindFirst: vi.fn().mockResolvedValue(null),
    automationEventFindMany: vi.fn().mockResolvedValue([]),
    issueLifecycleEventFindMany: vi.fn().mockResolvedValue([]),
    issueFindMany: vi.fn().mockResolvedValue([]),
  },
}));

const { WORKER_TOKEN } = vi.hoisted(() => ({ WORKER_TOKEN: "worker-token" }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    automationRepo: {
      findUnique: mocks.findUniqueAutomationRepo,
      delete: mocks.deleteAutomationRepo,
    },
    repository: {
      updateMany: mocks.updateManyRepository,
    },
    auditLog: { create: mocks.createAuditLog },

    githubWorkflowRun: { count: mocks.githubWorkflowRunCount },
    automationSyncRun: { findFirst: mocks.automationSyncRunFindFirst },
    automationEvent: { findMany: mocks.automationEventFindMany },
    issueLifecycleEvent: { findMany: mocks.issueLifecycleEventFindMany },
    issue: { findMany: mocks.issueFindMany },
  },
}));

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock(mockToken, { [WORKER_TOKEN]: "worker", "second-maintainer": "maintainer" }));

import { GET, DELETE } from "./route";
import { resetAuthCaches } from "@/lib/auth";

// The rate limiter keeps module-global state — reset it so the per-credential
// window never leaks between tests.
beforeEach(() => {
  resetRateLimits();
});

function deleteRequest(repoSegments: string[], includeAuth = true, token?: string) {
  return DELETE(
    authedRequest(`http://localhost/api/automation/repos/${repoSegments.join("/")}`, {
      method: "DELETE",
      includeAuth,
      ...(token ? { token } : {}),
    }),
    { params: Promise.resolve({ repo: repoSegments }) },
  );
}


function getRequest(
  repoSegments: string[],
  searchParams?: Record<string, string>,
  options?: { token?: string; includeAuth?: boolean },
) {
  const url = new URL(`http://localhost/api/automation/repos/${repoSegments.join("/")}`);
  if (searchParams) {
    Object.entries(searchParams).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  return GET(
    authedRequest(url.toString(), { method: "GET", ...options }),
    { params: Promise.resolve({ repo: repoSegments }) },
  );
}

describe("GET /api/automation/repos/[...repo]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findUniqueAutomationRepo.mockResolvedValue({
      id: "repo-1",
      fullName: "myorg/myrepo",
      name: "myrepo",
      owner: "myorg",
      defaultBranch: "main",
      latestCommitSha: "abc123",
      openPRCount: 3,
      lastSyncedAt: new Date().toISOString(),
      syncError: null,
      workflows: [],
      releases: [],
      packages: [],
      _count: { workflows: 0, releases: 0 },
    });
    mocks.githubWorkflowRunCount.mockResolvedValue(0);
    mocks.automationSyncRunFindFirst.mockResolvedValue(null);
    mocks.automationEventFindMany.mockResolvedValue([]);
  });

  it("returns 400 when no repo parameter is provided", async () => {
    const res = await getRequest([]);
    expect(res.status).toBe(400);
  });

  it("returns 404 for an untracked repo", async () => {
    mocks.findUniqueAutomationRepo.mockResolvedValueOnce(null);
    const res = await getRequest(["myorg", "missing"]);
    expect(res.status).toBe(404);
  });

  it("returns repo data for a tracked repo", async () => {
    const res = await getRequest(["myorg", "myrepo"]);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.fullName).toBe("myorg/myrepo");
  });

  it("uses the query 'repo' param over the path segments", async () => {
    mocks.findUniqueAutomationRepo.mockClear();
    const res = await getRequest(["wrong", "repo"], { repo: "query/org/queryrepo" });
    expect(res.status).toBe(200);
    expect(mocks.findUniqueAutomationRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { fullName: "query/org/queryrepo" },
      }),
    );
  });

  it("decodes URL-encoded repo names in the path", async () => {
    const res = await getRequest(["myorg", "my%20repo"]);
    expect(res.status).toBe(200);
    expect(mocks.findUniqueAutomationRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { fullName: "myorg/my repo" },
      }),
    );
  });
});

describe("GET /api/automation/repos/[...repo] — auth", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.resetAllMocks();
  });

  it("returns 401 when no authorization header is provided", async () => {
    const res = await getRequest(["myorg", "myrepo"], undefined, { includeAuth: false });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(mocks.findUniqueAutomationRepo).not.toHaveBeenCalled();
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await getRequest(["myorg", "myrepo"], undefined, { token: "wrong-token" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(mocks.findUniqueAutomationRepo).not.toHaveBeenCalled();
  });

  it("returns 403 for a worker-tier token", async () => {
    const res = await getRequest(["myorg", "myrepo"], undefined, { token: WORKER_TOKEN });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("maintainer");
    expect(mocks.findUniqueAutomationRepo).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/automation/repos/[...repo] — auth", () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it("returns 401 when no authorization header is provided", async () => {
    const res = await DELETE(
      new Request(`http://localhost/api/automation/repos/myorg/myrepo`, { method: "DELETE" }),
      { params: Promise.resolve({ repo: ["myorg", "myrepo"] }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await DELETE(
      new Request(`http://localhost/api/automation/repos/myorg/myrepo`, {
        method: "DELETE",
        headers: { Authorization: "Bearer wrong-token" },
      }),
      { params: Promise.resolve({ repo: ["myorg", "myrepo"] }) },
    );
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/automation/repos/[...repo]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findUniqueAutomationRepo.mockResolvedValue({ id: "repo-1", source: "user" });
    mocks.deleteAutomationRepo.mockResolvedValue(undefined);
    mocks.updateManyRepository.mockResolvedValue({ count: 1 });
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  it("returns 404 when the repo is not tracked", async () => {
    mocks.findUniqueAutomationRepo.mockResolvedValueOnce(null);
    const res = await deleteRequest(["myorg", "missing"]);
    expect(res.status).toBe(404);
    expect(mocks.deleteAutomationRepo).not.toHaveBeenCalled();
  });

  it("deletes the AutomationRepo, soft-disables Repository, and writes an audit row", async () => {
    const res = await deleteRequest(["myorg", "myrepo"]);
    expect(res.status).toBe(200);

    expect(mocks.deleteAutomationRepo).toHaveBeenCalledWith({
      where: { fullName: "myorg/myrepo" },
    });
    expect(mocks.updateManyRepository).toHaveBeenCalledWith({
      where: { fullName: "myorg/myrepo" },
      data: { enabled: false },
    });
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "remove_tracked_repo",
        repoFullName: "myorg/myrepo",
        success: true,
        beforeLabels: ["user"],
      }),
    });
  });

  it("writes a failure audit row when delete throws", async () => {
    mocks.deleteAutomationRepo.mockRejectedValueOnce(new Error("db down"));
    const res = await deleteRequest(["myorg", "myrepo"]);
    expect(res.status).toBe(500);

    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "remove_tracked_repo",
        repoFullName: "myorg/myrepo",
        success: false,
        errorMessage: "db down",
      }),
    });
  });
});

describe("DELETE /api/automation/repos/[...repo] — rate limit", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    resetRateLimits();
    mocks.findUniqueAutomationRepo.mockResolvedValue({ id: "repo-1", source: "user" });
    mocks.deleteAutomationRepo.mockResolvedValue(undefined);
    mocks.updateManyRepository.mockResolvedValue({ count: 1 });
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  it("returns 429 after exceeding the rate limit (10 per 60s) without deleting", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await deleteRequest(["myorg", "myrepo"]);
      expect(res.status).toBe(200);
    }

    const res = await deleteRequest(["myorg", "myrepo"]);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: "Rate limit exceeded" });
    // The rejected request deleted nothing.
    expect(mocks.deleteAutomationRepo).toHaveBeenCalledTimes(10);
  });

  it("keeps an independent window for a second credential (#1322)", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await deleteRequest(["myorg", "myrepo"]);
      expect(res.status).toBe(200);
    }
    const throttled = await deleteRequest(["myorg", "myrepo"]);
    expect(throttled.status).toBe(429);

    // A different credential still deletes: the window is keyed on the
    // credential-derived throttleKey, never shared or caller-name derived.
    const res = await deleteRequest(["myorg", "myrepo"], true, "second-maintainer");
    expect(res.status).toBe(200);
    expect(mocks.deleteAutomationRepo).toHaveBeenCalledTimes(11);
  });
});





describe("GET /api/automation/repos/[...repo] — release pulse (#1484)", () => {
  const BASELINE_MS = Date.parse("2024-01-01T00:00:00Z");

  function readyRepo(overrides: Record<string, unknown> = {}) {
    return {
      id: "repo-1",
      fullName: "myorg/myrepo",
      name: "myrepo",
      owner: "myorg",
      defaultBranch: "main",
      latestCommitSha: "headsha1",
      releaseState: "ahead",
      releaseBaselineTag: "v1.0.0",
      releaseBaselineSha: "basesha1",
      releaseBaselinePublishedAt: new Date(BASELINE_MS),
      releaseHeadSha: "headsha1",
      releaseAheadBy: 7,
      releaseError: null,
      releaseDeltaSyncedAt: new Date("2024-01-02T00:00:00Z"),
      openPRCount: 0,
      lastSyncedAt: new Date("2024-01-02T00:00:00Z"),
      syncError: null,
      source: "user",
      workflows: [],
      releases: [],
      packages: [],
      _count: { workflows: 0, releases: 1 },
      ...overrides,
    };
  }

  function pulseGetRequest() {
    return GET(
      new Request("http://localhost/api/automation/repos/myorg/myrepo", {
        headers: { Authorization: `Bearer ${mockToken}` },
      }),
      { params: Promise.resolve({ repo: ["myorg", "myrepo"] }) },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    mocks.issueLifecycleEventFindMany.mockResolvedValue([]);
    mocks.issueFindMany.mockResolvedValue([]);
    mocks.githubWorkflowRunCount.mockResolvedValue(0);
    mocks.automationSyncRunFindFirst.mockResolvedValue(null);
    mocks.automationEventFindMany.mockResolvedValue([]);
  });

  it("returns a ready pulse and advisory readiness for a baseline repo", async () => {
    mocks.findUniqueAutomationRepo.mockResolvedValue(readyRepo());
    mocks.issueLifecycleEventFindMany.mockResolvedValue([
      {
        kind: "pr_merged",
        source: "github-webhook",
        actor: "myorg",
        agentName: null,
        fromStatus: null,
        toStatus: null,
        sourceEventId: "pr-101",
        occurredAt: new Date("2024-01-05T12:00:00Z"),
        observedAt: new Date("2024-01-05T12:00:05Z"),
        metadata: {
          pullRequestNumber: 101,
          pullRequestUrl: "https://github.com/myorg/myrepo/pull/101",
          mergeCommitSha: "mergesha1",
          mergedAt: "2024-01-05T12:00:00Z",
        },
        issueNumber: 41,
      },
    ]);
    mocks.issueFindMany.mockResolvedValue([
      {
        number: 41,
        title: "Bounded implementation work",
        url: "https://github.com/myorg/myrepo/issues/41",
        state: "closed",
        closedAt: new Date("2024-01-05T13:00:00Z"),
        labels: [],
        releaseSignal: { kind: "fix", headline: "Fix it", significance: null },
        decomposed: false,
        followUpUrls: [],
      },
    ]);

    const res = await pulseGetRequest();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.pulse.pulseState).toBe("ready");
    expect(data.pulse.baseline.tag).toBe("v1.0.0");
    expect(data.pulse.unreleasedCommits).toEqual({ state: "ahead", count: 7 });
    expect(data.pulse.deliveredIssueCount).toBe(1);
    expect(data.pulse.highlights).toHaveLength(1);
    // Advisory readiness is present with the derived CI context (no runs → unknown).
    expect(data.readiness.state).toBeDefined();
    expect(data.readiness.ci).toBe("unknown");
    // Positive success evidence is now counted for the CI context.
    expect(data.succeededRuns).toBe(0);
  });

  it("returns an unknown pulse for a repo without usable release evidence", async () => {
    mocks.findUniqueAutomationRepo.mockResolvedValue(readyRepo({ releaseState: "diverged" }));

    const res = await pulseGetRequest();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.pulse.pulseState).toBe("unknown");
    expect(data.readiness.state).toBe("unknown");
    // Non-ready repos stay cheap: no issue/event reads.
    expect(mocks.issueLifecycleEventFindMany).not.toHaveBeenCalled();
    expect(mocks.issueFindMany).not.toHaveBeenCalled();
  });
});
