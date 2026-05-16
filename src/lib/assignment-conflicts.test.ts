import { describe, expect, it } from "vitest";
import {
  analyzeAssignmentConflict,
  buildNewLabels,
  buildUnassignedLabels,
  isAgentLabel,
  isOwnerLabel,
  getAgentLabels,
  getOwnerLabels,
  resolveClaimConflict,
  getAgentFromLabels,
} from "./assignment-conflicts";

describe("analyzeAssignmentConflict", () => {
  it("returns empty arrays for no assignment labels", () => {
    const result = analyzeAssignmentConflict(["priority/p1", "status/backlog"]);
    expect(result.existingAgents).toEqual([]);
    expect(result.existingOwners).toEqual([]);
    expect(result.hasAgentConflict).toBe(false);
    expect(result.hasOwnerConflict).toBe(false);
    expect(result.preservedLabels).toContain("priority/p1");
  });

  it("identifies agent labels", () => {
    const result = analyzeAssignmentConflict(["agent/saffron", "status/in-progress"]);
    expect(result.existingAgents).toContain("agent/saffron");
    expect(result.hasAgentConflict).toBe(true);
  });

  it("identifies owner labels", () => {
    const result = analyzeAssignmentConflict(["owner/alice", "priority/p0"]);
    expect(result.existingOwners).toContain("owner/alice");
    expect(result.hasOwnerConflict).toBe(true);
  });

  it("identifies both agent and owner labels", () => {
    const result = analyzeAssignmentConflict(["agent/saffron", "owner/bob", "status/in-review"]);
    expect(result.existingAgents).toContain("agent/saffron");
    expect(result.existingOwners).toContain("owner/bob");
    expect(result.hasAgentConflict).toBe(true);
    expect(result.hasOwnerConflict).toBe(true);
  });

  it("preserves all non-assignment labels", () => {
    const result = analyzeAssignmentConflict([
      "agent/saffron",
      "owner/alice",
      "priority/p1",
      "status/in-progress",
      "type/feature",
    ]);
    expect(result.preservedLabels).toHaveLength(3);
    expect(result.preservedLabels).toContain("priority/p1");
    expect(result.preservedLabels).toContain("status/in-progress");
    expect(result.preservedLabels).toContain("type/feature");
  });
});

describe("buildNewLabels", () => {
  it("adds agent label and removes conflicting agent labels", () => {
    const result = buildNewLabels(["agent/old-agent", "priority/p1"], "assign_agent", "agent/new-agent");
    expect(result).toContain("agent/new-agent");
    expect(result).not.toContain("agent/old-agent");
    expect(result).toContain("priority/p1");
  });

  it("adds owner label and removes conflicting owner labels", () => {
    const result = buildNewLabels(["owner/old-owner", "status/in-progress"], "assign_owner", "owner/new-owner");
    expect(result).toContain("owner/new-owner");
    expect(result).not.toContain("owner/old-owner");
    expect(result).toContain("status/in-progress");
  });

  it("preserves labels of different types", () => {
    const result = buildNewLabels(["agent/saffron", "owner/alice"], "assign_agent", "agent/bob");
    expect(result).toContain("agent/bob");
    expect(result).not.toContain("agent/saffron");
    expect(result).toContain("owner/alice");
  });
});

describe("buildUnassignedLabels", () => {
  it("removes all agent labels", () => {
    const result = buildUnassignedLabels(["agent/saffron", "priority/p1"], "unassign_agent");
    expect(result).not.toContain("agent/saffron");
    expect(result).toContain("priority/p1");
  });

  it("removes all owner labels", () => {
    const result = buildUnassignedLabels(["owner/alice", "status/in-progress"], "unassign_owner");
    expect(result).not.toContain("owner/alice");
    expect(result).toContain("status/in-progress");
  });

  it("preserves other label types for agent unassign", () => {
    const result = buildUnassignedLabels(["agent/saffron", "owner/bob", "priority/p0"], "unassign_agent");
    expect(result).not.toContain("agent/saffron");
    expect(result).toContain("owner/bob");
    expect(result).toContain("priority/p0");
  });

  it("preserves other label types for owner unassign", () => {
    const result = buildUnassignedLabels(["agent/saffron", "owner/alice", "status/done"], "unassign_owner");
    expect(result).not.toContain("owner/alice");
    expect(result).toContain("agent/saffron");
    expect(result).toContain("status/done");
  });
});

