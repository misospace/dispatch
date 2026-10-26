import { describe, expect, it } from "vitest";
import { rebaseWorkItem } from "./pr-fix-rebase";

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
