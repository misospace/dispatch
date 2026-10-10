import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock(mockToken, { "test-worker-token": "worker" }, { "bound-token": "alpha" }));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    issueFindMany: vi.fn(),
    prFixFindMany: vi.fn(),
    prFixCreate: vi.fn(),
    prFixHistoryCreate: vi.fn(),
    prFixFindUnique: vi.fn(),
    prFixFindUniqueByRepo: vi.fn(),
    prFixUpdateMany: vi.fn(),
    findLeasedIssueIds: vi.fn(),
    linkedRows: [] as any[],
    fetchPullRequestLabels: vi.fn().mockResolvedValue([]),
    fetchPullRequestHeadSha: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.issueFindMany },
    prFixQueueItem: {
      findMany: mocks.prFixFindMany,
      findUnique: vi.fn(async ({ where }: any) => {
        const rows = [...mocks.linkedRows, ...(await mocks.prFixFindMany())];
        if (where.id !== undefined) {
          const byId = await mocks.prFixFindUnique({ where });
          return byId ?? rows.find((row: any) => row.id === where.id) ?? null;
        }
        return mocks.prFixFindUniqueByRepo({ where });
      }),
      create: mocks.prFixCreate,
      updateMany: mocks.prFixUpdateMany,
    },
    prFixHistory: { create: mocks.prFixHistoryCreate },
    $transaction: async (fn: any) => fn({
      prFixQueueItem: {
        create: mocks.prFixCreate,
        findUnique: mocks.prFixFindUniqueByRepo,
      },
      prFixHistory: { create: mocks.prFixHistoryCreate },
    }),
  },
  asPrFixQueueClient: (client: any) => client,
}));

vi.mock("@/lib/github", () => ({
  fetchPullRequestLabels: mocks.fetchPullRequestLabels,
  fetchPullRequestHeadSha: mocks.fetchPullRequestHeadSha,
}));

vi.mock("@/lib/lease", () => ({
  findLeasedIssueIds: mocks.findLeasedIssueIds,
}));

// The production queue-mutation functions (enqueue/mark/requeue) surface
// outcomes to GitHub; no-op them so route-level lifecycle tests can drive the
// real state machine without network.
vi.mock("@/lib/pr-fix-surfacing", () => ({
  NEEDS_HUMAN_LABEL: "needs-human",
  surfacePrFixBlocked: vi.fn().mockResolvedValue({ labelApplied: false, commentPosted: false, errors: [] }),
  surfacePrFixRequeued: vi.fn().mockResolvedValue({ labelRemoved: false, commentUpdated: false, errors: [] }),
  surfacePrFixUnblocked: vi.fn().mockResolvedValue({ labelRemoved: false, commentUpdated: false, errors: [] }),
  extractUrlsFromText: vi.fn(() => []),
}));

import { GET } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { enqueuePrFixItem, markPrFixItem, requeuePrFixItem } from "@/lib/pr-fix-queue";

/**
 * Minimal in-memory PrFixQueueClient backing the production queue-mutation
 * functions: findUnique by (repo, pr), update by id (with Prisma `increment`
 * support), findMany by status/lane, and history append.
 */
function makeQueueStore() {
  const items: any[] = [];
  let seq = 0;
  const client: any = {
    items,
    $transaction: async (fn: any) => fn(client),
    prFixQueueItem: {
      findUnique: async ({ where }: any) =>
        items.find((i) =>
          where.id !== undefined
            ? i.id === where.id
            : i.repo === where.repo_pr.repo && i.pr === where.repo_pr.pr,
        ) ?? null,
      create: async ({ data }: any) => {
        const item = { id: `prfix-${++seq}`, generation: 1, queuedAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"), ...data };
        items.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const idx = items.findIndex((i) => i.id === where.id);
        const patch: Record<string, any> = { ...data };
        for (const key of Object.keys(patch)) {
          const value = patch[key];
          if (value && typeof value === "object" && typeof value.increment === "number") {
            patch[key] = (items[idx][key] ?? 0) + value.increment;
          }
        }
        items[idx] = { ...items[idx], ...patch, updatedAt: new Date("2026-01-02T00:00:00Z") };
        return items[idx];
      },
      updateMany: async ({ where, data }: any) => {
        const idx = items.findIndex((i) =>
          where.id !== undefined
            ? i.id === where.id && (where.generation === undefined || i.generation === where.generation)
            : i.repo === where.repo_pr.repo && i.pr === where.repo_pr.pr,
        );
        if (idx === -1) return { count: 0 };
        const patch: Record<string, any> = { ...data };
        for (const key of Object.keys(patch)) {
          const value = patch[key];
          if (value && typeof value === "object" && typeof value.increment === "number") {
            patch[key] = (items[idx][key] ?? 0) + value.increment;
          }
        }
        items[idx] = { ...items[idx], ...patch, updatedAt: new Date("2026-01-02T00:00:00Z") };
        return { count: 1 };
      },
      findMany: async ({ where }: any) => {
        let result = items.slice();
        if (where?.status) {
          result = Array.isArray(where.status.in)
            ? result.filter((i) => where.status.in.includes(i.status))
            : result.filter((i) => i.status === where.status);
        }
        if (where?.lane) result = result.filter((i) => i.lane === where.lane);
        return result;
      },
    },
    prFixHistory: {
      create: async ({ data }: any) => ({ ...data }),
    },
  };
  return client;
}

/**
 * Mirrors the route's first-hand-out-only stamp `where` against a stateful
 * fake row: match id + generation, and (dispatchedGeneration IS NULL OR
 * != the stamped generation). Lets updateMany genuinely no-op on re-hand-outs
 * of an already-stamped generation.
 */
function matchesFirstHandOut(row: any, where: any): boolean {
  if (row.id !== where.id || row.generation !== where.generation) return false;
  if (!where.OR) return true;
  return where.OR.some((cond: any) => {
    if (!("dispatchedGeneration" in cond)) return false;
    if (cond.dispatchedGeneration === null) return row.dispatchedGeneration == null;
    return (
      row.dispatchedGeneration != null &&
      row.dispatchedGeneration !== cond.dispatchedGeneration.not
    );
  });
}

/**
 * Apply a Prisma update patch to a fake row, resolving the array-mutation
 * shapes the route writes: `{ push: [...] }` for the per-agent hand-out
 * record (#1133) and `{ increment: n }` for counters. A plain value is
 * assigned as-is.
 */
function applyUpdate(row: any, data: any): void {
  const patch: Record<string, any> = { ...data };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === "object" && Array.isArray(value.push)) {
      patch[key] = [...(Array.isArray(row[key]) ? row[key] : []), ...value.push];
    } else if (value && typeof value === "object" && typeof value.increment === "number") {
      patch[key] = (row[key] ?? 0) + value.increment;
    }
  }
  Object.assign(row, patch);
}

function request(url: string, agentName = "example-agent", includeAuth = true) {
  return authedRequest(`http://localhost${url}`, { includeAuth });
}

