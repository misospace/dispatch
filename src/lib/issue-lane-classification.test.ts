import { describe, it, expect, vi } from "vitest";
import {
  validateLane,
  validateConfidence,
  validateClassification,
  buildClassificationPrompt,
  classifyIssue,
  noopClassifier,
  shouldIgnoreEscalationLabels,
  isBroadAuditParent,
  hasAcceptanceCriteria,
} from "./issue-lane-classification";

describe("validateLane", () => {
  it("accepts valid lanes", () => {
    expect(validateLane("NORMAL")).toBe("NORMAL");
    expect(validateLane("GPT")).toBe("GPT");
    expect(validateLane("BACKLOG")).toBe("BACKLOG");
  });

  it("rejects invalid lanes", () => {
    expect(validateLane("normal")).toBeNull();
    expect(validateLane("gpt")).toBeNull();
    expect(validateLane("backlog")).toBeNull();
    expect(validateLane("unknown")).toBeNull();
    expect(validateLane(null)).toBeNull();
    expect(validateLane(undefined)).toBeNull();
    expect(validateLane(123)).toBeNull();
  });
});

describe("validateConfidence", () => {
  it("accepts valid confidence values", () => {
    expect(validateConfidence(0)).toBe(0);
    expect(validateConfidence(1)).toBe(1);
    expect(validateConfidence(0.5)).toBe(0.5);
    expect(validateConfidence(0.75)).toBe(0.75);
  });

  it("rejects out-of-range values", () => {
    expect(validateConfidence(-0.1)).toBeNull();
    expect(validateConfidence(1.1)).toBeNull();
    expect(validateConfidence(-1)).toBeNull();
    expect(validateConfidence(2)).toBeNull();
  });

  it("rejects non-numeric values", () => {
    expect(validateConfidence(null)).toBeNull();
    expect(validateConfidence(undefined)).toBeNull();
    expect(validateConfidence("0.5")).toBeNull();
    expect(validateConfidence({})).toBeNull();
    expect(validateConfidence(NaN)).toBeNull();
  });

  it("rounds to 2 decimal places", () => {
    expect(validateConfidence(0.123456)).toBe(0.12);
    expect(validateConfidence(0.999)).toBe(1);
  });
});

describe("validateClassification", () => {
  it("validates a complete classification object", () => {
    const result = validateClassification({
      lane: "NORMAL",
      confidence: 0.8,
      reason: "Concrete implementation task",
      model: "test-model",
    });

    expect(result.lane).toBe("NORMAL");
    expect(result.confidence).toBe(0.8);
    expect(result.reason).toBe("Concrete implementation task");
    expect(result.model).toBe("test-model");
  });

  it("rejects invalid lane in classification", () => {
    const result = validateClassification({
      lane: "INVALID",
      confidence: 0.8,
      reason: "Test",
      model: "test",
    });

    expect(result.lane).toBeNull();
  });

  it("handles missing fields gracefully", () => {
    const result = validateClassification({ lane: "GPT" });
    expect(result.lane).toBe("GPT");
    expect(result.confidence).toBeNull();
    expect(result.reason).toBeNull();
    expect(result.model).toBeNull();
  });

  it("rejects non-object input", () => {
    expect(validateClassification(null)).toEqual({ lane: null, confidence: null, reason: null, model: null });
    expect(validateClassification(undefined)).toEqual({ lane: null, confidence: null, reason: null, model: null });
    expect(validateClassification("string")).toEqual({ lane: null, confidence: null, reason: null, model: null });
    expect(validateClassification(123)).toEqual({ lane: null, confidence: null, reason: null, model: null });
  });

  it("trims reason and model strings", () => {
    const result = validateClassification({
      lane: "BACKLOG",
      confidence: 0.5,
      reason: "  Not actionable yet  ",
      model: "  test-model  ",
    });

    expect(result.reason).toBe("Not actionable yet");
    expect(result.model).toBe("test-model");
  });

  it("rejects empty reason and model", () => {
    const result = validateClassification({
      lane: "NORMAL",
      confidence: 0.5,
      reason: "",
      model: "",
    });

    expect(result.reason).toBeNull();
    expect(result.model).toBeNull();
  });
});

describe("buildClassificationPrompt", () => {
  it("includes title and body in prompt", () => {
    const prompt = buildClassificationPrompt({
      title: "Fix login bug",
      body: "Users can't log in with SSO",
      labels: ["bug"],
    });

    expect(prompt).toContain("Fix login bug");
    expect(prompt).toContain("Users can't log in with SSO");
  });

  it("includes labels when present", () => {
    const prompt = buildClassificationPrompt({
      title: "Add feature",
      body: null,
      labels: ["priority/p1", "type/feature"],
    });

    expect(prompt).toContain("priority/p1");
    expect(prompt).toContain("type/feature");
  });

  it("handles null body gracefully", () => {
    const prompt = buildClassificationPrompt({
      title: "Simple issue",
      body: null,
      labels: [],
    });

    expect(prompt).toContain("Simple issue");
    expect(prompt).not.toContain("Body:");
  });

  it("does not contain hardcoded agent names", () => {
    const prompt = buildClassificationPrompt({
      title: "Test issue",
      body: "Some body text",
      labels: [],
    });

    expect(prompt).not.toContain("saffron");
    expect(prompt).not.toContain("mission-control");
    expect(prompt).not.toContain("joryirving");
  });

  it("does not contain hardcoded repo names", () => {
    const prompt = buildClassificationPrompt({
      title: "Test issue",
      body: null,
      labels: [],
    });

    expect(prompt).not.toContain("mission-control");
    expect(prompt).not.toContain("miso-gallery");
  });

  it("escapes special characters in title/body", () => {
    const prompt = buildClassificationPrompt({
      title: "Issue with `backticks` and {braces}",
      body: null,
      labels: [],
    });

    expect(prompt).toContain("\\`backticks\\`");
    expect(prompt).toContain("{{braces}}");
  });
});

