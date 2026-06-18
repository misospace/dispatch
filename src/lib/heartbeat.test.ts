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

// ---------------------------------------------------------------------------
// runSyncBestEffort
// ---------------------------------------------------------------------------

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

  it("aggregates synced counts from multiple repos", async () => {
    mocks.getSyncRepos.mockResolvedValue([
      { id: "repo-1", fullName: "org/repo" },
      { id: "repo-2", fullName: "org/repo2" },
    ]);
    mocks.parseExcludedLabels.mockReturnValue([]);
    mocks.syncIssuesForRepos.mockResolvedValue({
      success: true,
      repos: 2,
      syncedCount: 15,
      results: [
        { repo: "org/repo", synced: 8, error: null },
        { repo: "org/repo2", synced: 7, error: null },
      ],
    });

    const result = await runSyncBestEffort();

    expect(result.synced).toBe(15);
    expect(result.reposProcessed).toBe(2);
  });

  it("collects touchedIssueUrls for successful repos", async () => {
    mocks.getSyncRepos.mockResolvedValue([
      { id: "repo-1", fullName: "org/repo" },
      { id: "repo-2", fullName: "org/repo2" },
    ]);
    mocks.parseExcludedLabels.mockReturnValue([]);
    mocks.syncIssuesForRepos.mockResolvedValue({
      success: true,
      repos: 2,
      syncedCount: 5,
      results: [
        { repo: "org/repo", synced: 3, error: null },
        { repo: "org/repo2", synced: 2, error: null },
      ],
    });

    const result = await runSyncBestEffort();

    expect(result.touchedIssueUrls).toContain("repo:org/repo");
    expect(result.touchedIssueUrls).toContain("repo:org/repo2");
    expect(result.touchedIssueUrls).toHaveLength(2);
  });

  it("collects warnings for repos with errors", async () => {
    mocks.getSyncRepos.mockResolvedValue([
      { id: "repo-1", fullName: "org/repo" },
      { id: "repo-2", fullName: "org/repo2" },
    ]);
    mocks.parseExcludedLabels.mockReturnValue([]);
    mocks.syncIssuesForRepos.mockResolvedValue({
      success: false,
      repos: 2,
      syncedCount: 3,
      results: [
        { repo: "org/repo", synced: 3, error: null },
        { repo: "org/repo2", synced: 0, error: "rate limited" },
      ],
    });

    const result = await runSyncBestEffort();

    expect(result.warnings).toContain("Sync warning for org/repo2: rate limited");
    expect(result.errors).toContain(
      "Sync completed with one or more repo failures",
    );
  });

  it("returns error when no tracked repositories exist", async () => {
    mocks.getSyncRepos.mockResolvedValue([]);

    const result = await runSyncBestEffort();

    expect(result.synced).toBe(0);
    expect(result.reposProcessed).toBe(0);
    expect(result.errors).toContain(
      "No tracked repositories found — sync skipped",
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.touchedIssueUrls).toHaveLength(0);
  });

  it("handles mixed success and failure results", async () => {
    mocks.getSyncRepos.mockResolvedValue([
      { id: "repo-1", fullName: "org/a" },
      { id: "repo-2", fullName: "org/b" },
      { id: "repo-3", fullName: "org/c" },
    ]);
    mocks.parseExcludedLabels.mockReturnValue([]);
    mocks.syncIssuesForRepos.mockResolvedValue({
      success: false,
      repos: 3,
      syncedCount: 12,
      results: [
        { repo: "org/a", synced: 5, error: null },
        { repo: "org/b", synced: 0, error: "forbidden" },
        { repo: "org/c", synced: 7, error: null },
      ],
    });

    const result = await runSyncBestEffort();

    expect(result.synced).toBe(12);
    expect(result.reposProcessed).toBe(3);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("org/b");
    expect(result.errors).toHaveLength(1);
    expect(result.touchedIssueUrls).toContain("repo:org/a");
    expect(result.touchedIssueUrls).toContain("repo:org/c");
    expect(result.touchedIssueUrls).not.toContain("repo:org/b");
  });

  it("catches unexpected errors from getSyncRepos", async () => {
    mocks.getSyncRepos.mockRejectedValue(new Error("network timeout"));

    const result = await runSyncBestEffort();

    expect(result.synced).toBe(0);
    expect(result.reposProcessed).toBe(0);
    expect(result.errors).toContain("Sync failed: network timeout");
    expect(result.warnings).toHaveLength(0);
  });

  it("catches unexpected errors from syncIssuesForRepos", async () => {
    mocks.getSyncRepos.mockResolvedValue([
      { id: "repo-1", fullName: "org/repo" },
    ]);
    mocks.parseExcludedLabels.mockReturnValue([]);
    mocks.syncIssuesForRepos.mockRejectedValue(new Error("database unreachable"));

    const result = await runSyncBestEffort();

    expect(result.synced).toBe(0);
    expect(result.reposProcessed).toBe(0);
    expect(result.errors).toContain("Sync failed: database unreachable");
  });

  it("handles non-Error throw in catch block", async () => {
    mocks.getSyncRepos.mockRejectedValue("string error");

    const result = await runSyncBestEffort();

    expect(result.errors).toContain("Sync failed: Unknown sync error");
  });

  it("uses excludedLabels from opts when provided", async () => {
    const customLabels = ["status/done"];
    mocks.getSyncRepos.mockResolvedValue([
      { id: "repo-1", fullName: "org/repo" },
    ]);
    mocks.parseExcludedLabels.mockReturnValue([]);
    mocks.syncIssuesForRepos.mockResolvedValue({
      success: true,
      repos: 1,
      syncedCount: 0,
      results: [{ repo: "org/repo", synced: 0, error: null }],
    });

    await runSyncBestEffort({ excludedLabels: customLabels });

    expect(mocks.syncIssuesForRepos).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Function),
      expect.any(Object),
      customLabels,
    );
  });

  it("falls back to parseExcludedLabels when opts not provided", async () => {
    const envLabels = ["status/done"];
    mocks.getSyncRepos.mockResolvedValue([
      { id: "repo-1", fullName: "org/repo" },
    ]);
    mocks.parseExcludedLabels.mockReturnValue(envLabels);
    mocks.syncIssuesForRepos.mockResolvedValue({
      success: true,
      repos: 1,
      syncedCount: 0,
      results: [{ repo: "org/repo", synced: 0, error: null }],
    });

    await runSyncBestEffort();

    expect(mocks.parseExcludedLabels).toHaveBeenCalled();
    expect(mocks.syncIssuesForRepos).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Function),
      expect.any(Object),
      envLabels,
    );
  });

  it("returns zero counts on total sync failure", async () => {
    mocks.getSyncRepos.mockResolvedValue([
      { id: "repo-1", fullName: "org/repo" },
    ]);
    mocks.parseExcludedLabels.mockReturnValue([]);
    mocks.syncIssuesForRepos.mockRejectedValue(new Error("total failure"));

    const result = await runSyncBestEffort();

    expect(result.synced).toBe(0);
    expect(result.reposProcessed).toBe(0);
  });

  it("touchedIssueUrls is empty when all repos fail", async () => {
    mocks.getSyncRepos.mockResolvedValue([
      { id: "repo-1", fullName: "org/repo" },
    ]);
    mocks.parseExcludedLabels.mockReturnValue([]);
    mocks.syncIssuesForRepos.mockResolvedValue({
      success: false,
      repos: 1,
      syncedCount: 0,
      results: [{ repo: "org/repo", synced: 0, error: "timeout" }],
    });

    const result = await runSyncBestEffort();

    expect(result.touchedIssueUrls).toHaveLength(0);
  });

  it("preserves warnings and errors alongside touchedIssueUrls on partial failure", async () => {
    mocks.getSyncRepos.mockResolvedValue([
      { id: "r1", fullName: "org/a" },
      { id: "r2", fullName: "org/b" },
    ]);
    mocks.parseExcludedLabels.mockReturnValue([]);
    mocks.syncIssuesForRepos.mockResolvedValue({
      success: false,
      repos: 2,
      syncedCount: 4,
      results: [
        { repo: "org/a", synced: 4, error: null },
        { repo: "org/b", synced: 0, error: "auth failed" },
      ],
    });

    const result = await runSyncBestEffort();

    expect(result.touchedIssueUrls).toContain("repo:org/a");
    expect(result.warnings).toContain("Sync warning for org/b: auth failed");
    expect(result.errors).toContain(
      "Sync completed with one or more repo failures",
    );
  });
});

