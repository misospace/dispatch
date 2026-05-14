import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findManyIssues: vi.fn().mockResolvedValue([]),
    findManyRepos: vi.fn().mockResolvedValue([]),
    aggregateIssues: vi.fn().mockResolvedValue({ _count: { _all: 0 }, _max: { lastSyncedAt: null } }),
    getTrackedRepos: vi.fn().mockResolvedValue([]),
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
vi.mock("@/components/filter-bar", () => ({ FilterBar: () => null }));
vi.mock("@/components/sync-issues-button", () => ({ SyncIssuesButton: () => null }));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: unknown }) => children,
  CardContent: ({ children }: { children: unknown }) => children,
}));

import BoardPage from "./page";

describe("BoardPage searchParams handling (Next 16 async)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findManyIssues.mockResolvedValue([]);
    mocks.findManyRepos.mockResolvedValue([]);
    mocks.aggregateIssues.mockResolvedValue({ _count: { _all: 0 }, _max: { lastSyncedAt: null } });
    mocks.getTrackedRepos.mockResolvedValue([]);
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

  it("applies no extra filters when searchParams resolves empty", async () => {
    await BoardPage({ searchParams: Promise.resolve({}) });

    const filteredCall = mocks.findManyIssues.mock.calls[0][0];
    expect(filteredCall.where).toEqual({ repository: { enabled: true } });
  });
});
