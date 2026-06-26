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
});
