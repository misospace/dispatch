import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubIssue } from "@/types";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    fetchIssues: vi.fn(),
    issueAggregate: vi.fn(),
  },
}));

vi.mock("@/lib/github", () => ({
  fetchIssues: mocks.fetchIssues,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      aggregate: mocks.issueAggregate,
    },
  },
}));

import {
  IssueStore,
  syncIssuesForRepos,
  mergeLabels,
  reconcileClosedIssues,
  closedIssueStatusFix,
  fetchAllStateIssues,
  SYNC_OVERLAP_BUFFER_MS,
} from "./issue-sync";

function githubIssue(number: number, overrides?: Partial<GitHubIssue>): GitHubIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: null,
    state: "open",
    html_url: `https://github.com/org/repo/issues/${number}`,
    labels: [{ name: "type/bug", color: "ffffff" }],
    assignees: [{ login: "alice" }],
    comments: 2,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    closed_at: null,
    ...overrides,
  };
}

describe("mergeLabels", () => {
  it("preserves agent/* labels not present on GitHub", () => {
    const ghLabels = ["type/bug", "priority/p1"];
    const existingLabels = ["agent/saffron", "status/in-progress", "priority/p1"];
    const result = mergeLabels(ghLabels, existingLabels);
    expect(result).toContain("agent/saffron");
    // status/in-progress is NOT preserved (only agent/* labels are)
    expect(result).toContain("type/bug");
    expect(result).toContain("priority/p1");
  });

  it("avoids duplicates when GitHub already has the agent label", () => {
    const ghLabels = ["type/bug", "agent/saffron"];
    const existingLabels = ["agent/saffron", "status/in-progress"];
    const result = mergeLabels(ghLabels, existingLabels);
    // Should have agent/saffron only once
    const count = result.filter((l) => l === "agent/saffron").length;
    expect(count).toBe(1);
  });

  it("only preserves labels starting with agent/", () => {
    const ghLabels = ["type/bug"];
    const existingLabels = ["agent/saffron", "status/in-progress", "priority/p1"];
    const result = mergeLabels(ghLabels, existingLabels);
    expect(result).toContain("agent/saffron");
    // Other labels from existing should NOT be merged (only agent/*)
    expect(result).not.toContain("status/in-progress");
    expect(result).not.toContain("priority/p1");
  });

  it("returns GitHub labels unchanged when no agent/* in existing", () => {
    const ghLabels = ["type/bug", "priority/p1"];
    const existingLabels = ["status/in-progress"];
    const result = mergeLabels(ghLabels, existingLabels);
    expect(result).toEqual(ghLabels);
  });

  it("handles empty arrays", () => {
    expect(mergeLabels([], [])).toEqual([]);
    expect(mergeLabels(["a"], [])).toEqual(["a"]);
    expect(mergeLabels([], ["agent/x"])).toEqual(["agent/x"]);
  });
});

describe("closedIssueStatusFix", () => {
  it("leaves open issues untouched", () => {
    expect(closedIssueStatusFix(["status/ready", "type/bug"], "open")).toEqual({
      labels: ["status/ready", "type/bug"],
      added: [],
      removed: [],
    });
  });

  it("moves a closed issue from any status to status/done", () => {
    for (const from of ["status/backlog", "status/ready", "status/in-progress", "status/in-review"]) {
      const r = closedIssueStatusFix([from, "type/bug"], "closed");
      expect(r.labels).toEqual(["type/bug", "status/done"]);
      expect(r.removed).toEqual([from]);
      expect(r.added).toEqual(["status/done"]);
    }
  });

  it("adds status/done to a closed issue that has no status label", () => {
    const r = closedIssueStatusFix(["type/bug"], "closed");
    expect(r.labels).toEqual(["type/bug", "status/done"]);
    expect(r.added).toEqual(["status/done"]);
    expect(r.removed).toEqual([]);
  });

  it("is a no-op when a closed issue is already status/done", () => {
    expect(closedIssueStatusFix(["type/bug", "status/done"], "closed")).toEqual({
      labels: ["type/bug", "status/done"],
      added: [],
      removed: [],
    });
  });

  it("dedupes a stale status label alongside done", () => {
    const r = closedIssueStatusFix(["status/done", "status/ready", "type/bug"], "closed");
    expect(r.labels).toEqual(["type/bug", "status/done"]);
    expect(r.removed).toEqual(["status/ready"]);
    expect(r.added).toEqual([]);
  });
});

