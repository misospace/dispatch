import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks, prismaMocks, githubMocks, configMocks, reconciliationMocks } = vi.hoisted(() => ({
  mocks: {
    acquireLock: vi.fn().mockResolvedValue({ locked: true, runId: "test-run" }),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    auditLogFindMany: vi.fn().mockResolvedValue([]),
  },
  prismaMocks: {
    issueFindMany: vi.fn((_args?: unknown) => Promise.resolve([] as any)),
    issueUpdate: vi.fn(() => Promise.resolve({} as any)),
    auditLogCreate: vi.fn(() => Promise.resolve({} as any)),
    prFixQueueItemFindMany: vi.fn(() => Promise.resolve([] as any)),
    lifecycleRows: [] as Array<Record<string, any>>,
  },
  githubMocks: {
    fetchPullRequests: vi.fn(() => Promise.resolve([] as any)),
    fetchClosedPullRequests: vi.fn(() => Promise.resolve([] as any)),
    fetchIssues: vi.fn(() => Promise.resolve([] as any)),
    fetchLinkedPrHealthInput: vi.fn(),
  },
  configMocks: {
    getSyncRepos: vi.fn(() => Promise.resolve([] as any)),
  },
  reconciliationMocks: {
    executeActions: vi.fn(() => Promise.resolve([] as any)),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { findMany: mocks.auditLogFindMany, create: prismaMocks.auditLogCreate },
    issue: { findMany: prismaMocks.issueFindMany, update: prismaMocks.issueUpdate },
    prFixQueueItem: { findMany: prismaMocks.prFixQueueItemFindMany },
    issueLifecycleEvent: {
      create: vi.fn(async ({ data }: any) => {
        prismaMocks.lifecycleRows.push({ ...data });
        return data;
      }),
      upsert: vi.fn(async ({ where, create }: any) => {
        const existing = prismaMocks.lifecycleRows.find((row) => row.dedupeKey === where.dedupeKey);
        if (existing) return existing;
        prismaMocks.lifecycleRows.push({ ...create });
        return create;
      }),
    },
  },
}));

vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  fetchPullRequests: githubMocks.fetchPullRequests,
  fetchClosedPullRequests: githubMocks.fetchClosedPullRequests,
  fetchIssues: githubMocks.fetchIssues,
  fetchLinkedPrHealthInput: githubMocks.fetchLinkedPrHealthInput,
}));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getSyncRepos: configMocks.getSyncRepos,
}));

vi.mock("@/lib/sync-lock", () => ({
  acquireLock: mocks.acquireLock,
  releaseLock: mocks.releaseLock,
}));

vi.mock("@/lib/issue-reconciliation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/issue-reconciliation")>()),
  executeActions: reconciliationMocks.executeActions,
}));

import { GET, POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";

function request(urlString: string, includeAuth = true) {
  return authedRequest(urlString, { includeAuth });
}

describe("POST /api/issues/reconcile", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.acquireLock.mockResolvedValue({ locked: true, runId: "test-run" });
    mocks.releaseLock.mockResolvedValue(undefined);
  });

  it("returns 409 when another reconciliation holds the lock", async () => {
    mocks.acquireLock.mockResolvedValue({ locked: false });

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ locked: true });
    expect(mocks.acquireLock).toHaveBeenCalledWith("reconcile");
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });
});

