import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  classifyLaneByHeuristics,
  extractFixingIssueNumbers,
  prBranchMatchesIssue,
  checkPrHealth,
  reconcileIssue,
  prReferencesIssue,
  executeAction,
  executeActions,
} from "./issue-reconciliation";

const githubModule = await import("./github");

describe("classifyLaneByHeuristics", () => {
  it("classifies architecture/design issues as escalated", () => {
    const result = classifyLaneByHeuristics(
      "Database migration strategy for user tables",
      "We need to plan the migration strategy for moving user data to a new schema.",
      ["enhancement"],
    );
    expect(result.lane).toBe("escalated");
    expect(result.confidence).toBe("medium");
  });

  it("classifies audit parent/umbrella issues as escalated", () => {
    const result = classifyLaneByHeuristics(
      "Weekly tech debt audit: Q1 2026",
      null,
      ["audit", "needs-gpt"],
    );
    expect(result.lane).toBe("escalated");
  });

  it("classifies placeholder/tbd issues as backlog", () => {
    const result = classifyLaneByHeuristics(
      "New feature TBD",
      "This is a placeholder. More details needed.",
      ["enhancement"],
    );
    expect(result.lane).toBe("backlog");
  });

  it("classifies concrete implementation issues as normal", () => {
    const result = classifyLaneByHeuristics(
      "Add dark mode toggle to settings page",
      "Implement a toggle in the settings page that switches between light and dark themes.",
      ["enhancement"],
    );
    expect(result.lane).toBe("normal");
  });

  it("classifies issues with status/backlog label as backlog", () => {
    const result = classifyLaneByHeuristics(
      "Research API rate limiting",
      null,
      ["enhancement", "status/backlog"],
    );
    expect(result.lane).toBe("backlog");
  });

  it("handles empty inputs", () => {
    const result = classifyLaneByHeuristics("", "", []);
    expect(result.lane).toBe("normal");
  });
});

describe("extractFixingIssueNumbers", () => {
  it("extracts issue numbers from Fixes #N patterns", () => {
    const body = "This PR fixes #42 and closes #99.";
    const numbers = extractFixingIssueNumbers(body);
    expect(numbers).toContain(42);
    expect(numbers).toContain(99);
  });

  it("extracts issue numbers from resolves #N patterns", () => {
    const body = "Resolves #123 — adds new feature.";
    const numbers = extractFixingIssueNumbers(body);
    expect(numbers).toContain(123);
  });

  it("returns empty for null body", () => {
    expect(extractFixingIssueNumbers(null)).toEqual([]);
  });

  it("handles duplicate references", () => {
    const body = "Fixes #42. Also fixes #42 again.";
    const numbers = extractFixingIssueNumbers(body);
    expect(numbers).toHaveLength(1);
    expect(numbers[0]).toBe(42);
  });
});

describe("prBranchMatchesIssue", () => {
  it("matches fix/issue-{number}-slug pattern", () => {
    expect(prBranchMatchesIssue("fix/issue-42-add-dark-mode", 42)).toBe(true);
  });

  it("matches issue-{number} prefix", () => {
    expect(prBranchMatchesIssue("issue-42-fix", 42)).toBe(true);
  });

  it("does not match unrelated numbers", () => {
    expect(prBranchMatchesIssue("fix/issue-43-add-light-mode", 42)).toBe(false);
    expect(prBranchMatchesIssue("feature/new-ui", 42)).toBe(false);
  });

  it("handles numeric-only branch names", () => {
    expect(prBranchMatchesIssue("42", 42)).toBe(true);
  });
});

