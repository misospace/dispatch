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

  it("fixes an entry once when several errors target the same index, keeping the other indices aligned", () => {
    const raw = draft();
    const degraded = degradePlanDraft(raw, [
      'relatedWork[0].ref: "issue" must be a related-work evidence reference',
      'relatedWork[0].ref: unknown evidence reference "issue"',
      'relatedWork[2].ref: unknown evidence reference "repo:src/x.ts"',
      'implementationBrief.dependencies[0].evidenceRef: "comment:1" must be a related-work evidence reference',
      'implementationBrief.dependencies[0].evidenceRef: unknown evidence reference "comment:1"',
    ])!;

    const out = degraded.output as ReturnType<typeof draft>;
    // Dropping [0] must not shift [2] onto the valid entry at [1].
    expect(out.relatedWork).toEqual([{ ref: "github:pr:org/repo#2", relation: "related", note: "b" }]);
    expect(out.implementationBrief.dependencies[0].evidenceRef).toBeNull();
    expect(degraded.removedRefs).toEqual(["issue", "repo:src/x.ts", "comment:1"]);
    expect(degraded.warnings).toEqual([
      'plan: dropped relatedWork[0] (ref "issue"): not a related-work evidence id',
      'plan: dropped relatedWork[2] (ref "repo:src/x.ts"): not a related-work evidence id',
      'plan: cleared implementationBrief.dependencies[0].evidenceRef ("comment:1"): not a related-work evidence id',
    ]);
  });

  it("refuses when a degradable and a non-degradable error target the same entry", () => {
    expect(
      degradePlanDraft(draft(), [
        'relatedWork[0].ref: "issue" must be a related-work evidence reference',
        "relatedWork[0].note: must be at most 300 characters, got 400",
      ]),
    ).toBeNull();
  });

  it("truncates to exactly the limit: limit+1 loses one character to the ellipsis, the limit itself is kept", () => {
    const at = (n: number) => {
      const raw = draft();
      raw.verdict.uncertainties[0].question = "q".repeat(n);
      raw.verdict.lane.reason = "r".repeat(n);
      const out = degradePlanDraft(raw, [
        `verdict.uncertainties[0].question: must be at most 300 characters, got ${n}`,
        `verdict.lane.reason: must be at most 300 characters, got ${n}`,
      ])!.output as ReturnType<typeof draft>;
      return { question: out.verdict.uncertainties[0].question, reason: out.verdict.lane.reason };
    };

    expect(at(301)).toEqual({ question: `${"q".repeat(299)}…`, reason: `${"r".repeat(299)}…` });
    expect(at(301).question).toHaveLength(300);
    // The validator never reports a string at the limit; if one is named, it is left whole.
    expect(at(300)).toEqual({ question: "q".repeat(300), reason: "r".repeat(300) });
  });

  it("keeps model control characters and long refs out of warnings and removedRefs", () => {
    const raw = draft();
    const long = `comment:${"9".repeat(500)}`;
    raw.relatedWork[0].ref = "iss\u0000ue\u0007";
    raw.implementationBrief.dependencies[0].evidenceRef = long;
    const degraded = degradePlanDraft(raw, [
      'relatedWork[0].ref: unknown evidence reference "iss"',
      'implementationBrief.dependencies[0].evidenceRef: unknown evidence reference "comment:9"',
    ])!;

    expect(degraded.removedRefs[0]).toBe("issue");
    expect(degraded.warnings[0]).toBe('plan: dropped relatedWork[0] (ref "issue"): not a related-work evidence id');
    expect(degraded.warnings.join("")).not.toMatch(/[\u0000-\u0008\u000B-\u001F]/);
    const quoted = /evidenceRef \("([^"]*)"\)/.exec(degraded.warnings[1])![1];
    expect(quoted).toHaveLength(200);
    expect(quoted.endsWith("…")).toBe(true);
  });
});
