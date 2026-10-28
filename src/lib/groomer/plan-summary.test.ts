import { describe, expect, it } from "vitest";
import { summarizeGroomingOutput } from "./plan-summary";

describe("summarizeGroomingOutput", () => {
  it("renders a GroomingPlan row with its evidence-checked readiness", () => {
    const summary = summarizeGroomingOutput({
      schemaVersion: 1,
      evidence: { evidenceDigest: "digest-1" },
      verdict: {
        actionability: "ready",
        workType: "implementation",
        lane: { id: "local" },
        summary: "Ready.",
        uncertainties: [{ material: true }, { material: false }],
      },
      readiness: { ready: true, admission: "implementation" },
      citations: [{ id: "repo:a" }, { id: "issue" }],
    });
    expect(summary).toEqual({
      format: "grooming-plan",
      schemaVersion: 1,
      actionability: "ready",
      workType: "implementation",
      lane: "local",
      summary: "Ready.",
      ready: true,
      gapClass: null,
      admission: "implementation",
      evidenceDigest: "digest-1",
      citationCount: 2,
      materialUncertaintyCount: 1,
    });
  });

  it("surfaces the resolved gap class on a needs_info plan (dispatch#1452)", () => {
    const summary = summarizeGroomingOutput({
      schemaVersion: 1,
      verdict: {
        actionability: "needs_info",
        workType: "implementation",
        lane: { id: "backlog" },
        summary: "Waiting on a decision.",
        uncertainties: [{ material: true }],
      },
      readiness: { ready: false, admission: null, gapClass: "investigation_incomplete" },
    });
    expect(summary).toMatchObject({
      format: "grooming-plan",
      actionability: "needs_info",
      ready: false,
      gapClass: "investigation_incomplete",
    });
  });

  it("keeps a human_question gap class as-is", () => {
    const summary = summarizeGroomingOutput({
      schemaVersion: 1,
      verdict: { actionability: "needs_info", lane: { id: "backlog" } },
      readiness: { ready: false, admission: null, gapClass: "human_question" },
    });
    expect(summary.gapClass).toBe("human_question");
  });

  it("tolerates a gap class outside the contract as null", () => {
    const summary = summarizeGroomingOutput({
      schemaVersion: 1,
      verdict: { actionability: "backlog", lane: { id: "backlog" } },
      readiness: { ready: false, admission: null, gapClass: "mystery" },
    });
    expect(summary.gapClass).toBeNull();
  });

  it("keeps legacy dry-run history renderable without claiming readiness", () => {
    const summary = summarizeGroomingOutput({
      actionability: "ready",
      labelsToAdd: ["status/ready"],
      labelsToRemove: [],
      lane: { id: "local", confidence: "high", reason: "r" },
      summary: "Ready for work.",
    });
    expect(summary).toMatchObject({
      format: "legacy",
      actionability: "ready",
      lane: "local",
      summary: "Ready for work.",
      ready: null,
      gapClass: null,
      admission: null,
      evidenceDigest: null,
    });
  });

  it("tolerates missing or malformed output", () => {
    for (const value of [null, undefined, "text", [], { foo: 1 }]) {
      expect(summarizeGroomingOutput(value).format).toBe("unknown");
    }
  });
});
