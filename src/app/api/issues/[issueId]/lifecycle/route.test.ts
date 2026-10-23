import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMockWithSafeEqual as makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks } = vi.hoisted(() => ({
  mocks: {
    issueFindUnique: vi.fn(),
    eventsFindMany: vi.fn(),
    eventCreate: vi.fn(),
    eventUpsert: vi.fn(),
    agentRunFindMany: vi.fn(),
    prFixItemFindMany: vi.fn(),
    automationRepoFindUnique: vi.fn(),
    githubPullRequestFindMany: vi.fn(),
    githubPullRequestCount: vi.fn(),
    auth: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findUnique: mocks.issueFindUnique },
    issueLifecycleEvent: {
      findMany: mocks.eventsFindMany,
      create: mocks.eventCreate,
      upsert: mocks.eventUpsert,
    },
    agentRun: { findMany: mocks.agentRunFindMany },
    prFixQueueItem: { findMany: mocks.prFixItemFindMany },
    automationRepo: { findUnique: mocks.automationRepoFindUnique },
    githubPullRequest: {
      findMany: mocks.githubPullRequestFindMany,
      count: mocks.githubPullRequestCount,
    },
  },
}));

vi.mock("@/lib/auth-next", () => ({ auth: mocks.auth }));

import { GET, POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";

const URL_ = "http://localhost/api/issues/issue-1/lifecycle";
const ctx = { params: Promise.resolve({ issueId: "issue-1" }) };
const BASIC = `Basic ${Buffer.from("jory:op-pass").toString("base64")}`;

function asNextRequest(r: Request): any {
  return r;
}

function issue(over: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    number: 42,
    state: "open",
    url: "https://github.com/org/repo/issues/42",
    closedAt: null,
    repository: { fullName: "org/repo" },
    ...over,
  };
}

function eventRow(over: Record<string, unknown> = {}) {
  return {
    kind: "claim",
    source: "api:claim",
    actor: "agent/alpha",
    agentName: "agent/alpha",
    fromStatus: "status/ready",
    toStatus: "status/in-progress",
    sourceEventId: null,
    occurredAt: new Date("2026-10-01T10:00:00Z"),
    observedAt: new Date("2026-10-01T10:00:00Z"),
    metadata: null,
    ...over,
  };
}

const get = (headers: Record<string, string> = {}) =>
  GET(asNextRequest(authedRequest(URL_, { headers })), ctx);

const operatorPost = () =>
  POST(
    asNextRequest(
      new Request(URL_, { method: "POST", headers: { Authorization: BASIC } }),
    ),
    ctx,
  );

const agentPost = () =>
  POST(asNextRequest(authedRequest(URL_, { method: "POST" })), ctx);

beforeEach(() => {
  process.env.DISPATCH_AUTH_USERNAME = "jory";
  process.env.DISPATCH_AUTH_PASSWORD = "op-pass";
  process.env.DISPATCH_AUTH_MODE = "basic";
  resetAuthCaches();
  resetRateLimits();
  vi.clearAllMocks();
  mocks.issueFindUnique.mockResolvedValue(issue());
  mocks.eventsFindMany.mockResolvedValue([]);
  mocks.eventUpsert.mockResolvedValue({});
  mocks.agentRunFindMany.mockResolvedValue([]);
  mocks.prFixItemFindMany.mockResolvedValue([]);
  mocks.automationRepoFindUnique.mockResolvedValue({ id: "repo-1" });
  mocks.githubPullRequestFindMany.mockResolvedValue([]);
  mocks.githubPullRequestCount.mockResolvedValue(0);
  mocks.auth.mockResolvedValue(null);
});