// ---------------------------------------------------------------------------
// runReconcileBestEffort
// ---------------------------------------------------------------------------

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

  it("returns error when no tracked repositories exist", async () => {
    mocks.getSyncRepos.mockResolvedValue([]);

    const result = await runReconcileBestEffort();

    expect(result.issuesReconciled).toBe(0);
    expect(result.issuesChecked).toBe(0);
    expect(result.reposProcessed).toBe(0);
    expect(result.errors).toContain(
      "No tracked repositories found — reconcile skipped",
    );
    expect(result.warnings).toHaveLength(0);
  });

  it("collects warnings for failed individual reconciliations", async () => {
    mocks.getSyncRepos.mockResolvedValue([
      { id: "repo-1", fullName: "org/repo" },
    ]);
    mocks.reconcileClosedIssues.mockResolvedValue({
      success: false,
      reposProcessed: 1,
      issuesChecked: 2,
      issuesReconciled: 1,
      results: [
        {
          repo: "org/repo",
          issueNumber: 10,
          reconciled: true,
          action: "marked_done",
          error: null,
        },
        {
          repo: "org/repo",
          issueNumber: 20,
          reconciled: false,
          action: "no_change",
          error: "issue not found",
        },
      ],
    });

    const result = await runReconcileBestEffort();

    expect(result.warnings).toContain(
      "Reconcile warning for org/repo#20: issue not found",
    );
    expect(result.errors).toContain(
      "Reconciliation completed with one or more failures",
    );
  });

  it("does not warn when result has error but was reconciled", async () => {
    mocks.getSyncRepos.mockResolvedValue([
      { id: "repo-1", fullName: "org/repo" },
    ]);
    mocks.reconcileClosedIssues.mockResolvedValue({
      success: true,
      reposProcessed: 1,
      issuesChecked: 1,
      issuesReconciled: 1,
      results: [
        {
          repo: "org/repo",
          issueNumber: 10,
          reconciled: true,
          action: "marked_done",
          error: "deprecated field ignored",
        },
      ],
    });

    const result = await runReconcileBestEffort();

    expect(result.warnings).toHaveLength(0);
  });

  it("catches unexpected errors from getSyncRepos", async () => {
    mocks.getSyncRepos.mockRejectedValue(new Error("connection refused"));

    const result = await runReconcileBestEffort();

    expect(result.issuesReconciled).toBe(0);
    expect(result.issuesChecked).toBe(0);
    expect(result.reposProcessed).toBe(0);
    expect(result.errors).toContain("Reconciliation failed: connection refused");
  });

  it("catches unexpected errors from reconcileClosedIssues", async () => {
    mocks.getSyncRepos.mockResolvedValue([
      { id: "repo-1", fullName: "org/repo" },
    ]);
    mocks.reconcileClosedIssues.mockRejectedValue(
      new Error("prisma connection lost"),
    );

    const result = await runReconcileBestEffort();

    expect(result.issuesReconciled).toBe(0);
    expect(result.issuesChecked).toBe(0);
    expect(result.reposProcessed).toBe(0);
    expect(result.errors).toContain("Reconciliation failed: prisma connection lost");
  });

  it("handles non-Error throw in catch block", async () => {
    mocks.getSyncRepos.mockRejectedValue("plain string error");

    const result = await runReconcileBestEffort();

    expect(result.errors).toContain(
      "Reconciliation failed: Unknown reconcile error",
    );
  });

  it("returns zero counts on total reconcile failure", async () => {
    mocks.getSyncRepos.mockResolvedValue([
      { id: "repo-1", fullName: "org/repo" },
    ]);
    mocks.reconcileClosedIssues.mockRejectedValue(new Error("total failure"));

    const result = await runReconcileBestEffort();

    expect(result.issuesReconciled).toBe(0);
    expect(result.issuesChecked).toBe(0);
    expect(result.reposProcessed).toBe(0);
  });

  it("handles multiple repos with mixed reconcile results", async () => {
    mocks.getSyncRepos.mockResolvedValue([
      { id: "r1", fullName: "org/a" },
      { id: "r2", fullName: "org/b" },
    ]);
    mocks.reconcileClosedIssues.mockResolvedValue({
      success: false,
      reposProcessed: 2,
      issuesChecked: 6,
      issuesReconciled: 3,
      results: [
        {
          repo: "org/a",
          issueNumber: 1,
          reconciled: true,
          action: "marked_done",
          error: null,
        },
        {
          repo: "org/a",
          issueNumber: 2,
          reconciled: false,
          action: "no_change",
          error: "not found",
        },
        {
          repo: "org/b",
          issueNumber: 3,
          reconciled: true,
          action: "released_lease",
          error: null,
        },
      ],
    });

    const result = await runReconcileBestEffort();

    expect(result.issuesReconciled).toBe(3);
    expect(result.issuesChecked).toBe(6);
    expect(result.reposProcessed).toBe(2);
    expect(result.warnings).toContain("Reconcile warning for org/a#2: not found");
    expect(result.errors).toContain(
      "Reconciliation completed with one or more failures",
    );
  });
});
