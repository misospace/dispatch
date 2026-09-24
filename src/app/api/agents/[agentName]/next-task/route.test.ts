import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks } = vi.hoisted(() => ({
  mocks: {
    issueFindMany: vi.fn(),
    prFixFindMany: vi.fn(),
    findLeasedIssueIds: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.issueFindMany },
    prFixQueueItem: { findMany: mocks.prFixFindMany },
  },
  asPrFixQueueClient: (client: any) => client,
}));

vi.mock("@/lib/lease", () => ({
  findLeasedIssueIds: mocks.findLeasedIssueIds,
}));

// The production queue-mutation functions (enqueue/mark/requeue) surface
// outcomes to GitHub; no-op them so route-level lifecycle tests can drive the
// real state machine without network.
vi.mock("@/lib/pr-fix-surfacing", () => ({
  surfacePrFixBlocked: vi.fn().mockResolvedValue({ labelApplied: false, commentPosted: false, errors: [] }),
  surfacePrFixRequeued: vi.fn().mockResolvedValue({ labelRemoved: false, commentUpdated: false, errors: [] }),
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
        items.find((i) => i.repo === where.repo_pr.repo && i.pr === where.repo_pr.pr) ?? null,
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

function request(url: string, agentName = "example-agent", includeAuth = true) {
  return authedRequest(`http://localhost${url}`, { includeAuth });
}

describe("GET /api/agents/[agentName]/next-task", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.prFixFindMany.mockResolvedValue([]);
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
        linkedPrFollowupReasons: ["tests failing", "lint errors"],
        linkedPrReviewDecision: null,
        linkedPrMergeState: null,
        linkedPrHealthCheckedAt: new Date("2026-01-01T00:00:00Z"),
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
    expect(body.prFixItem).toBeUndefined();
  });

  it("linked PR follow-up beats normal implement work", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-followup",
        number: 42,
        title: "Issue with PR needing follow-up",
        url: "https://github.com/org/repo/issues/42",
        labels: ["priority/p1", "status/ready"],
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
    expect(body.issue.repoFullName).toBe("org/repo");
    expect(body.issue.number).toBe(42);
    expect(body.issue.title).toBe("Fix login bug");
    expect(body.issue.url).toBe("https://github.com/org/repo/issues/42");
  });

  it("linked PR follow-up includes pull request context", async () => {
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
    expect(body.pullRequest.repoFullName).toBe("org/repo");
    expect(body.pullRequest.number).toBe(15);
    expect(body.pullRequest.url).toBe("https://github.com/org/repo/pull/15");
  });

  it("linked PR follow-up uses followup reasons", async () => {
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
        linkedPrFollowupReasons: ["tests failing", "lint errors", "missing docs"],
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

  // ─── Groom mode tests ──────────────────────────────────────────────

  describe("mode=groom", () => {
    it("default next-task behavior is unchanged when mode is absent", async () => {
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

      const body = await res.json();
      expect(body.type).toBe("implement");
      expect(body.issue.number).toBe(42);
    });

    it("mode=groom returns one groom task", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 10,
          title: "Unlabeled issue",
          url: "https://github.com/org/repo/issues/10",
          labels: [],
          currentLane: null,
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("groom");
      expect(body.shouldRun).toBe(true);
      expect(body.agentName).toBe("groomer");
    });

    it("unlabeled issue is eligible", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 10,
          title: "Unlabeled issue",
          url: "https://github.com/org/repo/issues/10",
          labels: [],
          currentLane: null,
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("groom");
      expect(body.issue.number).toBe(10);
    });

    it("issue missing status is eligible", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 20,
          title: "Missing status",
          url: "https://github.com/org/repo/issues/20",
          labels: ["priority/p1"],
          currentLane: "local",
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("groom");
      expect(body.issue.number).toBe(20);
    });

    it("issue missing priority is eligible", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 30,
          title: "Missing priority",
          url: "https://github.com/org/repo/issues/30",
          labels: ["status/ready"],
          currentLane: "local",
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("groom");
      expect(body.issue.number).toBe(30);
    });

    it("backlog lane issue is eligible", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 40,
          title: "Backlog issue",
          url: "https://github.com/org/repo/issues/40",
          labels: ["status/backlog", "priority/p2"],
          currentLane: "backlog",
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("groom");
      expect(body.issue.number).toBe(40);
    });

    it("fully labeled issue with lane is not eligible", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 50,
          title: "Fully labeled",
          url: "https://github.com/org/repo/issues/50",
          labels: ["status/ready", "priority/p0", "agent/alice"],
          currentLane: "local",
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("idle");
      expect(body.reason).toBe("No grooming work available");
    });

    it("closed issues are excluded", async () => {
      mocks.issueFindMany.mockResolvedValue([]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      expect(mocks.issueFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ state: "open" }),
        }),
      );
      const body = await res.json();
      expect(body.type).toBe("idle");
    });

    it("disabled repo issues are excluded", async () => {
      mocks.issueFindMany.mockResolvedValue([]);

      await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      expect(mocks.issueFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ repository: { enabled: true } }),
        }),
      );
    });

    it("no candidates returns idle", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 50,
          title: "Fully labeled",
          url: "https://github.com/org/repo/issues/50",
          labels: ["status/ready", "priority/p0", "agent/alice"],
          currentLane: "local",
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("idle");
      expect(body.shouldRun).toBe(false);
      expect(body.reason).toBe("No grooming work available");
    });

    it("groom mode does not claim or mutate anything", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 10,
          title: "Unlabeled issue",
          url: "https://github.com/org/repo/issues/10",
          labels: [],
          currentLane: null,
          repository: { fullName: "org/repo" },
        },
      ]);

      await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      expect(mocks.issueFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ state: "open" }),
        }),
      );
    });

    it("groom mode returns one object, not an array", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 10,
          title: "Unlabeled issue",
          url: "https://github.com/org/repo/issues/10",
          labels: [],
          currentLane: null,
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect(Array.isArray(body)).toBe(false);
      expect(body.type).toBe("groom");
    });

    it("groom mode does not require harness-specific fields", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 10,
          title: "Unlabeled issue",
          url: "https://github.com/org/repo/issues/10",
          labels: [],
          currentLane: null,
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect("harness" in body).toBe(false);
      expect("workflowRepo" in body).toBe(false);
    });

    it("prefers unlabeled issues over partially labeled", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 20,
          title: "Missing status",
          url: "https://github.com/org/repo/issues/20",
          labels: ["priority/p1"],
          currentLane: "local",
          repository: { fullName: "org/repo" },
        },
        {
          number: 10,
          title: "Unlabeled issue",
          url: "https://github.com/org/repo/issues/10",
          labels: [],
          currentLane: null,
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("groom");
      expect(body.issue.number).toBe(10);
    });

    it("prefers missing status over missing priority", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 30,
          title: "Missing priority",
          url: "https://github.com/org/repo/issues/30",
          labels: ["status/ready"],
          currentLane: "local",
          repository: { fullName: "org/repo" },
        },
        {
          number: 20,
          title: "Missing status",
          url: "https://github.com/org/repo/issues/20",
          labels: ["priority/p1"],
          currentLane: "local",
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("groom");
      expect(body.issue.number).toBe(20);
    });

    it("prefers lowest issue number as tie breaker", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 30,
          title: "Also unlabeled",
          url: "https://github.com/org/repo/issues/30",
          labels: [],
          currentLane: null,
          repository: { fullName: "org/repo" },
        },
        {
          number: 10,
          title: "Unlabeled issue",
          url: "https://github.com/org/repo/issues/10",
          labels: [],
          currentLane: null,
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("groom");
      expect(body.issue.number).toBe(10);
    });

    it("includes issue context in groom task", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 10,
          title: "Unlabeled issue",
          url: "https://github.com/org/repo/issues/10",
          labels: [],
          currentLane: null,
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("groom");
      expect(body.issue.repoFullName).toBe("org/repo");
      expect(body.issue.number).toBe(10);
      expect(body.issue.title).toBe("Unlabeled issue");
      expect(body.issue.url).toBe("https://github.com/org/repo/issues/10");
    });

    it("includes lane in groom task when available", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 40,
          title: "Backlog issue",
          url: "https://github.com/org/repo/issues/40",
          labels: ["status/backlog", "priority/p2"],
          currentLane: "backlog",
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("groom");
      expect(body.lane).toBe("backlog");
    });

    it("defaults lane to backlog when currentLane is null", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 10,
          title: "Unlabeled issue",
          url: "https://github.com/org/repo/issues/10",
          labels: [],
          currentLane: null,
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("groom");
      expect(body.lane).toBe("backlog");
    });

    // ─── Groom idle read-only tests ──────────────────────────────────────

    it("groom idle with no candidates returns shouldRun false", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 50,
          title: "Fully labeled",
          url: "https://github.com/org/repo/issues/50",
          labels: ["status/ready", "priority/p0", "agent/alice"],
          currentLane: "local",
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("idle");
      expect(body.shouldRun).toBe(false);
    });

    it("groom idle reason is 'No grooming work available'", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 50,
          title: "Fully labeled",
          url: "https://github.com/org/repo/issues/50",
          labels: ["status/ready", "priority/p0", "agent/alice"],
          currentLane: "local",
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect(body.reason).toBe("No grooming work available");
    });

    it("groom idle does not mutate issues", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 50,
          title: "Fully labeled",
          url: "https://github.com/org/repo/issues/50",
          labels: ["status/ready", "priority/p0", "agent/alice"],
          currentLane: "local",
          repository: { fullName: "org/repo" },
        },
      ]);

      await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      expect(mocks.issueFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ state: "open" }),
        }),
      );
    });

    it("groom idle does not mutate PR-fix queue", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 50,
          title: "Fully labeled",
          url: "https://github.com/org/repo/issues/50",
          labels: ["status/ready", "priority/p0", "agent/alice"],
          currentLane: "local",
          repository: { fullName: "org/repo" },
        },
      ]);

      await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      // Groom mode does not query the PR-fix queue at all
      expect(mocks.prFixFindMany).not.toHaveBeenCalled();
    });

    it("groom idle does not mutate leases", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 50,
          title: "Fully labeled",
          url: "https://github.com/org/repo/issues/50",
          labels: ["status/ready", "priority/p0", "agent/alice"],
          currentLane: "local",
          repository: { fullName: "org/repo" },
        },
      ]);

      await GET(
        request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      // Groom mode does not query leases at all
      expect(mocks.findLeasedIssueIds).not.toHaveBeenCalled();
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

    it("escalation lane does not pick up NORMAL PR-fix work", async () => {
      prFixStore([prFixItem("prfix-1", "NORMAL")]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=frontier"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

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

    it("allows mode=groom with valid bearer token", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          number: 10,
          title: "Unlabeled issue",
          url: "https://github.com/org/repo/issues/10",
          labels: [],
          currentLane: null,
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom", "groomer"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.type).toBe("groom");
      expect(body.issue.number).toBe(10);
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
