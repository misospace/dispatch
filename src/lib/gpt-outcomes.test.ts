import { describe, expect, it } from "vitest";
import { buildAgentQueue } from "./agent-queue";
import {
  VALID_GPT_OUTCOMES,
  isValidGptOutcome,
  GPT_OUTCOME_LABELS,
} from "@/types";

const makeIssue = (
  overrides: Partial<{
    number: number;
    title: string;
    url: string;
    labels: string[];
    lane?: string;
    decomposed?: boolean;
  }> = {},
) => ({
  number: overrides.number ?? 1,
  title: overrides.title ?? "Test issue",
  url: overrides.url ?? "https://github.com/test/repo/issues/1",
  labels: overrides.labels ?? [],
  lane: overrides.lane,
  decomposed: overrides.decomposed ?? false,
});

// ─── GPT Outcome Validation Tests ────────────────────────────────────────────

describe("GPT outcome validation", () => {
  it("accepts all valid outcomes", () => {
    for (const outcome of VALID_GPT_OUTCOMES) {
      expect(isValidGptOutcome(outcome)).toBe(true);
    }
  });

  it("rejects invalid outcomes", () => {
    expect(isValidGptOutcome("PR_MERGED")).toBe(false);
    expect(isValidGptOutcome("completed")).toBe(false);
    expect(isValidGptOutcome("")).toBe(false);
    expect(isValidGptOutcome("random")).toBe(false);
  });

  it("provides human-readable labels for all outcomes", () => {
    for (const outcome of VALID_GPT_OUTCOMES) {
      expect(GPT_OUTCOME_LABELS[outcome]).toBeDefined();
      expect(typeof GPT_OUTCOME_LABELS[outcome]).toBe("string");
      expect(GPT_OUTCOME_LABELS[outcome].length).toBeGreaterThan(0);
    }
  });

  it("labels match expected human-readable descriptions", () => {
    expect(GPT_OUTCOME_LABELS.PR_OPENED).toBe("PR opened");
    expect(GPT_OUTCOME_LABELS.PR_UPDATED).toBe("PR updated");
    expect(GPT_OUTCOME_LABELS.FOLLOW_UP_CREATED).toBe("Follow-up issues created");
    expect(GPT_OUTCOME_LABELS.DESIGN_COMMENT_POSTED).toBe("Design/RFC comment posted");
    expect(GPT_OUTCOME_LABELS.DECOMPOSED_SKIPPED).toBe("Decomposed/skipped");
    expect(GPT_OUTCOME_LABELS.STUCK).toBe("Stuck");
  });
});

// ─── Decomposed Audit Parent Tests ───────────────────────────────────────────

