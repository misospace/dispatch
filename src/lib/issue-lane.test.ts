import { describe, expect, it, afterEach } from "vitest";
import {
  isValidLane,
  isValidConfidence,
  parseLaneClassification,
  validateLaneRecord,
  classifyByHeuristics,
} from "./issue-lane";
import { setLaneConfig, resetLaneConfig } from "./lane-config";

describe("isValidLane", () => {
  it("returns true for valid lanes", () => {
    expect(isValidLane("local")).toBe(true);
    expect(isValidLane("frontier")).toBe(true);
    expect(isValidLane("backlog")).toBe(true);
  });

  it("returns false for invalid lanes", () => {
    expect(isValidLane("gpt")).toBe(false);
    expect(isValidLane("normal-worker")).toBe(false);
    expect(isValidLane(123)).toBe(false);
    expect(isValidLane(null)).toBe(false);
    expect(isValidLane(undefined)).toBe(false);
  });

  it("accepts custom configured lanes", () => {
    setLaneConfig({
      lanes: [
        { id: "fast", title: "Fast Lane", claimable: true },
        { id: "slow", title: "Slow Lane", claimable: true },
        { id: "parked", title: "Parked", claimable: false },
      ],
    });
    expect(isValidLane("fast")).toBe(true);
    expect(isValidLane("slow")).toBe(true);
    expect(isValidLane("parked")).toBe(true);
    expect(isValidLane("normal")).toBe(false);
    resetLaneConfig();
  });
});

describe("isValidConfidence", () => {
  it("returns true for valid confidences", () => {
    expect(isValidConfidence("high")).toBe(true);
    expect(isValidConfidence("medium")).toBe(true);
    expect(isValidConfidence("low")).toBe(true);
  });

  it("returns false for invalid confidences", () => {
    expect(isValidConfidence("extreme")).toBe(false);
    expect(isValidConfidence("100")).toBe(false);
    expect(isValidConfidence(null)).toBe(false);
  });
});

describe("parseLaneClassification", () => {
  it("parses valid classification", () => {
    const result = parseLaneClassification({ lane: "local", confidence: "high", reason: "Concrete bug fix" });
    expect(result).toEqual({ lane: "local", confidence: "high", reason: "Concrete bug fix" });
  });

  it("parses with model field", () => {
    const result = parseLaneClassification({ lane: "frontier", confidence: "medium", reason: "Architecture decision", model: "test-model" });
    expect(result).toEqual({ lane: "frontier", confidence: "medium", reason: "Architecture decision", model: "test-model" });
  });

  it("returns null for invalid lane", () => {
    expect(parseLaneClassification({ lane: "invalid", confidence: "high", reason: "test" })).toBeNull();
  });

  it("returns null for invalid confidence", () => {
    expect(parseLaneClassification({ lane: "local", confidence: "extreme", reason: "test" })).toBeNull();
  });

  it("returns null for empty reason", () => {
    expect(parseLaneClassification({ lane: "local", confidence: "high", reason: "" })).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parseLaneClassification("string")).toBeNull();
    expect(parseLaneClassification(null)).toBeNull();
    expect(parseLaneClassification(123)).toBeNull();
    expect(parseLaneClassification(undefined)).toBeNull();
  });

  it("trims and truncates reason", () => {
    const result = parseLaneClassification({ lane: "local", confidence: "high", reason: "  too long " + "x".repeat(495) });
    expect(result!.reason.length).toBeLessThanOrEqual(500);
  });

  it("parses custom configured lane", () => {
    setLaneConfig({
      lanes: [
        { id: "fast", title: "Fast Lane", claimable: true },
        { id: "parked", title: "Parked", claimable: false },
      ],
    });
    const result = parseLaneClassification({ lane: "fast", confidence: "high", reason: "Custom lane work" });
    expect(result).toEqual({ lane: "fast", confidence: "high", reason: "Custom lane work" });
    resetLaneConfig();
  });
});