describe("syncIssuesForRepos", () => {
  let store: IssueStore;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    store = {
      findIssue: vi.fn().mockResolvedValue(null),
      updateIssue: vi.fn().mockResolvedValue(undefined),
      createIssue: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("returns the expected response shape and counts", async () => {
    const response = await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [githubIssue(1), githubIssue(2)],
      store,
    );

    expect(response).toMatchObject({
      success: true,
      repos: 1,
      syncedCount: 2,
      results: [{ repo: "org/repo", synced: 2, error: null }],
    });
  });

  it("continues syncing repos after a per-repo error", async () => {
    const response = await syncIssuesForRepos(
      [
        { id: "repo-1", fullName: "org/bad" },
        { id: "repo-2", fullName: "org/good" },
      ],
      async (repo) => {
        if (repo.fullName === "org/bad") throw new Error("GitHub exploded");
        return [githubIssue(1)];
      },
      store,
    );

    expect(response).toEqual({
      success: false,
      repos: 2,
      syncedCount: 1,
      results: [
        { repo: "org/bad", synced: 0, error: "GitHub exploded" },
        { repo: "org/good", synced: 1, error: null },
      ],
    });
  });

  it("calls updateIssue for existing issues and createIssue for new ones", async () => {
    const findMock = vi.fn().mockResolvedValueOnce({ id: "existing-1", labels: [] }).mockResolvedValue(null);
    const updateMock = vi.fn().mockResolvedValue(undefined);
    const createMock = vi.fn().mockResolvedValue(undefined);

    store = {
      findIssue: findMock,
      updateIssue: updateMock,
      createIssue: createMock,
    };

    await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [githubIssue(1), githubIssue(2)],
      store,
    );

    expect(findMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenCalledWith("existing-1", expect.objectContaining({ number: 1 }));
    expect(createMock).toHaveBeenCalledWith("repo-1", expect.objectContaining({ number: 2 }));
  });

  it("preserves agent/* labels from the cached record when updating", async () => {
    store = {
      findIssue: vi.fn().mockResolvedValue({ id: "existing-1", labels: ["agent/saffron", "status/in-progress"] }),
      updateIssue: vi.fn().mockResolvedValue(undefined),
      createIssue: vi.fn().mockResolvedValue(undefined),
    };

    await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [githubIssue(1)],
      store,
    );

    // GitHub labels stay the base; only agent/* labels are preserved from the cache.
    expect(store.updateIssue).toHaveBeenCalledWith(
      "existing-1",
      expect.objectContaining({ labels: ["type/bug", "agent/saffron"] }),
    );
  });

  it("stores status/done for a closed issue and mirrors the change to GitHub", async () => {
    const syncGithubLabels = vi.fn().mockResolvedValue(undefined);

    await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [githubIssue(1, { state: "closed", labels: [{ name: "status/ready", color: "f" }, { name: "type/bug", color: "f" }] })],
      store,
      [],
      syncGithubLabels,
    );

    // Cache: status/ready replaced with status/done.
    expect(store.createIssue).toHaveBeenCalledWith("repo-1", expect.objectContaining({ labels: ["type/bug", "status/done"] }));
    // GitHub: remove the stale status, add done.
    expect(syncGithubLabels).toHaveBeenCalledWith("org/repo", 1, ["status/done"], ["status/ready"]);
  });

  it("does not touch GitHub for open issues", async () => {
    const syncGithubLabels = vi.fn().mockResolvedValue(undefined);

    await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [githubIssue(1, { state: "open", labels: [{ name: "status/ready", color: "f" }] })],
      store,
      [],
      syncGithubLabels,
    );

    expect(store.createIssue).toHaveBeenCalledWith("repo-1", expect.objectContaining({ labels: ["status/ready"] }));
    expect(syncGithubLabels).not.toHaveBeenCalled();
  });

  it("still fixes the cache when no GitHub writer is provided", async () => {
    await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [githubIssue(1, { state: "closed", labels: [{ name: "status/backlog", color: "f" }] })],
      store,
    );

    expect(store.createIssue).toHaveBeenCalledWith("repo-1", expect.objectContaining({ labels: ["status/done"] }));
  });
});

