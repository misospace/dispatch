import { describe, expect, it } from "vitest";
import {
  factsShowIncompleteInvestigation,
  infoGapReadinessReason,
  investigationFactCodes,
  resolveInfoGap,
  type InfoGap,
  type InvestigationGapFacts,
} from "./investigation-gap";

function facts(patch: Partial<InvestigationGapFacts> = {}): InvestigationGapFacts {
  return {
    explorationRan: true,
    toolFailures: [],
    truncatedReads: [],
    budgetExhausted: false,
    roundsExhausted: false,
    aborted: false,
    unavailable: false,
    ...patch,
  };
}

const clean = facts();

const productDecision: InfoGap = {
  kind: "product_decision",
  question: "Which documentation page should host the link?",
  whyToolsCannotAnswer: "The repository holds no existing destination; it is a maintainer choice.",
};

describe("factsShowIncompleteInvestigation", () => {
  it("is false when the exploration ran with no adverse facts", () => {
    expect(factsShowIncompleteInvestigation(clean)).toBe(false);
  });

  it("is true for each adverse fact class", () => {
    expect(factsShowIncompleteInvestigation(facts({ toolFailures: ["search_code"] }))).toBe(true);
    expect(factsShowIncompleteInvestigation(facts({ truncatedReads: ["src/a.ts"] }))).toBe(true);
    expect(factsShowIncompleteInvestigation(facts({ budgetExhausted: true }))).toBe(true);
    expect(factsShowIncompleteInvestigation(facts({ roundsExhausted: true }))).toBe(true);
    expect(factsShowIncompleteInvestigation(facts({ aborted: true }))).toBe(true);
    expect(factsShowIncompleteInvestigation(facts({ unavailable: true }))).toBe(true);
  });
});

describe("investigationFactCodes", () => {
  it("names each failed tool and truncated read once", () => {
    expect(
      investigationFactCodes(
        facts({ toolFailures: ["search_code", "search_code", "read_related_pr"], truncatedReads: ["src/a.ts"] }),
      ),
    ).toEqual(["tool_failure:search_code", "tool_failure:read_related_pr", "truncated_read:src/a.ts"]);
  });

  it("adds the loop-level codes", () => {
    expect(
      investigationFactCodes(facts({ budgetExhausted: true, roundsExhausted: true, aborted: true, unavailable: true })),
    ).toEqual(["budget_exhausted", "rounds_exhausted", "exploration_aborted", "exploration_unavailable"]);
  });
});

describe("resolveInfoGap", () => {
  it("is null without a declaration", () => {
    expect(resolveInfoGap(null, clean)).toBeNull();
  });

  it("keeps a concrete product decision a human question on a clean run", () => {
    const gap = resolveInfoGap(productDecision, clean)!;
    expect(gap.resolution).toBe("human_question");
    expect(gap.factCodes).toEqual([]);
    expect(gap.question).toBe(productDecision.question);
  });

  it("overrides a human question when the run's tools failed", () => {
    const gap = resolveInfoGap(productDecision, facts({ toolFailures: ["search_code"] }))!;
    expect(gap.resolution).toBe("investigation_incomplete");
    expect(gap.kind).toBe("product_decision");
    expect(gap.factCodes).toContain("tool_failure:search_code");
  });

  it("overrides a runtime-reproduction question when the byte budget was exhausted", () => {
    const gap = resolveInfoGap(
      { kind: "runtime_reproduction", question: "Does it recur?", whyToolsCannotAnswer: "runtime only" },
      facts({ budgetExhausted: true }),
    )!;
    expect(gap.resolution).toBe("investigation_incomplete");
    expect(gap.factCodes).toContain("budget_exhausted");
  });

  it("keeps the model's own investigation_incomplete even with clean facts", () => {
    const gap = resolveInfoGap(
      { kind: "investigation_incomplete", question: "Which line raises it?", whyToolsCannotAnswer: "read truncated" },
      clean,
    )!;
    expect(gap.resolution).toBe("investigation_incomplete");
    expect(gap.factCodes).toEqual([]);
  });

  it("stands alone when the run recorded no facts at all", () => {
    const gap = resolveInfoGap(productDecision, null)!;
    expect(gap.resolution).toBe("human_question");
    expect(gap.factCodes).toEqual([]);
  });
});

describe("infoGapReadinessReason", () => {
  it("names the fact codes for an incomplete investigation", () => {
    const gap = resolveInfoGap(productDecision, facts({ toolFailures: ["search_code"] }))!;
    expect(infoGapReadinessReason(gap)).toBe(
      "investigation incomplete (tool_failure:search_code): Which documentation page should host the link?",
    );
  });

  it("falls back to the declared kind wording when there are no facts", () => {
    const gap = resolveInfoGap(
      { kind: "investigation_incomplete", question: "q", whyToolsCannotAnswer: "w" },
      null,
    )!;
    expect(infoGapReadinessReason(gap)).toBe("investigation incomplete (evidence not read): q");
  });

  it("names the kind and question for a human question", () => {
    const gap = resolveInfoGap(productDecision, clean)!;
    expect(infoGapReadinessReason(gap)).toBe(
      "awaiting human (product_decision): Which documentation page should host the link?",
    );
  });
});