describe("GET /api/issues/reconcile", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.acquireLock.mockResolvedValue({ locked: true, runId: "test-run" });
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.auditLogFindMany.mockResolvedValue([]);
  });

  it("returns 401 when no auth header is present", async () => {
    const res = await GET(request("http://localhost/api/issues/reconcile", false));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 for bad bearer token", async () => {
    const headers: Record<string, string> = { Authorization: "Bearer wrong-token" };
    const res = await GET(new Request("http://localhost/api/issues/reconcile", { headers }));

    expect(res.status).toBe(401);
  });

  it("returns reconciliation status when authorized", async () => {
    mocks.auditLogFindMany.mockResolvedValue([
      {
        id: "log-1",
        actor: "reconciler",
        action: "reconcile_add_label",
        repoFullName: "org/repo",
        issueNumber: 42,
        notes: "health check",
        success: true,
        beforeLabels: [],
        afterLabels: ["status/ready"],
        createdAt: new Date(),
      },
    ]);

    const res = await GET(request("http://localhost/api/issues/reconcile"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lastRuns).toBeDefined();
    expect(Array.isArray(body.lastRuns)).toBe(true);
  });

  it("limits recent logs to 10", async () => {
    await GET(request("http://localhost/api/issues/reconcile"));

    const call = mocks.auditLogFindMany.mock.calls[0][0];
    expect(call.take).toBe(10);
  });

  it("filters by reconciler actor", async () => {
    await GET(request("http://localhost/api/issues/reconcile"));

    const call = mocks.auditLogFindMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ actor: "reconciler" });
  });

  it("returns 500 on database error", async () => {
    mocks.auditLogFindMany.mockRejectedValue(new Error("db connection lost"));

    const res = await GET(request("http://localhost/api/issues/reconcile"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch status");
  });

  it("unauthorized request does not call prisma", async () => {
    await GET(request("http://localhost/api/issues/reconcile", false));

    expect(mocks.auditLogFindMany).not.toHaveBeenCalled();
  });
});

describe("recordReconciledAction — lifecycle evidence (#1202)", () => {
  function makeClient() {
    const rows: Array<Record<string, any>> = [];
    const client = {
      issueLifecycleEvent: {
        create: vi.fn(async ({ data }: any) => {
          rows.push({ ...data });
          return data;
        }),
        upsert: vi.fn(async ({ where, create }: any) => {
          const existing = rows.find((row) => row.dedupeKey === where.dedupeKey);
          if (existing) return existing;
          rows.push({ ...create });
          return create;
        }),
      },
    };
    return { client, rows };
  }

  const repo = { id: "repo-1", fullName: "org/repo" };

  it("records the merge and the close as separate facts", async () => {
    const { recordReconciledAction } = await import("./route");
    const { client, rows } = makeClient();

    await recordReconciledAction({
      repo,
      issueNumber: 42,
      existingIssue: { id: "issue-1" },
      mergedPr: { number: 7, merged_at: "2026-10-02T08:00:00Z" },
      executed: {
        action: { type: "close_issue", issueNumber: 42, repoFullName: "org/repo", reason: "fixed" },
        success: true,
        beforeLabels: ["status/in-review"],
        afterLabels: [],
      },
      client,
    });

    expect(rows.map((row) => row.kind)).toEqual(["pr_merged", "issue_closed"]);
    // The merge is dated by the PR's own merged_at, not by the reconcile pass.
    expect(rows[0]).toMatchObject({
      source: "reconciler",
      sourceEventId: "pr-7",
      occurredAt: new Date("2026-10-02T08:00:00Z"),
      metadata: { pullRequestNumber: 7 },
    });
  });

  it("does not record a second merge when a later pass re-derives the same one", async () => {
    const { recordReconciledAction } = await import("./route");
    const { client, rows } = makeClient();
    const input = {
      repo,
      issueNumber: 42,
      existingIssue: { id: "issue-1" },
      mergedPr: { number: 7, merged_at: "2026-10-02T08:00:00Z" },
      executed: {
        action: { type: "close_issue" as const, issueNumber: 42, repoFullName: "org/repo", reason: "fixed" },
        success: true,
        beforeLabels: ["status/in-review"],
        afterLabels: [],
      },
      client,
    };

    await recordReconciledAction(input);
    await recordReconciledAction(input);

    expect(rows).toHaveLength(2);
  });

  it("records a PR-driven status move with the PR as its identity", async () => {
    const { recordReconciledAction } = await import("./route");
    const { client, rows } = makeClient();

    await recordReconciledAction({
      repo,
      issueNumber: 42,
      existingIssue: { id: "issue-1" },
      mergedPr: { number: 9, merged_at: null },
      executed: {
        action: { type: "set_status", issueNumber: 42, repoFullName: "org/repo", label: "status/in-review", reason: "PR healthy" },
        success: true,
        beforeLabels: ["status/backlog"],
        afterLabels: ["status/in-review"],
      },
      client,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "status_changed",
      source: "reconciler",
      fromStatus: "status/backlog",
      toStatus: "status/in-review",
      dedupeKey: "reconciler|org/repo|42|status_changed|9|unknown",
    });
  });

  it("records nothing for a failed action or an uncached issue", async () => {
    const { recordReconciledAction } = await import("./route");
    const { client, rows } = makeClient();

    await recordReconciledAction({
      repo,
      issueNumber: 42,
      existingIssue: { id: "issue-1" },
      mergedPr: null,
      executed: {
        action: { type: "set_status", issueNumber: 42, repoFullName: "org/repo", label: "status/ready", reason: "x" },
        success: false,
        error: "github 500",
        beforeLabels: ["status/backlog"],
        afterLabels: ["status/backlog"],
      },
      client,
    });
    await recordReconciledAction({
      repo,
      issueNumber: 42,
      existingIssue: undefined,
      mergedPr: null,
      executed: {
        action: { type: "set_status", issueNumber: 42, repoFullName: "org/repo", label: "status/ready", reason: "x" },
        success: true,
        beforeLabels: ["status/backlog"],
        afterLabels: ["status/ready"],
      },
      client,
    });

    expect(rows).toHaveLength(0);
  });
});

