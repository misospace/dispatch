import { describe, expect, it } from "vitest";
import { rebaseWorkItem } from "./pr-fix-rebase";
import {
  isRebaseModelRequired,
  readRebaseSemanticConflict,
  rebaseModelAssistFeedback,
  rebaseModelTransport,
} from "./pr-fix-rebase";

describe("rebaseWorkItem (#1327)", () => {
  it("builds a NORMAL-lane REBASE work item", () => {
    const item = rebaseWorkItem("dirty");
    expect(item.lane).toBe("NORMAL");
    expect(item.type).toBe("REBASE");
    expect(item.reason).toBe("Mechanical rebase: PR dirty against base (#1327)");
  });

  it("carries the worker contract in the feedback text", () => {
    const { feedback } = rebaseWorkItem("DIRTY");
    expect(feedback).toContain("this PR is DIRTY against its base branch");
    expect(feedback).toContain("MECHANICALLY ONLY");
    expect(feedback).toContain("--force-with-lease");
    expect(feedback).toContain("human_decision");
    expect(feedback).toContain("never merge");
  });
});

describe("readRebaseSemanticConflict (#1674)", () => {
  it("reads a well-formed bounded context", () => {
    const context = readRebaseSemanticConflict({
      semanticConflict: { base: "main", files: ["src/a.go", "src/b.go"], reason: "two-sided code edit" },
    });
    expect(context).toEqual({ base: "main", files: ["src/a.go", "src/b.go"], reason: "two-sided code edit" });
  });

  it("reads null on rows without a context, and on malformed values", () => {
    expect(readRebaseSemanticConflict({})).toBeNull();
    expect(readRebaseSemanticConflict({ semanticConflict: null })).toBeNull();
    expect(readRebaseSemanticConflict({ semanticConflict: "dirty" })).toBeNull();
    expect(readRebaseSemanticConflict({ semanticConflict: [] })).toBeNull();
    expect(readRebaseSemanticConflict(null)).toBeNull();
    expect(readRebaseSemanticConflict("row")).toBeNull();
  });

  it("reads null when every field is empty or malformed", () => {
    expect(readRebaseSemanticConflict({ semanticConflict: {} })).toBeNull();
    expect(readRebaseSemanticConflict({ semanticConflict: { base: "  ", files: [], reason: "" } })).toBeNull();
    expect(readRebaseSemanticConflict({ semanticConflict: { base: 42, files: "x", reason: true } })).toBeNull();
  });

  it("keeps valid fields and drops malformed ones", () => {
    const context = readRebaseSemanticConflict({
      semanticConflict: { base: "main", files: ["ok.go", 42, null, "also-ok.go"], reason: "kept" },
    });
    expect(context).toEqual({ base: "main", files: ["ok.go", "also-ok.go"], reason: "kept" });
  });

  it("bounds the context: strings truncated, paths capped", () => {
    const longBase = "b".repeat(300);
    const longReason = "r".repeat(600);
    const manyFiles = Array.from({ length: 50 }, (_, i) => `p${i}`.padEnd(300, "x"));
    const context = readRebaseSemanticConflict({ semanticConflict: { base: longBase, files: manyFiles, reason: longReason } });

    expect(context?.base).toHaveLength(256);
    expect(context?.reason).toHaveLength(512);
    expect(context?.files).toHaveLength(32);
    for (const path of context?.files ?? []) expect(path.length).toBeLessThanOrEqual(256);
  });
});

describe("isRebaseModelRequired (#1674)", () => {
  it("is true exactly when the row carries a context", () => {
    expect(isRebaseModelRequired({ semanticConflict: { base: "main" } })).toBe(true);
    expect(isRebaseModelRequired({ semanticConflict: null })).toBe(false);
    expect(isRebaseModelRequired({})).toBe(false);
  });
});

describe("rebaseModelAssistFeedback (#1674)", () => {
  const wall = rebaseModelAssistFeedback().join("\n");

  it("keeps the mechanical fast path and the publication contract", () => {
    expect(wall).toContain("MECHANICALLY FIRST");
    expect(wall).toContain("--force-with-lease");
    expect(wall).toContain("never merge");
    expect(wall).toContain("never open a new PR");
  });

  it("authorizes the ONE configured model coordinator with no delegation", () => {
    expect(wall).toContain("CONFIGURED MODEL COORDINATOR");
    expect(wall).toContain("exactly the one configured model");
    expect(wall).toContain("no delegation");
    expect(wall).toContain("no\nsilent substitution");
  });

  it("does NOT carry the deterministic refusal that would forbid a model call", () => {
    // The deterministic wall's "do NOT resolve it yourself" is the refusal
    // that makes a model-assisted attempt impossible; the model wall must
    // not repeat it.
    expect(wall).not.toContain("do NOT resolve it yourself");
  });

  it("bounds the model assist to one attempt per episode and stops honestly", () => {
    expect(wall).toContain("one\nbounded model-assisted attempt per episode");
    expect(wall).toContain("human_decision");
    expect(wall).toContain("never count a deterministic refusal as a model-assisted");
  });
});

describe("rebaseModelTransport (#1674)", () => {
  it("pins the exact granted capability identity in the transport block", () => {
    const block = rebaseModelTransport({ base: "main", files: ["src/a.go"], reason: "two-sided code edit" });
    expect(block.capability).toBe("rebase-model-executor");
    expect(block.version).toBe(1);
    expect(block.semanticConflict).toEqual({ base: "main", files: ["src/a.go"], reason: "two-sided code edit" });
  });

  it("ships a null context until a producer persists one", () => {
    expect(rebaseModelTransport(null)).toEqual({
      capability: "rebase-model-executor",
      version: 1,
      semanticConflict: null,
    });
  });
});
