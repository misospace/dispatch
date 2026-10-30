import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findManyIssues: vi.fn().mockResolvedValue([]),
    findManyRepos: vi.fn().mockResolvedValue([]),
    aggregateIssues: vi.fn().mockResolvedValue({ _count: { _all: 0 }, _max: { lastSyncedAt: null } }),
    getTrackedRepos: vi.fn().mockResolvedValue([]),
    filterBar: vi.fn(() => null),
    findUniqueAutomationRepo: vi.fn().mockResolvedValue(null),
    countWorkflowRuns: vi.fn().mockResolvedValue(0),
    releasePulseStrip: vi.fn(() => null),
    collectReleasePulse: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.findManyIssues, aggregate: mocks.aggregateIssues },
    repository: { findMany: mocks.findManyRepos },
    automationRepo: { findUnique: mocks.findUniqueAutomationRepo },
    githubWorkflowRun: { count: mocks.countWorkflowRuns },
  },
}));

// The strip derivation must not touch the issue/event queries the board's
// own assertions index into — stub the reader with a deterministic snapshot.
vi.mock("@/lib/release-pulse-read", () => ({
  asReleaseDeltaState: (value: string) => value,
  collectReleasePulse: mocks.collectReleasePulse,
}));
vi.mock("@/components/automation/release-pulse", () => ({
  ReleasePulseStrip: mocks.releasePulseStrip,
}));

vi.mock("@/lib/config", () => ({
  getTrackedRepos: mocks.getTrackedRepos,
  parseExcludedLabels: vi.fn().mockReturnValue([]),
}));

// Components render to React elements but are not deep-rendered here.
vi.mock("@/components/kanban-board", () => ({ KanbanBoard: () => null }));
vi.mock("@/components/filter-bar", () => ({ FilterBar: mocks.filterBar }));
vi.mock("@/components/sync-issues-button", () => ({ SyncIssuesButton: () => null }));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: unknown }) => children,
  CardContent: ({ children }: { children: unknown }) => children,
}));

import BoardPage from "./page";
import { KanbanBoardClient } from "./kanban-board-client";

function findElementByType(node: React.ReactNode, type: unknown): React.ReactElement | null {
  if (!React.isValidElement(node)) return null;
  if (node.type === type) return node;

  const props = node.props as { children?: React.ReactNode };
  const children = React.Children.toArray(props.children);

  for (const child of children) {
    const match = findElementByType(child, type);
    if (match) return match;
  }

  return null;
}

