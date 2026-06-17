import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    reconcileClosedIssues: vi.fn(),
    getSyncRepos: vi.fn(),
    syncIssuesForRepos: vi.fn(),
    parseExcludedLabels: vi.fn(),
  },
}));

vi.mock("@/lib/issue-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/issue-sync")>();
  return {
    ...actual,
    reconcileClosedIssues: mocks.reconcileClosedIssues,
    syncIssuesForRepos: mocks.syncIssuesForRepos,
    mergeLabels: actual.mergeLabels,
  };
});

vi.mock("@/lib/config", () => ({
  getSyncRepos: mocks.getSyncRepos,
  parseExcludedLabels: mocks.parseExcludedLabels,
}));

vi.mock("@/lib/github", () => ({
  fetchIssues: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

import { runSyncBestEffort, runReconcileBestEffort } from "@/lib/heartbeat";

describe("runReconcileBestEffort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports actual counts from reconcileClosedIssues", async () => {
    mocks.getSyncRepos.mockResolvedValue([{ id: "repo-1", fullName: "org/repo" }]);
    mocks.reconcileClosedIssues.mockResolvedValue({
      success: true,
      reposProcessed: 1,
      issuesChecked: 5,
      issuesReconciled: 3,
      results: [],
    });

    const result = await runReconcileBestEffort();

    expect(result.issuesReconciled).toBe(3);
    expect(result.issuesChecked).toBe(5);
    expect(result.reposProcessed).toBe(1);
  });
});

describe("runSyncBestEffort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports actual reposProcessed from syncIssuesForRepos", async () => {
    mocks.getSyncRepos.mockResolvedValue([
      { id: "repo-1", fullName: "org/repo" },
      { id: "repo-2", fullName: "org/repo2" },
    ]);
    mocks.parseExcludedLabels.mockReturnValue([]);
    mocks.syncIssuesForRepos.mockResolvedValue({
      success: true,
      repos: 2,
      syncedCount: 10,
      results: [],
    });

    const result = await runSyncBestEffort();

    expect(result.reposProcessed).toBe(2);
  });
});
