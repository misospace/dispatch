import { describe, expect, it } from "vitest";
import {
  analyzeAssignmentConflict,
  buildNewLabels,
  buildUnassignedLabels,
  isAgentLabel,
  isOwnerLabel,
  getAgentLabels,
  getOwnerLabels,
} from "./assignment-conflicts";

describe("analyzeAssignmentConflict", () => {
  it("returns empty conflicts when no agent or owner labels exist", () => {
    const result = analyzeAssignmentConflict(["status/backlog", "priority/p1"]);
    expect(result.existingAgents).toEqual([]);
    expect(result.existingOwners).toEqual([]);
    expect(result.hasAgentConflict).toBe(false);
    expect(result.hasOwnerConflict).toBe(false);
    expect(result.preservedLabels).toEqual(["status/backlog", "priority/p1"]);
  });

  it("detects existing agent label conflicts", () => {
    const result = analyzeAssignmentConflict(["agent/worker", "status/backlog"]);
    expect(result.existingAgents).toEqual(["agent/worker"]);
    expect(result.hasAgentConflict).toBe(true);
    expect(result.preservedLabels).toEqual(["status/backlog"]);
  });

  it("detects existing owner label conflicts", () => {
    const result = analyzeAssignmentConflict(["owner/alice", "priority/p1"]);
    expect(result.existingOwners).toEqual(["owner/alice"]);
    expect(result.hasOwnerConflict).toBe(true);
    expect(result.preservedLabels).toEqual(["priority/p1"]);
  });

  it("detects both agent and owner conflicts simultaneously", () => {
    const result = analyzeAssignmentConflict([
      "agent/worker",
      "owner/bob",
      "status/in-progress",
    ]);
    expect(result.existingAgents).toEqual(["agent/worker"]);
    expect(result.existingOwners).toEqual(["owner/bob"]);
    expect(result.hasAgentConflict).toBe(true);
    expect(result.hasOwnerConflict).toBe(true);
    expect(result.preservedLabels).toEqual(["status/in-progress"]);
  });

  it("detects multiple agent labels as conflicts", () => {
    const result = analyzeAssignmentConflict([
      "agent/old-worker",
      "agent/dup-worker",
      "status/backlog",
    ]);
    expect(result.existingAgents).toEqual(["agent/old-worker", "agent/dup-worker"]);
    expect(result.hasAgentConflict).toBe(true);
  });

  it("preserves all non-assignment labels", () => {
    const result = analyzeAssignmentConflict([
      "status/backlog",
      "priority/p1",
      "type/feature",
      "agent/worker",
      "owner/alice",
      "project/board",
    ]);
    expect(result.preservedLabels).toEqual([
      "status/backlog",
      "priority/p1",
      "type/feature",
      "project/board",
    ]);
  });

  it("handles empty label set", () => {
    const result = analyzeAssignmentConflict([]);
    expect(result.existingAgents).toEqual([]);
    expect(result.existingOwners).toEqual([]);
    expect(result.hasAgentConflict).toBe(false);
    expect(result.hasOwnerConflict).toBe(false);
    expect(result.preservedLabels).toEqual([]);
  });
});

describe("buildNewLabels", () => {
  it("adds agent label when no conflict exists", () => {
    const result = buildNewLabels(["status/backlog"], "assign_agent", "agent/worker");
    expect(result).toEqual(["status/backlog", "agent/worker"]);
  });

  it("replaces existing agent label with new one", () => {
    const result = buildNewLabels(
      ["status/backlog", "agent/old-worker"],
      "assign_agent",
      "agent/new-worker"
    );
    expect(result).toEqual(["status/backlog", "agent/new-worker"]);
  });

  it("removes all existing agent labels before adding new one", () => {
    const result = buildNewLabels(
      ["agent/dup1", "agent/dup2", "status/backlog"],
      "assign_agent",
      "agent/worker"
    );
    expect(result).toEqual(["status/backlog", "agent/worker"]);
  });

  it("preserves owner labels when assigning agent", () => {
    const result = buildNewLabels(
      ["owner/alice", "status/in-progress"],
      "assign_agent",
      "agent/worker"
    );
    expect(result).toEqual(["owner/alice", "status/in-progress", "agent/worker"]);
  });

  it("replaces existing owner label with new one", () => {
    const result = buildNewLabels(
      ["status/backlog", "owner/old-owner"],
      "assign_owner",
      "owner/new-owner"
    );
    expect(result).toEqual(["status/backlog", "owner/new-owner"]);
  });

  it("preserves agent labels when assigning owner", () => {
    const result = buildNewLabels(
      ["agent/worker", "status/in-progress"],
      "assign_owner",
      "owner/alice"
    );
    expect(result).toEqual(["agent/worker", "status/in-progress", "owner/alice"]);
  });

  it("handles empty label set", () => {
    const result = buildNewLabels([], "assign_agent", "agent/worker");
    expect(result).toEqual(["agent/worker"]);
  });

  it("preserves priority and type labels during agent assignment", () => {
    const result = buildNewLabels(
      ["priority/p1", "type/bug", "agent/old"],
      "assign_agent",
      "agent/new"
    );
    expect(result).toEqual(["priority/p1", "type/bug", "agent/new"]);
  });
});