describe("GET /api/issues/[issueId]/lifecycle", () => {
  it("returns 401 without auth", async () => {
    const res = await GET(
      asNextRequest(new Request(URL_)),
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown issue", async () => {
    mocks.issueFindUnique.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
  });

  it("projects claims and merges into the timeline contract", async () => {
    mocks.eventsFindMany.mockResolvedValue([
      eventRow(),
      eventRow({
        kind: "pr_merged",
        source: "reconciler",
        actor: "reconciler",
        agentName: null,
        fromStatus: "status/in-review",
        toStatus: "status/done",
        sourceEventId: "pr-7",
        occurredAt: new Date("2026-10-02T08:00:00Z"),
        metadata: {
          pullRequestNumber: 7,
          pullRequestUrl: "https://github.com/org/repo/pull/7",
          mergedAt: "2026-10-02T08:00:00.000Z",
          linkSource: "body-keyword",
        },
      }),
    ]);

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.issue).toEqual({
      id: "issue-1",
      repoFullName: "org/repo",
      issueNumber: 42,
      state: "open",
      url: "https://github.com/org/repo/issues/42",
    });
    expect(body.truncated).toBe(false);
    expect(body.timeline.schema).toBe("dispatch.issue-lifecycle-timeline/v1");
    expect(body.timeline.units).toBe("milliseconds");
    expect(body.timeline.firstClaim.at).toBe("2026-10-01T10:00:00.000Z");
    expect(body.timeline.firstMergedAt.at).toBe("2026-10-02T08:00:00.000Z");
    expect(body.timeline.delivery).toBe("merged");
    expect(body.timeline.claimToMergeMs).toBe(86400000 - (10 - 8) * 3600000);
    expect(body.timeline.pullRequests).toHaveLength(1);
    expect(body.timeline.pullRequests[0]).toMatchObject({
      prNumber: 7,
      linkSource: "body-keyword",
    });
  });

  it("keeps a missing first claim unknown, not zero", async () => {
    mocks.eventsFindMany.mockResolvedValue([
      eventRow({
        kind: "issue_closed",
        source: "sync",
        actor: "github",
        agentName: null,
        occurredAt: new Date("2026-10-03T08:00:00Z"),
      }),
    ]);
    mocks.issueFindUnique.mockResolvedValue(issue({ state: "closed" }));

    const body = await (await get()).json();
    expect(body.timeline.firstClaim).toEqual({ at: null, provenance: "unknown", via: [] });
    expect(body.timeline.claimToDoneMs).toBeNull();
    expect(body.timeline.claimToMergeMs).toBeNull();
    expect(body.timeline.delivery).toBe("closed-unmerged");
  });

  it("bounds the read window and surfaces truncation", async () => {
    const many = Array.from({ length: 501 }, (_, i) =>
      eventRow({
        kind: "status_changed",
        actor: "github",
        occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      }),
    );
    mocks.eventsFindMany.mockResolvedValue(many);

    const body = await (await get()).json();
    expect(body.truncated).toBe(true);
    expect(body.events).toHaveLength(500);
  });

  it("additively projects the attempt chain from runs and pr-fix items (#1183)", async () => {
    mocks.eventsFindMany.mockResolvedValue([
      eventRow({ kind: "claim", agentName: "agent/alpha" }),
    ]);
    mocks.agentRunFindMany.mockResolvedValue([
      {
        id: "run-1",
        agentName: "agent/alpha",
        runType: "implement",
        status: "completed",
        startedAt: new Date("2026-10-01T10:05:00Z"),
        finishedAt: new Date("2026-10-01T11:00:00Z"),
        executionMetadata: { worker: "courier", model: "gpt-5.5" },
      },
    ]);
    mocks.prFixItemFindMany.mockResolvedValue([
      {
        id: "item-1",
        repo: "org/repo",
        pr: 7,
        issue: 42,
        generation: 1,
        fixAttempts: 1,
        status: "FIXED",
        outcome: null,
        queuedAt: new Date("2026-10-01T12:00:00Z"),
        history: [
          { at: new Date("2026-10-01T12:10:00Z"), action: "ack", status: null, outcome: null },
        ],
      },
    ]);

    const body = await (await get()).json();
    expect(body.attempts.schema).toBe("dispatch.work-item-attempt-chain/v1");
    expect(body.attempts.workItem).toEqual({ repoFullName: "org/repo", issueNumber: 42 });
    expect(body.attemptsTruncated).toBe(false);
    // Content-derived execution id (#1183): sha256 over the claim event's
    // canonical dedupe identity [kind, fromStatus, toStatus, occurredAtMs,
    // agentName]. `source`/`actor` are excluded on purpose — the same claim
    // observed by two writers is one fact and keeps one id.
    const claimKey = [
      "claim",
      "status/ready",
      "status/in-progress",
      Date.parse("2026-10-01T10:00:00.000Z"),
      "agent/alpha",
      "",
    ].join("\u0000");
    const execId = `exec-${createHash("sha256").update(claimKey).digest("hex").slice(0, 12)}`;
    expect(body.attempts.attempts.map((a: { attemptId: string }) => a.attemptId)).toEqual([
      execId,
      "fix-item-1-g1",
    ]);
    expect(body.attempts.attempts[0]).toMatchObject({
      outcome: "unclassified",
      classification: "active-execution",
      executionMetadata: { workerProduct: "courier", model: "gpt-5.5" },
      artifacts: { agentRunIds: ["run-1"] },
      prFix: null,
    });
    expect(body.attempts.attempts[1].outcome).toBe("success");
    expect(body.attempts.attempts[1].prFix).toEqual({ itemId: "item-1", repo: "org/repo", pr: 7 });
    expect(body.attempts.totalExecutionWallTimeMs).toBe(3300000);
  });

  it("folds the cached repo casing into the pr-fix read (#1183 review)", async () => {
    // Queue writes always fold repo lowercase (#1145); Repository.fullName
    // keeps caller casing, so a mixed-case cache row must still find its
    // normalized queue items instead of silently reading none.
    mocks.issueFindUnique.mockResolvedValue(
      issue({ repository: { fullName: "Org/Repo" } }),
    );

    const res = await get();
    expect(res.status).toBe(200);
    expect(mocks.prFixItemFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { repo: "org/repo", issue: 42 },
      }),
    );
  });

  it("flags attemptsTruncated when the bounded run read hits its cap", async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({
      id: `run-${i}`,
      agentName: null,
      runType: "implement",
      status: "completed",
      startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      finishedAt: null,
      executionMetadata: null,
    }));
    mocks.agentRunFindMany.mockResolvedValue(many);

    const body = await (await get()).json();
    expect(body.attemptsTruncated).toBe(true);
    expect(body.attempts.attempts).toEqual([]);
  });
});