describe("BoardPage searchParams handling (Next 16 async)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findManyIssues.mockResolvedValue([]);
    mocks.findManyRepos.mockResolvedValue([]);
    mocks.aggregateIssues.mockResolvedValue({ _count: { _all: 0 }, _max: { lastSyncedAt: null } });
    mocks.getTrackedRepos.mockResolvedValue([]);
    mocks.filterBar.mockClear();
  });

  it("defaults to open issues + recently closed Done issues", async () => {
    await BoardPage({ searchParams: Promise.resolve({}) });

    const filteredCall = mocks.findManyIssues.mock.calls[0][0];
    // Should use OR clause, not a simple state filter
    expect(filteredCall.where.OR).toBeDefined();
    expect(Array.isArray(filteredCall.where.OR)).toBe(true);
    expect(filteredCall.where.OR.length).toBe(2);
    // First OR branch: open issues
    expect(filteredCall.where.OR[0]).toEqual({ state: "open" });
    // Second OR branch: recently closed with status/done
    expect(filteredCall.where.OR[1].state).toBe("closed");
    expect(filteredCall.where.OR[1].labels.has).toBe("status/done");
    expect(filteredCall.where.OR[1].closedAt.gte).toBeDefined();
  });

  it("includes all issues when includeClosed=true", async () => {
    await BoardPage({ searchParams: Promise.resolve({ includeClosed: "true" }) });

    const filteredCall = mocks.findManyIssues.mock.calls[0][0];
    expect(filteredCall.where.OR).toBeUndefined();
    expect(filteredCall.where.state).toBeUndefined();
  });

  it("awaits searchParams and applies repo filter to the issue query", async () => {
    await BoardPage({ searchParams: Promise.resolve({ repo: "myorg/repo1" }) });

    // The first findMany call is the filtered issue query (the second is filter-options).
    const filteredCall = mocks.findManyIssues.mock.calls[0][0];
    expect(filteredCall.where.repository).toEqual({ enabled: true, fullName: "myorg/repo1" });
  });

  it("awaits searchParams and applies agent label filter", async () => {
    await BoardPage({ searchParams: Promise.resolve({ agent: "agent/alpha" }) });

    const filteredCall = mocks.findManyIssues.mock.calls[0][0];
    expect(filteredCall.where.labels).toEqual({ has: "agent/alpha" });
  });

  it("awaits searchParams and applies owner label filter", async () => {
    await BoardPage({ searchParams: Promise.resolve({ owner: "owner/alice" }) });

    const filteredCall = mocks.findManyIssues.mock.calls[0][0];
    expect(filteredCall.where.labels).toEqual({ has: "owner/alice" });
  });

  it("awaits searchParams and applies priority filter", async () => {
    await BoardPage({ searchParams: Promise.resolve({ priority: "priority/p1" }) });

    const filteredCall = mocks.findManyIssues.mock.calls[0][0];
    expect(filteredCall.where.labels).toEqual({ has: "priority/p1" });
  });

  it("combines agent, owner, and priority label filters", async () => {
    await BoardPage({
      searchParams: Promise.resolve({ agent: "agent/alpha", owner: "owner/alice", priority: "priority/p1" }),
    });

    const filteredCall = mocks.findManyIssues.mock.calls[0][0];
    expect(filteredCall.where.labels).toEqual({ hasEvery: ["agent/alpha", "owner/alice", "priority/p1"] });
  });

  it("passes discovered label filter options to the filter bar", async () => {
    mocks.findManyIssues.mockResolvedValueOnce([]);
    mocks.findManyIssues.mockResolvedValueOnce([
      { labels: ["owner/bob", "agent/beta", "status/backlog"] },
      { labels: ["agent/alpha", "owner/alice", "agent/beta"] },
    ]);

    const page = await BoardPage({ searchParams: Promise.resolve({}) });
    const filterBar = findElementByType(page, mocks.filterBar);

    expect(filterBar?.props).toEqual(
      expect.objectContaining({
        agents: ["agent/alpha", "agent/beta"],
        owners: ["owner/alice", "owner/bob"],
      })
    );
  });

  it("uses OR clause instead of simple state filter by default", async () => {
    await BoardPage({ searchParams: Promise.resolve({}) });

    const filteredCall = mocks.findManyIssues.mock.calls[0][0];
    expect(filteredCall.where).toEqual(expect.objectContaining({ OR: expect.any(Array) }));
  });
});

describe("BoardPage dependency block reason", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findManyRepos.mockResolvedValue([]);
    mocks.aggregateIssues.mockResolvedValue({ _count: { _all: 1 }, _max: { lastSyncedAt: null } });
    mocks.getTrackedRepos.mockResolvedValue([]);
  });

  it("annotates cards against all open issues, not the repo-filtered subset", async () => {
    mocks.findManyIssues.mockImplementation(async (args: { where: Record<string, unknown>; select?: unknown }) => {
      // Blocker lookup: the unfiltered open universe.
      if ((args.where.number as { in?: number[] } | undefined)?.in) {
        return [{ number: 20, repository: { fullName: "bar/repo" } }];
      }
      // Filter-options query selects labels only.
      if (args.select) return [];
      return [
        { id: "a", number: 10, state: "open", labels: [], body: "Depends on bar/repo#20", repository: { fullName: "foo/repo" } },
      ];
    });

    const page = await BoardPage({ searchParams: Promise.resolve({ repo: "foo/repo" }) });

    const board = findElementByType(page, KanbanBoardClient);
    const initialIssues = (board?.props as { initialIssues: Array<{ dependencyBlockReason: string | null }> }).initialIssues;
    expect(initialIssues[0].dependencyBlockReason).toBe("Blocked by open bar/repo#20");
  });
});

describe("BoardPage release-signal projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findManyRepos.mockResolvedValue([]);
    mocks.aggregateIssues.mockResolvedValue({ _count: { _all: 1 }, _max: { lastSyncedAt: null } });
    mocks.getTrackedRepos.mockResolvedValue([]);
  });

  it("normalizes a cleared release-signal tombstone in the board payload (dispatch#1487)", async () => {
    mocks.findManyIssues.mockImplementation(async (args: { select?: unknown }) => {
      // Filter-options query selects labels only.
      if (args.select) return [];
      return [
        {
          id: "a",
          number: 10,
          state: "open",
          labels: [],
          body: "",
          releaseSignal: {
            tombstone: true,
            provenance: {
              groomingRunId: "gr-1",
              applicationKey: "an-application",
              appliedAt: "2026-01-01T00:00:00.000Z",
            },
          },
          repository: { fullName: "foo/repo" },
        },
      ];
    });

    const page = await BoardPage({ searchParams: Promise.resolve({}) });

    const board = findElementByType(page, KanbanBoardClient);
    const initialIssues = (board?.props as { initialIssues: Array<{ releaseSignal: unknown }> }).initialIssues;
    expect(initialIssues[0].releaseSignal).toBeNull();
  });
});

