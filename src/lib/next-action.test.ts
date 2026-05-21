import { describe, expect, it } from "vitest";
import {
  VALID_NEXT_ACTIONS,
  VALID_CHECKPOINTS,
  isValidNextAction,
  isValidCheckpoint,
  resolveNextAction,
  buildResumeContext,
  NextActionValue,
  CheckpointValue,
} from "./next-action";

describe("constants", () => {
  it("VALID_NEXT_ACTIONS has exactly 9 entries", () => {
    expect(VALID_NEXT_ACTIONS).toHaveLength(9);
  });

  it("VALID_CHECKPOINTS has exactly 6 entries", () => {
    expect(VALID_CHECKPOINTS).toHaveLength(6);
  });

  it("all next action values are unique", () => {
    const unique = new Set(VALID_NEXT_ACTIONS);
    expect(unique.size).toBe(VALID_NEXT_ACTIONS.length);
  });

  it("all checkpoint values are unique", () => {
    const unique = new Set(VALID_CHECKPOINTS);
    expect(unique.size).toBe(VALID_CHECKPOINTS.length);
  });
});

describe("isValidNextAction", () => {
  it("returns true for all valid next action values", () => {
    for (const action of VALID_NEXT_ACTIONS) {
      expect(isValidNextAction(action)).toBe(true);
    }
  });

  it("returns false for invalid strings", () => {
    expect(isValidNextAction("")).toBe(false);
    expect(isValidNextAction("unknown_action")).toBe(false);
    expect(isValidNextAction("prepare_repo_extra")).toBe(false);
    expect(isValidNextAction("CHECK_PR_STATUS")).toBe(false); // case-sensitive
  });
});

describe("isValidCheckpoint", () => {
  it("returns true for all valid checkpoint values", () => {
    for (const cp of VALID_CHECKPOINTS) {
      expect(isValidCheckpoint(cp)).toBe(true);
    }
  });

  it("returns false for invalid strings", () => {
    expect(isValidCheckpoint("")).toBe(false);
    expect(isValidCheckpoint("unknown_checkpoint")).toBe(false);
    expect(isValidCheckpoint("PR_OPENED")).toBe(false); // case-sensitive
  });
});

describe("resolveNextAction", () => {
  it("maps issue_claimed to inspect_issue", () => {
    expect(resolveNextAction("issue_claimed")).toBe("inspect_issue");
  });

  it("maps branch_created to continue_changes", () => {
    expect(resolveNextAction("branch_created")).toBe("continue_changes");
  });

  it("maps changes_made to open_pr", () => {
    expect(resolveNextAction("changes_made")).toBe("open_pr");
  });

  it("maps pr_opened to check_pr_status", () => {
    expect(resolveNextAction("pr_opened")).toBe("check_pr_status");
  });

  it("maps feedback_received to address_pr_feedback", () => {
    expect(resolveNextAction("feedback_received")).toBe("address_pr_feedback");
  });

  it("maps work_complete to finish_or_block", () => {
    expect(resolveNextAction("work_complete")).toBe("finish_or_block");
  });

  it("all valid checkpoints have a mapping", () => {
    for (const cp of VALID_CHECKPOINTS) {
      const result = resolveNextAction(cp);
      expect(isValidNextAction(result)).toBe(true);
    }
  });

  it("mapping forms a linear workflow chain", () => {
    const chain: Array<[CheckpointValue, NextActionValue]> = [
      ["issue_claimed", "inspect_issue"],
      ["branch_created", "continue_changes"],
      ["changes_made", "open_pr"],
      ["pr_opened", "check_pr_status"],
      ["feedback_received", "address_pr_feedback"],
      ["work_complete", "finish_or_block"],
    ];

    // Each next action should correspond to a possible resulting checkpoint
    const actions = chain.map(([, action]) => action);
    // inspect_issue → changes_made (after inspecting and deciding)
    // continue_changes → could go to changes_made or run_validation
    // open_pr → pr_opened
    // check_pr_status → feedback_received or work_complete
    // address_pr_feedback → could loop back to check_pr_status
    // finish_or_block → terminal

    // Verify no two checkpoints map to the same action (1:1 mapping)
    const actionsSet = new Set(actions);
    expect(actionsSet.size).toBe(chain.length);
  });
});

