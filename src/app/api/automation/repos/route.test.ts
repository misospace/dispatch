import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock } from "@/test/route-helpers";
import { resetRateLimits } from "@/lib/rate-limit";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

const { mocks } = vi.hoisted(() => ({
  mocks: {
    createAutomationRepo: vi.fn(),
    upsertRepository: vi.fn(),
    findAutomationRepos: vi.fn(),
    countWorkflowRuns: vi.fn(),
    findLastSyncRun: vi.fn(),
    findLifecycleEvents: vi.fn(),
    findIssues: vi.fn(),
    transaction: vi.fn((callback) =>
      callback({
        automationRepo: { create: mocks.createAutomationRepo },
        repository: { upsert: mocks.upsertRepository },
        auditLog: { create: mocks.createAuditLog },
      }),
    ),
    createAuditLog: vi.fn().mockResolvedValue({ id: "log-1" }),
    createTrackedRepo: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    automationRepo: { create: mocks.createAutomationRepo, findMany: mocks.findAutomationRepos },
    repository: { upsert: mocks.upsertRepository },
    auditLog: { create: mocks.createAuditLog },
    githubWorkflowRun: { count: mocks.countWorkflowRuns },
    automationSyncRun: { findFirst: mocks.findLastSyncRun },
    issueLifecycleEvent: { findMany: mocks.findLifecycleEvents },
    issue: { findMany: mocks.findIssues },
  },
}));

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

// Real Prisma error shape so the `instanceof` check in the route triggers.
vi.mock("@prisma/client", () => ({
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code: string;
      clientVersion: string;
      constructor(message: string, opts: { code: string; clientVersion?: string }) {
        super(message);
        this.code = opts.code;
        this.clientVersion = opts.clientVersion ?? "test";
      }
    },
  },
}));

// The route creates the tracked repo through createTrackedRepo. Wrap the real
// implementation in a spy so the test can count calls; the real one still
// writes through the mocked prisma client.
vi.mock("@/lib/tracked-repos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tracked-repos")>();
  mocks.createTrackedRepo.mockImplementation(actual.createTrackedRepo);
  return { ...actual, createTrackedRepo: mocks.createTrackedRepo };
});

import { POST, GET } from "./route";
import { Prisma } from "@prisma/client";

// The rate limiter keeps module-global state — reset it so the per-actor
// window never leaks between tests.
beforeEach(() => {
  resetRateLimits();
});

function postRequest(body: unknown, includeAuth = true) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (includeAuth) headers.Authorization = `Bearer ${mockToken}`;
  return POST(
    new Request("http://localhost/api/automation/repos", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/automation/repos — auth", () => {
  it("returns 401 when no authorization header is provided", async () => {
    const res = await postRequest({ fullName: "org/repo" }, false);
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(
      new Request("http://localhost/api/automation/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
        body: JSON.stringify({ fullName: "org/repo" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/automation/repos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAutomationRepo.mockResolvedValue({
      id: "repo-1",
      fullName: "myorg/myrepo",
      owner: "myorg",
      name: "myrepo",
      source: "user",
    });
    mocks.upsertRepository.mockResolvedValue({
      id: "mirror-1",
      fullName: "myorg/myrepo",
      owner: "myorg",
      name: "myrepo",
      enabled: true,
    });
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  it("returns 400 on malformed JSON", async () => {
    const res = await postRequest("not-json");
    expect(res.status).toBe(400);
  });

  it("returns 400 when fullName is missing", async () => {
    const res = await postRequest({});
    expect(res.status).toBe(400);
  });

  it("returns 400 when fullName is not owner/repo", async () => {
    const res = await postRequest({ fullName: "no-slash" });
    expect(res.status).toBe(400);
  });

  it("creates AutomationRepo and Repository rows, then writes an audit row on success", async () => {
    const res = await postRequest({ fullName: "myorg/myrepo" });
    expect(res.status).toBe(201);

    expect(mocks.createAutomationRepo).toHaveBeenCalledWith({
      data: { fullName: "myorg/myrepo", owner: "myorg", name: "myrepo", source: "user" },
    });
    expect(mocks.upsertRepository).toHaveBeenCalledWith({
      where: { fullName: "myorg/myrepo" },
      create: { fullName: "myorg/myrepo", owner: "myorg", name: "myrepo", enabled: true },
      update: { owner: "myorg", name: "myrepo", enabled: true },
    });

    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "add_tracked_repo",
        repoFullName: "myorg/myrepo",
        success: true,
      }),
    });
  });

  it("returns 409 when the repository is already tracked (P2002 unique violation)", async () => {
    mocks.createAutomationRepo.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" }),
    );

    const res = await postRequest({ fullName: "myorg/myrepo" });
    expect(res.status).toBe(409);
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("writes an audit row with success=false on unexpected failure", async () => {
    mocks.createAutomationRepo.mockRejectedValueOnce(new Error("boom"));

    const res = await postRequest({ fullName: "myorg/myrepo" });
    expect(res.status).toBe(500);

    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "add_tracked_repo",
        repoFullName: "myorg/myrepo",
        success: false,
        errorMessage: "boom",
      }),
    });
  });
});