describe("classifyIssue", () => {
  it("returns validated classification from classifier", async () => {
    const mockClassifier = vi.fn().mockResolvedValue({
      lane: "NORMAL",
      confidence: 0.9,
      reason: "Concrete task",
    });

    const result = await classifyIssue(
      { title: "Fix bug", body: null, labels: ["bug"] },
      mockClassifier,
      "test-model",
    );

    expect(result.lane).toBe("NORMAL");
    expect(result.confidence).toBe(0.9);
    expect(result.reason).toBe("Concrete task");
    expect(result.model).toBe("test-model");
  });

  it("defaults to NORMAL when classifier throws", async () => {
    const mockClassifier = vi.fn().mockRejectedValue(new Error("LLM unavailable"));

    const result = await classifyIssue(
      { title: "Fix bug", body: null, labels: [] },
      mockClassifier,
      "test-model",
    );

    expect(result.lane).toBe("NORMAL");
    expect(result.confidence).toBe(0.1);
    expect(result.reason).toContain("Classification failed");
  });

  it("defaults to NORMAL when classifier returns invalid lane", async () => {
    const mockClassifier = vi.fn().mockResolvedValue({
      lane: "INVALID_LANE",
      confidence: 0.5,
      reason: "Test",
    });

    const result = await classifyIssue(
      { title: "Test", body: null, labels: [] },
      mockClassifier,
      "test-model",
    );

    expect(result.lane).toBe("NORMAL");
  });

  it("uses noopClassifier by default", async () => {
    const result = await classifyIssue(
      { title: "Test issue", body: null, labels: [] },
      undefined,
      "default",
    );

    expect(result.lane).toBe("NORMAL");
    expect(result.model).toBe("default");
  });
});

describe("noopClassifier", () => {
  it("returns NORMAL with 0.5 confidence", async () => {
    const result = await noopClassifier("any prompt");
    expect(result.lane).toBe("NORMAL");
    expect(result.confidence).toBe(0.5);
    expect(result.reason).toContain("Default classification");
  });
});

describe("shouldIgnoreEscalationLabels", () => {
  it("returns true for escalation labels", () => {
    expect(shouldIgnoreEscalationLabels(["needs-gpt"])).toBe(true);
    expect(shouldIgnoreEscalationLabels(["escalated"])).toBe(true);
    expect(shouldIgnoreEscalationLabels(["priority/p1", "needs-gpt"])).toBe(true);
  });

  it("returns false for non-escalation labels", () => {
    expect(shouldIgnoreEscalationLabels(["priority/p1"])).toBe(false);
    expect(shouldIgnoreEscalationLabels(["type/feature"])).toBe(false);
    expect(shouldIgnoreEscalationLabels([])).toBe(false);
  });
});

describe("isBroadAuditParent", () => {
  it("detects audit parent issues", () => {
    expect(isBroadAuditParent({ title: "Security audit decomposition", body: null })).toBe(true);
    expect(isBroadAuditParent({ title: "Umbrella: CI improvements", body: null })).toBe(true);
    expect(isBroadAuditParent({ title: "Epic: Auth overhaul", body: null })).toBe(true);
  });

  it("returns false for concrete issues", () => {
    expect(isBroadAuditParent({ title: "Fix login bug", body: null })).toBe(false);
    expect(isBroadAuditParent({ title: "Add unit tests", body: null })).toBe(false);
    expect(isBroadAuditParent({ title: "Update README", body: null })).toBe(false);
  });
});

describe("hasAcceptanceCriteria", () => {
  it("detects acceptance criteria patterns", () => {
    expect(hasAcceptanceCriteria({ title: "Fix login", body: "Acceptance criteria:\n- User can log in with SSO" })).toBe(true);
    expect(hasAcceptanceCriteria({ title: "Add feature", body: "Given X, when Y, then Z" })).toBe(true);
    expect(hasAcceptanceCriteria({ title: "Fix bug", body: "Checklist:\n- [ ] Test case 1\n- [ ] Test case 2" })).toBe(true);
  });

  it("returns false for issues without acceptance criteria", () => {
    expect(hasAcceptanceCriteria({ title: "Fix login", body: null })).toBe(false);
    expect(hasAcceptanceCriteria({ title: "Research options", body: "Looking into different approaches" })).toBe(false);
  });
});
