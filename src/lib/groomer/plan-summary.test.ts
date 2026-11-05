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
      // #1557: the resolved class decides the presented disposition, so an
      // incomplete investigation never reads as a needs-info question.
      actionability: "backlog",
      ready: false,
      gapClass: "investigation_incomplete",
    });
  });

  it("presents an incomplete investigation as the not-ready disposition, never as needs_info (#1557)", () => {
    // The history badge renders this value, so an incomplete investigation
    // must not read as "Needs Info" (the issue's UI/history criterion).
    const summary = summarizeGroomingOutput({
      schemaVersion: 1,
      verdict: {
        actionability: "needs_info",
        workType: "implementation",
        lane: { id: "backlog" },
        summary: "The investigation did not finish.",
        uncertainties: [{ material: true }],
      },
      readiness: { ready: false, admission: null, gapClass: "investigation_incomplete" },
    });
    expect(summary.actionability).toBe("backlog");
    expect(summary.gapClass).toBe("investigation_incomplete");
  });

  it("keeps a human question presented as needs_info (#1557)", () => {
    const summary = summarizeGroomingOutput({
      schemaVersion: 1,
      verdict: { actionability: "needs_info", lane: { id: "backlog" } },
      readiness: { ready: false, admission: null, gapClass: "human_question" },
    });
    expect(summary.actionability).toBe("needs_info");
  });

  it("keeps a legacy row's stored actionability (the gap class predates the plan contract)", () => {
    // A legacy row carries no gap class — the class did not exist when it was
    // recorded — so it keeps the actionability it was stored with.
    const summary = summarizeGroomingOutput({
      actionability: "needs_info",
      needsInfoReason: "which page should the link point at?",
      labelsToAdd: ["status/backlog"],
      labelsToRemove: [],
      lane: { id: "backlog", confidence: "medium", reason: "not ready" },
      summary: "Waiting on a decision.",
    });
    expect(summary.format).toBe("legacy");
    expect(summary.actionability).toBe("needs_info");
    expect(summary.gapClass).toBeNull();
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
