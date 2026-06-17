import { describe, expect, it, vi, beforeEach } from "vitest";

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

import { GET } from "./route";

describe("GET /api/agents/[agentName]/next-task", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prFixFindMany.mockResolvedValue([]);
    mocks.issueFindMany.mockResolvedValue([]);
    mocks.findLeasedIssueIds.mockResolvedValue([]);
  });

  it("returns idle when the queue is empty", async () => {
    const res = await GET(
      new Request("http://localhost/api/agents/example-agent/next-task"),
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
      new Request("http://localhost/api/agents/example-agent/next-task"),
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
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
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
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
      {
        id: "issue-2",
        number: 43,
        title: "Second issue",
        url: "https://github.com/org/repo/issues/43",
        labels: ["priority/p1", "status/ready"],
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
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
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
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
    expect(Array.isArray(body.reasons)).toBe(true);
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
      new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
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
      new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
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
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
      {
        id: "issue-escalated",
        number: 20,
        title: "Escalated issue",
        url: "https://github.com/org/repo/issues/20",
        labels: ["priority/p0", "status/ready"],
        currentLane: "escalated",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
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
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
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
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      new Request(
        "http://localhost/api/agents/example-agent/next-task?lane=normal&includeClaimed=true",
      ),
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
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
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
      new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
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
        currentLane: "normal",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    await GET(
      new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
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
        currentLane: "normal",
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
      new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.shouldRun).toBe(true);
  });

  it("linked PR follow-up beats normal implement work", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-followup",
        number: 42,
        title: "Issue with PR needing follow-up",
        url: "https://github.com/org/repo/issues/42",
        labels: ["priority/p1", "status/ready"],
        currentLane: "normal",
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
        currentLane: "normal",
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
      new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
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
        currentLane: "normal",
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
      new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
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
        currentLane: "normal",
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
      new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
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
        currentLane: "normal",
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
      new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
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
        currentLane: "normal",
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
      new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
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
        currentLane: "normal",
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
      new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
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
        currentLane: "normal",
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
      new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(42);
  });

  it("idle still works when queue is empty", async () => {
    mocks.issueFindMany.mockResolvedValue([]);

    const res = await GET(
      new Request("http://localhost/api/agents/example-agent/next-task"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("idle");
    expect(body.shouldRun).toBe(false);
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
          currentLane: "normal",
          decomposed: false,
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        new Request("http://localhost/api/agents/example-agent/next-task?lane=normal"),
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
        new Request("http://localhost/api/agents/groomer/next-task?mode=groom"),
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
        new Request("http://localhost/api/agents/groomer/next-task?mode=groom"),
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
          currentLane: "normal",
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        new Request("http://localhost/api/agents/groomer/next-task?mode=groom"),
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
          currentLane: "normal",
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        new Request("http://localhost/api/agents/groomer/next-task?mode=groom"),
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
        new Request("http://localhost/api/agents/groomer/next-task?mode=groom"),
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
          currentLane: "normal",
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        new Request("http://localhost/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("idle");
      expect(body.reason).toBe("No grooming work available");
    });

    it("closed issues are excluded", async () => {
      mocks.issueFindMany.mockResolvedValue([]);

      const res = await GET(
        new Request("http://localhost/api/agents/groomer/next-task?mode=groom"),
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
        new Request("http://localhost/api/agents/groomer/next-task?mode=groom"),
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
          currentLane: "normal",
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        new Request("http://localhost/api/agents/groomer/next-task?mode=groom"),
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
        new Request("http://localhost/api/agents/groomer/next-task?mode=groom"),
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
        new Request("http://localhost/api/agents/groomer/next-task?mode=groom"),
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
        new Request("http://localhost/api/agents/groomer/next-task?mode=groom"),
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
          currentLane: "normal",
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
        new Request("http://localhost/api/agents/groomer/next-task?mode=groom"),
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
          currentLane: "normal",
          repository: { fullName: "org/repo" },
        },
        {
          number: 20,
          title: "Missing status",
          url: "https://github.com/org/repo/issues/20",
          labels: ["priority/p1"],
          currentLane: "normal",
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        new Request("http://localhost/api/agents/groomer/next-task?mode=groom"),
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
        new Request("http://localhost/api/agents/groomer/next-task?mode=groom"),
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
        new Request("http://localhost/api/agents/groomer/next-task?mode=groom"),
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
        new Request("http://localhost/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("groom");
      expect(body.lane).toBe("backlog");
    });
  });
});