describe("isAgentLabel / isOwnerLabel", () => {
  it("identifies agent labels", () => {
    expect(isAgentLabel("agent/saffron")).toBe(true);
    expect(isAgentLabel("agent/test-worker")).toBe(true);
  });

  it("rejects non-agent labels", () => {
    expect(isAgentLabel("owner/alice")).toBe(false);
    expect(isAgentLabel("status/in-progress")).toBe(false);
    expect(isAgentLabel("agent")).toBe(false);
  });

  it("identifies owner labels", () => {
    expect(isOwnerLabel("owner/alice")).toBe(true);
    expect(isOwnerLabel("owner/bob")).toBe(true);
  });

  it("rejects non-owner labels", () => {
    expect(isOwnerLabel("agent/saffron")).toBe(false);
    expect(isOwnerLabel("priority/p1")).toBe(false);
    expect(isOwnerLabel("owner")).toBe(false);
  });
});

describe("getAgentLabels / getOwnerLabels", () => {
  it("returns all agent labels", () => {
    const result = getAgentLabels(["agent/a", "status/in-progress", "agent/b"]);
    expect(result).toEqual(["agent/a", "agent/b"]);
  });

  it("returns all owner labels", () => {
    const result = getOwnerLabels(["owner/x", "priority/p0", "owner/y"]);
    expect(result).toEqual(["owner/x", "owner/y"]);
  });

  it("returns empty arrays when no matching labels", () => {
    expect(getAgentLabels(["status/done"])).toEqual([]);
    expect(getOwnerLabels(["type/bug"])).toEqual([]);
  });
});

describe("resolveClaimConflict — closed/done issues", () => {
  it("blocks closed issues", () => {
    const result = resolveClaimConflict([], "closed", "test-agent", undefined, false);
    expect(result.conflict).toBe("closed");
    expect(result.reason).toBe("Cannot claim a closed issue");
  });

  it("blocks done issues", () => {
    const result = resolveClaimConflict(["status/done"], "open", "test-agent", undefined, false);
    expect(result.conflict).toBe("done");
    expect(result.reason).toBe("Cannot claim a done issue");
  });

  it("allows open issues without status/done", () => {
    const result = resolveClaimConflict(["status/in-progress"], "open", "test-agent", undefined, false);
    expect(result.conflict).toBe("none");
    expect(result.reason).toBeNull();
  });
});

describe("resolveClaimConflict — agent conflicts", () => {
  it("allows fresh claim when no agent label exists", () => {
    const result = resolveClaimConflict(["priority/p1"], "open", "test-agent", undefined, false);
    expect(result.conflict).toBe("none");
  });

  it("blocks claim when another agent is assigned (no force)", () => {
    const result = resolveClaimConflict(["agent/other-agent"], "open", "test-agent", undefined, false);
    expect(result.conflict).toBe("agent");
    expect(result.reason).toContain("already assigned to other-agent");
  });

  it("allows same agent re-claiming (no conflict)", () => {
    const result = resolveClaimConflict(["agent/test-agent"], "open", "test-agent", undefined, false);
    expect(result.conflict).toBe("none");
  });

  it("denies force-claim by non-admin when another agent is assigned", () => {
    const result = resolveClaimConflict(["agent/other-agent"], "open", "test-agent", true, false);
    expect(result.conflict).toBe("agent");
    expect(result.reason).toContain("Force-claim denied");
    expect(result.reason).toContain("Only admin agents may force-claim");
  });

  it("allows force-claim by admin when another agent is assigned", () => {
    const result = resolveClaimConflict(["agent/other-agent"], "open", "admin/system", true, true);
    expect(result.conflict).toBe("none");
    expect(result.reason).toBeNull();
  });

  it("denies force-claim by non-admin even with owner label present", () => {
    const result = resolveClaimConflict(["agent/other-agent", "owner/alice"], "open", "test-agent", true, false);
    expect(result.conflict).toBe("agent");
    expect(result.reason).toContain("Force-claim denied");
  });
});

describe("resolveClaimConflict — owner labels do not block claims", () => {
  it("allows normal claim when only owner label exists", () => {
    const result = resolveClaimConflict(["owner/alice"], "open", "test-agent", undefined, false);
    expect(result.conflict).toBe("none");
  });

  it("allows force-claim by admin when owner and agent labels exist", () => {
    const result = resolveClaimConflict(["agent/other-agent", "owner/bob"], "open", "admin/system", true, true);
    expect(result.conflict).toBe("none");
  });

  it("allows non-admin claim when only owner label exists (no agent conflict)", () => {
    const result = resolveClaimConflict(["owner/alice"], "open", "test-agent", undefined, false);
    expect(result.conflict).toBe("none");
  });
});

describe("getAgentFromLabels", () => {
  it("returns the agent label if present", () => {
    expect(getAgentFromLabels(["agent/saffron", "priority/p1"])).toBe("agent/saffron");
  });

  it("returns null when no agent label", () => {
    expect(getAgentFromLabels(["owner/alice", "status/in-progress"])).toBeNull();
  });

  it("returns first agent label found", () => {
    expect(getAgentFromLabels(["priority/p1", "agent/bob", "status/done"])).toBe("agent/bob");
  });
});