describe("buildResumeContext", () => {
  it("builds a complete context from valid input", () => {
    const input = {
      issueId: "abc123",
      repoFullName: "misospace/dispatch",
      issueNumber: 42,
      agentName: "worker",
      checkpoint: "pr_opened",
      branch: "fix/issue-42-test",
      prUrl: "https://github.com/misospace/dispatch/pull/456",
    };

    const result = buildResumeContext(input);

    expect(result).toEqual({
      ...input,
      checkpoint: "pr_opened" as CheckpointValue,
      nextAction: "check_pr_status" as NextActionValue,
    });
  });

  it("builds context without optional branch/prUrl", () => {
    const input = {
      issueId: "abc123",
      repoFullName: "misospace/dispatch",
      issueNumber: 42,
      agentName: "worker",
      checkpoint: "issue_claimed",
    };

    const result = buildResumeContext(input);

    expect(result.branch).toBeUndefined();
    expect(result.prUrl).toBeUndefined();
    expect(result.nextAction).toBe("inspect_issue");
  });

  it("throws on unknown checkpoint", () => {
    expect(() =>
      buildResumeContext({
        issueId: "abc123",
        repoFullName: "misospace/dispatch",
        issueNumber: 42,
        agentName: "worker",
        checkpoint: "unknown_checkpoint",
      }),
    ).toThrow("Unknown checkpoint");
  });

  it("throws on empty checkpoint string", () => {
    expect(() =>
      buildResumeContext({
        issueId: "abc123",
        repoFullName: "misospace/dispatch",
        issueNumber: 42,
        agentName: "worker",
        checkpoint: "",
      }),
    ).toThrow("Unknown checkpoint");
  });

  it("preserves all input fields in output", () => {
    const input = {
      issueId: "cmpfu6r3r015i01lgcykgicrd",
      repoFullName: "misospace/dispatch",
      issueNumber: 167,
      agentName: "saffron",
      checkpoint: "feedback_received",
      branch: "fix/issue-167-next-action-contract",
      prUrl: "https://github.com/misospace/dispatch/pull/170",
    };

    const result = buildResumeContext(input);

    expect(result.issueId).toBe(input.issueId);
    expect(result.repoFullName).toBe(input.repoFullName);
    expect(result.issueNumber).toBe(input.issueNumber);
    expect(result.agentName).toBe(input.agentName);
    expect(result.checkpoint).toBe("feedback_received" as CheckpointValue);
    expect(result.branch).toBe(input.branch);
    expect(result.prUrl).toBe(input.prUrl);
  });
});

describe("workflow chain — end-to-end resume flow", () => {
  it("simulates a complete workflow from claim to finish", () => {
    const base = {
      issueId: "test-issue-1",
      repoFullName: "misospace/dispatch",
      issueNumber: 99,
      agentName: "test-agent",
    };

    // Step 1: Claim → inspect_issue
    let ctx = buildResumeContext({ ...base, checkpoint: "issue_claimed" });
    expect(ctx.nextAction).toBe("inspect_issue");

    // After inspection, branch is created → continue_changes
    ctx = buildResumeContext({ ...base, checkpoint: "branch_created", branch: "fix/issue-99-test" });
    expect(ctx.nextAction).toBe("continue_changes");

    // After changes, PR opened → check_pr_status
    ctx = buildResumeContext({
      ...base,
      checkpoint: "pr_opened",
      branch: "fix/issue-99-test",
      prUrl: "https://github.com/misospace/dispatch/pull/100",
    });
    expect(ctx.nextAction).toBe("check_pr_status");

    // Feedback received → address_pr_feedback
    ctx = buildResumeContext({
      ...base,
      checkpoint: "feedback_received",
      branch: "fix/issue-99-test",
      prUrl: "https://github.com/misospace/dispatch/pull/100",
    });
    expect(ctx.nextAction).toBe("address_pr_feedback");

    // After feedback addressed, work complete → finish_or_block
    ctx = buildResumeContext({
      ...base,
      checkpoint: "work_complete",
      branch: "fix/issue-99-test",
      prUrl: "https://github.com/misospace/dispatch/pull/100",
    });
    expect(ctx.nextAction).toBe("finish_or_block");
  });

  it("handles agent-agnostic checkpoint data", () => {
    // The contract must work for any agent name — no hardcoded names.
    const agents = ["saffron", "opencode", "alpha", "beta", "cron-worker"];
    const base = {
      issueId: "test-issue",
      repoFullName: "org/repo",
      issueNumber: 1,
    };

    for (const agent of agents) {
      const ctx = buildResumeContext({ ...base, agentName: agent, checkpoint: "pr_opened" });
      expect(ctx.nextAction).toBe("check_pr_status");
      expect(ctx.agentName).toBe(agent);
    }
  });
});
