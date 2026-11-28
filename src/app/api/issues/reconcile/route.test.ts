import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks, prismaMocks, githubMocks, configMocks, reconciliationMocks } = vi.hoisted(() => ({
  mocks: {
    acquireLock: vi.fn().mockResolvedValue({ locked: true, runId: "test-run" }),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    auditLogFindMany: vi.fn().mockResolvedValue([]),
    // #1641: the deleted-PR reap is stubbed here so the route test never
    // calls the forge. The real reap is covered by the unit suite and by the
    // real-PostgreSQL integration test.
    reconcileDeletedPrFixItems: vi.fn(async () => ({ checked: 0, markedStale: 0, errored: 0 })),
  },
  prismaMocks: {
    issueFindMany: vi.fn((_args?: unknown) => Promise.resolve([] as any)),
    issueUpdate: vi.fn(() => Promise.resolve({} as any)),
    issueLaneCreate: vi.fn((_args: { data: any }) => Promise.resolve({} as any)),
    transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
    auditLogCreate: vi.fn((_args: any) => Promise.resolve({} as any)),
    // #1727: the skip-annotation dedupe read; defaults to "no prior skip" so
    // the first annotation always writes.
    auditLogFindFirst: vi.fn(async (_args?: any) => null as any),
    auditRows: [] as Array<Record<string, any>>,
    prFixQueueItemFindMany: vi.fn(() => Promise.resolve([] as any)),
    prFixQueueItemUpdateMany: vi.fn(() => Promise.resolve({ count: 0 } as any)),
    lifecycleRows: [] as Array<Record<string, any>>,
    // #1727 reopen-evidence read: defaults to "no reopen observed" so
    // pre-#1727 tests keep their close behavior.
    lifecycleEventFindMany: vi.fn(async (_args?: any) => [] as any[]),
  },
  githubMocks: {
    fetchPullRequests: vi.fn(() => Promise.resolve([] as any)),
    fetchClosedPullRequests: vi.fn(() => Promise.resolve([] as any)),
    fetchIssues: vi.fn(() => Promise.resolve([] as any)),
    fetchLinkedPrHealthInput: vi.fn(),
    // #1727 review: live re-read before a close — open by default so close
    // suites keep closing.
    fetchIssue: vi.fn(async () => ({ state: "open" } as any)),
    // #1727 review: reopen confirmation over the timeline. Default confirms
    // the lifecycle event, keeping the fail-closed reading for suites that
    // pin a post-merge reopen; inflation/refutation tests override it.
    fetchReopenAfter: vi.fn(async () => new Date("2026-12-31T00:00:00Z") as any),
    // The credential check in front of the no-tracked-repos reap (#1652
    // review): resolves by default so the reap runs; the skip test rejects it.
    getGitHubToken: vi.fn(async () => "test-token"),
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
    auditLog: {
      findMany: mocks.auditLogFindMany,
      findFirst: prismaMocks.auditLogFindFirst,
      create: vi.fn(async (args: any) => {
        prismaMocks.auditRows.push({ ...args.data, createdAt: new Date() });
        return prismaMocks.auditLogCreate(args);
      }),
    },
        issue: { findMany: prismaMocks.issueFindMany, update: prismaMocks.issueUpdate },
        issueLane: { create: prismaMocks.issueLaneCreate },
        $transaction: prismaMocks.transaction,
    prFixQueueItem: { findMany: prismaMocks.prFixQueueItemFindMany, updateMany: prismaMocks.prFixQueueItemUpdateMany },
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
      findMany: prismaMocks.lifecycleEventFindMany,
    },
  },
}));

vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  fetchPullRequests: githubMocks.fetchPullRequests,
  fetchClosedPullRequests: githubMocks.fetchClosedPullRequests,
  fetchIssues: githubMocks.fetchIssues,
  fetchIssue: githubMocks.fetchIssue,
  fetchReopenAfter: githubMocks.fetchReopenAfter,
  fetchLinkedPrHealthInput: githubMocks.fetchLinkedPrHealthInput,
  getGitHubToken: githubMocks.getGitHubToken,
}));

vi.mock("@/lib/pr-fix-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pr-fix-queue")>()),
  reconcileDeletedPrFixItems: mocks.reconcileDeletedPrFixItems,
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
import { resetRateLimits } from "@/lib/rate-limit";

function request(urlString: string, includeAuth = true) {
  return authedRequest(urlString, { includeAuth });
}

