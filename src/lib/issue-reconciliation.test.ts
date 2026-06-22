import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  classifyLaneByHeuristics,
  evaluateLaneSignals,
  extractFixingIssueNumbers,
  prBranchMatchesIssue,
  checkPrHealth,
  reconcileIssue,
  prReferencesIssue,
  executeAction,
  executeActions,
  shouldReclassifyStaleBacklog,
} from "./issue-reconciliation";
import { setLaneConfig, resetLaneConfig } from "./lane-config";

const githubModule = await import("./github");

describe("classifyLaneByHeuristics", () => {
  it("classifies architecture/design issues as escalated", () => {
    const result = classifyLaneByHeuristics(
      "Database migration strategy for user tables",
      "We need to plan the migration strategy for moving user data to a new schema.",
      ["enhancement"],
    );
    expect(result.lane).toBe("frontier");
    expect(result.confidence).toBe("medium");
  });

  it("classifies audit parent/umbrella issues as escalated", () => {
    const result = classifyLaneByHeuristics(
      "Weekly tech debt audit: Q1 2026",
      null,
      ["audit", "needs-gpt"],
    );
    expect(result.lane).toBe("frontier");
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
    expect(result.lane).toBe("local");
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
    expect(result.lane).toBe("local");
  });

  it("classifies needs-escalation label as escalated", () => {
    const result = classifyLaneByHeuristics("Fix login bug", null, ["status/ready", "needs-escalation"]);
    expect(result.lane).toBe("frontier");
  });

  it("classifies needs-gpt label as escalated", () => {
    const result = classifyLaneByHeuristics("Add new feature", null, ["enhancement", "needs-gpt"]);
    expect(result.lane).toBe("frontier");
  });

  it("does NOT treat priority/p1 as escalation signal", () => {
    const result = classifyLaneByHeuristics("Fix urgent bug", null, ["status/ready", "priority/p1"]);
    expect(result.lane).toBe("local");
  });
});