describe("POST /api/automation/repos — rate limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAutomationRepo.mockResolvedValue({
      id: "repo-1",
      fullName: "myorg/myrepo",
      owner: "myorg",
      name: "myrepo",
      source: "user",
    });
    mocks.upsertRepository.mockResolvedValue({
      id: "mirror-1",
      fullName: "myorg/myrepo",
      owner: "myorg",
      name: "myrepo",
      enabled: true,
    });
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  it("returns 429 after exceeding the rate limit (10 per 60s)", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await postRequest({ fullName: "myorg/myrepo" });
      expect(res.status).toBe(201);
    }

    const res = await postRequest({ fullName: "myorg/myrepo" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: "Rate limit exceeded" });
    // The 11th request is rejected before the tracked repo is created.
    expect(mocks.createTrackedRepo).toHaveBeenCalledTimes(10);
  });
});

describe("GET /api/automation/repos — release-delta projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findAutomationRepos.mockResolvedValue([
      {
        id: "repo-1",
        fullName: "myorg/myrepo",
        name: "myrepo",
        owner: "myorg",
        defaultBranch: "main",
        latestCommitSha: "headsha1",
        releaseState: "ahead",
        releaseBaselineTag: "v1.0.0",
        releaseBaselineSha: "basesha1",
        releaseBaselinePublishedAt: new Date("2024-01-01T00:00:00Z"),
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
        _count: { workflows: 0, releases: 1 },
      },
    ]);
    mocks.countWorkflowRuns.mockResolvedValue(0);
    mocks.findLastSyncRun.mockResolvedValue(null);
    mocks.findLifecycleEvents.mockResolvedValue([]);
    mocks.findIssues.mockResolvedValue([]);
  });

  it("projects the persisted release-delta snapshot into the API response", async () => {
    const res = await GET(
      new Request("http://localhost/api/automation/repos", {
        headers: { Authorization: `Bearer ${mockToken}` },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      fullName: "myorg/myrepo",
      releaseState: "ahead",
      releaseBaselineTag: "v1.0.0",
      releaseBaselineSha: "basesha1",
      releaseBaselinePublishedAt: "2024-01-01T00:00:00.000Z",
      releaseHeadSha: "headsha1",
      releaseAheadBy: 7,
      releaseError: null,
      releaseDeltaSyncedAt: "2024-01-02T00:00:00.000Z",
      pulse: expect.objectContaining({ pulseState: "ready" }),
    });
  });
});