describe("buildAgentQueue with decomposed audit parents", () => {
  it("includes decomposed issues when excludeDecomposed is false (default)", () => {
    const issues = [makeIssue({ number: 1, labels: ["priority/p1"], decomposed: true })];
    const result = buildAgentQueue(issues, "saffron");
    expect(result).toHaveLength(1);
    expect(result[0].decomposed).toBe(true);
  });

  it("excludes decomposed issues when excludeDecomposed is true", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1"], decomposed: true }),
      makeIssue({ number: 2, labels: ["priority/p1"], decomposed: false }),
    ];
    const result = buildAgentQueue(issues, "saffron", { excludeDecomposed: true });
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("excludes only decomposed issues, keeps non-decomposed ones", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1"], lane: "GPT", decomposed: true }),
      makeIssue({ number: 2, labels: ["priority/p1"], lane: "GPT", decomposed: false }),
      makeIssue({ number: 3, labels: ["priority/p0"], lane: "GPT", decomposed: true }),
      makeIssue({ number: 4, labels: ["priority/p0"], lane: "GPT", decomposed: false }),
    ];
    const result = buildAgentQueue(issues, "saffron", { lane: "GPT", excludeDecomposed: true });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.number)).toEqual([4, 2]); // p0 first, then p1
  });

  it("returns decomposed flag in result for each issue", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1"], decomposed: true }),
      makeIssue({ number: 2, labels: ["priority/p1"], decomposed: false }),
    ];
    const result = buildAgentQueue(issues, "saffron");
    expect(result[0].decomposed).toBe(true);
    expect(result[1].decomposed).toBe(false);
  });

  it("defaults decomposed to false when not provided", () => {
    const issues = [makeIssue({ number: 1, labels: ["priority/p1"] })];
    const result = buildAgentQueue(issues, "saffron");
    expect(result[0].decomposed).toBe(false);
  });

  it("works with GPT lane + excludeDecomposed for audit parent workflow", () => {
    // Simulates: broad audit parent (decomposed) vs concrete follow-up issues (not decomposed)
    const issues = [
      makeIssue({ number: 10, title: "Security audit decomposition", labels: ["priority/p1"], lane: "GPT", decomposed: true }),
      makeIssue({ number: 11, title: "Review auth module", labels: ["priority/p1"], lane: "GPT", decomposed: false }),
      makeIssue({ number: 12, title: "Update CI config", labels: ["priority/p2"], lane: "GPT", decomposed: false }),
    ];
    const result = buildAgentQueue(issues, "saffron", { lane: "GPT", excludeDecomposed: true });
    expect(result).toHaveLength(2);
    expect(result[0].number).toBe(11); // p1 first
    expect(result[1].number).toBe(12); // p2 second
  });

  it("does not hardcode agent names in decomposed filtering", () => {
    const issues = [makeIssue({ number: 1, labels: ["priority/p1"], lane: "GPT", decomposed: true })];
    const resultSaffron = buildAgentQueue(issues, "saffron", { excludeDecomposed: true });
    const resultBeta = buildAgentQueue(issues, "beta", { excludeDecomposed: true });

    expect(resultSaffron).toHaveLength(0);
    expect(resultBeta).toHaveLength(0);
  });

  it("does not hardcode repo names in decomposed filtering", () => {
    const issues = [
      makeIssue({
        number: 1,
        url: "https://github.com/misospace/mission-control/issues/1",
        labels: ["priority/p1"],
        decomposed: true,
      }),
      makeIssue({
        number: 2,
        url: "https://github.com/misospace/miso-chat/issues/42",
        labels: ["priority/p1"],
        decomposed: false,
      }),
    ];
    const result = buildAgentQueue(issues, "saffron", { excludeDecomposed: true });
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });
});

// ─── Combined Lane + Decomposed Filtering ────────────────────────────────────

describe("Combined lane and decomposed filtering", () => {
  it("applies both lane filter and decomposed exclusion together", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1"], lane: "GPT", decomposed: true }),
      makeIssue({ number: 2, labels: ["priority/p1"], lane: "GPT", decomposed: false }),
      makeIssue({ number: 3, labels: ["priority/p1"], lane: "NORMAL", decomposed: true }),
      makeIssue({ number: 4, labels: ["priority/p0"], lane: "GPT", decomposed: false }),
    ];
    const result = buildAgentQueue(issues, "saffron", { lane: "GPT", excludeDecomposed: true });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.number)).toEqual([4, 2]);
  });

  it("excludes BACKLOG lane items even when excludeDecomposed is false", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1"], lane: "BACKLOG", decomposed: true }),
      makeIssue({ number: 2, labels: ["priority/p1"], lane: "GPT", decomposed: false }),
    ];
    const result = buildAgentQueue(issues, "saffron");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("excludes BACKLOG lane items even when excludeDecomposed is true", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["priority/p1"], lane: "BACKLOG", decomposed: false }),
      makeIssue({ number: 2, labels: ["priority/p1"], lane: "GPT", decomposed: false }),
    ];
    const result = buildAgentQueue(issues, "saffron", { excludeDecomposed: true });
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });
});