describe("checkPrHealth", () => {
  it("returns healthy for a clean PR", () => {
    const pr = {
      number: 42,
      url: "https://github.com/test/repo/pull/42",
      title: "Add feature",
      state: "open",
      user: { login: "test-user" },
      head: { ref: "fix/issue-42-feature" },
      base: { ref: "main" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      merged_at: null,
      draft: false,
    };
    const health = checkPrHealth(pr);
    expect(health.status).toBe("healthy");
  });

  it("returns healthy for a PR with no issues", () => {
    const pr = {
      number: 42,
      url: "https://github.com/test/repo/pull/42",
      title: "Add feature",
      state: "open",
      user: { login: "test-user" },
      head: { ref: "fix/issue-42-feature" },
      base: { ref: "main" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      merged_at: null,
      draft: false,
    };
    const health = checkPrHealth(pr);
    expect(health.status).toBe("healthy");
  });

  it("includes PR health details in result", () => {
    const pr = {
      number: 42,
      url: "https://github.com/test/repo/pull/42",
      title: "Add feature",
      state: "open",
      user: { login: "test-user" },
      head: { ref: "fix/issue-42-feature" },
      base: { ref: "main" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      merged_at: null,
      draft: false,
    };
    const health = checkPrHealth(pr);
    expect(health.prNumber).toBe(42);
    expect(health.url).toContain("pull/42");
    expect(health.headRefName).toBe("fix/issue-42-feature");
  });
});

describe("reconcileIssue", () => {
  it("returns close action when merged PR fixes the issue", () => {
    const mergedPrs = new Map([
      [42, {
        number: 42,
        url: "https://github.com/test/repo/pull/42",
        title: "Fix issue #42",
        state: "closed",
        user: { login: "bot" },
        head: { ref: "fix/issue-42-fix" },
        base: { ref: "main" },
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
        merged_at: "2026-01-03T00:00:00Z",
        draft: false,
      }],
    ]);

    const result = reconcileIssue(
      { number: 42, title: "Bug fix", body: null, labels: [], state: "open" },
      mergedPrs,
      new Map(),
    );

    expect(result.isClosedByMergedPr).toBe(true);
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].type).toBe("close_issue");
  });

  it("returns no action for already-closed issues", () => {
    const result = reconcileIssue(
      { number: 42, title: "Bug fix", body: null, labels: [], state: "closed" },
      new Map(),
      new Map(),
    );

    expect(result.actions.length).toBe(0);
    expect(result.isClosedByMergedPr).toBe(false);
    expect(result.hasOpenPr).toBe(false);
  });

  it("detects open PR and marks healthy", () => {
    const openPrs = new Map([
      [42, {
        number: 42,
        url: "https://github.com/test/repo/pull/42",
        title: "Fix issue #42",
        state: "open",
        user: { login: "dev" },
        head: { ref: "fix/issue-42-fix" },
        base: { ref: "main" },
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
        merged_at: null,
        draft: false,
      }],
    ]);

    const result = reconcileIssue(
      { number: 42, title: "Bug fix", body: null, labels: [], state: "open" },
      new Map(),
      openPrs,
    );

    expect(result.hasOpenPr).toBe(true);
  });
});

describe("prReferencesIssue", () => {
  it("matches PR by branch name", () => {
    const pr = {
      number: 42,
      url: "https://github.com/test/repo/pull/42",
      title: "Fix issue #42",
      state: "open",
      user: { login: "dev" },
      head: { ref: "fix/issue-42-fix" },
      base: { ref: "main" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      merged_at: null,
      draft: false,
    };
    expect(prReferencesIssue(pr, 42)).toBe(true);
    expect(prReferencesIssue(pr, 43)).toBe(false);
  });
});

describe("executeAction", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("closes an issue successfully", async () => {
    const closeMock = vi.spyOn(githubModule, "closeIssue").mockResolvedValue(undefined);
    const action = {
      type: "close_issue" as const,
      issueNumber: 42,
      repoFullName: "test/repo",
      reason: "Fixed by merged PR #100",
    };

    const result = await executeAction(action, ["bug", "priority/p1"]);

    expect(closeMock).toHaveBeenCalledWith("test/repo", 42);
    expect(result.success).toBe(true);
    expect(result.beforeLabels).toEqual(["bug", "priority/p1"]);
    expect(result.afterLabels).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("adds a label successfully", async () => {
    const addLabelMock = vi.spyOn(githubModule, "addIssueLabel").mockResolvedValue(undefined);
    const action = {
      type: "add_label" as const,
      issueNumber: 42,
      repoFullName: "test/repo",
      label: "status/in-review",
      reason: "PR is healthy",
    };

    const result = await executeAction(action, ["bug"]);

    expect(addLabelMock).toHaveBeenCalledWith("test/repo", 42, "status/in-review");
    expect(result.success).toBe(true);
    expect(result.afterLabels).toEqual(["bug", "status/in-review"]);
  });

  it("skips adding a label that already exists", async () => {
    const addLabelMock = vi.spyOn(githubModule, "addIssueLabel").mockResolvedValue(undefined);
    const action = {
      type: "add_label" as const,
      issueNumber: 42,
      repoFullName: "test/repo",
      label: "status/in-progress",
      reason: "PR needs work",
    };

    const result = await executeAction(action, ["bug", "status/in-progress"]);

    expect(addLabelMock).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.afterLabels).toEqual(["bug", "status/in-progress"]);
  });

  it("removes a label successfully", async () => {
    const removeLabelMock = vi.spyOn(githubModule, "removeIssueLabel").mockResolvedValue(undefined);
    const action = {
      type: "remove_label" as const,
      issueNumber: 42,
      repoFullName: "test/repo",
      label: "status/backlog",
      reason: "Issue is now actionable",
    };

    const result = await executeAction(action, ["bug", "status/backlog"]);

    expect(removeLabelMock).toHaveBeenCalledWith("test/repo", 42, "status/backlog");
    expect(result.success).toBe(true);
    expect(result.afterLabels).toEqual(["bug"]);
  });

  it("skips removing a label that does not exist", async () => {
    const removeLabelMock = vi.spyOn(githubModule, "removeIssueLabel").mockResolvedValue(undefined);
    const action = {
      type: "remove_label" as const,
      issueNumber: 42,
      repoFullName: "test/repo",
      label: "status/done",
      reason: "Cleanup",
    };

    const result = await executeAction(action, ["bug"]);

    expect(removeLabelMock).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("captures error when close fails", async () => {
    vi.spyOn(githubModule, "closeIssue").mockRejectedValue(new Error("API rate limit"));
    const action = {
      type: "close_issue" as const,
      issueNumber: 42,
      repoFullName: "test/repo",
      reason: "Fixed by merged PR #100",
    };

    const result = await executeAction(action, ["bug"], { maxRetries: 0 });

    expect(result.success).toBe(false);
    expect(result.error).toContain("API rate limit");
    expect(result.afterLabels).toEqual(["bug"]);
  });

  it("captures error when add label fails", async () => {
    vi.spyOn(githubModule, "addIssueLabel").mockRejectedValue(new Error("Forbidden"));
    const action = {
      type: "add_label" as const,
      issueNumber: 42,
      repoFullName: "test/repo",
      label: "status/in-review",
      reason: "PR is healthy",
    };

    const result = await executeAction(action, ["bug"], { maxRetries: 0 });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Forbidden");
    expect(result.afterLabels).toEqual(["bug"]);
  });

  it("handles update_lane as no-op", async () => {
    const action = {
      type: "update_lane" as const,
      issueNumber: 42,
      repoFullName: "test/repo",
      reason: "Lane update",
    };

    const result = await executeAction(action, ["bug"]);

    expect(result.success).toBe(true);
    expect(result.afterLabels).toEqual(["bug"]);
  });
});

describe("executeActions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("executes multiple actions sequentially with label propagation", async () => {
    const addLabelMock = vi.spyOn(githubModule, "addIssueLabel").mockResolvedValue(undefined);
    const closeMock = vi.spyOn(githubModule, "closeIssue").mockResolvedValue(undefined);

    const actions = [
      {
        type: "add_label" as const,
        issueNumber: 42,
        repoFullName: "test/repo",
        label: "status/in-progress",
        reason: "PR detected",
      },
      {
        type: "add_label" as const,
        issueNumber: 42,
        repoFullName: "test/repo",
        label: "status/in-review",
        reason: "PR healthy",
      },
    ];

    const results = await executeActions(actions, ["bug"]);

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[0].afterLabels).toEqual(["bug", "status/in-progress"]);
    expect(results[1].success).toBe(true);
    expect(results[1].afterLabels).toEqual(["bug", "status/in-progress", "status/in-review"]);
    expect(addLabelMock).toHaveBeenCalledTimes(2);
  });

  it("stops propagating labels after a failed action", async () => {
    vi.spyOn(githubModule, "addIssueLabel")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("404 Not Found"));
    const closeMock = vi.spyOn(githubModule, "closeIssue").mockResolvedValue(undefined);

    const actions = [
      {
        type: "add_label" as const,
        issueNumber: 42,
        repoFullName: "test/repo",
        label: "status/in-progress",
        reason: "PR detected",
      },
      {
        type: "add_label" as const,
        issueNumber: 42,
        repoFullName: "test/repo",
        label: "status/in-review",
        reason: "PR healthy",
      },
      {
        type: "close_issue" as const,
        issueNumber: 42,
        repoFullName: "test/repo",
        reason: "Fixed by merged PR",
      },
    ];

    const results = await executeActions(actions, ["bug"], { maxRetries: 0 });

    expect(results).toHaveLength(3);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
    expect(results[2].success).toBe(true);
  });

  it("retries on transient failure then succeeds", async () => {
    const addLabelMock = vi.spyOn(githubModule, "addIssueLabel")
      .mockRejectedValueOnce(new Error("403 API rate limit exceeded"))
      .mockRejectedValueOnce(new Error("403 API rate limit exceeded"))
      .mockResolvedValue(undefined);

    const action = {
      type: "add_label" as const,
      issueNumber: 42,
      repoFullName: "test/repo",
      label: "status/in-review",
      reason: "PR is healthy",
    };

    const result = await executeAction(action, ["bug"]);

    expect(result.success).toBe(true);
    expect(addLabelMock).toHaveBeenCalledTimes(3);
    expect(result.afterLabels).toEqual(["bug", "status/in-review"]);
  });

  it("does not retry on non-transient failure", async () => {
    const addLabelMock = vi.spyOn(githubModule, "addIssueLabel")
      .mockRejectedValue(new Error("404 Not Found"));

    const action = {
      type: "add_label" as const,
      issueNumber: 42,
      repoFullName: "test/repo",
      label: "status/in-review",
      reason: "PR is healthy",
    };

    const result = await executeAction(action, ["bug"]);

    expect(result.success).toBe(false);
    expect(addLabelMock).toHaveBeenCalledTimes(1);
  });
});