describe("recordReconciledAction — linked-merge evidence (#1203)", () => {
  function makeClient() {
    const rows: Array<Record<string, any>> = [];
    const client = {
      issueLifecycleEvent: {
        create: vi.fn(async ({ data }: any) => {
          rows.push({ ...data });
          return data;
        }),
        upsert: vi.fn(async ({ where, create }: any) => {
          const existing = rows.find((row) => row.dedupeKey === where.dedupeKey);
          if (existing) return existing;
          rows.push({ ...create });
          return create;
        }),
      },
    };
    return { client, rows };
  }

  const repo = { id: "repo-1", fullName: "org/repo" };
  const closeExecuted = {
    action: { type: "close_issue" as const, issueNumber: 42, repoFullName: "org/repo", reason: "fixed" },
    success: true,
    beforeLabels: ["status/in-review"],
    afterLabels: [],
  };

  it("records one merge event per explicitly linked PR with its provenance", async () => {
    const { recordReconciledAction } = await import("./route");
    const { client, rows } = makeClient();

    await recordReconciledAction({
      repo,
      issueNumber: 42,
      existingIssue: { id: "issue-1" },
      mergedPr: { number: 7, merged_at: "2026-10-02T08:00:00Z" },
      mergedPrs: [
        { prNumber: 7, mergedAt: "2026-10-02T08:00:00Z", prUrl: "https://github.com/org/repo/pull/7", linkSource: "body-keyword" },
        { prNumber: 9, mergedAt: "2026-10-01T09:00:00Z", prUrl: "https://github.com/org/repo/pull/9", linkSource: "branch-name" },
      ],
      executed: closeExecuted,
      client,
    });

    const merges = rows.filter((row) => row.kind === "pr_merged");
    expect(merges).toHaveLength(2);
    expect(merges.map((row) => row.metadata.pullRequestNumber).sort()).toEqual([7, 9]);
    expect(merges[0].metadata).toMatchObject({ pullRequestUrl: "https://github.com/org/repo/pull/7", linkSource: "body-keyword" });
    expect(merges[1].metadata).toMatchObject({ linkSource: "branch-name" });
  });

  it("never infers a link from a title: a PR without explicit evidence records only the honest close-trigger provenance", async () => {
    const { recordReconciledAction } = await import("./route");
    const { client, rows } = makeClient();

    await recordReconciledAction({
      repo,
      issueNumber: 42,
      existingIssue: { id: "issue-1" },
      mergedPr: { number: 7, merged_at: "2026-10-02T08:00:00Z" },
      mergedPrs: null,
      executed: closeExecuted,
      client,
    });

    const merge = rows.find((row) => row.kind === "pr_merged")!;
    expect(merge.metadata.linkSource).toBe("reconcile-close-trigger");
    expect(merge.metadata.linkSource).not.toBe("title-keyword");
  });

  it("keys a Date-form merge onto the same row as the pre-#1203 string form", async () => {
    const { recordReconciledAction } = await import("./route");
    const { client, rows } = makeClient();
    const base = { repo, issueNumber: 42, existingIssue: { id: "issue-1" }, executed: closeExecuted, client };

    await recordReconciledAction({ ...base, mergedPr: { number: 7, merged_at: "2026-10-02T08:00:00Z" } });
    await recordReconciledAction({
      ...base,
      mergedPr: { number: 7, merged_at: "2026-10-02T08:00:00Z" },
      mergedPrs: [{ prNumber: 7, mergedAt: new Date("2026-10-02T08:00:00Z"), linkSource: "body-keyword" }],
    });

    expect(rows.filter((row) => row.kind === "pr_merged")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "issue_closed")).toHaveLength(1);
  });
});