describe("shouldReclassifyStaleBacklog", () => {
  it("returns null when existing lane is not backlog", () => {
    expect(shouldReclassifyStaleBacklog("normal", "Fix bug", null, ["status/ready"])).toBeNull();
    expect(shouldReclassifyStaleBacklog("escalated", "Fix bug", null, ["status/ready"])).toBeNull();
    expect(shouldReclassifyStaleBacklog(null, "Fix bug", null, ["status/ready"])).toBeNull();
  });

  it("returns null when issue still has status/backlog label", () => {
    expect(shouldReclassifyStaleBacklog("backlog", "Research API", null, ["status/backlog", "enhancement"])).toBeNull();
  });

  it("reclass backlog→normal when current label is status/ready", () => {
    expect(shouldReclassifyStaleBacklog("backlog", "Add dark mode toggle", null, ["status/ready", "enhancement"])).toBe("local");
  });

  it("reclass backlog→normal when current label is status/in-progress", () => {
    expect(shouldReclassifyStaleBacklog("backlog", "Fix login bug", null, ["status/in-progress", "bug"])).toBe("local");
  });

  it("reclass backlog→normal when current label is status/in-review", () => {
    expect(shouldReclassifyStaleBacklog("backlog", "Add settings page", null, ["status/in-review", "enhancement"])).toBe("local");
  });

  it("reclass backlog→escalated when title has escalation signals", () => {
    expect(shouldReclassifyStaleBacklog("backlog", "Database migration strategy for user tables", null, ["status/ready", "enhancement"])).toBe("frontier");
    expect(shouldReclassifyStaleBacklog("backlog", "RFC: new auth architecture", null, ["status/ready"])).toBe("frontier");
  });

  it("reclass backlog→escalated when body has escalation signals", () => {
    expect(shouldReclassifyStaleBacklog("backlog", "Tech debt audit", "Weekly audit parent for Q1 decomposition.", ["status/ready"])).toBe("frontier");
  });

  it("reclass backlog→escalated when needs-escalation label present", () => {
    expect(shouldReclassifyStaleBacklog("backlog", "Fix login bug", null, ["status/ready", "needs-escalation"])).toBe("frontier");
    expect(shouldReclassifyStaleBacklog("backlog", "Add new feature", null, ["status/ready", "needs-gpt"])).toBe("frontier");
  });

  it("does NOT treat priority/p1 as escalation signal", () => {
    expect(shouldReclassifyStaleBacklog("backlog", "Fix urgent bug", null, ["status/ready", "priority/p1"])).toBe("local");
  });

  it("falls back to normal when classifier returns backlog for active-status issue", () => {
    // Issue has status/ready but body contains backlog signals like "placeholder"
    expect(shouldReclassifyStaleBacklog("backlog", "New feature TBD", "This is a placeholder. More details needed.", ["status/ready"])).toBe("local");
  });

  it("returns null when no active status label present", () => {
    expect(shouldReclassifyStaleBacklog("backlog", "Fix bug", null, ["enhancement", "bug"])).toBeNull();
  });

  it("preserves existing normal/escalated lanes by returning null", () => {
    // These verify the route won't overwrite non-backlog lanes
    expect(shouldReclassifyStaleBacklog("normal", "Fix bug", null, ["status/ready"])).toBeNull();
    expect(shouldReclassifyStaleBacklog("escalated", "Fix bug", null, ["status/ready"])).toBeNull();
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

  it("returns needs_work when reviewDecision is CHANGES_REQUESTED", () => {
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
      reviewDecision: "CHANGES_REQUESTED",
    };
    const health = checkPrHealth(pr);
    expect(health.status).toBe("needs_work");
    expect(health.reason).toBe("Review changes requested");
  });

  it("returns healthy when reviewDecision is APPROVED", () => {
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
      reviewDecision: "APPROVED",
    };
    const health = checkPrHealth(pr);
    expect(health.status).toBe("healthy");
  });

  it("returns healthy when reviewDecision is COMMENTED", () => {
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
      reviewDecision: "COMMENTED",
    };
    const health = checkPrHealth(pr);
    expect(health.status).toBe("healthy");
  });

  it("returns needs_work when mergeStateStatus is dirty", () => {
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
      mergeStateStatus: "dirty",
    };
    const health = checkPrHealth(pr);
    expect(health.status).toBe("needs_work");
    expect(health.reason).toBe("Merge state is dirty");
  });

  it("returns needs_work when mergeStateStatus is behind", () => {
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
      mergeStateStatus: "behind",
    };
    const health = checkPrHealth(pr);
    expect(health.status).toBe("needs_work");
  });

  it("returns needs_work when mergeStateStatus is blocked", () => {
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
      mergeStateStatus: "blocked",
    };
    const health = checkPrHealth(pr);
    expect(health.status).toBe("needs_work");
  });

  it("returns needs_work when mergeStateStatus is unknown", () => {
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
      mergeStateStatus: "unknown",
    };
    const health = checkPrHealth(pr);
    expect(health.status).toBe("needs_work");
  });

  it("returns healthy when mergeStateStatus is clean", () => {
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
      mergeStateStatus: "clean",
    };
    const health = checkPrHealth(pr);
    expect(health.status).toBe("healthy");
  });

  it("prioritizes CHANGES_REQUESTED over dirty merge state", () => {
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
      reviewDecision: "CHANGES_REQUESTED",
      mergeStateStatus: "dirty",
    };
    const health = checkPrHealth(pr);
    expect(health.status).toBe("needs_work");
    expect(health.reason).toBe("Review changes requested");
  });

  it("handles null reviewDecision and mergeStateStatus gracefully", () => {
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
      reviewDecision: null,
      mergeStateStatus: null,
    };
    const health = checkPrHealth(pr);
    expect(health.status).toBe("healthy");
    expect(health.reviewDecision).toBe(null);
    expect(health.mergeStateStatus).toBe(null);
  });

  it("handles missing reviewDecision and mergeStateStatus fields gracefully", () => {
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
    } as any;
    const health = checkPrHealth(pr);
    expect(health.status).toBe("healthy");
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

describe("classifyLaneByHeuristics config-aware", () => {
  afterEach(() => {
    resetLaneConfig();
  });

  it("default config stays backward-compatible: concrete issue -> normal", () => {
    const result = classifyLaneByHeuristics(
      "Add dark mode toggle to settings page",
      "Implement a toggle in the settings page.",
      ["enhancement"],
    );
    expect(result.lane).toBe("local");
  });

  it("default config stays backward-compatible: architecture issue -> escalated", () => {
    const result = classifyLaneByHeuristics(
      "Database migration strategy for user tables",
      "We need to plan the migration strategy.",
      ["enhancement"],
    );
    expect(result.lane).toBe("frontier");
  });

  it("default config stays backward-compatible: placeholder -> backlog", () => {
    const result = classifyLaneByHeuristics(
      "New feature TBD",
      "This is a placeholder. More details needed.",
      ["enhancement"],
    );
    expect(result.lane).toBe("backlog");
  });

  it("single claimable lane: actionable issue goes to that lane", () => {
    setLaneConfig({
      lanes: [
        { id: "default", title: "Default", claimable: true },
        { id: "backlog", title: "Backlog", claimable: false },
      ],
    });
    const result = classifyLaneByHeuristics(
      "Add dark mode toggle",
      "Implement a toggle.",
      ["enhancement"],
    );
    expect(result.lane).toBe("default");
  });

  it("single claimable lane: high-complexity goes to same lane (no escalation lane)", () => {
    setLaneConfig({
      lanes: [
        { id: "default", title: "Default", claimable: true },
        { id: "backlog", title: "Backlog", claimable: false },
      ],
    });
    const result = classifyLaneByHeuristics(
      "Database migration strategy",
      "Plan the migration strategy.",
      ["enhancement"],
    );
    expect(result.lane).toBe("default");
  });

  it("single claimable lane: high-complexity goes to explicit escalation lane when configured", () => {
    setLaneConfig({
      lanes: [
        { id: "default", title: "Default", claimable: true, role: "default" },
        { id: "expert", title: "Expert", claimable: true, role: "escalation" },
        { id: "backlog", title: "Backlog", claimable: false },
      ],
    });
    const result = classifyLaneByHeuristics(
      "Database migration strategy",
      "Plan the migration strategy.",
      ["enhancement"],
    );
    expect(result.lane).toBe("expert");
  });

  it("backlog signals go to configured non-claimable lane", () => {
    setLaneConfig({
      lanes: [
        { id: "default", title: "Default", claimable: true },
        { id: "parked", title: "Parked", claimable: false },
      ],
    });
    const result = classifyLaneByHeuristics(
      "New feature TBD",
      "This is a placeholder.",
      ["enhancement"],
    );
    expect(result.lane).toBe("parked");
  });

  it("custom multi-lane config: high-complexity to configured escalation lane", () => {
    setLaneConfig({
      lanes: [
        { id: "alpha", title: "Alpha", claimable: true, role: "default" },
        { id: "beta", title: "Beta", claimable: true, role: "escalation" },
        { id: "gamma", title: "Gamma", claimable: false },
      ],
    });
    const result = classifyLaneByHeuristics(
      "Architecture review for auth service",
      "Design doc for new authentication redesign.",
      ["type/feature"],
    );
    expect(result.lane).toBe("beta");
  });

  it("no hardcoded lane allowlist rejects configured custom lanes", () => {
    setLaneConfig({
      lanes: [
        { id: "fast", title: "Fast Lane", claimable: true },
        { id: "slow", title: "Slow Lane", claimable: true, role: "escalation" },
        { id: "parked", title: "Parked", claimable: false },
      ],
    });
    const normalResult = classifyLaneByHeuristics("Fix typo", null, ["bug"]);
    expect(normalResult.lane).toBe("fast");
    const escalatedResult = classifyLaneByHeuristics(
      "RFC: new auth flow",
      "Design document for authentication redesign",
      ["type/feature"],
    );
    expect(escalatedResult.lane).toBe("slow");
    const backlogResult = classifyLaneByHeuristics(
      "Research API rate limiting",
      null,
      ["enhancement", "status/backlog"],
    );
    expect(backlogResult.lane).toBe("parked");
  });

  it("never returns unknown lane ids", () => {
    setLaneConfig({
      lanes: [
        { id: "custom1", title: "Custom 1", claimable: true },
        { id: "custom2", title: "Custom 2", claimable: false },
      ],
    });
    const lanes = new Set<string>();
    // Test all signal combinations
    lanes.add(
      classifyLaneByHeuristics("Fix typo", null, ["bug"]).lane,
    );
    lanes.add(
      classifyLaneByHeuristics("Architecture review", "Design doc.", ["type/feature"]).lane,
    );
    lanes.add(
      classifyLaneByHeuristics("TBD", "placeholder", ["enhancement"]).lane,
    );
    for (const lane of lanes) {
      expect(["custom1", "custom2"]).toContain(lane);
    }
  });
});

describe("shouldReclassifyStaleBacklog config-aware", () => {
  afterEach(() => {
    resetLaneConfig();
  });

  it("default config: reclass backlog->normal for concrete issue", () => {
    expect(
      shouldReclassifyStaleBacklog("backlog", "Add dark mode toggle", null, ["status/ready", "enhancement"]),
    ).toBe("local");
  });

  it("default config: reclass backlog->escalated for architecture issue", () => {
    expect(
      shouldReclassifyStaleBacklog("backlog", "Database migration strategy for user tables", null, ["status/ready", "enhancement"]),
    ).toBe("frontier");
  });

  it("single claimable lane: reclass to that lane", () => {
    setLaneConfig({
      lanes: [
        { id: "default", title: "Default", claimable: true },
        { id: "backlog", title: "Backlog", claimable: false },
      ],
    });
    expect(
      shouldReclassifyStaleBacklog("backlog", "Add dark mode toggle", null, ["status/ready"]),
    ).toBe("default");
  });

  it("single claimable lane: high-complexity reclass to same lane (no escalation)", () => {
    setLaneConfig({
      lanes: [
        { id: "default", title: "Default", claimable: true },
        { id: "backlog", title: "Backlog", claimable: false },
      ],
    });
    expect(
      shouldReclassifyStaleBacklog("backlog", "Database migration strategy", null, ["status/ready"]),
    ).toBe("default");
  });

  it("custom escalation lane: high-complexity reclass to escalation lane", () => {
    setLaneConfig({
      lanes: [
        { id: "normal", title: "Normal", claimable: true, role: "default" },
        { id: "expert", title: "Expert", claimable: true, role: "escalation" },
        { id: "backlog", title: "Backlog", claimable: false },
      ],
    });
    expect(
      shouldReclassifyStaleBacklog("backlog", "Database migration strategy", null, ["status/ready"]),
    ).toBe("expert");
  });

  it("falls back to default claimable when classifier returns backlog for active-status issue", () => {
    setLaneConfig({
      lanes: [
        { id: "work", title: "Work", claimable: true },
        { id: "backlog", title: "Backlog", claimable: false },
      ],
    });
    expect(
      shouldReclassifyStaleBacklog("backlog", "New feature TBD", "This is a placeholder.", ["status/ready"]),
    ).toBe("work");
  });

  it("rejection of unknown lane ids: never writes hardcoded lane", () => {
    setLaneConfig({
      lanes: [
        { id: "alpha", title: "Alpha", claimable: true },
        { id: "beta", title: "Beta", claimable: true, role: "escalation" },
        { id: "gamma", title: "Gamma", claimable: false },
      ],
    });
    // gamma is the backlog lane; reclassify from gamma
    const result1 = shouldReclassifyStaleBacklog("gamma", "Fix typo", null, ["status/ready"]);
    expect(["alpha", "beta"]).toContain(result1);
    const result2 = shouldReclassifyStaleBacklog("gamma", "Architecture review", "Design doc.", ["status/ready"]);
    expect(["alpha", "beta"]).toContain(result2);
  });
});

describe("shouldReclassifyStaleBacklog — lane aliases", () => {
  afterEach(() => {
    resetLaneConfig();
  });

  it("resolves aliased lane before backlog check", () => {
    setLaneConfig({
      lanes: [
        { id: "local", title: "Local", claimable: true, role: "default" },
        { id: "parking-lot", title: "Parking Lot", claimable: false },
      ],
      laneAliases: { normal: "local", backlog: "parking-lot" },
    });

    // "normal" is aliased to "local", so it's not the backlog lane -> returns null
    const result = shouldReclassifyStaleBacklog("normal", "Fix bug", null, ["status/ready"]);
    expect(result).toBeNull();

    // "backlog" is aliased to "parking-lot", so it IS the backlog lane -> reclassifies
    const result2 = shouldReclassifyStaleBacklog("backlog", "Add dark mode toggle", null, ["status/ready"]);
    expect(result2).toBe("local");
  });

  it("unknown lanes in backlog are not reclassified", () => {
    setLaneConfig({
      lanes: [
        { id: "local", title: "Local", claimable: true },
        { id: "parking-lot", title: "Parking Lot", claimable: false },
      ],
      laneAliases: { normal: "local" },
    });

    // "unknown-old-lane" is not configured and not aliased -> never reclassified
    const result = shouldReclassifyStaleBacklog("unknown-old-lane", "Fix bug", null, ["status/ready"]);
    expect(result).toBeNull();
  });
});