describe("POST /api/issues/reconcile", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    // Reset process-global per-actor rate-limit windows per test (see claim suite).
    resetRateLimits();
    vi.clearAllMocks();
    mocks.acquireLock.mockResolvedValue({ locked: true, runId: "test-run" });
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.reconcileDeletedPrFixItems.mockResolvedValue({ checked: 0, markedStale: 0, errored: 0 });
  });

  it("returns 409 when another reconciliation holds the lock", async () => {
    mocks.acquireLock.mockResolvedValue({ locked: false });

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ locked: true });
    expect(mocks.acquireLock).toHaveBeenCalledWith("reconcile");
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });

  it("runs the deleted-PR reap even with no tracked repos (#1651)", async () => {
    // The reap is item-driven: it names each row's own repository directly,
    // so the no-tracked-repos early return must not skip it. A row whose PR
    // was deleted upstream must not stay dispatchable because the instance
    // (or the `repo` filter) tracks nothing. The 404 stays the answer, and
    // it reports the reap counts (#1652 review).
    configMocks.getSyncRepos.mockResolvedValue([]);
    mocks.reconcileDeletedPrFixItems.mockResolvedValue({ checked: 2, markedStale: 1, errored: 0 });

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: "No tracked repos found",
      prFixQueueDeletedChecked: 2,
      prFixQueueDeletedMarked: 1,
      prFixQueueDeletedErrored: 0,
    });
    expect(mocks.reconcileDeletedPrFixItems).toHaveBeenCalledTimes(1);
    // The repo-list-driven work stays skipped on this path.
    expect(githubMocks.fetchPullRequests).not.toHaveBeenCalled();
    expect(githubMocks.fetchClosedPullRequests).not.toHaveBeenCalled();
  });

  it("still returns the 404 when the deleted-PR reap fails on the no-tracked-repos path (#1651)", async () => {
    // A failed reap is reported in the logs and in the counts, and never
    // turns the "no repos" answer into a 500.
    configMocks.getSyncRepos.mockResolvedValue([]);
    mocks.reconcileDeletedPrFixItems.mockRejectedValueOnce(new Error("forge unreachable"));

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: "No tracked repos found",
      prFixQueueDeletedChecked: 0,
      prFixQueueDeletedMarked: 0,
      prFixQueueDeletedErrored: 1,
    });
    expect(mocks.reconcileDeletedPrFixItems).toHaveBeenCalledTimes(1);
    expect(githubMocks.fetchPullRequests).not.toHaveBeenCalled();
    expect(githubMocks.fetchClosedPullRequests).not.toHaveBeenCalled();
  });

  it("skips the deleted-PR reap when no GitHub credential is configured (#1652 review)", async () => {
    // Without a credential every presence probe answers `unknown` before it
    // reaches the forge, each due row still counts as considered and is
    // stamped, and a doomed pass rotates the 1-hour re-verify window on
    // clean-looking zero-error counts without reaping anything. Skip the reap
    // and say so in the body instead.
    configMocks.getSyncRepos.mockResolvedValue([]);
    githubMocks.getGitHubToken.mockRejectedValueOnce(new Error("GITHUB_TOKEN environment variable is not set"));

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: "No tracked repos found",
      prFixQueueDeletedChecked: 0,
      prFixQueueDeletedMarked: 0,
      prFixQueueDeletedErrored: 0,
      prFixQueueDeletedReapSkipped: "no-github-credential",
    });
    expect(mocks.reconcileDeletedPrFixItems).not.toHaveBeenCalled();
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
    // Reset process-global per-actor rate-limit windows per test (see claim suite).
    resetRateLimits();
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

  it("keeps the branch link when the PR number collides with an issue number in the close-decision map", async () => {
    // Regression (#1203 review): the branch-name evidence used to be skipped
    // whenever the PR's own number was already in the close-decision map, so
    // PR #42 (body "Fixes #42") never recorded its branch link to issue #99
    // and issue #99's merge went unrecorded.
    githubMocks.fetchClosedPullRequests.mockResolvedValue([
      {
        number: 42,
        state: "closed",
        title: "Fix the crash",
        body: "Fixes #42",
        merged_at: "2026-10-02T08:00:00Z",
        html_url: "https://github.com/org/repo/pull/42",
        merge_commit_sha: "merge-sha",
        head: { ref: "issue-99", sha: "head-sha" },
      },
    ]);
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 5, title: "Open issue", body: null, state: "open", labels: [] },
    ]);
    const cachedRows = [
      { id: "issue-42", number: 42, repositoryId: "repo-1", currentLane: "normal", linkedPrNumber: null },
      { id: "issue-99", number: 99, repositoryId: "repo-1", currentLane: "normal", linkedPrNumber: null },
      { id: "issue-5", number: 5, repositoryId: "repo-1", currentLane: "normal", linkedPrNumber: null },
    ];
    prismaMocks.issueFindMany.mockImplementation(async ({ where }: any) =>
      cachedRows.filter(
        (row: { number: number; repositoryId: string }) =>
          where.number.in.includes(row.number) && row.repositoryId === where.repositoryId,
      ),
    );

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));

    expect(res.status).toBe(200);
    const merges = prismaMocks.lifecycleRows.filter((row) => row.kind === "pr_merged");
    const issue99Merge = merges.find((row) => row.issueNumber === 99)!;
    expect(issue99Merge).toMatchObject({
      kind: "pr_merged",
      issueId: "issue-99",
      issueNumber: 99,
      source: "reconciler",
      occurredAt: new Date("2026-10-02T08:00:00Z"),
      metadata: { pullRequestNumber: 42, linkSource: "branch-name" },
    });
    // The body keyword was recorded first for issue #42 and keeps its
    // provenance — the branch link is additive, never a replacement.
    const issue42Merge = merges.find((row) => row.issueNumber === 42)!;
    expect(issue42Merge).toMatchObject({
      metadata: { pullRequestNumber: 42, linkSource: "body-keyword" },
    });
  });

  it("keeps the branch link without closing in the collision case (#1727)", async () => {
    // #1727 reversed the collision behavior this test once pinned: the
    // branch claim is link evidence only, so PR #42 (body "Fixes #42", head
    // ref "issue-99") records the branch link for issue #99 — merge evidence,
    // nothing else. It no longer closes issue #99.
    githubMocks.fetchClosedPullRequests.mockResolvedValue([
      {
        number: 42,
        state: "closed",
        title: "Fix the crash",
        body: "Fixes #42",
        merged_at: "2026-10-02T08:00:00Z",
        html_url: "https://github.com/org/repo/pull/42",
        merge_commit_sha: "merge-sha",
        head: { ref: "issue-99", sha: "head-sha" },
      },
    ]);
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 99, title: "Another issue", body: null, state: "open", labels: [] },
    ]);
    const cachedRows = [
      { id: "issue-42", number: 42, repositoryId: "repo-1", currentLane: "normal", linkedPrNumber: null },
      { id: "issue-99", number: 99, repositoryId: "repo-1", currentLane: "normal", linkedPrNumber: null },
    ];
    prismaMocks.issueFindMany.mockImplementation(async ({ where }: any) =>
      cachedRows.filter(
        (row: { number: number; repositoryId: string }) =>
          where.number.in.includes(row.number) && row.repositoryId === where.repositoryId,
      ),
    );

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));

    expect(res.status).toBe(200);
    expect(reconciliationMocks.executeActions).not.toHaveBeenCalled();
    const merges = prismaMocks.lifecycleRows.filter((row) => row.kind === "pr_merged");
    const issue99Merge = merges.find((row) => row.issueNumber === 99)!;
    expect(issue99Merge).toMatchObject({
      kind: "pr_merged",
      issueId: "issue-99",
      metadata: { pullRequestNumber: 42, linkSource: "branch-name" },
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

describe("POST — lane history rows (#1598)", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    // Reset process-global per-actor rate-limit windows per test (see claim suite).
    resetRateLimits();
    vi.clearAllMocks();
    mocks.acquireLock.mockResolvedValue({ locked: true, runId: "test-run" });
    mocks.releaseLock.mockResolvedValue(undefined);
    configMocks.getSyncRepos.mockResolvedValue([{ id: "repo-1", fullName: "org/repo" }]);
    reconciliationMocks.executeActions.mockResolvedValue([]);
    githubMocks.fetchPullRequests.mockResolvedValue([]);
    githubMocks.fetchClosedPullRequests.mockResolvedValue([]);
  });

  function mockIssueRow(overrides: Record<string, unknown>) {
    const row = { id: "issue-5", number: 5, repositoryId: "repo-1", linkedPrNumber: null, ...overrides };
    prismaMocks.issueFindMany.mockImplementation(async ({ where }: any) =>
      [row].filter(
        (r: { number: number; repositoryId: string }) =>
          where.number.in.includes(r.number) && r.repositoryId === where.repositoryId,
      ),
    );
    return row;
  }

  it("creates an IssueLane history row alongside the first-time currentLane write", async () => {
    const { classifyLaneByHeuristics } = await import("@/lib/issue-reconciliation");
    mockIssueRow({ currentLane: null });
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 5, title: "Add dark mode toggle", body: null, state: "open", labels: [{ name: "enhancement" }] },
    ]);

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lanesClassified).toBe(1);
    const expected = classifyLaneByHeuristics("Add dark mode toggle", null, ["enhancement"]);
    expect(prismaMocks.issueLaneCreate).toHaveBeenCalledTimes(1);
    expect(prismaMocks.issueLaneCreate).toHaveBeenCalledWith({
      data: {
        issueId: "issue-5",
        lane: expected.lane,
        confidence: expected.confidence,
        reason: expected.reason,
        model: "heuristic",
      },
    });
    // History row and column write share one transaction.
    expect(prismaMocks.transaction).toHaveBeenCalledTimes(1);
    expect(prismaMocks.transaction.mock.calls[0][0]).toHaveLength(2);
    expect(prismaMocks.issueUpdate).toHaveBeenCalledWith({
      where: { repositoryId_number: { repositoryId: "repo-1", number: 5 } },
      data: { currentLane: expected.lane },
    });
  });

  it("runs the deleted-PR reap and reports its counts (#1641)", async () => {
    // #1641: the deleted-PR reap is queue-wide, so it runs once after the
    // per-repo loop. Its counts reach the response, and a transient forge
    // failure stays a reported number instead of failing the whole
    // reconciliation.
    mocks.reconcileDeletedPrFixItems.mockResolvedValue({ checked: 4, markedStale: 1, errored: 0 });

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(mocks.reconcileDeletedPrFixItems).toHaveBeenCalledTimes(1);
    expect(body.prFixQueueDeletedChecked).toBe(4);
    expect(body.prFixQueueDeletedMarked).toBe(1);
    expect(body.prFixQueueDeletedErrored).toBe(0);
    expect(body.success).toBe(true);
  });

  it("keeps a transient deleted-PR reap failure out of the reconciliation result (#1641)", async () => {
    mocks.reconcileDeletedPrFixItems.mockResolvedValue({ checked: 4, markedStale: 0, errored: 1 });

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));
    expect(res.status).toBe(200);

    const body = await res.json();
    // The reap error is reported, but the issues this route reconciled were
    // reconciled: `success` stays about the issues.
    expect(body.prFixQueueDeletedErrored).toBe(1);
    expect(body.success).toBe(true);
  });

  it("creates an IssueLane history row for stale-backlog reclassification", async () => {
    const { classifyLaneByHeuristics } = await import("@/lib/issue-reconciliation");
    mockIssueRow({ currentLane: "backlog" });
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 5, title: "Add dark mode toggle", body: null, state: "open", labels: [{ name: "status/ready" }, { name: "enhancement" }] },
    ]);

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lanesClassified).toBe(1);
    const expected = classifyLaneByHeuristics("Add dark mode toggle", null, ["status/ready", "enhancement"]);
    expect(prismaMocks.issueLaneCreate).toHaveBeenCalledTimes(1);
    expect(prismaMocks.issueLaneCreate).toHaveBeenCalledWith({
      data: {
        issueId: "issue-5",
        lane: "local",
        confidence: expected.confidence,
        reason: expected.reason,
        model: "reconcile",
      },
    });
    expect(prismaMocks.issueUpdate).toHaveBeenCalledWith({
      where: { repositoryId_number: { repositoryId: "repo-1", number: 5 } },
      data: { currentLane: "local" },
    });
  });

  it("records the stale-backlog fallback when the classifier itself still says backlog", async () => {
    // A placeholder issue reclassifies away from the backlog lane even though
    // the heuristic classifier still lands on backlog; the history row must
    // name the lane actually written and note the fallback.
    mockIssueRow({ currentLane: "backlog" });
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 5, title: "New feature TBD", body: "This is a placeholder. More details needed.", state: "open", labels: [{ name: "status/ready" }] },
    ]);

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));

    expect(res.status).toBe(200);
    expect(prismaMocks.issueLaneCreate).toHaveBeenCalledTimes(1);
    const data = prismaMocks.issueLaneCreate.mock.calls[0][0].data;
    expect(data.model).toBe("reconcile");
    expect(data.lane).not.toBe("backlog");
    expect(data.reason).toContain("default claimable lane");
    expect(prismaMocks.issueUpdate).toHaveBeenCalledWith({
      where: { repositoryId_number: { repositoryId: "repo-1", number: 5 } },
      data: { currentLane: data.lane },
    });
  });

  it("writes no lane history row when the lane is already set and not backlog", async () => {
    mockIssueRow({ currentLane: "normal" });
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 5, title: "Open issue", body: null, state: "open", labels: [] },
    ]);

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lanesClassified).toBe(0);
    expect(prismaMocks.issueLaneCreate).not.toHaveBeenCalled();
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
  });
});