describe("validateLaneRecord", () => {
  it("validates correct record", () => {
    const result = validateLaneRecord({ lane: "local", confidence: "high", reason: "test reason" });
    expect(result.valid).toBe(true);
    expect(result.parsed).toEqual({ lane: "local", confidence: "high", reason: "test reason" });
  });

  it("rejects invalid lane", () => {
    const result = validateLaneRecord({ lane: "gpt", confidence: "high", reason: "test" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("invalid lane");
  });

  it("rejects invalid confidence", () => {
    const result = validateLaneRecord({ lane: "local", confidence: "very", reason: "test" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("invalid confidence");
  });

  it("rejects empty reason", () => {
    const result = validateLaneRecord({ lane: "local", confidence: "high", reason: "" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("reason is required");
  });

  it("rejects non-object input", () => {
    const result = validateLaneRecord("string");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("must be an object");
  });
});

describe("classifyByHeuristics", () => {
  it("classifies backlog for status/backlog label", () => {
    const result = classifyByHeuristics("Fix bug", null, ["status/backlog"]);
    expect(result.lane).toBe("backlog");
    expect(result.confidence).toBe("high");
  });

  it("classifies backlog for type/research label", () => {
    const result = classifyByHeuristics("Research options", null, ["type/research"]);
    expect(result.lane).toBe("backlog");
    expect(result.confidence).toBe("high");
  });

  it("classifies escalated when architecture keywords present", () => {
    const result = classifyByHeuristics("Design migration strategy", "Need to plan database migration strategy", ["priority/p1"]);
    expect(result.lane).toBe("frontier");
    expect(result.confidence).toBe("medium");
  });

  it("classifies escalated for rfc/design doc keywords", () => {
    const result = classifyByHeuristics("RFC: New auth flow", "Design document for authentication redesign", ["type/feature"]);
    expect(result.lane).toBe("frontier");
    expect(result.confidence).toBe("medium");
  });

  it("classifies escalated for umbrella/decomposition keywords", () => {
    const result = classifyByHeuristics("Audit findings", "Umbrella issue: audit parent decomposition needed", ["priority/p1"]);
    expect(result.lane).toBe("frontier");
    expect(result.confidence).toBe("medium");
  });

  it("defaults to normal for concrete issues", () => {
    const result = classifyByHeuristics("Fix login bug", "Login fails when password is wrong", ["priority/p2"]);
    expect(result.lane).toBe("local");
    expect(result.confidence).toBe("medium");
  });

  it("does not escalate just for priority/p1 label", () => {
    const result = classifyByHeuristics("Fix typo in README", "Change 'teh' to 'the'", ["priority/p1"]);
    expect(result.lane).toBe("local");
  });

  it("does not escalate just for needs-escalation label", () => {
    const result = classifyByHeuristics("Update config", "Simple config change", ["needs-escalation"]);
    expect(result.lane).toBe("local");
  });
});

describe("classifyByHeuristics config-aware", () => {
  afterEach(() => {
    resetLaneConfig();
  });

  it("default config stays backward-compatible: concrete -> normal", () => {
    const result = classifyByHeuristics("Fix login bug", "Login fails when password is wrong", ["priority/p2"]);
    expect(result.lane).toBe("local");
  });

  it("default config stays backward-compatible: architecture -> escalated", () => {
    const result = classifyByHeuristics("Design migration strategy", "Need to plan database migration strategy", ["priority/p1"]);
    expect(result.lane).toBe("frontier");
  });

  it("default config stays backward-compatible: backlog label -> backlog", () => {
    const result = classifyByHeuristics("Fix bug", null, ["status/backlog"]);
    expect(result.lane).toBe("backlog");
  });

  it("single claimable lane: actionable goes to that lane", () => {
    setLaneConfig({
      lanes: [
        { id: "work", title: "Work", claimable: true },
        { id: "backlog", title: "Backlog", claimable: false },
      ],
    });
    const result = classifyByHeuristics("Fix login bug", "Login fails.", ["bug"]);
    expect(result.lane).toBe("work");
  });

  it("single claimable lane: high-complexity goes to same lane (no escalation)", () => {
    setLaneConfig({
      lanes: [
        { id: "work", title: "Work", claimable: true },
        { id: "backlog", title: "Backlog", claimable: false },
      ],
    });
    const result = classifyByHeuristics("Architecture review", "Design doc for auth.", ["type/feature"]);
    expect(result.lane).toBe("work");
  });

  it("custom escalation lane: high-complexity goes to escalation lane", () => {
    setLaneConfig({
      lanes: [
        { id: "normal", title: "Normal", claimable: true, role: "default" },
        { id: "expert", title: "Expert", claimable: true, role: "escalation" },
        { id: "backlog", title: "Backlog", claimable: false },
      ],
    });
    const result = classifyByHeuristics("Architecture review", "Design doc for auth.", ["type/feature"]);
    expect(result.lane).toBe("expert");
  });

  it("backlog goes to configured non-claimable lane", () => {
    setLaneConfig({
      lanes: [
        { id: "work", title: "Work", claimable: true },
        { id: "parked", title: "Parked", claimable: false },
      ],
    });
    const result = classifyByHeuristics("Research options", null, ["type/research"]);
    expect(result.lane).toBe("parked");
  });

  it("no hardcoded lane allowlist: custom lanes work", () => {
    setLaneConfig({
      lanes: [
        { id: "fast", title: "Fast Lane", claimable: true },
        { id: "slow", title: "Slow Lane", claimable: true, role: "escalation" },
        { id: "parked", title: "Parked", claimable: false },
      ],
    });
    expect(classifyByHeuristics("Fix typo", null, ["bug"]).lane).toBe("fast");
    expect(classifyByHeuristics("RFC: new flow", "Design doc.", ["type/feature"]).lane).toBe("slow");
    expect(classifyByHeuristics("Research", null, ["status/backlog"]).lane).toBe("parked");
  });
});
