import { describe, expect, it } from "vitest";
import { degradePlanDraft } from "./plan-degrade";

const draft = () => ({
  verdict: {
    lane: { id: "local", confidence: "high", reason: "r".repeat(310) },
    uncertainties: [{ kind: "scope", question: `  ${"q".repeat(305)}  `, material: true }],
  },
  implementationBrief: { dependencies: [{ ref: "#7", state: "open", evidenceRef: "comment:1" }] },
  relatedWork: [
    { ref: "issue", relation: "related", note: "a" },
    { ref: "github:pr:org/repo#2", relation: "related", note: "b" },
    { ref: "repo:src/x.ts", relation: "related", note: "c" },
  ],
});

describe("degradePlanDraft (dispatch#1126)", () => {
  it("drops, clears and truncates only the fields the errors name, on a copy", () => {
    const raw = draft();
    const before = structuredClone(raw);
    const degraded = degradePlanDraft(raw, [
      'relatedWork[0].ref: "issue" must be a related-work evidence reference',
      'relatedWork[2].ref: unknown evidence reference "repo:src/x.ts"',
      'implementationBrief.dependencies[0].evidenceRef: "comment:1" must be a related-work evidence reference',
      "verdict.uncertainties[0].question: must be at most 300 characters, got 305",
      "verdict.lane.reason: must be at most 300 characters, got 310",
    ]);

    expect(raw).toEqual(before);
    const out = degraded!.output as ReturnType<typeof draft>;
    expect(out.relatedWork).toEqual([{ ref: "github:pr:org/repo#2", relation: "related", note: "b" }]);
    expect(out.implementationBrief.dependencies[0]).toEqual({ ref: "#7", state: "open", evidenceRef: null });
    expect(out.verdict.uncertainties[0]).toEqual({ kind: "scope", question: `${"q".repeat(299)}…`, material: true });
    expect(out.verdict.lane).toEqual({ id: "local", confidence: "high", reason: `${"r".repeat(299)}…` });
    expect(degraded!.removedRefs).toEqual(["issue", "repo:src/x.ts", "comment:1"]);
    expect(degraded!.warnings).toHaveLength(5);
  });

  it("refuses when any error is outside the degradable fields", () => {
    expect(
      degradePlanDraft(draft(), [
        'relatedWork[0].ref: "issue" must be a related-work evidence reference',
        "mutations.labelsToAdd[0]: disallowed label: status/ready",
      ]),
    ).toBeNull();
    // Same field, different failure: a relation is not a reference.
    expect(degradePlanDraft(draft(), ['relatedWork[0].relation: must be one of duplicate_of|superseded_by|related, got "dup"'])).toBeNull();
    // Over-long text in a field other than the two allowed ones.
    expect(degradePlanDraft(draft(), ["verdict.rationale: must be at most 1000 characters, got 1200"])).toBeNull();
    // Not a related-work field: a relevant path or a close citation must stay failing.
    expect(degradePlanDraft(draft(), ['implementationBrief.relevantPaths[0].ref: "issue" must be a repository evidence reference'])).toBeNull();
    expect(degradePlanDraft(draft(), ['mutations.close.evidenceRefs[0]: unknown evidence reference "github:pr:x#1"'])).toBeNull();
  });

  it("refuses when the draft does not have the shape an error describes", () => {
    expect(degradePlanDraft(draft(), ['relatedWork[9].ref: "issue" must be a related-work evidence reference'])).toBeNull();
    expect(degradePlanDraft("not a plan", ["verdict.lane.reason: must be at most 300 characters, got 310"])).toBeNull();
    expect(degradePlanDraft(draft(), [])).toBeNull();
  });
});
