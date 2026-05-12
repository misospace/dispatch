import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubIssue } from "@/types";
import { IssueStore, syncIssuesForRepos } from "./issue-sync";

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
      store
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
      store
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
});
