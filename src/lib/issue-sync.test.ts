import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubIssue } from "@/types";
import { IssueStore, syncIssuesForRepos, mergeLabels, reconcileClosedIssues } from "./issue-sync";

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
        if (repo === "org/bad") throw new Error("GitHub exploded");
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
    const findMock = vi.fn().mockResolvedValueOnce({ id: "existing-1" }).mockResolvedValue(null);
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