describe("POST — close authority and reopen gate (#1727)", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
    prismaMocks.lifecycleRows.length = 0;
    prismaMocks.auditRows.length = 0;
    mocks.acquireLock.mockResolvedValue({ locked: true, runId: "test-run" });
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.reconcileDeletedPrFixItems.mockResolvedValue({ checked: 0, markedStale: 0, errored: 0 });
    configMocks.getSyncRepos.mockResolvedValue([{ id: "repo-1", fullName: "org/repo" }]);
    reconciliationMocks.executeActions.mockResolvedValue([]);
    githubMocks.fetchPullRequests.mockResolvedValue([]);
    githubMocks.fetchClosedPullRequests.mockResolvedValue([]);
    // Faithful reopen-evidence read over the shared lifecycle rows.
    prismaMocks.lifecycleEventFindMany.mockImplementation(async ({ where }: any) =>
      prismaMocks.lifecycleRows
        .filter((row) => row.kind === where.kind && where.issueId.in.includes(row.issueId))
        .map((row) => ({ issueId: row.issueId, occurredAt: row.occurredAt })),
    );
    // Faithful latest-skip read over the shared audit rows, backing the
    // #1363-style annotation dedupe.
    prismaMocks.auditLogFindFirst.mockImplementation(async ({ where }: any) => {
      const matches = prismaMocks.auditRows.filter(
        (row) =>
          (where.actor === undefined || row.actor === where.actor) &&
          (where.action === undefined || row.action === where.action) &&
          (where.repoFullName === undefined || row.repoFullName === where.repoFullName) &&
          (where.issueNumber === undefined || row.issueNumber === where.issueNumber) &&
          (where.issueId === undefined || row.issueId === where.issueId),
      );
      return matches.length > 0 ? matches[matches.length - 1] : null;
    });
  });

  function mockBodyKeywordMerge(overrides: Record<string, unknown> = {}) {
    githubMocks.fetchClosedPullRequests.mockResolvedValue([
      {
        number: 7,
        state: "closed",
        title: "Fix the crash",
        body: "Fixes #42",
        merged_at: "2026-10-02T08:00:00Z",
        html_url: "https://github.com/org/repo/pull/7",
        merge_commit_sha: "merge-sha",
        head: { ref: "fix/issue-42", sha: "head-sha" },
        ...overrides,
      },
    ]);
  }

  function mockIssueRows(rows: Array<{ id: string; number: number; closedAt?: Date | null }>) {
    const cached = rows.map((row) => ({
      repositoryId: "repo-1",
      currentLane: "normal",
      linkedPrNumber: null,
      closedAt: null,
      ...row,
    }));
    prismaMocks.issueFindMany.mockImplementation(async ({ where }: any) =>
      cached.filter(
        (row: { number: number; repositoryId: string }) =>
          where.number.in.includes(row.number) && row.repositoryId === where.repositoryId,
      ),
    );
  }

  it("records branch evidence without ever closing from branch correlation alone", async () => {
    // A merged PR that names the issue only through its branch pattern is
    // correlation, not completion evidence: the merge records, the issue
    // stays open, and no close action is even considered.
    githubMocks.fetchClosedPullRequests.mockResolvedValue([
      {
        number: 9,
        state: "closed",
        title: "Cleanup",
        body: null,
        merged_at: "2026-10-02T08:00:00Z",
        html_url: "https://github.com/org/repo/pull/9",
        merge_commit_sha: "merge-sha-9",
        head: { ref: "issue-77", sha: "head-sha-9" },
      },
    ]);
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 77, title: "Old issue", body: null, state: "open", labels: [] },
    ]);
    mockIssueRows([{ id: "issue-77", number: 77 }]);

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuesClosed).toBe(0);
    expect(body.closesSkipped).toBe(0);
    expect(reconciliationMocks.executeActions).not.toHaveBeenCalled();

    const merges = prismaMocks.lifecycleRows.filter((row) => row.kind === "pr_merged");
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({
      issueNumber: 77,
      metadata: { pullRequestNumber: 9, linkSource: "branch-name" },
    });
  });

  it("does not re-close an issue reopened after the merge, on any pass", async () => {
    mockBodyKeywordMerge();
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 42, title: "Crash on save", body: null, state: "open", labels: ["status/in-review"] },
    ]);
    mockIssueRows([{ id: "issue-42", number: 42 }]);
    // Sync observed the maintainer's reopen on 2026-10-05, after the merge.
    prismaMocks.lifecycleRows.push({
      kind: "issue_reopened",
      source: "sync",
      issueId: "issue-42",
      issueNumber: 42,
      dedupeKey: "sync|org/repo|42|issue_reopened|2026-10-05",
      occurredAt: new Date("2026-10-05T00:00:00Z"),
    });

    const first = await (
      await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }))
    ).json();
    expect(first.issuesClosed).toBe(0);
    expect(first.closesSkipped).toBe(1);
    expect(reconciliationMocks.executeActions).not.toHaveBeenCalled();

    // The withheld close is audited with a reason an operator can read, and
    // the row links to the cached issue so the #1363 composite index applies.
    const skipAudit = prismaMocks.auditLogCreate.mock.calls
      .map((call) => call[0].data)
      .find((data) => data.action === "reconcile_close_skipped");
    expect(skipAudit).toMatchObject({ actor: "reconciler", issueId: "issue-42", issueNumber: 42, success: true });
    expect(skipAudit.notes).toContain("reopened after merged PR #7");

    // Evidence stays decoupled: the merge still records despite the skip.
    expect(prismaMocks.lifecycleRows.filter((row) => row.kind === "pr_merged")).toHaveLength(1);

    // A second pass replays the same decision: still no close, the same
    // single pr_merged row, and — #1363-style — the identical skip
    // annotation is not re-written every pass.
    const second = await (
      await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }))
    ).json();
    expect(second.issuesClosed).toBe(0);
    expect(second.closesSkipped).toBe(1);
    expect(reconciliationMocks.executeActions).not.toHaveBeenCalled();
    expect(prismaMocks.lifecycleRows.filter((row) => row.kind === "pr_merged")).toHaveLength(1);
    expect(
      prismaMocks.auditRows.filter((row) => row.action === "reconcile_close_skipped"),
    ).toHaveLength(1);
  });

  it("does not re-close when the cached row records a close after the merge", async () => {
    // The window between a close and the sync that records the reopen:
    // GitHub says open, the cache still carries the close timestamp, and no
    // lifecycle event exists yet — the cached close is the reopen evidence.
    mockBodyKeywordMerge();
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 42, title: "Crash on save", body: null, state: "open", labels: ["status/in-review"] },
    ]);
    mockIssueRows([{ id: "issue-42", number: 42, closedAt: new Date("2026-10-04T00:00:00Z") }]);

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuesClosed).toBe(0);
    expect(body.closesSkipped).toBe(1);
    expect(reconciliationMocks.executeActions).not.toHaveBeenCalled();
  });

  it("holds the close when the reopen-evidence read fails (fail closed)", async () => {
    // Without the reopen stream there is no proof a close would not override
    // a maintainer. The close is repeatable, so the pass holds it and the
    // next pass retries; a lifecycle-table fault must not re-open the
    // re-close window.
    mockBodyKeywordMerge();
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 42, title: "Crash on save", body: null, state: "open", labels: ["status/in-review"] },
    ]);
    mockIssueRows([{ id: "issue-42", number: 42 }]);
    prismaMocks.lifecycleEventFindMany.mockRejectedValueOnce(new Error("lifecycle table unavailable"));

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuesClosed).toBe(0);
    expect(body.closesSkipped).toBe(1);
    expect(reconciliationMocks.executeActions).not.toHaveBeenCalled();
    const skipAudit = prismaMocks.auditRows.find((row) => row.action === "reconcile_close_skipped");
    expect(skipAudit?.notes).toContain("reopen evidence unavailable");

    // Merge evidence still records: the withhold touches only the close.
    expect(prismaMocks.lifecycleRows.filter((row) => row.kind === "pr_merged")).toHaveLength(1);
  });

  it("closes when the recorded close predates the merge", async () => {
    // An issue closed before the PR merged and reopened afterwards is fresh
    // work again — the later merge is a new completion claim.
    mockBodyKeywordMerge();
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 42, title: "Crash on save", body: null, state: "open", labels: ["status/in-progress"] },
    ]);
    mockIssueRows([{ id: "issue-42", number: 42, closedAt: new Date("2026-10-01T00:00:00Z") }]);
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
    expect(body.closesSkipped).toBe(0);
    expect(reconciliationMocks.executeActions).toHaveBeenCalledWith(
      [expect.objectContaining({ type: "close_issue", issueNumber: 42 })],
      expect.any(Array),
    );
  });

  it("keeps an older keyword merge from overriding a newer one for the same issue", async () => {
    // Two merged PRs carry "Fixes #42". The reopen lands between them, so
    // only the newest merge can carry the completion claim — and it postdates
    // the reopen, so the close stands. Had the authority map kept the first
    // (older) merge, the reopen would withhold a legitimate close.
    githubMocks.fetchClosedPullRequests.mockResolvedValue([
      {
        number: 5,
        state: "closed",
        title: "First attempt",
        body: "Fixes #42",
        merged_at: "2026-10-01T00:00:00Z",
        html_url: "https://github.com/org/repo/pull/5",
        merge_commit_sha: "merge-sha-5",
        head: { ref: "attempt-one", sha: "head-5" },
      },
      {
        number: 8,
        state: "closed",
        title: "Real fix",
        body: "Fixes #42",
        merged_at: "2026-10-07T00:00:00Z",
        html_url: "https://github.com/org/repo/pull/8",
        merge_commit_sha: "merge-sha-8",
        head: { ref: "attempt-two", sha: "head-8" },
      },
    ]);
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 42, title: "Crash on save", body: null, state: "open", labels: ["status/in-review"] },
    ]);
    mockIssueRows([{ id: "issue-42", number: 42 }]);
    prismaMocks.lifecycleRows.push({
      kind: "issue_reopened",
      source: "sync",
      issueId: "issue-42",
      issueNumber: 42,
      dedupeKey: "sync|org/repo|42|issue_reopened|2026-10-03",
      occurredAt: new Date("2026-10-03T00:00:00Z"),
    });
    reconciliationMocks.executeActions.mockResolvedValue([
      {
        action: { type: "close_issue", issueNumber: 42, repoFullName: "org/repo", reason: "fixed" },
        success: true,
        beforeLabels: ["status/in-review"],
        afterLabels: [],
      },
    ]);

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuesClosed).toBe(1);
    expect(body.closesSkipped).toBe(0);
    // The close is attributed to the newest keyword merge (#8).
    const closes = prismaMocks.lifecycleRows.filter((row) => row.kind === "issue_closed");
    expect(closes).toHaveLength(1);
    expect(closes[0].metadata).toMatchObject({ pullRequestNumber: 8 });
  });

  it("closes when the timeline refutes an inflated reopen stamp", async () => {
    // The lifecycle event's occurredAt is the issue's updated_at at sync
    // observation: a comment after the merge inflated it past the merge, and
    // the gate alone would withhold forever. The timeline carries the real
    // reopen time, and it holds no reopen after the merge — the documented
    // "a reopen that predates the merge does not suppress" contract stands.
    mockBodyKeywordMerge();
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 42, title: "Crash on save", body: null, state: "open", labels: ["status/in-progress"] },
    ]);
    mockIssueRows([{ id: "issue-42", number: 42 }]);
    prismaMocks.lifecycleRows.push({
      kind: "issue_reopened",
      source: "sync",
      issueId: "issue-42",
      issueNumber: 42,
      dedupeKey: "sync|org/repo|42|issue_reopened|2026-10-05",
      occurredAt: new Date("2026-10-05T00:00:00Z"),
    });
    githubMocks.fetchReopenAfter.mockResolvedValueOnce(null);
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
    expect(body.closesSkipped).toBe(0);
    expect(githubMocks.fetchReopenAfter).toHaveBeenCalledWith(
      "org/repo",
      42,
      new Date("2026-10-02T08:00:00Z"),
    );
    expect(
      prismaMocks.auditRows.filter((row) => row.action === "reconcile_close_skipped"),
    ).toHaveLength(0);
  });

  it("reports the timeline-confirmed reopen time in the skip reason", async () => {
    // The event stamp (2026-10-05) was inflated by post-reopen activity; the
    // timeline names the real reopen (2026-10-04). It still postdates the
    // merge, so the close stays held — with the authoritative time noted.
    mockBodyKeywordMerge();
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 42, title: "Crash on save", body: null, state: "open", labels: ["status/in-review"] },
    ]);
    mockIssueRows([{ id: "issue-42", number: 42 }]);
    prismaMocks.lifecycleRows.push({
      kind: "issue_reopened",
      source: "sync",
      issueId: "issue-42",
      issueNumber: 42,
      dedupeKey: "sync|org/repo|42|issue_reopened|2026-10-05",
      occurredAt: new Date("2026-10-05T00:00:00Z"),
    });
    githubMocks.fetchReopenAfter.mockResolvedValueOnce(new Date("2026-10-04T12:00:00Z"));

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.closesSkipped).toBe(1);
    expect(reconciliationMocks.executeActions).not.toHaveBeenCalled();
    const skipAudit = prismaMocks.auditRows.find((row) => row.action === "reconcile_close_skipped");
    expect(skipAudit?.notes).toContain("2026-10-04T12:00:00.000Z");
    expect(skipAudit?.notes).not.toContain("2026-10-05");
  });

  it("holds the close when the reopen confirmation timeline is unreadable", async () => {
    // Fail closed: a timeline that cannot be read cannot prove the reopen
    // predates the merge, so the upper bound stands and the close waits.
    mockBodyKeywordMerge();
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 42, title: "Crash on save", body: null, state: "open", labels: ["status/in-review"] },
    ]);
    mockIssueRows([{ id: "issue-42", number: 42 }]);
    prismaMocks.lifecycleRows.push({
      kind: "issue_reopened",
      source: "sync",
      issueId: "issue-42",
      issueNumber: 42,
      dedupeKey: "sync|org/repo|42|issue_reopened|2026-10-05",
      occurredAt: new Date("2026-10-05T00:00:00Z"),
    });
    githubMocks.fetchReopenAfter.mockRejectedValueOnce(new Error("timeline 403"));

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuesClosed).toBe(0);
    expect(body.closesSkipped).toBe(1);
    expect(reconciliationMocks.executeActions).not.toHaveBeenCalled();
  });

  it("does not consult the timeline when a cached close already proves the override", async () => {
    // closedAt after the merge is exact evidence: the reopen necessarily came
    // later, so no forge confirmation is owed.
    mockBodyKeywordMerge();
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 42, title: "Crash on save", body: null, state: "open", labels: ["status/in-review"] },
    ]);
    mockIssueRows([{ id: "issue-42", number: 42, closedAt: new Date("2026-10-04T00:00:00Z") }]);

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.closesSkipped).toBe(1);
    expect(githubMocks.fetchReopenAfter).not.toHaveBeenCalled();
  });

  it("skips a close the live issue already closed upstream", async () => {
    // The pass-start snapshot said open; the live re-read says otherwise.
    // Our close is redundant — it is dropped, recorded, and GitHub is not
    // written for this issue.
    mockBodyKeywordMerge();
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 42, title: "Crash on save", body: null, state: "open", labels: ["status/in-progress"] },
    ]);
    mockIssueRows([{ id: "issue-42", number: 42 }]);
    githubMocks.fetchIssue.mockResolvedValueOnce({ state: "closed" });

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuesClosed).toBe(0);
    expect(body.closesSkipped).toBe(1);
    expect(reconciliationMocks.executeActions).not.toHaveBeenCalled();
    const skipAudit = prismaMocks.auditRows.find((row) => row.action === "reconcile_close_skipped");
    expect(skipAudit?.notes).toContain("already closed upstream");
    expect(skipAudit?.issueId).toBe("issue-42");
  });

  it("holds a close when the live issue re-read fails", async () => {
    // Writing blind is not an option: the close is held and the next pass
    // retries. The note is stable text; the raw error stays in the log.
    mockBodyKeywordMerge();
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 42, title: "Crash on save", body: null, state: "open", labels: ["status/in-progress"] },
    ]);
    mockIssueRows([{ id: "issue-42", number: 42 }]);
    githubMocks.fetchIssue.mockRejectedValueOnce(new Error("github 502"));

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuesClosed).toBe(0);
    expect(body.closesSkipped).toBe(1);
    expect(reconciliationMocks.executeActions).not.toHaveBeenCalled();
    const skipAudit = prismaMocks.auditRows.find((row) => row.action === "reconcile_close_skipped");
    expect(skipAudit?.notes).toContain("live issue recheck failed");
  });

  it("falls back to repo+number for the skip audit of an unsynced issue", async () => {
    // No cached row means no issueId to key the #1363 dedupe on: the skip
    // row still records, linked only by repo + number.
    mockBodyKeywordMerge();
    githubMocks.fetchIssues.mockResolvedValue([
      { number: 42, title: "Crash on save", body: null, state: "open", labels: ["status/in-progress"] },
    ]);
    prismaMocks.issueFindMany.mockResolvedValue([]);
    githubMocks.fetchIssue.mockRejectedValueOnce(new Error("github 502"));

    const res = await POST(authedRequest("http://localhost/api/issues/reconcile", { method: "POST", body: {} }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.closesSkipped).toBe(1);
    const skipAudit = prismaMocks.auditRows.find((row) => row.action === "reconcile_close_skipped");
    expect(skipAudit?.issueId).toBeNull();
    expect(skipAudit?.repoFullName).toBe("org/repo");
    expect(skipAudit?.issueNumber).toBe(42);
    const lookup = prismaMocks.auditLogFindFirst.mock.calls
      .map((call) => call[0].where)
      .find((where) => where.action === "reconcile_close_skipped");
    expect(lookup).toMatchObject({ repoFullName: "org/repo", issueNumber: 42 });
    expect(lookup).not.toHaveProperty("issueId");
  });
});
