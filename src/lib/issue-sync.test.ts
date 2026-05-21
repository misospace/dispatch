import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubIssue } from "@/types";
import { IssueStore, syncIssuesForRepos, mergeLabels } from "./issue-sync";

function githubIssue(number: number): GitHubIssue {
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
