import { describe, expect, it } from "vitest";
import {
  createIdleTask,
  createImplementTask,
  createFollowupPrTask,
  createGroomTask,
} from "./agent-task";

describe("createIdleTask", () => {
  it("has shouldRun false", () => {
    const task = createIdleTask("No work available");
    expect(task.shouldRun).toBe(false);
  });

  it("has type idle", () => {
    const task = createIdleTask("No work available");
    expect(task.type).toBe("idle");
  });

  it("preserves reason", () => {
    const task = createIdleTask("All issues are backlog");
    expect(task.reason).toBe("All issues are backlog");
  });

  it("does not contain agentName or issue fields", () => {
    const task = createIdleTask("idle");
    expect("agentName" in task).toBe(false);
    expect("issue" in task).toBe(false);
    expect("instructions" in task).toBe(false);
    expect("forbiddenActions" in task).toBe(false);
  });
});

describe("createImplementTask", () => {
  const baseIssue = {
    repoFullName: "misospace/dispatch",
    number: 393,
    title: "Add AgentTask contract",
    url: "https://github.com/misospace/dispatch/issues/393",
  };

  it("has shouldRun true", () => {
    const task = createImplementTask({ agentName: "alpha", issue: baseIssue });
    expect(task.shouldRun).toBe(true);
  });

  it("has type implement", () => {
    const task = createImplementTask({ agentName: "alpha", issue: baseIssue });
    expect(task.type).toBe("implement");
  });

  it("includes agentName", () => {
    const task = createImplementTask({ agentName: "alpha", issue: baseIssue });
    expect(task.agentName).toBe("alpha");
  });

  it("includes lane when provided", () => {
    const task = createImplementTask({ agentName: "alpha", issue: baseIssue, lane: "escalated" });
    expect(task.lane).toBe("escalated");
  });

  it("omits lane when not provided", () => {
    const task = createImplementTask({ agentName: "alpha", issue: baseIssue });
    expect(task.lane).toBeUndefined();
  });

  it("includes issue fields", () => {
    const task = createImplementTask({ agentName: "alpha", issue: baseIssue });
    expect(task.issue.repoFullName).toBe("misospace/dispatch");
    expect(task.issue.number).toBe(393);
    expect(task.issue.title).toBe("Add AgentTask contract");
    expect(task.issue.url).toBe("https://github.com/misospace/dispatch/issues/393");
  });

  it("includes stopAfter", () => {
    const task = createImplementTask({ agentName: "alpha", issue: baseIssue });
    expect(task.stopAfter).toContain("PR");
  });

  it("includes forbiddenActions by default", () => {
    const task = createImplementTask({ agentName: "alpha", issue: baseIssue });
    expect(task.forbiddenActions).toContain("Merging any pull request");
    expect(task.forbiddenActions).toContain("Grooming unrelated issues");
    expect(task.forbiddenActions).toContain("Claiming another issue while this one is open");
  });

  it("includes default instructions", () => {
    const task = createImplementTask({ agentName: "alpha", issue: baseIssue });
    expect(task.instructions).toContain("Claim or work the assigned issue");
    expect(task.instructions).toContain("Open or update exactly one PR");
  });

  it("preserves custom instructions", () => {
    const task = createImplementTask({ agentName: "alpha", issue: baseIssue, instructions: "Custom instruction" });
    expect(task.instructions).toBe("Custom instruction");
  });

  it("preserves custom stopAfter", () => {
    const task = createImplementTask({ agentName: "alpha", issue: baseIssue, stopAfter: "When done" });
    expect(task.stopAfter).toBe("When done");
  });

  it("preserves custom forbiddenActions", () => {
    const custom = ["No merging"];
    const task = createImplementTask({ agentName: "alpha", issue: baseIssue, forbiddenActions: custom });
    expect(task.forbiddenActions).toEqual(custom);
  });

  it("does not require harness-specific fields", () => {
    const task = createImplementTask({ agentName: "alpha", issue: baseIssue });
    expect("harness" in task).toBe(false);
    expect("workflowRepo" in task).toBe(false);
  });
});