describe("buildUnassignedLabels", () => {
  it("removes all agent labels", () => {
    const result = buildUnassignedLabels(
      ["status/backlog", "agent/worker"],
      "unassign_agent"
    );
    expect(result).toEqual(["status/backlog"]);
  });

  it("removes all owner labels", () => {
    const result = buildUnassignedLabels(
      ["status/in-progress", "owner/alice"],
      "unassign_owner"
    );
    expect(result).toEqual(["status/in-progress"]);
  });

  it("removes multiple agent labels in one unassign", () => {
    const result = buildUnassignedLabels(
      ["agent/dup1", "agent/dup2", "priority/p1"],
      "unassign_agent"
    );
    expect(result).toEqual(["priority/p1"]);
  });

  it("preserves agent labels when unassigning owner", () => {
    const result = buildUnassignedLabels(
      ["agent/worker", "owner/alice"],
      "unassign_owner"
    );
    expect(result).toEqual(["agent/worker"]);
  });

  it("preserves owner labels when unassigning agent", () => {
    const result = buildUnassignedLabels(
      ["agent/worker", "owner/alice"],
      "unassign_agent"
    );
    expect(result).toEqual(["owner/alice"]);
  });

  it("handles empty label set", () => {
    const result = buildUnassignedLabels([], "unassign_agent");
    expect(result).toEqual([]);
  });
});

describe("isAgentLabel / isOwnerLabel", () => {
  it("identifies agent labels", () => {
    expect(isAgentLabel("agent/worker")).toBe(true);
    expect(isAgentLabel("agent/some-agent")).toBe(true);
    expect(isAgentLabel("owner/worker")).toBe(false);
    expect(isAgentLabel("status/backlog")).toBe(false);
  });

  it("identifies owner labels", () => {
    expect(isOwnerLabel("owner/alice")).toBe(true);
    expect(isOwnerLabel("owner/bob")).toBe(true);
    expect(isOwnerLabel("agent/worker")).toBe(false);
    expect(isOwnerLabel("priority/p1")).toBe(false);
  });

  it("handles edge cases", () => {
    expect(isAgentLabel("agent/")).toBe(true);
    expect(isOwnerLabel("owner/")).toBe(true);
    expect(isAgentLabel("")).toBe(false);
    expect(isOwnerLabel("")).toBe(false);
  });
});

describe("getAgentLabels / getOwnerLabels", () => {
  it("extracts all agent labels", () => {
    const result = getAgentLabels([
      "agent/worker",
      "status/backlog",
      "agent/reviewer",
    ]);
    expect(result).toEqual(["agent/worker", "agent/reviewer"]);
  });

  it("extracts all owner labels", () => {
    const result = getOwnerLabels([
      "owner/alice",
      "priority/p1",
      "owner/bob",
    ]);
    expect(result).toEqual(["owner/alice", "owner/bob"]);
  });

  it("returns empty arrays when no matching labels exist", () => {
    expect(getAgentLabels(["status/backlog", "priority/p1"])).toEqual([]);
    expect(getOwnerLabels(["type/feature", "status/done"])).toEqual([]);
  });
});

// Two p0s stalled 20 days because a re-claim by the same agent counted as a
// conflict with itself: the claim route 409'd "already assigned to foreman-coder"
// on every tick, and claim_one skipped the candidate rather than starving the lane,
// so nothing ever surfaced it.
describe("analyzeAssignmentConflict — self-claim", () => {
  it("does not report a conflict when the only agent label is the assigning agent", () => {
    const a = analyzeAssignmentConflict(["status/ready", "agent/foreman-coder"], "agent/foreman-coder");
    expect(a.hasAgentConflict).toBe(false);
    expect(a.existingAgents).toEqual(["agent/foreman-coder"]);
  });

  it("still reports a conflict for a different agent", () => {
    const a = analyzeAssignmentConflict(["status/ready", "agent/other-bot"], "agent/foreman-coder");
    expect(a.hasAgentConflict).toBe(true);
  });

  it("reports a conflict when another agent is present alongside the assigning agent", () => {
    const a = analyzeAssignmentConflict(["agent/foreman-coder", "agent/other-bot"], "agent/foreman-coder");
    expect(a.hasAgentConflict).toBe(true);
  });

  it("keeps the old behaviour when no assigning agent is supplied", () => {
    const a = analyzeAssignmentConflict(["agent/foreman-coder"]);
    expect(a.hasAgentConflict).toBe(true);
  });
});