describe("POST /api/issues/[issueId]/lifecycle (backfill)", () => {
  it("refuses agent bearer tokens", async () => {
    const res = await agentPost();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/requires operator auth/);
  });

  it("returns 404 for an unknown issue", async () => {
    mocks.issueFindUnique.mockResolvedValue(null);
    const res = await operatorPost();
    expect(res.status).toBe(404);
  });

  it("records merges from run history for an operator call", async () => {
    mocks.agentRunFindMany.mockResolvedValue([
      { touchedIssueUrls: ["https://github.com/org/repo/pull/7"] },
    ]);
    mocks.githubPullRequestFindMany.mockResolvedValue([
      {
        number: 7,
        url: "https://api.github.com/repos/org/repo/pulls/7",
        mergedAt: new Date("2026-10-02T08:00:00Z"),
      },
    ]);
    mocks.githubPullRequestCount.mockResolvedValue(1);

    const res = await operatorPost();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, recorded: 1, skippedUnmerged: 0, skippedNoLink: 0 });
    expect(mocks.eventUpsert).toHaveBeenCalledTimes(1);
    const created = mocks.eventUpsert.mock.calls[0][0].create;
    expect(created.kind).toBe("pr_merged");
    expect(created.source).toBe("backfill");
    expect(created.metadata).toMatchObject({
      pullRequestNumber: 7,
      pullRequestUrl: "https://github.com/org/repo/pull/7",
      backfilled: true,
    });
  });

  it("is a no-op without automation repo rows and never writes claims", async () => {
    mocks.automationRepoFindUnique.mockResolvedValue(null);

    const res = await operatorPost();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, recorded: 0 });
    expect(mocks.eventUpsert).not.toHaveBeenCalled();
    expect(mocks.eventCreate).not.toHaveBeenCalled();
    expect(mocks.githubPullRequestFindMany).not.toHaveBeenCalled();
    expect(mocks.githubPullRequestCount).not.toHaveBeenCalled();
  });

  it("scopes the PR read to the numbers the issue's runs touch", async () => {
    mocks.agentRunFindMany.mockResolvedValue([
      { touchedIssueUrls: ["https://github.com/org/repo/pull/7"] },
    ]);
    mocks.githubPullRequestCount.mockResolvedValue(3);

    const res = await operatorPost();
    expect(res.status).toBe(200);

    expect(mocks.githubPullRequestFindMany).toHaveBeenCalledTimes(1);
    const findManyArgs = mocks.githubPullRequestFindMany.mock.calls[0][0];
    expect(findManyArgs.where).toEqual({ repoId: "repo-1", number: { in: [7] } });

    expect(mocks.githubPullRequestCount).toHaveBeenCalledTimes(1);
    const countArgs = mocks.githubPullRequestCount.mock.calls[0][0];
    expect(countArgs.where).toEqual({ repoId: "repo-1", mergedAt: { not: null } });

    const body = await res.json();
    expect(body).toMatchObject({ success: true, recorded: 0, skippedUnmerged: 0, skippedNoLink: 3 });
  });

  it("excludes a touched PR of another repo from the scoped PR read", async () => {
    mocks.agentRunFindMany.mockResolvedValue([
      { touchedIssueUrls: ["https://github.com/other-owner/repo/pull/7"] },
    ]);

    const res = await operatorPost();
    expect(res.status).toBe(200);

    const findManyArgs = mocks.githubPullRequestFindMany.mock.calls[0][0];
    expect(findManyArgs.where).toEqual({ repoId: "repo-1", number: { in: [] } });
  });

  it("counts a scoped PR without a merge time as unmerged and writes nothing", async () => {
    mocks.agentRunFindMany.mockResolvedValue([
      { touchedIssueUrls: ["https://github.com/org/repo/pull/7"] },
    ]);
    mocks.githubPullRequestFindMany.mockResolvedValue([
      {
        number: 7,
        url: "https://api.github.com/repos/org/repo/pulls/7",
        mergedAt: null,
      },
    ]);

    const res = await operatorPost();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({ success: true, recorded: 0, skippedUnmerged: 1 });
    expect(mocks.eventUpsert).not.toHaveBeenCalled();
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });

  it("fails as 500 when the event write fails", async () => {
    mocks.agentRunFindMany.mockResolvedValue([
      { touchedIssueUrls: ["https://github.com/org/repo/pull/7"] },
    ]);
    mocks.githubPullRequestFindMany.mockResolvedValue([
      {
        number: 7,
        url: "https://github.com/org/repo/pull/7",
        mergedAt: new Date("2026-10-02T08:00:00Z"),
      },
    ]);
    mocks.eventUpsert.mockRejectedValue(new Error("db down"));

    const res = await operatorPost();
    expect(res.status).toBe(500);
  });
});
