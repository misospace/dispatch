import { describe, expect, it } from "vitest";
import {
  deriveObserveDisposition,
  resolveGroomerMode,
  summarizeObserveWindow,
  wouldMutate,
} from "./observe";

describe("resolveGroomerMode", () => {
  it("accepts each configured mode", () => {
    expect(resolveGroomerMode("off", true)).toBe("off");
    expect(resolveGroomerMode("observe", true)).toBe("observe");
    expect(resolveGroomerMode("auto", true)).toBe("auto");
  });

  it("normalizes whitespace and case", () => {
    expect(resolveGroomerMode("  AUTO  ", true)).toBe("auto");
    expect(resolveGroomerMode("Observe", false)).toBe("observe");
  });

  it("maps an unset value from the legacy dry-run boolean", () => {
    expect(resolveGroomerMode(undefined, true)).toBe("observe");
    expect(resolveGroomerMode(undefined, false)).toBe("auto");
    expect(resolveGroomerMode("", false)).toBe("auto");
  });

  it("falls back to the dry-run mapping for an unrecognized value", () => {
    expect(resolveGroomerMode("shadow", true)).toBe("observe");
    expect(resolveGroomerMode("shadow", false)).toBe("auto");
  });
});

describe("wouldMutate", () => {
  const base = {
    labelsStep: ["status/backlog", "priority/p1"],
    labelsBefore: ["status/backlog", "priority/p1"],
    comment: null,
    commentWouldPost: false,
    close: false,
    children: false,
    title: null,
    body: null,
  };

  it("is false when nothing would change", () => {
    expect(wouldMutate(base)).toBe(false);
  });

  it("is true for a label-set change", () => {
    expect(wouldMutate({ ...base, labelsStep: ["status/ready", "priority/p1"] })).toBe(true);
    expect(wouldMutate({ ...base, labelsStep: ["status/backlog"] })).toBe(true);
  });

  it("ignores label-order-only differences", () => {
    expect(wouldMutate({ ...base, labelsStep: ["priority/p1", "status/backlog"] })).toBe(false);
  });

  it("is true for a comment that would post", () => {
    expect(wouldMutate({ ...base, comment: "hello", commentWouldPost: true })).toBe(true);
  });

  it("is false for a comment that would be held", () => {
    expect(wouldMutate({ ...base, comment: "hello", commentWouldPost: false })).toBe(false);
  });

  it("is true for close, children, title and body writes", () => {
    expect(wouldMutate({ ...base, close: true })).toBe(true);
    expect(wouldMutate({ ...base, children: true })).toBe(true);
    expect(wouldMutate({ ...base, title: "New title" })).toBe(true);
    expect(wouldMutate({ ...base, body: "New body" })).toBe(true);
  });
});

describe("deriveObserveDisposition", () => {
  it("reports an unavailable assessment when the snapshot was unreadable", () => {
    expect(
      deriveObserveDisposition({
        applyOutcome: "unverifiable",
        wouldMutate: true,
        inFlight: true,
        snapshotUnreadable: true,
      }),
    ).toBe("assessment_unavailable");
  });

  it("refuses an in-flight issue", () => {
    expect(
      deriveObserveDisposition({ applyOutcome: "dry_run", wouldMutate: true, inFlight: true, snapshotUnreadable: false }),
    ).toBe("would_refuse");
  });

  it("refuses stale and unverifiable evidence", () => {
    expect(
      deriveObserveDisposition({ applyOutcome: "stale", wouldMutate: true, inFlight: false, snapshotUnreadable: false }),
    ).toBe("would_refuse");
    expect(
      deriveObserveDisposition({ applyOutcome: "unverifiable", wouldMutate: false, inFlight: false, snapshotUnreadable: false }),
    ).toBe("would_refuse");
  });

  it("treats a replay as a no-op", () => {
    expect(
      deriveObserveDisposition({ applyOutcome: "would_replay", wouldMutate: true, inFlight: false, snapshotUnreadable: false }),
    ).toBe("would_noop");
  });

  it("refuses a held reply with no other mutation", () => {
    expect(
      deriveObserveDisposition({
        applyOutcome: "dry_run",
        wouldMutate: false,
        inFlight: false,
        snapshotUnreadable: false,
        commentHeldOnly: true,
      }),
    ).toBe("would_refuse");
    // Other mutations alongside the held reply still act.
    expect(
      deriveObserveDisposition({
        applyOutcome: "dry_run",
        wouldMutate: true,
        inFlight: false,
        snapshotUnreadable: false,
        commentHeldOnly: true,
      }),
    ).toBe("would_act");
  });

  it("acts only when the plan would mutate", () => {
    expect(
      deriveObserveDisposition({ applyOutcome: "dry_run", wouldMutate: true, inFlight: false, snapshotUnreadable: false }),
    ).toBe("would_act");
    expect(
      deriveObserveDisposition({ applyOutcome: "dry_run", wouldMutate: false, inFlight: false, snapshotUnreadable: false }),
    ).toBe("would_noop");
  });
});

describe("summarizeObserveWindow", () => {
  it("counts each disposition and totals every row", () => {
    const rows = [
      { observeDisposition: "would_act" },
      { observeDisposition: "would_act" },
      { observeDisposition: "would_noop" },
      { observeDisposition: "would_refuse" },
      { observeDisposition: "assessment_unavailable" },
      { observeDisposition: null },
    ];
    expect(summarizeObserveWindow(rows)).toEqual({
      total: 6,
      would_act: 2,
      would_noop: 1,
      would_refuse: 1,
      assessment_unavailable: 1,
    });
  });

  it("handles an empty window", () => {
    expect(summarizeObserveWindow([])).toEqual({
      total: 0,
      would_act: 0,
      would_noop: 0,
      would_refuse: 0,
      assessment_unavailable: 0,
    });
  });
});