describe("GET /api/automation/repos — release pulse", () => {
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
      _count: { workflows: 0, releases: 1 },
      ...overrides,
    };
  }

  function getRequest() {
    return GET(
      new Request("http://localhost/api/automation/repos", {
        headers: { Authorization: `Bearer ${mockToken}` },
      }),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findLifecycleEvents.mockResolvedValue([]);
    mocks.findIssues.mockResolvedValue([]);
    mocks.countWorkflowRuns.mockResolvedValue(0);
    mocks.findLastSyncRun.mockResolvedValue(null);
  });

  it("computes a ready pulse from lifecycle events and issue rows", async () => {
    mocks.findAutomationRepos.mockResolvedValue([readyRepo()]);
    mocks.findLifecycleEvents.mockResolvedValue([
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
      {
        kind: "issue_closed",
        source: "github-webhook",
        actor: "myorg",
        agentName: null,
        fromStatus: null,
        toStatus: null,
        sourceEventId: null,
        occurredAt: new Date("2024-01-06T09:00:00Z"),
        observedAt: new Date("2024-01-06T09:00:05Z"),
        metadata: null,
        issueNumber: 41,
      },
    ]);
    mocks.findIssues.mockResolvedValue([
      {
        number: 41,
        title: "Tenant-scoped login",
        url: "https://github.com/myorg/myrepo/issues/41",
        state: "open",
        closedAt: null,
        labels: ["type/feature"],
        releaseSignal: {
          kind: "feature",
          headline: "Adds tenant-scoped login",
          significance: "major",
          evidenceRefs: [],
        },
        decomposed: false,
        followUpUrls: [],
      },
    ]);

    const res = await getRequest();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body[0].pulse).toMatchObject({
      schema: "dispatch.release-pulse/v1",
      repoFullName: "myorg/myrepo",
      pulseState: "ready",
      baseline: {
        tag: "v1.0.0",
        sha: "basesha1",
        publishedAt: "2024-01-01T00:00:00.000Z",
      },
      headSha: "headsha1",
      unreleasedCommits: { state: "ahead", count: 7 },
      deliveredIssueCount: 1,
      completedUmbrellaCount: 0,
      unknownDeliveryCount: 0,
      highlightsTruncated: false,
    });
    expect(body[0].pulse.highlights).toHaveLength(1);
    expect(body[0].pulse.highlights[0]).toMatchObject({
      kind: "feature",
      headline: "Adds tenant-scoped login",
      issueNumber: 41,
      issueUrl: "https://github.com/myorg/myrepo/issues/41",
      deliveredAt: "2024-01-05T12:00:00.000Z",
      significance: "major",
      confidence: "high",
      provenance: "groomer-release-signal",
    });
    expect(body[0].pulse.highlights[0].prs).toEqual([
      {
        prNumber: 101,
        prUrl: "https://github.com/myorg/myrepo/pull/101",
        mergeCommitSha: "mergesha1",
        mergedAt: "2024-01-05T12:00:00.000Z",
      },
    ]);

    expect(mocks.findLifecycleEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          repoFullName: "myorg/myrepo",
          // Merge evidence is read across every interval (pre-baseline PR
          // links are retained on delivered highlights); close/reopen
          // evidence stays baseline-scoped.
          OR: [
            { kind: "pr_merged" },
            {
              kind: { in: ["completed", "issue_closed", "issue_reopened"] },
              occurredAt: { gte: new Date(BASELINE_MS) },
            },
          ],
        }),
        orderBy: { occurredAt: "asc" },
      }),
    );
    expect(mocks.findIssues).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          repository: { fullName: "myorg/myrepo" },
          OR: [
            { number: { in: [41] } },
            { state: "closed" },
            { decomposed: true, followUpUrls: { isEmpty: false } },
          ],
        },
      }),
    );
  });

  it("skips the issue/event reads for a no-baseline repo and reports no-baseline", async () => {
    mocks.findAutomationRepos.mockResolvedValue([
      readyRepo({
        releaseState: "no-baseline",
        releaseBaselineTag: null,
        releaseBaselineSha: null,
        releaseBaselinePublishedAt: null,
        releaseHeadSha: null,
        releaseAheadBy: null,
      }),
    ]);

    const res = await getRequest();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body[0].pulse).toMatchObject({
      schema: "dispatch.release-pulse/v1",
      repoFullName: "myorg/myrepo",
      pulseState: "no-baseline",
      baseline: null,
      headSha: null,
      unreleasedCommits: { state: "no-baseline", count: null },
      deliveredIssueCount: 0,
      highlights: [],
      completedUmbrellaCount: 0,
      unknownDeliveryCount: 0,
    });
    expect(mocks.findLifecycleEvents).not.toHaveBeenCalled();
    expect(mocks.findIssues).not.toHaveBeenCalled();
  });

  it("degrades to an unknown pulse without queries for a diverged repo", async () => {
    mocks.findAutomationRepos.mockResolvedValue([readyRepo({ releaseState: "diverged" })]);

    const res = await getRequest();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body[0].pulse).toMatchObject({
      pulseState: "unknown",
      baseline: null,
      unreleasedCommits: { state: "diverged", count: null },
      highlights: [],
    });
    expect(mocks.findLifecycleEvents).not.toHaveBeenCalled();
    expect(mocks.findIssues).not.toHaveBeenCalled();
  });

  it("drops the event-number OR arm when no post-baseline events exist", async () => {
    mocks.findAutomationRepos.mockResolvedValue([readyRepo()]);
    mocks.findIssues.mockResolvedValue([]);

    const res = await getRequest();
    expect(res.status).toBe(200);

    expect(mocks.findIssues).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ state: "closed" }, { decomposed: true, followUpUrls: { isEmpty: false } }],
        }),
      }),
    );
  });

  it("computes a ready pulse for an identical-state repo with zero unreleased commits", async () => {
    mocks.findAutomationRepos.mockResolvedValue([readyRepo({ releaseState: "identical", releaseAheadBy: null })]);
    const res = await getRequest();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].pulse).toMatchObject({
      pulseState: "ready",
      unreleasedCommits: { state: "identical", count: 0 },
      deliveredIssueCount: 0,
      highlights: [],
    });
    // Identical is still a computable baseline: issue/event reads happen.
    expect(mocks.findLifecycleEvents).toHaveBeenCalledTimes(1);
    expect(mocks.findIssues).toHaveBeenCalledTimes(1);
  });
});
