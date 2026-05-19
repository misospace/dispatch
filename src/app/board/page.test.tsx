import { describe, expect, it, vi, beforeEach } from "vitest";
import React from "react";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findManyIssues: vi.fn().mockResolvedValue([]),
    findManyRepos: vi.fn().mockResolvedValue([]),
    aggregateIssues: vi.fn().mockResolvedValue({ _count: { _all: 0 }, _max: { lastSyncedAt: null } }),
    getTrackedRepos: vi.fn().mockResolvedValue([]),
    filterBar: vi.fn(() => null),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.findManyIssues, aggregate: mocks.aggregateIssues },
    repository: { findMany: mocks.findManyRepos },
  },
}));

vi.mock("@/lib/config", () => ({
  getTrackedRepos: mocks.getTrackedRepos,
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

  it("defaults to filtering open issues only", async () => {
    await BoardPage({ searchParams: Promise.resolve({}) });

    const filteredCall = mocks.findManyIssues.mock.calls[0][0];
    expect(filteredCall.where.state).toBe("open");
  });

  it("includes closed issues when includeClosed=true", async () => {
    await BoardPage({ searchParams: Promise.resolve({ includeClosed: "true" }) });

    const filteredCall = mocks.findManyIssues.mock.calls[0][0];
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

  it("applies state filter when searchParams resolves empty", async () => {
    await BoardPage({ searchParams: Promise.resolve({}) });

    const filteredCall = mocks.findManyIssues.mock.calls[0][0];
    expect(filteredCall.where).toEqual(expect.objectContaining({ state: "open" }));
  });
});
