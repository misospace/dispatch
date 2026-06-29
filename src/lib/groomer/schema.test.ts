import { describe, expect, it } from "vitest";
import { validateGroomerOutput, type GroomerOutput } from "./schema";

describe("groomer schema validation", () => {
  const validOutput: GroomerOutput = {
    labelsToAdd: ["status/ready", "priority/p1"],
    labelsToRemove: [],
    lane: { id: "local", confidence: "high", reason: "clear implementation task" },
    summary: "Issue is ready for work.",
  };

  it("accepts valid minimal output", () => {
    const result = validateGroomerOutput(validOutput);
    expect(result.valid).toBe(true);
  });

  it("accepts optional fields", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      githubComment: "Groomed by hosted groomer.",
      needsInfoReason: "Missing acceptance criteria",
      blockedReason: "Waiting on design decision",
      nextGroomingAction: "promote_to_ready",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects invalid nextGroomingAction", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      nextGroomingAction: "do_whatever",
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toContain("nextGroomingAction");
  });

  it("rejects agent/* in labelsToRemove", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      labelsToRemove: ["agent/bob"],
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toContain("agent/");
  });

  it("rejects invalid status label", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      labelsToAdd: ["status/invalid"],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects invalid priority label", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      labelsToAdd: ["priority/p9"],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects invalid type label", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      labelsToAdd: ["type/epic"],
    });
    expect(result.valid).toBe(false);
  });

  it("accepts valid status labels", () => {
    for (const label of ["status/backlog", "status/ready", "status/in-progress", "status/in-review", "status/done"]) {
      const result = validateGroomerOutput({ ...validOutput, labelsToAdd: [label] });
      expect(result.valid).toBe(true);
    }
  });

  it("accepts valid priority labels", () => {
    for (const label of ["priority/p0", "priority/p1", "priority/p2", "priority/p3"]) {
      const result = validateGroomerOutput({ ...validOutput, labelsToAdd: [label] });
      expect(result.valid).toBe(true);
    }
  });

  it("accepts valid type labels", () => {
    for (const label of ["type/bug", "type/feature", "type/chore", "type/research", "type/security"]) {
      const result = validateGroomerOutput({ ...validOutput, labelsToAdd: [label] });
      expect(result.valid).toBe(true);
    }
  });

  it("rejects invalid label prefix like owner/*", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      labelsToAdd: ["owner/alice"],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects agent/* in labelsToAdd", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      labelsToAdd: ["agent/bob"],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects invalid lane id", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      lane: { id: "unknown-lane", confidence: "high", reason: "test" },
    });
    expect(result.valid).toBe(false);
  });

  it("rejects invalid confidence value", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      lane: { id: "local", confidence: "certain" as any, reason: "test" },
    });
    expect(result.valid).toBe(false);
  });

  it("rejects empty lane reason", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      lane: { id: "local", confidence: "high", reason: "" },
    });
    expect(result.valid).toBe(false);
  });

  it("rejects missing lane field", () => {
    const result = validateGroomerOutput({
      labelsToAdd: [],
      labelsToRemove: [],
    } as any);
    expect(result.valid).toBe(false);
  });

  it("rejects non-string summary when provided", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      summary: 123 as any,
    });
    expect(result.valid).toBe(false);
  });

  it("accepts empty labelsToAdd and labelsToRemove", () => {
    const result = validateGroomerOutput({
      labelsToAdd: [],
      labelsToRemove: [],
      lane: { id: "backlog", confidence: "medium", reason: "not actionable yet" },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects labelsToRemove with invalid status label", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      labelsToRemove: ["status/invalid"],
    });
    expect(result.valid).toBe(false);
  });

  it("collects multiple errors", () => {
    const result = validateGroomerOutput({
      labelsToAdd: ["agent/bad", "priority/p9"],
      labelsToRemove: ["agent/alice"],
      lane: { id: "unknown", confidence: "bad" as any, reason: "" },
    } as any);
    expect(result.valid).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(1);
  });

  it("accepts valid backlog lane", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      lane: { id: "backlog", confidence: "medium", reason: "needs more detail" },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts valid frontier lane", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      lane: { id: "frontier", confidence: "high", reason: "architecture decision needed" },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts valid cloud lane", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      lane: { id: "cloud", confidence: "high", reason: "cloud model task" },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects project/* labels in add", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      labelsToAdd: ["project/k8s"],
    });
    expect(result.valid).toBe(false);
  });

  // --- Null tolerance for optional fields ---

  it("accepts null summary (treated as omitted)", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      summary: null as any,
    });
    expect(result.valid).toBe(true);
    expect(result.parsed?.summary).toBeUndefined();
  });

  it("accepts null githubComment (treated as omitted)", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      githubComment: null as any,
    });
    expect(result.valid).toBe(true);
    expect(result.parsed?.githubComment).toBeUndefined();
  });

  it("accepts null needsInfoReason (treated as omitted)", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      needsInfoReason: null as any,
    });
    expect(result.valid).toBe(true);
    expect(result.parsed?.needsInfoReason).toBeUndefined();
  });

  it("accepts null blockedReason (treated as omitted)", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      blockedReason: null as any,
    });
    expect(result.valid).toBe(true);
    expect(result.parsed?.blockedReason).toBeUndefined();
  });

  it("accepts null nextGroomingAction (treated as omitted)", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      nextGroomingAction: null as any,
    });
    expect(result.valid).toBe(true);
    expect(result.parsed?.nextGroomingAction).toBeUndefined();
  });

  it("rejects non-null non-string summary", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      summary: 123 as any,
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toContain("summary must be a string");
  });

  it("rejects non-null non-string githubComment", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      githubComment: 123 as any,
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toContain("githubComment must be a string");
  });

  it("rejects non-null non-string needsInfoReason", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      needsInfoReason: 123 as any,
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toContain("needsInfoReason must be a string");
  });

  it("rejects non-null non-string blockedReason", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      blockedReason: 123 as any,
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toContain("blockedReason must be a string");
  });

  it("rejects non-null non-string nextGroomingAction", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      nextGroomingAction: 123 as any,
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toContain("nextGroomingAction must be a string");
  });

  // --- Schema-driven enum validation & alias resolution ---

  it("resolves lane alias: raw 'normal' -> resolved 'local', mutation applied, resolution event recorded", () => {
    const result = validateGroomerOutput({
      labelsToAdd: [],
      labelsToRemove: [],
      lane: { id: "normal", confidence: "high", reason: "test" },
    });
    expect(result.valid).toBe(true);
    expect(result.parsed?.lane.id).toBe("local");
    expect(result.resolutions).toHaveLength(1);
    expect(result.resolutions?.[0]).toEqual({
      field: "lane.id",
      rawValue: "normal",
      resolvedValue: "local",
      source: "alias",
    });
  });

  it("resolves lane alias: raw 'escalated' -> resolved 'frontier'", () => {
    const result = validateGroomerOutput({
      labelsToAdd: [],
      labelsToRemove: [],
      lane: { id: "escalated", confidence: "medium", reason: "complex task" },
    });
    expect(result.valid).toBe(true);
    expect(result.parsed?.lane.id).toBe("frontier");
    expect(result.resolutions).toHaveLength(1);
    expect(result.resolutions?.[0].rawValue).toBe("escalated");
    expect(result.resolutions?.[0].resolvedValue).toBe("frontier");
  });

  it("lane configured directly: no resolution event", () => {
    const result = validateGroomerOutput({
      labelsToAdd: [],
      labelsToRemove: [],
      lane: { id: "local", confidence: "high", reason: "test" },
    });
    expect(result.valid).toBe(true);
    expect(result.parsed?.lane.id).toBe("local");
    expect(result.resolutions).toHaveLength(0);
  });

  it("unknown lane: validation error, no resolution event", () => {
    const result = validateGroomerOutput({
      labelsToAdd: [],
      labelsToRemove: [],
      lane: { id: "bogus-lane", confidence: "high", reason: "test" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toContain("lane id");
    expect(result.resolutions).toHaveLength(0);
  });

  it("multiple enum fields with aliases: both events appear in resolutions", () => {
    const result = validateGroomerOutput({
      labelsToAdd: [],
      labelsToRemove: [],
      lane: { id: "normal", confidence: "high", reason: "test" },
      actionability: "ready",
      nextGroomingAction: "promote_to_ready",
    });
    expect(result.valid).toBe(true);
    // Only lane.id has an alias hit here (actionability and nextGroomingAction are canonical)
    expect(result.resolutions).toHaveLength(1);
    expect(result.resolutions?.[0].field).toBe("lane.id");
  });

  it("empty aliases map: behavior matches no-aliases (no spurious events)", () => {
    const result = validateGroomerOutput({
      labelsToAdd: [],
      labelsToRemove: [],
      lane: { id: "local", confidence: "high", reason: "test" },
      actionability: "ready",
    });
    expect(result.valid).toBe(true);
    expect(result.resolutions).toHaveLength(0);
  });

  it("resolutions is an empty array on valid output with no aliases", () => {
    const result = validateGroomerOutput(validOutput);
    expect(result.valid).toBe(true);
    expect(Array.isArray(result.resolutions)).toBe(true);
    expect(result.resolutions).toHaveLength(0);
  });

  it("resolutions is an empty array on invalid output (still present)", () => {
    const result = validateGroomerOutput({
      labelsToAdd: [],
      labelsToRemove: [],
      lane: { id: "bogus", confidence: "high", reason: "test" },
    });
    expect(result.valid).toBe(false);
    expect(Array.isArray(result.resolutions)).toBe(true);
  });

  it("resolutions array is present on non-object input", () => {
    const result = validateGroomerOutput("not an object");
    expect(result.valid).toBe(false);
    expect(Array.isArray(result.resolutions)).toBe(false); // early return, no resolutions
  });

  it("resolutions array is present on null input", () => {
    const result = validateGroomerOutput(null as any);
    expect(result.valid).toBe(false);
  });

  // ─── proposedTitle validation ───

  it("accepts valid proposedTitle (10-200 chars)", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      proposedTitle: "Fix SSO/OIDC callback state verification mismatch",
    });
    expect(result.valid).toBe(true);
    expect(result.parsed?.proposedTitle).toBe("Fix SSO/OIDC callback state verification mismatch");
  });

  it("rejects proposedTitle that is too short (< 10 chars)", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      proposedTitle: "Fix bug",
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toContain("proposedTitle must be between 10 and 200 characters");
  });

  it("rejects proposedTitle that is too long (> 200 chars)", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      proposedTitle: "A".repeat(201),
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toContain("proposedTitle must be between 10 and 200 characters");
  });

  it("accepts null proposedTitle (treated as omitted)", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      proposedTitle: null as any,
    });
    expect(result.valid).toBe(true);
    expect(result.parsed?.proposedTitle).toBeUndefined();
  });

  // ─── proposedBody validation ───

  it("accepts valid proposedBody (under 10000 chars)", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      proposedBody: "## Context\nThis issue relates to the login flow.",
    });
    expect(result.valid).toBe(true);
    expect(result.parsed?.proposedBody).toBe("## Context\nThis issue relates to the login flow.");
  });

  it("rejects proposedBody that is too long (> 10000 chars)", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      proposedBody: "A".repeat(10_001),
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toContain("proposedBody must be under 10000 characters");
  });

  it("accepts null proposedBody (treated as omitted)", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      proposedBody: null as any,
    });
    expect(result.valid).toBe(true);
    expect(result.parsed?.proposedBody).toBeUndefined();
  });

  it("accepts both proposedTitle and proposedBody together", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      proposedTitle: "Fix SSO callback state mismatch in auth module",
      proposedBody: "## Context\nThe SSO login flow has a bug.",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects non-string proposedTitle when provided", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      proposedTitle: 123 as any,
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toContain("proposedTitle must be a string");
  });

  it("rejects non-string proposedBody when provided", () => {
    const result = validateGroomerOutput({
      ...validOutput,
      proposedBody: 123 as any,
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toContain("proposedBody must be a string");
  });
});