describe("reconcileClosedIssues", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("marks closed issues with active status labels as done", async () => {
    const updateCalls: Array<{ id: string; data: any }> = [];

    const result = await reconcileClosedIssues(
      [{ id: "repo-1", fullName: "org/repo" }],
      async (_, number) =>
        githubIssue(number, {
          state: "closed",
          labels: [{ name: "type/bug", color: "ffffff" }],
          closed_at: "2026-01-03T00:00:00.000Z",
        }),
      {
        findActiveCachedIssues: vi.fn().mockResolvedValue([
          { id: "issue-1", number: 42, labels: ["status/ready", "type/bug"], state: "open" },
        ]),
        updateIssue: vi.fn().mockImplementation((id, data) => {
          updateCalls.push({ id, data });
        }),
      },
    );

    expect(result.issuesReconciled).toBe(1);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].data.state).toBe("closed");
    expect(updateCalls[0].data.labels).toContain("status/done");
    expect(updateCalls[0].data.labels).not.toContain("status/ready");
  });

  it("fixes stale state for issues with status/done but open state", async () => {
    const updateCalls: Array<{ id: string; data: any }> = [];

    const result = await reconcileClosedIssues(
      [{ id: "repo-1", fullName: "org/repo" }],
      async (_, number) =>
        githubIssue(number, {
          state: "closed",
          labels: [{ name: "status/done", color: "ffffff" }, { name: "type/bug", color: "ffffff" }],
          closed_at: "2026-01-03T00:00:00.000Z",
        }),
      {
        findActiveCachedIssues: vi.fn().mockResolvedValue([
          // Issue has status/done label but still shows as open (stale cache)
          { id: "issue-460", number: 460, labels: ["status/done", "type/bug"], state: "open" },
        ]),
        updateIssue: vi.fn().mockImplementation((id, data) => {
          updateCalls.push({ id, data });
        }),
      },
    );

    expect(result.issuesReconciled).toBe(1);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].data.state).toBe("closed");
    // Labels should be preserved (already has status/done)
    expect(updateCalls[0].data.labels).toContain("status/done");
    expect(updateCalls[0].data.labels).toContain("type/bug");

    // Verify the action is "state_fixed" not "marked_done"
    const stateFixedResults = result.results.filter((r) => r.action === "state_fixed");
    expect(stateFixedResults).toHaveLength(1);
    expect(stateFixedResults[0].issueNumber).toBe(460);
  });

  it("skips issues without reconcilable status labels or done label", async () => {
    const result = await reconcileClosedIssues(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => githubIssue(99, { state: "closed", closed_at: "2026-01-03T00:00:00.000Z" }),
      {
        findActiveCachedIssues: vi.fn().mockResolvedValue([
          // No reconcilable status label and no done label — should be skipped
          { id: "issue-99", number: 99, labels: ["type/bug"], state: "open" },
        ]),
        updateIssue: vi.fn(),
      },
    );

    expect(result.issuesReconciled).toBe(0);
    expect(result.issuesChecked).toBe(0);
    // No results generated since the issue was filtered out before processing
    expect(result.results).toHaveLength(0);
  });

  it("does not reconcile if GitHub still shows the issue as open", async () => {
    const result = await reconcileClosedIssues(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => githubIssue(42, { state: "open" }),
      {
        findActiveCachedIssues: vi.fn().mockResolvedValue([
          { id: "issue-42", number: 42, labels: ["status/ready"], state: "open" },
        ]),
        updateIssue: vi.fn(),
      },
    );

    expect(result.issuesReconciled).toBe(0);
    expect(result.results[0].reconciled).toBe(false);
    expect(result.results[0].action).toBe("no_change");
  });

  it("marks in-progress issues as released_lease", async () => {
    const result = await reconcileClosedIssues(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => githubIssue(42, { state: "closed", closed_at: "2026-01-03T00:00:00.000Z" }),
      {
        findActiveCachedIssues: vi.fn().mockResolvedValue([
          { id: "issue-42", number: 42, labels: ["status/in-progress"], state: "open" },
        ]),
        updateIssue: vi.fn(),
      },
    );

    expect(result.issuesReconciled).toBe(1);
    expect(result.results[0].action).toBe("released_lease");
  });
});

describe("fetchAllStateIssues", () => {
  beforeEach(() => {
    mocks.fetchIssues.mockReset().mockResolvedValue([]);
    mocks.issueAggregate.mockReset();
  });

  it("does a full fetch (no since) when the repo has no cached issues", async () => {
    mocks.issueAggregate.mockResolvedValue({ _max: { lastSyncedAt: null } });

    await fetchAllStateIssues({ id: "repo-1", fullName: "org/repo" });

    expect(mocks.issueAggregate).toHaveBeenCalledWith({
      where: { repositoryId: "repo-1" },
      _max: { lastSyncedAt: true },
    });
    expect(mocks.fetchIssues).toHaveBeenCalledWith("org/repo", { includeClosed: true, since: undefined });
  });

  it("narrows with since = anchor - SYNC_OVERLAP_BUFFER_MS when the repo has cached issues", async () => {
    const anchor = new Date("2026-07-01T00:00:00.000Z");
    mocks.issueAggregate.mockResolvedValue({ _max: { lastSyncedAt: anchor } });

    await fetchAllStateIssues({ id: "repo-1", fullName: "org/repo" });

    expect(mocks.fetchIssues).toHaveBeenCalledWith("org/repo", {
      includeClosed: true,
      since: new Date(anchor.getTime() - SYNC_OVERLAP_BUFFER_MS),
    });
  });
});
