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
      admission: "implementation",
      evidenceDigest: "digest-1",
      citationCount: 2,
      materialUncertaintyCount: 1,
    });
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