describe("recordLinkedMergeEvidence — decoupled merge evidence (#1203)", () => {
  function makeClient(existingIssues: Array<{ id: string; number: number; repositoryId?: string }> = []) {
    const rows: Array<Record<string, any>> = [];
    const client = {
      issueLifecycleEvent: {
        create: vi.fn(async ({ data }: any) => {
          rows.push({ ...data });
          return data;
        }),
        upsert: vi.fn(async ({ where, create }: any) => {
          const existing = rows.find((row) => row.dedupeKey === where.dedupeKey);
          if (existing) return existing;
          rows.push({ ...create });
          return create;
        }),
      },
      issue: {
        // Faithful to the Prisma read: rows are scoped by repositoryId AND number.
        findMany: vi.fn(async ({ where }: any) =>
          existingIssues.filter(
            (row: { number: number; repositoryId?: string }) =>
              where.number.in.includes(row.number) && row.repositoryId === where.repositoryId,
          ),
        ),
      },
    };
    return { client, rows };
  }

  const repo = { id: "repo-1", fullName: "org/repo" };
  const bodyKeywordMerge = {
    prNumber: 7,
    prUrl: "https://github.com/org/repo/pull/7",
    mergedAt: "2026-10-02T08:00:00Z",
    mergeCommitSha: "merge-sha",
    headSha: "head-sha",
    linkSource: "body-keyword",
  };
  const branchNameMerge = {
    prNumber: 9,
    prUrl: "https://github.com/org/repo/pull/9",
    mergedAt: "2026-10-05T09:00:00Z",
    mergeCommitSha: "merge-sha-9",
    headSha: "head-sha-9",
    linkSource: "branch-name",
  };

  it("records exactly one pr_merged for a closed issue's linked merged PR, with body-keyword provenance and no close/status writes", async () => {
    const { recordLinkedMergeEvidence } = await import("./route");
    const { client, rows } = makeClient([{ id: "issue-42", number: 42, repositoryId: "repo-1" }]);

    await recordLinkedMergeEvidence({
      repo,
      mergedPrLinkEvidence: new Map([[42, [bodyKeywordMerge]]]),
      client,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "pr_merged",
      issueId: "issue-42",
      issueNumber: 42,
      source: "reconciler",
      actor: "reconciler",
      fromStatus: null,
      toStatus: null,
      occurredAt: new Date("2026-10-02T08:00:00Z"),
      metadata: {
        pullRequestNumber: 7,
        pullRequestUrl: "https://github.com/org/repo/pull/7",
        linkSource: "body-keyword",
      },
    });
  });

  it("records nothing when a linked number has no cached issue row", async () => {
    const { recordLinkedMergeEvidence } = await import("./route");
    const { client, rows } = makeClient([]);

    await recordLinkedMergeEvidence({
      repo,
      mergedPrLinkEvidence: new Map([[42, [bodyKeywordMerge]]]),
      client,
    });

    expect(rows).toHaveLength(0);
  });

  it("records nothing when the cached row belongs to a different repository", async () => {
    const { recordLinkedMergeEvidence } = await import("./route");
    const { client, rows } = makeClient([{ id: "issue-42", number: 42, repositoryId: "repo-other" }]);

    await recordLinkedMergeEvidence({
      repo,
      mergedPrLinkEvidence: new Map([[42, [bodyKeywordMerge]]]),
      client,
    });

    expect(rows).toHaveLength(0);
  });

  it("records merge evidence for issues the open loop already acted on — decoupled from close execution and open-state", async () => {
    const { recordLinkedMergeEvidence } = await import("./route");
    const { client, rows } = makeClient([{ id: "issue-42", number: 42, repositoryId: "repo-1" }]);

    await recordLinkedMergeEvidence({
      repo,
      mergedPrLinkEvidence: new Map([[42, [bodyKeywordMerge]]]),
      client,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "pr_merged", issueNumber: 42 });
  });

  it("records exactly one event per PR across sequential merges and repeated reconciliation", async () => {
    const { recordLinkedMergeEvidence } = await import("./route");
    const { client, rows } = makeClient([{ id: "issue-42", number: 42, repositoryId: "repo-1" }]);
    // PR #7 merged and closed the issue; PR #9 merged later in the window.
    const evidence = new Map([[42, [bodyKeywordMerge, branchNameMerge]]]);

    await recordLinkedMergeEvidence({ repo, mergedPrLinkEvidence: evidence, client });
    await recordLinkedMergeEvidence({ repo, mergedPrLinkEvidence: evidence, client });

    const merges = rows.filter((row) => row.kind === "pr_merged");
    expect(merges).toHaveLength(2);
    expect(merges.map((row) => row.metadata.pullRequestNumber).sort()).toEqual([7, 9]);
    expect(merges.map((row) => row.metadata.linkSource).sort()).toEqual(["body-keyword", "branch-name"]);
  });
});