/** A plain issue with no linked PR: independent implement work. */
function independentIssue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `issue-${number}`,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/org/repo/issues/${number}`,
    labels: ["priority/p2", "status/ready"],
    currentLane: "local",
    decomposed: false,
    repository: { fullName: "org/repo" },
    linkedPrNumber: null,
    linkedPrUrl: null,
    linkedPrNeedsFollowup: false,
    linkedPrFollowupReasons: [],
    linkedPrReviewDecision: null,
    linkedPrMergeState: null,
    linkedPrHealthCheckedAt: null,
    ...overrides,
  };
}

function linkedIssue(number: number, pr: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `issue-${number}`,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/org/repo/issues/${number}`,
    labels: ["priority/p0", "status/ready"],
    currentLane: "local",
    decomposed: false,
    repository: { fullName: "org/repo" },
    linkedPrNumber: pr,
    linkedPrUrl: `https://github.com/org/repo/pull/${pr}`,
    linkedPrNeedsFollowup: true,
    linkedPrFollowupReasons: ["changes requested", "checks failing"],
    linkedPrReviewDecision: "CHANGES_REQUESTED",
    linkedPrMergeState: null,
    linkedPrHealthCheckedAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  };
}

describe("GET /api/agents/[agentName]/next-task", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.prFixFindMany.mockResolvedValue([]);
    mocks.linkedRows = [];
    mocks.prFixFindUniqueByRepo.mockImplementation(async ({ where }: any) => {
      const rows = [...mocks.linkedRows, ...(await mocks.prFixFindMany())];
      return rows.find((row: any) => row.repo === where.repo_pr.repo && row.pr === where.repo_pr.pr) ?? null;
    });
    mocks.fetchPullRequestLabels.mockResolvedValue([]);
    mocks.fetchPullRequestHeadSha.mockResolvedValue(null);
    mocks.prFixCreate.mockImplementation(async ({ data }: any) => {
      const item = { id: "linked-prfix", generation: 1, status: "QUEUED", agentHandouts: [], ...data };
      mocks.linkedRows.push(item);
      return item;
    });
    mocks.prFixHistoryCreate.mockResolvedValue({});
    // Default re-read mirrors production: the row read back after the stamp
    // is the same live row listQueuedPrFixItems served. Stateful tests
    // override this with their own implementation.
    mocks.prFixFindUnique.mockImplementation(async () => {
      const items = await mocks.prFixFindMany();
      const first = items[0];
      return first
        ? { reason: first.reason, feedback: first.feedback, generation: first.generation, status: first.status, lane: first.lane, agentHandouts: first.agentHandouts }
        : null;
    });
    mocks.prFixUpdateMany.mockResolvedValue({ count: 1 });
    mocks.issueFindMany.mockResolvedValue([]);
    mocks.findLeasedIssueIds.mockResolvedValue([]);
  });

  it("returns idle when the queue is empty", async () => {
    const res = await GET(
      request("/api/agents/example-agent/next-task"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("idle");
    expect(body.shouldRun).toBe(false);
    expect(body.reason).toBe("No work available");
  });

  it("returns idle when queue is empty (not an array)", async () => {
    const res = await GET(
      request("/api/agents/example-agent/next-task"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(Array.isArray(body)).toBe(false);
  });

  it("returns one implement task for a normal issue", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 42,
        title: "Fix login bug",
        url: "https://github.com/org/repo/issues/42",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.shouldRun).toBe(true);
    expect(body.agentName).toBe("example-agent");
    expect(body.issue.number).toBe(42);
    expect(body.issue.title).toBe("Fix login bug");
    expect(body.issue.repoFullName).toBe("org/repo");
    expect(body.issue.url).toBe("https://github.com/org/repo/issues/42");
  });

  it("returns exactly one task, not an array", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 42,
        title: "First issue",
        url: "https://github.com/org/repo/issues/42",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
      {
        id: "issue-2",
        number: 43,
        title: "Second issue",
        url: "https://github.com/org/repo/issues/43",
        labels: ["priority/p1", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(Array.isArray(body)).toBe(false);
    expect(body.type).toBe("implement");
  });

  it("returns followup-pr task when a PR-fix item is ahead of issue work", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 12,
        issue: 67,
        branch: "fix/issue-67",
        url: "https://github.com/org/repo/pull/12",
        title: "Fix issue 67",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "review changes requested",
        feedback: ["please update tests"],
        evidenceKeys: ["review:1"],
        author: "itsmiso-ai",
        generation: 1,
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 99,
        title: "Regular issue",
        url: "https://github.com/org/repo/issues/99",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.shouldRun).toBe(true);
    expect(body.agentName).toBe("example-agent");
    expect(body.pullRequest.repoFullName).toBe("org/repo");
    expect(body.pullRequest.number).toBe(12);
    expect(body.pullRequest.url).toBe("https://github.com/org/repo/pull/12");
    expect(body.prFixItem).toEqual({
      id: "prfix-1",
      generation: 1,
    });
    expect(Array.isArray(body.reasons)).toBe(true);
  });

  it("serves distinct (id, generation) identities across a requeue of the same PR", async () => {
    // The route is a read over the persisted queue row; a requeue bumps the
    // row's generation without changing its id. First attempt:
    const item = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 12,
      issue: null,
      branch: "fix/something",
      url: "https://github.com/org/repo/pull/12",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "review changes requested",
      feedback: ["please update tests"],
      evidenceKeys: ["review:1"],
      author: "bot",
      generation: 1,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    };
    mocks.prFixFindMany.mockResolvedValue([item]);

    const first = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const firstBody = await first.json();
    expect(firstBody.prFixItem).toEqual({ id: "prfix-1", generation: 1 });

    // Same queue row after an explicit requeue — same id, bumped generation.
    item.generation = 2;
    const second = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const secondBody = await second.json();
    expect(secondBody.type).toBe("followup-pr");
    expect(secondBody.prFixItem).toEqual({ id: "prfix-1", generation: 2 });
    expect(secondBody.prFixItem.id).toBe(firstBody.prFixItem.id);
  });

  it("serves the bumped generation through the production requeue path", async () => {
    // Drive the real queue state machine (enqueue → BLOCKED → requeue) against
    // an in-memory store, and verify next-task surfaces the persisted identity.
    const client = makeQueueStore();
    mocks.prFixFindMany.mockImplementation(async ({ where }: any) =>
      client.prFixQueueItem.findMany({ where }),
    );

    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 12,
      lane: "NORMAL",
      reason: "review changes requested",
      feedback: "please update tests",
      evidenceKey: "review:1",
    });

    const first = await GET(
      request("/api/agents/example-agent/next-task"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const firstBody = await first.json();
    expect(firstBody.type).toBe("followup-pr");
    expect(firstBody.prFixItem.generation).toBe(1);
    const itemId = firstBody.prFixItem.id;

    await markPrFixItem(client, { repo: "org/repo", pr: 12, status: "BLOCKED", note: "stuck" });
    const requeued = await requeuePrFixItem(client, { repo: "org/repo", pr: 12, note: "try again" });
    expect(requeued?.status).toBe("QUEUED");
    expect(requeued?.generation).toBe(2);

    const second = await GET(
      request("/api/agents/example-agent/next-task"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const secondBody = await second.json();
    expect(secondBody.type).toBe("followup-pr");
    expect(secondBody.prFixItem).toEqual({ id: itemId, generation: 2 });
  });

  it("stamps the hand-out with a generation-conditional update (#1119)", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 12,
        issue: null,
        branch: "fix/something",
        url: "https://github.com/org/repo/pull/12",
        title: "Fix something",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "CI failure on main",
        feedback: ["update tests"],
        evidenceKeys: ["ci:1"],
        author: "bot",
        generation: 2,
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(mocks.prFixUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "prfix-1",
        generation: 2,
        status: "QUEUED",
        OR: [
          { dispatchedGeneration: null },
          { dispatchedGeneration: { not: 2 } },
        ],
      },
      data: expect.objectContaining({
        dispatchedAt: expect.any(Date),
        dispatchedGeneration: 2,
        postDispatchEvidenceKeys: [],
      }),
    });
  });

  it("another agent's hand-out of a stamped generation preserves post-dispatch evidence (#1119, #1133)", async () => {
    // Stateful fake row: the updateMany mock honors the first-hand-out-only
    // where clause, so a hand-out of an already-stamped generation genuinely
    // no-ops instead of re-stamping and clearing the post-dispatch keys.
    const row: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 7,
      issue: null,
      branch: "fix/x",
      url: "https://github.com/org/repo/pull/7",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["ci:1"],
      author: "bot",
      generation: 2,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: null,
      dispatchedGeneration: null,
      postDispatchEvidenceKeys: [],
      agentHandouts: [],
    };
    mocks.prFixFindMany.mockResolvedValue([row]);
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      if (!matchesFirstHandOut(row, where)) return { count: 0 };
      applyUpdate(row, data);
      return { count: 1 };
    });
    mocks.prFixFindUnique.mockImplementation(async () => ({
      id: row.id,
      reason: row.reason,
      feedback: row.feedback,
      generation: row.generation,
    }));

    // (a) First hand-out of generation 2, by agent A: stamps and clears the keys.
    const first = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    expect((await first.json()).type).toBe("followup-pr");
    expect(row.dispatchedGeneration).toBe(2);
    expect(row.dispatchedAt).toBeInstanceOf(Date);
    expect(row.postDispatchEvidenceKeys).toEqual([]);
    expect(row.agentHandouts).toEqual(["example-agent@2"]);
    const stampedAt = row.dispatchedAt;

    // (b) New evidence enqueues mid-run, after the dispatch.
    row.postDispatchEvidenceKeys = ["review:o/r#7:r2@H1"];

    // (c) Agent B's FIRST hand-out of the same still-QUEUED generation: the
    // stamp no-ops (dispatchedGeneration already == 2), so the post-dispatch
    // keys survive, and B receives the item (per-agent records, #1133).
    const second = await GET(
      request("/api/agents/other-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "other-agent" }) },
    );
    const secondBody = await second.json();
    expect(secondBody.type).toBe("followup-pr");
    expect(secondBody.prFixItem).toEqual({ id: "prfix-1", generation: 2 });
    expect(row.postDispatchEvidenceKeys).toEqual(["review:o/r#7:r2@H1"]);
    expect(row.dispatchedGeneration).toBe(2);
    expect(row.dispatchedAt).toBe(stampedAt);
    expect(row.agentHandouts).toEqual(["example-agent@2", "other-agent@2"]);

    // (d) Agent A re-polling at the same generation is SKIPPED (#1133): it
    // already has a run for this work identity, so re-handing would only
    // starve the lane. The request falls through to issue work.
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 99,
        title: "Regular issue",
        url: "https://github.com/org/repo/issues/99",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);
    const third = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const thirdBody = await third.json();
    expect(thirdBody.type).toBe("implement");
    expect(thirdBody.prFixItem).toBeUndefined();
    // The skip left the row untouched: the stamp and the recorded keys are
    // exactly as the in-flight worker needs them.
    expect(row.postDispatchEvidenceKeys).toEqual(["review:o/r#7:r2@H1"]);
    expect(row.dispatchedGeneration).toBe(2);
    expect(row.agentHandouts).toEqual(["example-agent@2", "other-agent@2"]);
  });

  it("serves the next pr-fix item when the first was already handed to this agent (#1133)", async () => {
    const handed: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 7,
      issue: null,
      branch: "fix/x",
      url: "https://github.com/org/repo/pull/7",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["ci:1"],
      author: "bot",
      generation: 2,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: new Date("2026-01-01T00:05:00Z"),
      dispatchedGeneration: 2,
      postDispatchEvidenceKeys: [],
      agentHandouts: ["example-agent@2"],
    };
    const fresh: any = {
      id: "prfix-2",
      repo: "org/other",
      pr: 9,
      issue: null,
      branch: "fix/y",
      url: "https://github.com/org/other/pull/9",
      title: "Fix something else",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "review changes requested",
      feedback: ["address comments"],
      evidenceKeys: ["review:2"],
      author: "bot",
      generation: 1,
      queuedAt: new Date("2026-01-01T00:06:00Z"),
      updatedAt: new Date("2026-01-01T00:06:00Z"),
      dispatchedAt: null,
      dispatchedGeneration: null,
      postDispatchEvidenceKeys: [],
      agentHandouts: [],
    };
    mocks.prFixFindMany.mockResolvedValue([handed, fresh]);
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      const target = handed.id === where.id ? handed : fresh.id === where.id ? fresh : null;
      if (!target || !matchesFirstHandOut(target, where)) return { count: 0 };
      applyUpdate(target, data);
      return { count: 1 };
    });
    mocks.prFixFindUnique.mockImplementation(async ({ where }: any) => {
      const target = handed.id === where.id ? handed : fresh;
      return { id: target.id, reason: target.reason, feedback: target.feedback, generation: target.generation };
    });

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    // The already-handed item is skipped; the NEXT pr-fix item ships.
    expect(body.type).toBe("followup-pr");
    expect(body.prFixItem).toEqual({ id: "prfix-2", generation: 1 });
    expect(handed.agentHandouts).toEqual(["example-agent@2"]);
    expect(fresh.agentHandouts).toEqual(["example-agent@1"]);
  });

  it("suppresses the issue of an already-handed pr-fix item from the implement fallback (#1145)", async () => {
    // The item's issue is ready for implement pickup and carries no linked-PR
    // health flag, so only the pr-fix skip marks it queue-owned.
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 7,
        issue: 42,
        branch: "fix/issue-42",
        url: "https://github.com/org/repo/pull/7",
        title: "Fix 42",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "review changes requested",
        feedback: ["address comments"],
        evidenceKeys: ["review:1"],
        author: "bot",
        generation: 2,
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        dispatchedAt: new Date("2026-01-01T00:05:00Z"),
        dispatchedGeneration: 2,
        postDispatchEvidenceKeys: [],
        agentHandouts: ["example-agent@2"],
      },
    ]);
    mocks.issueFindMany.mockResolvedValue([independentIssue(42), independentIssue(99)]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
  });

  it("suppresses the issue when the queue row's repo casing differs from the issue's (#1145)", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "Org/Repo",
        pr: 7,
        issue: 42,
        branch: "fix/issue-42",
        url: "https://github.com/Org/Repo/pull/7",
        title: "Fix 42",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "review changes requested",
        feedback: ["address comments"],
        evidenceKeys: ["review:1"],
        author: "bot",
        generation: 2,
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        postDispatchEvidenceKeys: [],
        agentHandouts: ["example-agent@2"],
      },
    ]);
    mocks.issueFindMany.mockResolvedValue([independentIssue(42), independentIssue(99)]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
  });

  it("idles when the only ready issue belongs to an already-handed pr-fix item (#1145)", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 7,
        issue: 42,
        branch: "fix/issue-42",
        url: "https://github.com/org/repo/pull/7",
        title: "Fix 42",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "review changes requested",
        feedback: ["address comments"],
        evidenceKeys: ["review:1"],
        author: "bot",
        generation: 2,
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        postDispatchEvidenceKeys: [],
        agentHandouts: ["example-agent@2"],
      },
    ]);
    mocks.issueFindMany.mockResolvedValue([independentIssue(42)]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("idle");
    expect(body.shouldRun).toBe(false);
    expect(body.reason).toContain("deferred");
  });

  it("hands the item to the same agent again after its generation moves (#1133)", async () => {
    const row: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 7,
      issue: null,
      branch: "fix/x",
      url: "https://github.com/org/repo/pull/7",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["ci:1"],
      author: "bot",
      generation: 2,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: null,
      dispatchedGeneration: null,
      postDispatchEvidenceKeys: [],
      agentHandouts: [],
    };
    mocks.prFixFindMany.mockResolvedValue([row]);
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      if (!matchesFirstHandOut(row, where)) return { count: 0 };
      applyUpdate(row, data);
      return { count: 1 };
    });
    mocks.prFixFindUnique.mockImplementation(async () => ({
      id: row.id,
      reason: row.reason,
      feedback: row.feedback,
      generation: row.generation,
    }));
    mocks.issueFindMany.mockResolvedValue([]);

    const first = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    expect((await first.json()).prFixItem).toEqual({ id: "prfix-1", generation: 2 });
    expect(row.agentHandouts).toEqual(["example-agent@2"]);

    // The item is re-issued as a fresh attempt (requeue/reopen): generation
    // bumps, and the fresh attempt cleared the hand-out records.
    row.generation = 3;
    row.dispatchedGeneration = null;
    row.agentHandouts = [];

    const second = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const secondBody = await second.json();
    expect(secondBody.type).toBe("followup-pr");
    expect(secondBody.prFixItem).toEqual({ id: "prfix-1", generation: 3 });
    expect(row.agentHandouts).toEqual(["example-agent@3"]);
  });

  it("still hands out a pr-fix item to an agent with no recorded hand-out (#1133)", async () => {
    // An item handed to another agent is still dispatchable to this one:
    // the records are per-agent, keyed by the receiving agent's name.
    const row: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 7,
      issue: null,
      branch: "fix/x",
      url: "https://github.com/org/repo/pull/7",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["ci:1"],
      author: "bot",
      generation: 2,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: new Date("2026-01-01T00:05:00Z"),
      dispatchedGeneration: 2,
      postDispatchEvidenceKeys: [],
      agentHandouts: ["some-other-agent@2"],
    };
    mocks.prFixFindMany.mockResolvedValue([row]);
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      if (!matchesFirstHandOut(row, where)) return { count: 0 };
      applyUpdate(row, data);
      return { count: 1 };
    });
    mocks.prFixFindUnique.mockImplementation(async () => ({
      id: row.id,
      reason: row.reason,
      feedback: row.feedback,
      generation: row.generation,
    }));

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.prFixItem).toEqual({ id: "prfix-1", generation: 2 });
    expect(row.agentHandouts).toEqual(["some-other-agent@2", "example-agent@2"]);
  });

  it("first hand-out of a new generation re-stamps and clears stale evidence keys", async () => {
    // Same PR requeued: generation bumped to 3, but the row still carries
    // the generation-2 stamp and its stale post-dispatch keys.
    const row: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 7,
      issue: null,
      branch: "fix/x",
      url: "https://github.com/org/repo/pull/7",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["ci:2"],
      author: "bot",
      generation: 3,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
      dispatchedAt: new Date("2026-01-02T00:00:00Z"),
      dispatchedGeneration: 2,
      postDispatchEvidenceKeys: ["review:o/r#7:r1@H1"],
    };
    mocks.prFixFindMany.mockResolvedValue([row]);
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      if (!matchesFirstHandOut(row, where)) return { count: 0 };
      applyUpdate(row, data);
      return { count: 1 };
    });
    mocks.prFixFindUnique.mockImplementation(async () => ({
      id: row.id,
      reason: row.reason,
      feedback: row.feedback,
      generation: row.generation,
    }));

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    // A new generation is a first hand-out: it re-stamps and clears the
    // stale post-dispatch keys from the prior generation.
    expect(row.dispatchedGeneration).toBe(3);
    expect(row.postDispatchEvidenceKeys).toEqual([]);
    expect(row.dispatchedAt).not.toEqual(new Date("2026-01-02T00:00:00Z"));
  });

  it("hands out a token for the NEW generation when the re-read shows generation moved (#1119)", async () => {
    const row: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 7,
      issue: null,
      branch: "fix/x",
      url: "https://github.com/org/repo/pull/7",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["ci:1"],
      author: "bot",
      generation: 2,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: null,
      dispatchedGeneration: null,
      postDispatchEvidenceKeys: [],
    };
    mocks.prFixFindMany.mockResolvedValue([row]);
    let stampCount = 0;
    const stamps: any[] = [];
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      if (!where.OR) {
        // The per-agent hand-out record push (#1133) is not a stamp.
        const recorded = matchesFirstHandOut(row, where);
        if (recorded) applyUpdate(row, data);
        return { count: recorded ? 1 : 0 };
      }
      stampCount += 1;
      stamps.push(where);
      if (!matchesFirstHandOut(row, where)) return { count: 0 };
      applyUpdate(row, data);
      if (stampCount === 1) {
        // A concurrent re-issue moves the row in the read→stamp gap.
        row.generation = 3;
        row.reason = "CI failure on main (re-issued)";
        row.feedback = ["update tests", "fix lint"];
      }
      return { count: 1 };
    });
    mocks.prFixFindUnique.mockImplementation(async () => ({
      id: row.id,
      reason: row.reason,
      feedback: row.feedback,
      generation: row.generation,
    }));

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    // The first stamp targeted 2; the retry targeted the NEW generation.
    expect(stampCount).toBe(2);
    expect(stamps[0].generation).toBe(2);
    expect(stamps[1].generation).toBe(3);
    // The handed-out token is the NEW generation, so the worker's settle
    // report matches the live row instead of being rejected as a mismatch.
    expect(body.prFixItem).toEqual({ id: "prfix-1", generation: 3 });
    // The payload reasons come from the latest read, not the queue snapshot.
    expect(body.reasons).toContain("CI failure on main (re-issued)");
    expect(body.reasons).toContain("fix lint");
    // The row is stamped at the generation the token names.
    expect(row.dispatchedGeneration).toBe(3);
  });

  it("does not hand out an unconfirmed token when the generation moves on both retry passes (#1119)", async () => {
    // A concurrent re-issue keeps winning the race: every successful stamp
    // is immediately followed by another generation bump, so neither pass
    // can confirm the generation it stamped. The route must not ship a
    // token for a generation it never confirmed — mid-run evidence would be
    // classified as pre-dispatch and absorbed, the exact #1119 loss.
    const row: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 7,
      issue: null,
      branch: "fix/x",
      url: "https://github.com/org/repo/pull/7",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["ci:1"],
      author: "bot",
      generation: 2,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: null,
      dispatchedGeneration: null,
      postDispatchEvidenceKeys: [],
    };
    mocks.prFixFindMany.mockResolvedValue([row]);
    let stampCount = 0;
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      stampCount += 1;
      if (!matchesFirstHandOut(row, where)) return { count: 0 };
      applyUpdate(row, data);
      row.generation = (where.generation as number) + 1;
      row.reason = `re-issued at generation ${row.generation}`;
      return { count: 1 };
    });
    mocks.prFixFindUnique.mockImplementation(async () => ({
      id: row.id,
      reason: row.reason,
      feedback: row.feedback,
      generation: row.generation,
    }));
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 99,
        title: "Regular issue",
        url: "https://github.com/org/repo/issues/99",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // The bounded retry ran both passes, then gave up.
    expect(stampCount).toBe(2);
    // No pr-fix token ships: the last observed generation (4) was never
    // stamped or confirmed. The request falls through to issue work.
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(body.prFixItem).toBeUndefined();
    // The last confirmed stamp (generation 3) stays on the row, so a later
    // poll confirms and hands it out against the then-live row.
    expect(row.dispatchedGeneration).toBe(3);
  });

  it("does not hand out a stale token when the second pass throws after a move was observed (#1119)", async () => {
    // Pass 1 observes the generation move; pass 2 then fails. Falling back
    // to first.generation would hand out a stale token whose settle report
    // is rejected as a generation mismatch — the move was already observed,
    // so no unconfirmed token may ship.
    const row: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 7,
      issue: null,
      branch: "fix/x",
      url: "https://github.com/org/repo/pull/7",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["ci:1"],
      author: "bot",
      generation: 2,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: null,
      dispatchedGeneration: null,
      postDispatchEvidenceKeys: [],
    };
    mocks.prFixFindMany.mockResolvedValue([row]);
    let stampCount = 0;
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      stampCount += 1;
      if (stampCount === 2) throw new Error("db down");
      if (!matchesFirstHandOut(row, where)) return { count: 0 };
      applyUpdate(row, data);
      // A concurrent re-issue moves the row in the read→stamp gap.
      row.generation = 3;
      return { count: 1 };
    });
    mocks.prFixFindUnique.mockImplementation(async () => ({
      id: row.id,
      reason: row.reason,
      feedback: row.feedback,
      generation: row.generation,
    }));
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 99,
        title: "Regular issue",
        url: "https://github.com/org/repo/issues/99",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(stampCount).toBe(2);
    // Neither the stale generation 2 nor the un-stamped generation 3 ships;
    // the request falls through to issue work instead.
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(body.prFixItem).toBeUndefined();
  });

  it("still serves the pre-stamp token when the dispatch tracking stamp throws (#1119)", async () => {
    const item: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 7,
      issue: null,
      branch: "fix/x",
      url: "https://github.com/org/repo/pull/7",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["ci:1"],
      author: "bot",
      generation: 2,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: null,
      dispatchedGeneration: null,
      postDispatchEvidenceKeys: [],
    };
    mocks.prFixFindMany.mockResolvedValue([item]);
    mocks.prFixUpdateMany.mockRejectedValue(new Error("db down"));

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    // Best-effort: the task is served with the pre-stamp snapshot's
    // generation and reasons.
    expect(body.prFixItem).toEqual({ id: "prfix-1", generation: 2 });
    expect(body.reasons).toContain("CI failure on main");
    expect(body.reasons).toContain("update tests");
  });

  it("feeds the re-read row's fresh feedback into the task payload (#1119)", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 12,
        issue: null,
        branch: "fix/something",
        url: "https://github.com/org/repo/pull/12",
        title: "Fix something",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "CI failure on main",
        feedback: ["update tests"],
        evidenceKeys: ["ci:1"],
        author: "bot",
        generation: 2,
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    mocks.prFixUpdateMany.mockResolvedValue({ count: 1 });
    mocks.prFixFindUnique.mockResolvedValue({
      reason: "CI failure on main",
      feedback: ["update tests", "fix lint (enqueued after the hand-out read)"],
    });

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.prFixItem).toEqual({ id: "prfix-1", generation: 2 });
    expect(body.reasons).toContain("CI failure on main");
    expect(body.reasons).toContain("update tests");
    // Only present in the re-read row — proves the payload reasons come from
    // the fresh row, not the stale queue snapshot.
    expect(body.reasons).toContain("fix lint (enqueued after the hand-out read)");
  });

  it("includes linked issue context when PR-fix has an issue number", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 12,
        issue: 67,
        branch: "fix/issue-67",
        url: "https://github.com/org/repo/pull/12",
        title: "Fix issue 67",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "review changes requested",
        feedback: ["please update tests"],
        evidenceKeys: ["review:1"],
        author: "itsmiso-ai",
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.issue.repoFullName).toBe("org/repo");
    expect(body.issue.number).toBe(67);
  });

  it("includes both reason and feedback in reasons", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 12,
        issue: null,
        branch: "fix/something",
        url: "https://github.com/org/repo/pull/12",
        title: "Fix something",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "CI failure on main",
        feedback: ["update tests", "fix lint"],
        evidenceKeys: ["ci:1"],
        author: "bot",
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.reasons).toContain("CI failure on main");
    expect(body.reasons).toContain("update tests");
    expect(body.reasons).toContain("fix lint");
  });

  it("preserves lane filtering", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-normal",
        number: 10,
        title: "Normal issue",
        url: "https://github.com/org/repo/issues/10",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
      {
        id: "issue-escalated",
        number: 20,
        title: "Escalated issue",
        url: "https://github.com/org/repo/issues/20",
        labels: ["priority/p0", "status/ready"],
        currentLane: "frontier",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(10);
  });

  it("passes through includeClaimed behavior", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-claimed-other",
        number: 30,
        title: "Claimed by other agent",
        url: "https://github.com/org/repo/issues/30",
        labels: ["agent/other-agent", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("idle");
  });

  it("includes claimed issues when includeClaimed=true", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-claimed-other",
        number: 30,
        title: "Claimed by other agent",
        url: "https://github.com/org/repo/issues/30",
        labels: ["agent/other-agent", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local&includeClaimed=true"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(30);
  });

  it("does not require harness-specific fields", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 42,
        title: "Test issue",
        url: "https://github.com/org/repo/issues/42",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect("harness" in body).toBe(false);
    expect("workflowRepo" in body).toBe(false);
  });

  it("followup-pr task uses reason when feedback is empty", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 12,
        issue: null,
        branch: "fix/something",
        url: "https://github.com/org/repo/pull/12",
        title: "Fix something",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "CI failure on main",
        feedback: [],
        evidenceKeys: ["ci:1"],
        author: "bot",
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.reasons).toEqual(["CI failure on main"]);
  });

  it("does not mutate issue or claim state", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 42,
        title: "Test issue",
        url: "https://github.com/org/repo/issues/42",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(mocks.issueFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ state: "open" }),
      }),
    );
  });

  // Linked PR follow-up tests

  it("returns followup-pr when issue has linked PR needing follow-up", async () => {
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, {
        title: "Fix login bug",
        linkedPrFollowupReasons: ["tests failing", "lint errors"],
        linkedPrReviewDecision: null,
      }),
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.shouldRun).toBe(true);
    expect(body.prFixItem).toEqual({ id: "linked-prfix", generation: 1 });
    expect(mocks.prFixCreate).toHaveBeenCalledTimes(1);
    expect(mocks.prFixHistoryCreate).toHaveBeenCalledTimes(1);
  });

  it("the PR-fix queue owns a linked PR that also qualifies as a queued issue", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "existing-prfix",
        repo: "org/repo",
        pr: 15,
        issue: 42,
        branch: null,
        url: "https://github.com/org/repo/pull/15",
        title: "Existing queued work",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "review changes requested",
        feedback: ["update tests"],
        evidenceKeys: ["review:1"],
        agentHandouts: [],
        generation: 3,
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 15)]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.prFixItem).toEqual({ id: "existing-prfix", generation: 3 });
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
    expect(mocks.fetchPullRequestLabels).not.toHaveBeenCalled();
  });

  it("linked-only work is materialized once and handout identity is not repeated", async () => {
    mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 15)]);

    const first = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const firstBody = await first.json();
    expect(firstBody.type).toBe("followup-pr");
    expect(firstBody.prFixItem).toEqual({ id: "linked-prfix", generation: 1 });
    expect(mocks.prFixHistoryCreate).toHaveBeenCalledTimes(1);

    const second = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    // The queue owns the PR now, so the issue is not re-served as implement work.
    expect((await second.json()).type).toBe("idle");
    expect(mocks.fetchPullRequestLabels).toHaveBeenCalledTimes(1);
    expect(mocks.prFixCreate).toHaveBeenCalledTimes(1);
    expect(mocks.prFixHistoryCreate).toHaveBeenCalledTimes(1);
    expect(mocks.prFixUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "linked-prfix", generation: 1, status: "QUEUED" },
      data: { agentHandouts: { push: ["example-agent@1"] } },
    }));
  });

  it.each(
    ["QUEUED", "BLOCKED", "FIXED", "IGNORED", "STALE"].flatMap((status) =>
      ["NORMAL", "ESCALATED", "NEEDS_HUMAN"].map((lane) => [status, lane]),
    ),
  )("linked path defers to existing %s/%s queue row and does not hand the issue out as implement work", async (status, lane) => {
    mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 15), independentIssue(99)]);
    mocks.linkedRows.push({ repo: "org/repo", pr: 15, status, lane });

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const body = await res.json();
    // The next independent issue, never the deferred linked one (#1145).
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
    expect(mocks.fetchPullRequestLabels).not.toHaveBeenCalled();
  });

  it.each(["QUEUED", "BLOCKED", "FIXED", "IGNORED", "STALE"])(
    "idles rather than re-serving a deferred linked issue (%s row) as implement work",
    async (status) => {
      mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 15)]);
      mocks.linkedRows.push({ repo: "org/repo", pr: 15, status, lane: "NEEDS_HUMAN" });

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );
      const body = await res.json();
      expect(body.type).toBe("idle");
      expect(body.shouldRun).toBe(false);
      expect(body.reason).toContain("deferred");
    },
  );

  it("does not dispatch or mutate a concurrent queue winner during linked materialization", async () => {
    const winner = {
      id: "concurrent-prfix",
      repo: "org/repo",
      pr: 15,
      issue: 7,
      lane: "ESCALATED",
      status: "BLOCKED",
      generation: 4,
      reason: "operator blocked",
      feedback: ["wait for approval"],
      agentHandouts: [],
    };
    mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 15), independentIssue(99)]);
    mocks.prFixCreate.mockRejectedValue(Object.assign(new Error("unique constraint"), { code: "P2002" }));
    mocks.prFixFindUniqueByRepo.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    mocks.linkedRows.push(winner);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const raceBody = await res.json();
    expect(raceBody.type).toBe("implement");
    expect(raceBody.issue.number).toBe(99);
    expect(mocks.prFixCreate).toHaveBeenCalledTimes(1);
    expect(mocks.prFixHistoryCreate).not.toHaveBeenCalled();
    expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
    expect(winner).toMatchObject({ status: "BLOCKED", generation: 4, lane: "ESCALATED", agentHandouts: [] });
  });

  it("does not create linked follow-up for a PR with the needs-human label, and serves the next issue", async () => {
    mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 15), independentIssue(99)]);
    mocks.fetchPullRequestLabels.mockResolvedValue(["needs-human"]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
  });

  it("defers the issue when the needs-human label read is unavailable, and serves the next issue", async () => {
    // A transient GitHub failure must not fail the verdict open: the PR may be
    // human-blocked, so the issue is not eligible for implement pickup either.
    mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 15), independentIssue(99)]);
    mocks.fetchPullRequestLabels.mockResolvedValue(null);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
  });

  it("idles when the label read is unavailable and the linked issue is the only ready work", async () => {
    mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 15)]);
    mocks.fetchPullRequestLabels.mockResolvedValue(null);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("idle");
    expect(body.reason).toContain("deferred");
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
  });

  it("continues to the next linked PR when the first cannot be materialized", async () => {
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15),
      linkedIssue(43, 16, { id: "issue-43", number: 43, title: "Second issue", url: "https://github.com/org/repo/issues/43" }),
    ]);
    mocks.linkedRows.push({ repo: "org/repo", pr: 15, status: "BLOCKED", lane: "NEEDS_HUMAN" });
    mocks.prFixCreate.mockImplementation(async ({ data }: any) => {
      const item = { id: "linked-prfix-2", generation: 1, status: "QUEUED", agentHandouts: [], ...data };
      mocks.linkedRows.push(item);
      return item;
    });

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.pullRequest.number).toBe(16);
    expect(body.prFixItem).toEqual({ id: "linked-prfix-2", generation: 1 });
  });

  it("materializes linked-only work for a lane without a PR-fix equivalent, without handing it to that lane", async () => {
    // "cloud" is claimable but carries no role, so prFixLaneForRequest returns
    // null: discovered work must still converge onto the queue (NORMAL) so a
    // capable lane picks it up, rather than being silently dropped. The cloud
    // caller itself must not consume PR-fix work (#1046).
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, { currentLane: "cloud" }),
      independentIssue(99, { currentLane: "cloud" }),
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=cloud"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    // The linked issue is queue-owned; the caller drains to its next issue.
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(mocks.prFixCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lane: "NORMAL", status: "QUEUED" }),
    }));
    expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
  });

  it("records the discovered head as the attempt baseline when materializing linked work", async () => {
    mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 15)]);
    mocks.fetchPullRequestHeadSha.mockResolvedValue("b".repeat(40));

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect((await res.json()).type).toBe("followup-pr");
    expect(mocks.prFixCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ headSha: "b".repeat(40), attemptHeadSha: "b".repeat(40) }),
    }));
  });

  it("does not fail the poll when linked materialization errors, and still serves the next candidate", async () => {
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15),
      linkedIssue(43, 16, { id: "issue-43", number: 43, title: "Second issue", url: "https://github.com/org/repo/issues/43" }),
      independentIssue(99),
    ]);
    mocks.prFixCreate
      .mockRejectedValueOnce(Object.assign(new Error("db down"), { code: "P2024" }))
      .mockImplementation(async ({ data }: any) => {
        const item = { id: "linked-prfix-2", generation: 1, status: "QUEUED", agentHandouts: [], ...data };
        mocks.linkedRows.push(item);
        return item;
      });

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.pullRequest.number).toBe(16);
  });

  it("defers a linked issue whose PR has a queue row even when cached health says no follow-up", async () => {
    // The cached health column is refreshed on a reconcile cadence and can lag
    // the queue row's creation. A false value must not let the issue through to
    // implement pickup on a PR the queue is holding back (BLOCKED rows are not
    // in the pr-fix list, so nothing else would stop it).
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, { linkedPrNeedsFollowup: false, linkedPrFollowupReasons: [] }),
      independentIssue(99),
    ]);
    mocks.linkedRows.push({ repo: "org/repo", pr: 15, status: "BLOCKED", lane: "NEEDS_HUMAN" });

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
  });

  it("still serves implement work for a linked PR that needs no follow-up and has no queue row", async () => {
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, { linkedPrNeedsFollowup: false, linkedPrFollowupReasons: [] }),
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(42);
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
    expect(mocks.fetchPullRequestLabels).not.toHaveBeenCalled();
  });

  it("finds an existing queue row when the issue cache's repo casing differs from the queue key", async () => {
    // Queue rows are stored under a case-folded repo; the issue cache is not
    // normalized against them, so the identity lookup must fold too (#1145).
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, { repository: { fullName: "Org/Repo" } }),
      independentIssue(99, { repository: { fullName: "Org/Repo" } }),
    ]);
    mocks.linkedRows.push({ repo: "org/repo", pr: 15, status: "BLOCKED", lane: "NEEDS_HUMAN" });

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
  });

  it("linked PR follow-up beats normal implement work", async () => {
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, { title: "Issue with PR needing follow-up", linkedPrFollowupReasons: ["needs changes"] }),
      {
        id: "issue-normal",
        number: 99,
        title: "Normal issue",
        url: "https://github.com/org/repo/issues/99",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
        linkedPrNumber: null,
        linkedPrUrl: null,
        linkedPrNeedsFollowup: false,
        linkedPrFollowupReasons: [],
        linkedPrReviewDecision: null,
        linkedPrMergeState: null,
        linkedPrHealthCheckedAt: null,
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.pullRequest.number).toBe(15);
  });

  it("PR-fix queue item still beats linked PR follow-up", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 12,
        issue: null,
        branch: "fix/something",
        url: "https://github.com/org/repo/pull/12",
        title: "Fix something",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "review changes requested",
        feedback: ["update tests"],
        evidenceKeys: ["review:1"],
        author: "bot",
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-followup",
        number: 42,
        title: "Issue with PR needing follow-up",
        url: "https://github.com/org/repo/issues/42",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
        linkedPrNumber: 15,
        linkedPrUrl: "https://github.com/org/repo/pull/15",
        linkedPrNeedsFollowup: true,
        linkedPrFollowupReasons: ["needs changes"],
        linkedPrReviewDecision: null,
        linkedPrMergeState: null,
        linkedPrHealthCheckedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.pullRequest.number).toBe(12);
  });

  it("linked PR follow-up includes issue context", async () => {
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, { title: "Fix login bug", linkedPrFollowupReasons: ["needs changes"] }),
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.issue.repoFullName).toBe("org/repo");
    expect(body.issue.number).toBe(42);
    expect(body.issue.title).toBe("Fix login bug");
    expect(body.issue.url).toBe("https://github.com/org/repo/issues/42");
  });

  it("linked PR follow-up includes pull request context", async () => {
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, { title: "Fix login bug", linkedPrFollowupReasons: ["needs changes"] }),
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.pullRequest.repoFullName).toBe("org/repo");
    expect(body.pullRequest.number).toBe(15);
    expect(body.pullRequest.url).toBe("https://github.com/org/repo/pull/15");
  });

  it("linked PR follow-up uses followup reasons", async () => {
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, { linkedPrFollowupReasons: ["tests failing", "lint errors", "missing docs"] }),
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.reasons).toContain("tests failing");
    expect(body.reasons).toContain("lint errors");
    expect(body.reasons).toContain("missing docs");
  });

  it("missing followup reasons uses fallback reason", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 42,
        title: "Fix login bug",
        url: "https://github.com/org/repo/issues/42",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
        linkedPrNumber: 15,
        linkedPrUrl: "https://github.com/org/repo/pull/15",
        linkedPrNeedsFollowup: true,
        linkedPrFollowupReasons: [],
        linkedPrReviewDecision: null,
        linkedPrMergeState: null,
        linkedPrHealthCheckedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.reasons).toEqual(["Linked PR needs follow-up"]);
  });

  it("normal issue still returns implement when no follow-up exists", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 42,
        title: "Fix login bug",
        url: "https://github.com/org/repo/issues/42",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
        linkedPrNumber: null,
        linkedPrUrl: null,
        linkedPrNeedsFollowup: false,
        linkedPrFollowupReasons: [],
        linkedPrReviewDecision: null,
        linkedPrMergeState: null,
        linkedPrHealthCheckedAt: null,
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(42);
  });

  it("idle still works when queue is empty", async () => {
    mocks.issueFindMany.mockResolvedValue([]);

    const res = await GET(
      request("/api/agents/example-agent/next-task"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("idle");
    expect(body.shouldRun).toBe(false);
  });

  // ─── Worker idle read-only tests ─────────────────────────────────────

  describe("worker idle is read-only", () => {
    it("empty issue queue returns idle with shouldRun false", async () => {
      mocks.issueFindMany.mockResolvedValue([]);
      mocks.prFixFindMany.mockResolvedValue([]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("idle");
      expect(body.shouldRun).toBe(false);
    });

    it("empty PR-fix queue returns idle with shouldRun false", async () => {
      mocks.issueFindMany.mockResolvedValue([]);
      mocks.prFixFindMany.mockResolvedValue([]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("idle");
      expect(body.shouldRun).toBe(false);
    });

    it("idle reason is a short non-empty string", async () => {
      mocks.issueFindMany.mockResolvedValue([]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      const body = await res.json();
      expect(typeof body.reason).toBe("string");
      expect(body.reason.length).toBeGreaterThan(0);
      expect(body.reason.length).toBeLessThan(200);
    });

    it("idle check does not mutate issues", async () => {
      mocks.issueFindMany.mockResolvedValue([]);

      await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      expect(mocks.issueFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ state: "open" }),
        }),
      );
    });

    it("idle check does not mutate PR-fix queue", async () => {
      mocks.issueFindMany.mockResolvedValue([]);
      mocks.prFixFindMany.mockResolvedValue([]);

      await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      // listQueuedPrFixItems reads via prisma.prFixQueueItem.findMany
      // An idle check must not create, update, or delete any PR-fix queue items
      expect(mocks.prFixFindMany).toHaveBeenCalled();
    });

    it("idle check does not mutate leases", async () => {
      mocks.issueFindMany.mockResolvedValue([]);

      await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      // findLeasedIssueIds is a read-only query; no lease mutations should occur
      expect(mocks.findLeasedIssueIds).toHaveBeenCalledWith("example-agent");
    });
  });

  // ─── Retired external grooming mode ────────────────────────────────
  describe("retired mode=groom", () => {
    it("returns 410 for maintainer tokens without queue, issue, or lease reads", async () => {
      const res = await GET(request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) });
      expect(res.status).toBe(410);
      expect((await res.json()).error).toContain("retired");
      expect(mocks.issueFindMany).not.toHaveBeenCalled();
      expect(mocks.prFixFindMany).not.toHaveBeenCalled();
      expect(mocks.findLeasedIssueIds).not.toHaveBeenCalled();
    });

    it("returns 410 for worker-tier bearer tokens", async () => {
      const res = await GET(authedRequest("http://localhost/api/agents/worker/next-task?mode=groom", { token: "test-worker-token" }),
        { params: Promise.resolve({ agentName: "worker" }) });
      expect(res.status).toBe(410);
      expect(mocks.issueFindMany).not.toHaveBeenCalled();
      expect(mocks.prFixFindMany).not.toHaveBeenCalled();
    });
  });

  // ─── PR-fix lane filter tests ──────────────────────────────────────────

  describe("PR-fix lane filter (#1046)", () => {
    function prFixStore(items: any[]) {
      mocks.prFixFindMany.mockImplementation(async ({ where }: any) => {
        let result = items.slice();
        if (where?.status) {
          result = Array.isArray(where.status.in)
            ? result.filter((i) => where.status.in.includes(i.status))
            : result.filter((i) => i.status === where.status);
        }
        if (where?.lane) result = result.filter((i) => i.lane === where.lane);
        return result;
      });
    }
    function prFixItem(id: string, lane: string, extra: Record<string, unknown> = {}) {
      return {
        id, repo: "org/repo", pr: 12, issue: null, branch: "fix/x",
        url: "https://github.com/org/repo/pull/12", title: "Fix", lane,
        status: "QUEUED", reason: "review changes requested", feedback: [],
        evidenceKeys: ["review:1"], author: "bot", generation: 1,
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        ...extra,
      };
    }

    it("serves NORMAL PR-fix work for a normal configured lane", async () => {
      prFixStore([prFixItem("prfix-1", "NORMAL")]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.type).toBe("followup-pr");
      expect(body.pullRequest.number).toBe(12);
      expect(mocks.prFixFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ lane: "NORMAL" }),
        }),
      );
    });

    it("does not coerce a normal lane to NEEDS_HUMAN", async () => {
      prFixStore([prFixItem("prfix-nh", "NEEDS_HUMAN")]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("idle");
      expect(mocks.prFixFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ lane: "NORMAL" }),
        }),
      );
    });

    it("resolves an alias lane to NORMAL PR-fix work", async () => {
      prFixStore([prFixItem("prfix-1", "NORMAL")]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=normal"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.type).toBe("followup-pr");
    });

    it("routes escalation lane to ESCALATED PR-fix work", async () => {
      prFixStore([prFixItem("prfix-e", "ESCALATED")]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=frontier"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.type).toBe("followup-pr");
    });

    it("backlog and custom no-role lanes do not pick up PR-fix work", async () => {
      for (const lane of ["backlog", "cloud"]) {
        vi.clearAllMocks();
        prFixStore([prFixItem("prfix-n", "NORMAL"), prFixItem("prfix-e", "ESCALATED")]);
        mocks.issueFindMany.mockResolvedValue([]);
        mocks.findLeasedIssueIds.mockResolvedValue([]);

        const res = await GET(
          request(`/api/agents/example-agent/next-task?lane=${lane}`),
          { params: Promise.resolve({ agentName: "example-agent" }) },
        );

        expect(res.status).toBe(200);
        expect((await res.json()).type).toBe("idle");
        expect(mocks.prFixFindMany).not.toHaveBeenCalled();
      }
    });

    it("escalation lane does not pick up NORMAL PR-fix work", async () => {
      prFixStore([prFixItem("prfix-1", "NORMAL")]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=frontier"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.type).toBe("idle");
      expect(mocks.prFixFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ lane: "ESCALATED" }),
        }),
      );
    });

    it("returns 400 for an unknown lane", async () => {
      prFixStore([prFixItem("prfix-1", "NORMAL")]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=definitely-not-a-lane"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid lane");
      expect(mocks.prFixFindMany).not.toHaveBeenCalled();
    });
  });

  // ─── Auth tests ──────────────────────────────────────────────────

  describe("auth", () => {
    it("returns 401 when no authorization header is provided", async () => {
      const res = await GET(
        request("/api/agents/example-agent/next-task", "example-agent", false),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 when bearer token is wrong", async () => {
      const res = await GET(
        new Request("http://localhost/api/agents/example-agent/next-task", {
          headers: { Authorization: "Bearer wrong-token" },
        }),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );
      expect(res.status).toBe(401);
    });

    it("allows normal worker next-task with valid bearer token", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          id: "issue-1",
          number: 42,
          title: "Fix login bug",
          url: "https://github.com/org/repo/issues/42",
          labels: ["priority/p0", "status/ready"],
          currentLane: "local",
          decomposed: false,
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.type).toBe("implement");
      expect(body.issue.number).toBe(42);
    });

    it("unauthorized normal request does not call pr-fix, issues, or leases", async () => {
      const res = await GET(
        request("/api/agents/example-agent/next-task", "example-agent", false),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      expect(res.status).toBe(401);
      expect(mocks.issueFindMany).not.toHaveBeenCalled();
      expect(mocks.prFixFindMany).not.toHaveBeenCalled();
      expect(mocks.findLeasedIssueIds).not.toHaveBeenCalled();
    });

    it("unauthorized groom request does not call issues, pr-fix, or leases", async () => {
      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom", "groomer", false),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      expect(res.status).toBe(401);
      expect(mocks.issueFindMany).not.toHaveBeenCalled();
      expect(mocks.prFixFindMany).not.toHaveBeenCalled();
      expect(mocks.findLeasedIssueIds).not.toHaveBeenCalled();
    });
  });
});

describe("GET /api/agents/[agentName]/next-task — bound worker scope (#1129)", () => {
  it("denies a bound worker requesting another agent's task", async () => {
    const res = await GET(
      authedRequest("http://localhost/api/agents/bravo/next-task", { token: "bound-token" }),
      { params: Promise.resolve({ agentName: "bravo" }) },
    );
    expect(res.status).toBe(403);
  });

  it("denies an unbound legacy worker token", async () => {
    const res = await GET(
      authedRequest("http://localhost/api/agents/alpha/next-task", { token: "test-worker-token" }),
      { params: Promise.resolve({ agentName: "alpha" }) },
    );
    expect(res.status).toBe(403);
  });
});