describe("BoardPage release pulse strip (#1484)", () => {
  function readyPulse() {
    return {
      schema: "dispatch.release-pulse/v1" as const,
      repoFullName: "myorg/repo1",
      pulseState: "ready" as const,
      baseline: { tag: "v1.0.0", sha: "basesha", publishedAt: "2026-10-25T12:00:00.000Z" },
      headSha: "headsha",
      unreleasedCommits: { state: "ahead" as const, count: 18 },
      deliveredIssueCount: 2,
      highlights: [],
      highlightsTruncated: false,
      notableDeliveryCount: 0,
      completedUmbrellaCount: 0,
      unknownDeliveryCount: 0,
    };
  }

  function trackedAutomationRepo() {
    return {
      id: "repo-1",
      fullName: "myorg/repo1",
      releaseState: "ahead",
      releaseBaselineTag: "v1.0.0",
      releaseBaselineSha: "basesha",
      releaseBaselinePublishedAt: new Date("2026-10-25T12:00:00.000Z"),
      releaseHeadSha: "headsha",
      releaseAheadBy: 18,
      releaseDeltaSyncedAt: new Date("2026-10-30T11:00:00.000Z"),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findManyIssues.mockResolvedValue([]);
    mocks.findManyRepos.mockResolvedValue([]);
    mocks.aggregateIssues.mockResolvedValue({ _count: { _all: 0 }, _max: { lastSyncedAt: null } });
    mocks.getTrackedRepos.mockResolvedValue([]);
    mocks.findUniqueAutomationRepo.mockResolvedValue(null);
    mocks.countWorkflowRuns.mockResolvedValue(0);
    mocks.collectReleasePulse.mockResolvedValue(readyPulse());
    // Freeze the clock so staleness is deterministic.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-30T12:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the strip for a single-repo filter with a tracked repo", async () => {
    mocks.findUniqueAutomationRepo.mockResolvedValue(trackedAutomationRepo());

    const page = await BoardPage({ searchParams: Promise.resolve({ repo: "myorg/repo1" }) });

    // Components are not deep-rendered here; assert the strip element in the
    // page tree and its props.
    const strip = findElementByType(page, mocks.releasePulseStrip);
    expect(strip).not.toBeNull();
    const props = strip?.props as { view: { kind: string; commitsLabel: string; readinessState: string }; repoFullName: string };
    expect(props.repoFullName).toBe("myorg/repo1");
    expect(props.view.kind).toBe("ready");
    expect(props.view.commitsLabel).toBe("+18 commits");
    // 18 unreleased commits cross the volume threshold → candidate.
    expect(props.view.readinessState).toBe("candidate");
    // No forge calls, no extra issue/event reads from the strip path.
    expect(mocks.collectReleasePulse).toHaveBeenCalledTimes(1);
  });

  it("renders no strip on the all-repo board", async () => {
    const page = await BoardPage({ searchParams: Promise.resolve({}) });

    expect(findElementByType(page, mocks.releasePulseStrip)).toBeNull();
    expect(mocks.findUniqueAutomationRepo).not.toHaveBeenCalled();
  });

  it("renders no strip when the repo is not tracked, board still renders", async () => {
    mocks.findUniqueAutomationRepo.mockResolvedValue(null);

    const page = await BoardPage({ searchParams: Promise.resolve({ repo: "myorg/repo1" }) });

    expect(findElementByType(page, mocks.releasePulseStrip)).toBeNull();
    expect(page).not.toBeNull();
  });

  it("renders no strip when the derivation fails, board still renders", async () => {
    mocks.findUniqueAutomationRepo.mockRejectedValue(new Error("db down"));

    const page = await BoardPage({ searchParams: Promise.resolve({ repo: "myorg/repo1" }) });

    expect(findElementByType(page, mocks.releasePulseStrip)).toBeNull();
    expect(page).not.toBeNull();
  });
});