describe("POST — merge evidence after close (#1203)", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    prismaMocks.lifecycleRows.length = 0;
    mocks.acquireLock.mockResolvedValue({ locked: true, runId: "test-run" });
    mocks.releaseLock.mockResolvedValue(undefined);
    configMocks.getSyncRepos.mockResolvedValue([{ id: "repo-1", fullName: "org/repo" }]);
    reconciliationMocks.executeActions.mockResolvedValue([]);
    githubMocks.fetchPullRequests.mockResolvedValue([]);
    githubMocks.fetchClosedPullRequests.mockResolvedValue([
      {
        number: 7,
        state: "closed",
        title: "Fix the crash",
        body: "Fixes #42",
        merged_at: "2026-10-02T08:00:00Z",
        html_url: "https://github.com/org/repo/pull/7",
        merge_commit_sha: "merge-sha",
        head: { ref: "issue-42", sha: "head-sha" },
      },
    ]);
    // The issue is closed on GitHub, so the open-issue fetch never returns it.
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 5, title: "Open issue", body: null, state: "open", labels: [] },
    ]);
    const cachedRows = [
      { id: "issue-42", number: 42, repositoryId: "repo-1", currentLane: "normal", linkedPrNumber: null },
      { id: "issue-5", number: 5, repositoryId: "repo-1", currentLane: "normal", linkedPrNumber: null },
    ];
    prismaMocks.issueFindMany.mockImplementation(async ({ where }: any) =>
      cachedRows.filter(
        (row: { number: number; repositoryId: string }) =>
          where.number.in.includes(row.number) && row.repositoryId === where.repositoryId,
      ),
    );
  });

  it("records the closed issue's linked merge once and replays idempotently", async () => {
    const run = async () => {
      const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));
      expect(res.status).toBe(200);
      return res.json();
    };

    const first = await run();
    const second = await run();

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(prismaMocks.lifecycleRows).toHaveLength(1);
    expect(prismaMocks.lifecycleRows[0]).toMatchObject({
      kind: "pr_merged",
      issueId: "issue-42",
      issueNumber: 42,
      source: "reconciler",
      fromStatus: null,
      toStatus: null,
      occurredAt: new Date("2026-10-02T08:00:00Z"),
      metadata: { pullRequestNumber: 7, linkSource: "body-keyword" },
    });
  });

  it("never closes or records a merge from a title-only match", async () => {
    // Regression (#1203 review): a merged PR with no body whose title says
    // "Fixes #42" is not link evidence — it must neither close issue 42 nor
    // record a pr_merged event for it.
    githubMocks.fetchClosedPullRequests.mockResolvedValue([
      {
        number: 7,
        state: "closed",
        title: "Fixes #42",
        body: null,
        merged_at: "2026-10-02T08:00:00Z",
        html_url: "https://github.com/org/repo/pull/7",
        merge_commit_sha: "merge-sha",
        head: { ref: "feature/other", sha: "head-sha" },
      },
    ]);
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 42, title: "Crash on save", body: null, state: "open", labels: ["status/in-progress"] },
    ]);
    const cachedRows = [{ id: "issue-42", number: 42, repositoryId: "repo-1", currentLane: "normal", linkedPrNumber: null }];
    prismaMocks.issueFindMany.mockImplementation(async ({ where }: any) =>
      cachedRows.filter(
        (row: { number: number; repositoryId: string }) =>
          where.number.in.includes(row.number) && row.repositoryId === where.repositoryId,
      ),
    );

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuesClosed).toBe(0);
    expect(reconciliationMocks.executeActions).not.toHaveBeenCalled();
    expect(prismaMocks.lifecycleRows).toHaveLength(0);
    expect(prismaMocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("converges to one pr_merged per PR when the close succeeds in the same run", async () => {
    // Regression (#1203 review): the close path and the merge-evidence pass
    // both observe the same linked merges in one run — exactly one event per
    // PR, keeping the close's status-transition context on the row.
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 42, title: "Crash on save", body: null, state: "open", labels: ["status/in-progress"] },
    ]);
    const cachedRows = [{ id: "issue-42", number: 42, repositoryId: "repo-1", currentLane: "normal", linkedPrNumber: null }];
    prismaMocks.issueFindMany.mockImplementation(async ({ where }: any) =>
      cachedRows.filter(
        (row: { number: number; repositoryId: string }) =>
          where.number.in.includes(row.number) && row.repositoryId === where.repositoryId,
      ),
    );
    reconciliationMocks.executeActions.mockResolvedValue([
      {
        action: { type: "close_issue", issueNumber: 42, repoFullName: "org/repo", reason: "fixed" },
        success: true,
        beforeLabels: ["status/in-progress"],
        afterLabels: [],
      },
    ]);

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuesClosed).toBe(1);
    expect(prismaMocks.lifecycleRows.map((row) => row.kind).sort()).toEqual(["issue_closed", "pr_merged"]);
    const merges = prismaMocks.lifecycleRows.filter((row) => row.kind === "pr_merged");
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({
      issueNumber: 42,
      fromStatus: "status/in-progress",
      toStatus: null,
      metadata: { pullRequestNumber: 7, linkSource: "body-keyword" },
    });
  });

  it("records the merge even when the close action fails", async () => {
    // Regression (#1203 review): pr_merged recording is decoupled from close
    // execution — a failed close must not lose the authoritative merge.
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 42, title: "Crash on save", body: null, state: "open", labels: ["status/in-progress"] },
    ]);
    const cachedRows = [{ id: "issue-42", number: 42, repositoryId: "repo-1", currentLane: "normal", linkedPrNumber: null }];
    prismaMocks.issueFindMany.mockImplementation(async ({ where }: any) =>
      cachedRows.filter(
        (row: { number: number; repositoryId: string }) =>
          where.number.in.includes(row.number) && row.repositoryId === where.repositoryId,
      ),
    );
    reconciliationMocks.executeActions.mockResolvedValue([
      {
        action: { type: "close_issue", issueNumber: 42, repoFullName: "org/repo", reason: "fixed" },
        success: false,
        error: "github 500",
        beforeLabels: ["status/in-progress"],
        afterLabels: ["status/in-progress"],
      },
    ]);

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuesClosed).toBe(0);
    expect(prismaMocks.lifecycleRows.map((row) => row.kind)).toEqual(["pr_merged"]);
    expect(prismaMocks.lifecycleRows[0]).toMatchObject({
      issueNumber: 42,
      metadata: { pullRequestNumber: 7, linkSource: "body-keyword" },
    });
  });
});
