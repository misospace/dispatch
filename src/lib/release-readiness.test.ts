import { describe, expect, it } from "vitest";
import {
  deriveReleaseReadiness,
  releaseCiStatus,
  RELEASE_READINESS_AGE_COMMITS,
  RELEASE_READINESS_AGE_DAYS,
  RELEASE_READINESS_VOLUME_COMMITS,
  type ReleaseCiStatus,
} from "./release-readiness";
import {
  isNotableDelivery,
  RELEASE_PULSE_MAX_HIGHLIGHTS,
  type ReleasePulseHighlight,
  type ReleasePulseSnapshot,
} from "./release-pulse";

/**
 * Pure-fixture tests for the advisory readiness policy (dispatch#1483):
 * hand-built pulse snapshots, an explicit clock, no I/O. Table-driven
 * boundary coverage per the issue: 0/1/5/9/10 commits, release age around
 * 7 days, routine vs notable highlights, completed umbrellas,
 * unknown/diverged baselines, and failing/running/green CI context.
 */

const BASELINE = "2026-10-01T00:00:00.000Z";
const NOW = "2026-10-06T00:00:00.000Z"; // 5 days after the baseline

function highlight(
  overrides: Partial<ReleasePulseHighlight> = {},
): ReleasePulseHighlight {
  return {
    kind: "feature",
    headline: "Adds a thing",
    issueNumber: 10,
    issueUrl: "https://github.com/octocat/hello-world/issues/10",
    deliveredAt: "2026-10-03T00:00:00.000Z",
    significance: "notable",
    confidence: "high",
    provenance: "groomer-release-signal",
    prs: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<ReleasePulseSnapshot> = {}): ReleasePulseSnapshot {
  // Mirrors the producer invariant: the semantic count is derived from the
  // FULL highlight set upstream (an explicit override wins, letting a test
  // simulate a truncated list with hidden evidence).
  const highlights = overrides.highlights ?? [];
  return {
    schema: "dispatch.release-pulse/v1",
    repoFullName: "octocat/hello-world",
    pulseState: "ready",
    baseline: { tag: "v0.1.12", sha: "baseline0", publishedAt: BASELINE },
    headSha: "head0",
    unreleasedCommits: { state: "ahead", count: 3 },
    deliveredIssueCount: 0,
    highlights,
    highlightsTruncated: false,
    highlightCount: highlights.length,
    deliveredWithoutHighlightCount: 0,
    notableDeliveryCount: highlights.filter(isNotableDelivery).length,
    completedUmbrellaCount: 0,
    unknownDeliveryCount: 0,
    ...overrides,
  };
}

function readiness(overrides: Partial<ReleasePulseSnapshot> = {}, ci: ReleaseCiStatus = "green") {
  return deriveReleaseReadiness({ pulse: snapshot(overrides), now: NOW, ci });
}

describe("deriveReleaseReadiness — volume/age boundaries", () => {
  it.each([
    // commits, days after baseline, expected state (no milestones)
    [0, 30, "quiet"],
    [1, 1, "building"],
    [1, 30, "building"], // age alone never qualifies without >=5 commits
    [4, 30, "building"], // just under the age-rule commit floor
    [5, 6.9, "building"], // age rule: just under 7 days
    [5, 7, "candidate"], // age rule: both floors exactly met
    [9, 6, "building"], // just under volume, just under age
    [10, 1, "candidate"], // volume threshold exactly met
    [18, 5, "candidate"], // the issue's example volume
  ] as const)("%i commits at %g days -> %s", (commits, days, expected) => {
    const result = deriveReleaseReadiness({
      pulse: snapshot({ unreleasedCommits: { state: "ahead", count: commits } }),
      now: Date.parse(BASELINE) + days * 86_400_000,
      ci: "green",
    });
    expect(result.state).toBe(expected);
  });

  it("lists the exact reasons for a candidate reached by the age rule", () => {
    const result = deriveReleaseReadiness({
      pulse: snapshot({ unreleasedCommits: { state: "ahead", count: 5 } }),
      now: Date.parse(BASELINE) + 7 * 86_400_000,
      ci: "green",
    });
    expect(result).toMatchObject({
      schema: "dispatch.release-readiness/v1",
      state: "candidate",
      reasons: ["5 unreleased commits", "7 days since v0.1.12"],
      ci: "green",
      policy: {
        volumeCommits: RELEASE_READINESS_VOLUME_COMMITS,
        ageCommits: RELEASE_READINESS_AGE_COMMITS,
        ageDays: RELEASE_READINESS_AGE_DAYS,
      },
    });
  });

  it("keeps singular/plural reason grammar deterministic", () => {
    const one = deriveReleaseReadiness({
      pulse: snapshot({ unreleasedCommits: { state: "ahead", count: 1 } }),
      now: Date.parse(BASELINE) + 1 * 86_400_000,
      ci: "green",
    });
    expect(one.reasons).toEqual(["1 unreleased commit", "1 day since v0.1.12"]);
  });

  it("clamps a clock before the baseline to 0 days", () => {
    const result = deriveReleaseReadiness({
      pulse: snapshot({ unreleasedCommits: { state: "ahead", count: 2 } }),
      now: Date.parse(BASELINE) - 86_400_000,
      ci: "green",
    });
    expect(result.state).toBe("building");
    expect(result.reasons).toEqual(["2 unreleased commits", "0 days since v0.1.12"]);
  });

  it("keeps zero commit volume quiet even with milestone evidence (literal rule order)", () => {
    // Stale release-delta (count 0) with fresh merge/close evidence is a
    // pulse-vs-pulse tension, not a readiness decision: "0 commits -> quiet"
    // is the contract's first rule and nothing accumulated since the tag.
    const result = readiness({
      unreleasedCommits: { state: "ahead", count: 0 },
      completedUmbrellaCount: 1,
      highlights: [highlight()],
    });
    expect(result.state).toBe("quiet");
    expect(result.reasons).toEqual(["No unreleased commits since v0.1.12."]);
  });
});

describe("deriveReleaseReadiness — semantic milestones", () => {
  it("promotes a single notable feature delivery to candidate under the volume floor", () => {
    const result = readiness({
      unreleasedCommits: { state: "ahead", count: 2 },
      highlights: [highlight()],
    });
    expect(result.state).toBe("candidate");
    expect(result.reasons).toEqual([
      "2 unreleased commits",
      "1 notable delivered feature",
      "5 days since v0.1.12",
    ]);
  });

  it("counts notable/major feature and architecture deliveries together", () => {
    const result = readiness({
      unreleasedCommits: { state: "ahead", count: 3 },
      highlights: [
        highlight({ issueNumber: 11, significance: "notable" }),
        highlight({ issueNumber: 12, kind: "architecture", significance: "major" }),
        // Volume-only noise: neither becomes a semantic reason.
        highlight({ issueNumber: 13, significance: "routine" }),
        highlight({ issueNumber: 14, significance: null, provenance: "legacy-issue-metadata" }),
        highlight({ issueNumber: 15, kind: "fix", significance: "major" }),
      ],
    });
    expect(result.state).toBe("candidate");
    expect(result.reasons).toEqual([
      "3 unreleased commits",
      "2 notable delivered features",
      "5 days since v0.1.12",
    ]);
  });

  it("promotes the hidden semantic delivery past the pulse's highlight cap", () => {
    // Truncation counterexample: the pulse caps the exposed list at 50
    // (newest-first), and one PR can deliver several issues, so a truncated
    // list does NOT imply the volume rule fires. Readiness must read the
    // producer's pre-truncation count, not filter the capped array.
    const visible = Array.from({ length: RELEASE_PULSE_MAX_HIGHLIGHTS }, (_, i) =>
      highlight({ issueNumber: 100 + i, significance: "routine" }),
    );
    const result = readiness({
      unreleasedCommits: { state: "ahead", count: 2 },
      highlights: visible,
      highlightsTruncated: true,
      highlightCount: RELEASE_PULSE_MAX_HIGHLIGHTS + 1,
      notableDeliveryCount: 1,
    });
    expect(result.state).toBe("candidate");
    expect(result.reasons).toEqual([
      "2 unreleased commits",
      "1 notable delivered feature",
      "5 days since v0.1.12",
    ]);
  });

  it("does not fabricate a semantic trigger from truncation alone", () => {
    const visible = Array.from({ length: RELEASE_PULSE_MAX_HIGHLIGHTS }, (_, i) =>
      highlight({ issueNumber: 100 + i, significance: "routine" }),
    );
    const result = readiness({
      unreleasedCommits: { state: "ahead", count: 2 },
      highlights: visible,
      highlightsTruncated: true,
      highlightCount: RELEASE_PULSE_MAX_HIGHLIGHTS + 1,
      notableDeliveryCount: 0,
    });
    expect(result.state).toBe("building");
  });

  it("never turns a routine-only or legacy-only delivery into a semantic reason", () => {
    const result = readiness({
      unreleasedCommits: { state: "ahead", count: 3 },
      highlights: [
        highlight({ issueNumber: 13, significance: "routine" }),
        highlight({ issueNumber: 14, significance: null, provenance: "legacy-issue-metadata" }),
      ],
    });
    expect(result.state).toBe("building");
  });

  it("promotes a completed umbrella to candidate", () => {
    const result = readiness({
      unreleasedCommits: { state: "ahead", count: 1 },
      completedUmbrellaCount: 1,
    });
    expect(result.state).toBe("candidate");
    expect(result.reasons).toEqual([
      "1 unreleased commit",
      "1 completed umbrella",
      "5 days since v0.1.12",
    ]);
  });

  it("stacks every triggering reason in decision order", () => {
    const result = deriveReleaseReadiness({
      pulse: snapshot({
        unreleasedCommits: { state: "ahead", count: 18 },
        highlights: [highlight()],
        completedUmbrellaCount: 1,
      }),
      now: Date.parse(BASELINE) + 5 * 86_400_000,
      ci: "green",
    });
    expect(result.state).toBe("candidate");
    expect(result.reasons).toEqual([
      "18 unreleased commits",
      "1 notable delivered feature",
      "1 completed umbrella",
      "5 days since v0.1.12",
    ]);
  });
});

describe("deriveReleaseReadiness — unknown evidence fails closed", () => {
  it.each([
    // The non-ready shapes the pulse itself produces (snapshot defaults cover
    // the zeroed highlights/umbrella fields).
    ["diverged", { pulseState: "unknown", baseline: null, unreleasedCommits: { state: "diverged", count: null } }],
    ["unknown", { pulseState: "unknown", baseline: null, unreleasedCommits: { state: "unknown", count: null } }],
    ["no-baseline", { pulseState: "no-baseline", baseline: null, unreleasedCommits: { state: "no-baseline", count: null } }],
  ] as const)("non-ready pulse (%s) -> unknown, never candidate", (_label, overrides) => {
    const result = readiness(overrides);
    expect(result.state).toBe("unknown");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("names the diverged baseline in the reason", () => {
    const result = readiness({
      pulseState: "unknown",
      baseline: null,
      unreleasedCommits: { state: "diverged", count: null },
    });
    expect(result.reasons[0]).toBe("Release delta is diverged; baseline comparison is unreliable.");
  });

  it("treats milestone evidence on a non-ready pulse as unknown, not candidate", () => {
    const result = readiness({
      pulseState: "unknown",
      baseline: null,
      unreleasedCommits: { state: "unknown", count: null },
      // Corrupt-but-shape-valid input: milestones must not outrank the gate.
      completedUmbrellaCount: 3,
      highlights: [highlight()],
    });
    expect(result.state).toBe("unknown");
  });

  it("degrades a ready snapshot with a null commit count to unknown", () => {
    const result = readiness({ unreleasedCommits: { state: "ahead", count: null } });
    expect(result.state).toBe("unknown");
    expect(result.reasons[0]).toBe("Unreleased commit count is unavailable.");
  });

  it("degrades a ready snapshot with an unparseable baseline time to unknown", () => {
    const result = readiness({
      baseline: { tag: "v0.1.12", sha: "baseline0", publishedAt: "not-a-date" },
    });
    expect(result.state).toBe("unknown");
    expect(result.reasons[0]).toBe("Release baseline publication time is unavailable.");
  });

  it("degrades an unparseable clock to unknown", () => {
    const result = deriveReleaseReadiness({
      pulse: snapshot(),
      now: "not-a-date",
      ci: "green",
    });
    expect(result.state).toBe("unknown");
    expect(result.reasons[0]).toBe("Current time evidence is unavailable.");
  });

  it("falls back to a generic baseline label without a tag", () => {
    const result = readiness({
      baseline: { tag: null, sha: "baseline0", publishedAt: BASELINE },
      unreleasedCommits: { state: "ahead", count: 2 },
    });
    expect(result.reasons[1]).toBe("5 days since the release baseline");
  });
});

describe("deriveReleaseReadiness — CI is context, never the signal", () => {
  const candidatePulse = snapshot({ unreleasedCommits: { state: "ahead", count: 12 } });

  it.each(["green", "running", "failing", "unknown"] as const)(
    "state is candidate for every CI status (%s)",
    (ci) => {
      const result = deriveReleaseReadiness({ pulse: candidatePulse, now: NOW, ci });
      expect(result.state).toBe("candidate");
      expect(result.ci).toBe(ci);
    },
  );

  it("appends a context-only reason for failing and running CI", () => {
    const failing = deriveReleaseReadiness({ pulse: candidatePulse, now: NOW, ci: "failing" });
    expect(failing.reasons).toEqual([
      "12 unreleased commits",
      "5 days since v0.1.12",
      "CI has failing runs (context only)",
    ]);
    const running = deriveReleaseReadiness({ pulse: candidatePulse, now: NOW, ci: "running" });
    expect(running.reasons).toEqual([
      "12 unreleased commits",
      "5 days since v0.1.12",
      "CI has a run in progress (context only)",
    ]);
    const green = deriveReleaseReadiness({ pulse: candidatePulse, now: NOW, ci: "green" });
    const unknownCi = deriveReleaseReadiness({ pulse: candidatePulse, now: NOW, ci: "unknown" });
    expect(green.reasons).toEqual(["12 unreleased commits", "5 days since v0.1.12"]);
    expect(unknownCi.reasons).toEqual(["12 unreleased commits", "5 days since v0.1.12"]);
  });
});

describe("deriveReleaseReadiness — determinism", () => {
  it("produces identical output for the same input snapshot", () => {
    const input = {
      pulse: snapshot({
        unreleasedCommits: { state: "ahead", count: 7 },
        highlights: [highlight()],
      }),
      now: NOW,
      ci: "failing" as ReleaseCiStatus,
    };
    expect(deriveReleaseReadiness(input)).toEqual(deriveReleaseReadiness(input));
  });

  it("does not mutate the input snapshot", () => {
    const pulse = snapshot({ unreleasedCommits: { state: "ahead", count: 2 }, highlights: [highlight()] });
    const before = JSON.stringify(pulse);
    deriveReleaseReadiness({ pulse, now: NOW, ci: "failing" });
    expect(JSON.stringify(pulse)).toBe(before);
  });
});

describe("releaseCiStatus", () => {
  it.each([
    // No evidence of any kind is honestly unknown; non-success conclusions
    // (skipped/neutral/cancelled/timed_out) never produce green.
    [{ failingRuns: 0, runningRuns: 0, succeededRuns: 0 }, "unknown"],
    [{ failingRuns: 0, runningRuns: 0, succeededRuns: 4 }, "green"],
    [{ failingRuns: 0, runningRuns: 1, succeededRuns: 4 }, "running"],
    [{ failingRuns: 1, runningRuns: 0, succeededRuns: 4 }, "failing"],
    [{ failingRuns: 1, runningRuns: 1, succeededRuns: 0 }, "failing"],
    [{ failingRuns: 0, runningRuns: 1, succeededRuns: 0 }, "running"],
  ] as const)("%j -> %s", (counts, expected) => {
    expect(releaseCiStatus(counts)).toBe(expected);
  });
});