describe("createFollowupPrTask", () => {
  const baseInput = {
    agentName: "beta",
    lane: "normal",
    pullRequest: {
      repoFullName: "misospace/dispatch",
      number: 456,
      url: "https://github.com/misospace/dispatch/pull/456",
    },
    reasons: ["Review feedback", "CI failure"],
  };

  it("has shouldRun true", () => {
    const task = createFollowupPrTask(baseInput);
    expect(task.shouldRun).toBe(true);
  });

  it("has type followup-pr", () => {
    const task = createFollowupPrTask(baseInput);
    expect(task.type).toBe("followup-pr");
  });

  it("includes pullRequest fields", () => {
    const task = createFollowupPrTask(baseInput);
    expect(task.pullRequest.repoFullName).toBe("misospace/dispatch");
    expect(task.pullRequest.number).toBe(456);
    expect(task.pullRequest.url).toBe("https://github.com/misospace/dispatch/pull/456");
  });

  it("includes reasons", () => {
    const task = createFollowupPrTask(baseInput);
    expect(task.reasons).toContain("Review feedback");
    expect(task.reasons).toContain("CI failure");
  });

  it("preserves optional issue when provided", () => {
    const task = createFollowupPrTask({
      ...baseInput,
      issue: {
        repoFullName: "misospace/dispatch",
        number: 393,
        title: "Related issue",
        url: "https://github.com/misospace/dispatch/issues/393",
      },
    });
    expect(task.issue?.number).toBe(393);
  });

  it("omits issue when not provided", () => {
    const task = createFollowupPrTask(baseInput);
    expect(task.issue).toBeUndefined();
  });

  it("includes default instructions about fixing existing PR", () => {
    const task = createFollowupPrTask(baseInput);
    expect(task.instructions).toContain("Fix the existing pull request");
  });

  it("includes forbiddenActions by default", () => {
    const task = createFollowupPrTask(baseInput);
    expect(task.forbiddenActions).toContain("Merging any pull request");
    expect(task.forbiddenActions).toContain("Opening a new pull request");
  });

  it("preserves custom instructions", () => {
    const task = createFollowupPrTask({ ...baseInput, instructions: "Fix lint errors" });
    expect(task.instructions).toBe("Fix lint errors");
  });

  it("preserves repo and PR fields from input", () => {
    const input = {
      agentName: "gamma",
      pullRequest: {
        repoFullName: "other/repo",
        number: 99,
      },
      reasons: ["Trivial fix"],
    };
    const task = createFollowupPrTask(input);
    expect(task.pullRequest.repoFullName).toBe("other/repo");
    expect(task.pullRequest.number).toBe(99);
    expect(task.reasons).toEqual(["Trivial fix"]);
  });

  it("does not require harness-specific fields", () => {
    const task = createFollowupPrTask(baseInput);
    expect("harness" in task).toBe(false);
    expect("workflowRepo" in task).toBe(false);
  });
});

describe("createGroomTask", () => {
  const baseInput = {
    agentName: "gamma",
  };

  it("has shouldRun true", () => {
    const task = createGroomTask(baseInput);
    expect(task.shouldRun).toBe(true);
  });

  it("has type groom", () => {
    const task = createGroomTask(baseInput);
    expect(task.type).toBe("groom");
  });

  it("includes agentName", () => {
    const task = createGroomTask(baseInput);
    expect(task.agentName).toBe("gamma");
  });

  it("includes default groom-specific instructions", () => {
    const task = createGroomTask(baseInput);
    expect(task.instructions).toContain("Enrich the issue");
    expect(task.instructions).toContain("labels");
    expect(task.instructions).toContain("lane");
  });

  it("includes default forbidden actions for grooming", () => {
    const task = createGroomTask(baseInput);
    expect(task.forbiddenActions).toContain("Writing implementation code");
    expect(task.forbiddenActions).toContain("Opening pull requests");
    expect(task.forbiddenActions).not.toContain("Merging any pull request");
  });

  it("preserves optional issue when provided", () => {
    const task = createGroomTask({
      ...baseInput,
      issue: {
        repoFullName: "misospace/dispatch",
        number: 100,
        title: "Needs grooming",
        url: "https://github.com/misospace/dispatch/issues/100",
      },
    });
    expect(task.issue?.number).toBe(100);
    expect(task.issue?.title).toBe("Needs grooming");
  });

  it("omits issue when not provided", () => {
    const task = createGroomTask(baseInput);
    expect(task.issue).toBeUndefined();
  });

  it("preserves custom instructions", () => {
    const task = createGroomTask({ ...baseInput, instructions: "Custom grooming" });
    expect(task.instructions).toBe("Custom grooming");
  });

  it("preserves custom forbiddenActions", () => {
    const custom = ["No code changes"];
    const task = createGroomTask({ ...baseInput, forbiddenActions: custom });
    expect(task.forbiddenActions).toEqual(custom);
  });

  it("does not require harness-specific fields", () => {
    const task = createGroomTask(baseInput);
    expect("harness" in task).toBe(false);
    expect("workflowRepo" in task).toBe(false);
  });
});

describe("AgentTask discriminated union", () => {
  it("idle task is distinguishable by type", () => {
    const task = createIdleTask("no work");
    if (task.type !== "idle") throw new Error("should be idle");
    expect(task.reason).toBe("no work");
  });

  it("implement task is distinguishable by type", () => {
    const task = createImplementTask({
      agentName: "a",
      issue: { repoFullName: "r", number: 1, title: "t", url: "u" },
    });
    if (task.type !== "implement") throw new Error("should be implement");
    expect(task.issue.number).toBe(1);
  });

  it("followup-pr task is distinguishable by type", () => {
    const task = createFollowupPrTask({
      agentName: "a",
      pullRequest: { repoFullName: "r", number: 2 },
      reasons: ["r"],
    });
    if (task.type !== "followup-pr") throw new Error("should be followup-pr");
    expect(task.pullRequest.number).toBe(2);
  });

  it("groom task is distinguishable by type", () => {
    const task = createGroomTask({ agentName: "a" });
    if (task.type !== "groom") throw new Error("should be groom");
    expect(task.agentName).toBe("a");
  });
});
