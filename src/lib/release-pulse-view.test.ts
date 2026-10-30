import { describe, expect, it } from "vitest";
import {
  RELEASE_PULSE_STALE_MS,
  buildReleasePulseView,
  formatReleaseAge,
  releasePulseStripVisible,
  type ReleasePulseViewInput,
} from "./release-pulse-view";
import type { ReleasePulseSnapshot } from "./release-pulse";

const NOW = "2026-10-30T12:00:00.000Z";
const PUBLISHED_5D = "2026-10-25T12:00:00.000Z";

function readyPulse(overrides: Partial<ReleasePulseSnapshot> = {}): ReleasePulseSnapshot {
  return {
    schema: "dispatch.release-pulse/v1",
    repoFullName: "org/repo",
    pulseState: "ready",
    baseline: { tag: "v0.1.12", sha: "abc", publishedAt: PUBLISHED_5D },
    headSha: "def",
    unreleasedCommits: { state: "ahead", count: 18 },
    deliveredIssueCount: 3,
    highlights: [],
    highlightsTruncated: false,
    deliveredWithoutHighlightCount: 0,
    notableDeliveryCount: 0,
    completedUmbrellaCount: 0,
    unknownDeliveryCount: 0,
    ...overrides,
    // Producer invariant: the count mirrors the set unless a fixture states
    // the truncated reality explicitly (capped array, larger true count).
    highlightCount: overrides.highlightCount ?? (overrides.highlights?.length ?? 0),
  };
}

function candidateReadiness() {
  return {
    state: "candidate",
    reasons: ["18 unreleased commits", "5 days since v0.1.12"],
  };
}

function highlightEntry(i: number): ReleasePulseSnapshot["highlights"][number] {
  return {
    kind: "feature",
    headline: `Feature ${i}`,
    issueNumber: i,
    issueUrl: null,
    deliveredAt: "2026-10-28T10:00:00.000Z",
    significance: null,
    confidence: "low",
    provenance: "legacy-issue-metadata",
    prs: [],
  };
}

function view(overrides: Partial<ReleasePulseViewInput> = {}) {
  const input: ReleasePulseViewInput = {
    pulse: readyPulse(),
    readiness: candidateReadiness(),
    releaseDeltaSyncedAt: "2026-10-30T11:00:00.000Z",
    now: NOW,
    ...overrides,
  };
  return buildReleasePulseView(input);
}

describe("formatReleaseAge", () => {
  it("formats whole floored days", () => {
    expect(formatReleaseAge(PUBLISHED_5D, NOW)).toBe("5d");
  });

  it("clamps future timestamps to 0d", () => {
    expect(formatReleaseAge("2026-10-31T00:00:00.000Z", NOW)).toBe("0d");
  });

  it("returns null for absent or unparseable input", () => {
    expect(formatReleaseAge(null, NOW)).toBeNull();
    expect(formatReleaseAge("not-a-date", NOW)).toBeNull();
    expect(formatReleaseAge(PUBLISHED_5D, "also not a date")).toBeNull();
  });
});

describe("buildReleasePulseView — ready pulse", () => {
  it("projects the ready fleet line fields", () => {
    const v = view();
    expect(v.kind).toBe("ready");
    expect(v.tagLabel).toBe("v0.1.12");
    expect(v.commitsLabel).toBe("+18 commits");
    expect(v.ageLabel).toBe("5d");
    expect(v.highlightsLabel).toBe("0 highlights");
    expect(v.readinessState).toBe("candidate");
    expect(v.readinessReasons).toEqual(["18 unreleased commits", "5 days since v0.1.12"]);
    expect(v.stale).toBe(false);
    expect(v.syncAgeLabel).toBeNull();
  });

  it("uses the singular for one commit", () => {
    expect(view({ pulse: readyPulse({ unreleasedCommits: { state: "ahead", count: 1 } }) }).commitsLabel).toBe(
      "+1 commit",
    );
  });

  it("keeps zero commits as a value, not unknown", () => {
    const v = view({ pulse: readyPulse({ unreleasedCommits: { state: "identical", count: 0 } }) });
    expect(v.commitsLabel).toBe("+0 commits");
    expect(v.kind).toBe("ready");
  });

  it("reports unknown commits when the count is unavailable", () => {
    expect(view({ pulse: readyPulse({ unreleasedCommits: { state: "ahead", count: null } }) }).commitsLabel).toBe(
      "unknown commits",
    );
  });

  it("counts the pre-cap highlight total, not the capped array", () => {
    const capped = Array.from({ length: 50 }, (_, i) => highlightEntry(i));
    const v = view({
      pulse: readyPulse({ highlights: capped, highlightsTruncated: true, highlightCount: 61 }),
    });
    expect(v.highlightsLabel).toBe("61 highlights");
  });

  it("falls back to the exposed list length when a legacy snapshot omits highlightCount", () => {
    const pulse = readyPulse({ highlights: [highlightEntry(0)] });
    delete (pulse as Partial<ReleasePulseSnapshot>).highlightCount;
    expect(view({ pulse }).highlightsLabel).toBe("1 highlight");
  });

  it("mentions completed umbrellas alongside highlights", () => {
    expect(
      view({ pulse: readyPulse({ completedUmbrellaCount: 2, highlights: [] }) }).highlightsLabel,
    ).toBe("0 highlights · 2 umbrellas");
    expect(
      view({ pulse: readyPulse({ completedUmbrellaCount: 1, highlights: [] }) }).highlightsLabel,
    ).toBe("0 highlights · 1 umbrella");
  });

  it("falls back when the baseline tag is missing", () => {
    expect(view({ pulse: readyPulse({ baseline: { tag: null, sha: "abc", publishedAt: PUBLISHED_5D } }) }).tagLabel).toBe(
      "no baseline tag",
    );
  });
});

describe("buildReleasePulseView — non-ready pulses", () => {
  it("projects diverged/unknown as unknown", () => {
    const v = view({ pulse: readyPulse({ pulseState: "unknown", baseline: null }) });
    expect(v.kind).toBe("unknown");
    expect(v.commitsLabel).toBeNull();
    expect(v.ageLabel).toBeNull();
    expect(v.highlightsLabel).toBeNull();
    expect(v.tagLabel).toBe("none");
  });

  it("projects no-baseline as its own kind", () => {
    expect(view({ pulse: readyPulse({ pulseState: "no-baseline", baseline: null }) }).kind).toBe("no-release");
  });

  it("downgrades readiness to unknown for non-ready pulses", () => {
    const v = view({ pulse: readyPulse({ pulseState: "no-baseline", baseline: null }) });
    expect(v.readinessState).toBe("unknown");
  });
});

describe("buildReleasePulseView — readiness passthrough", () => {
  it("passes quiet/building through", () => {
    expect(view({ readiness: { state: "quiet", reasons: [] } }).readinessState).toBe("quiet");
    expect(view({ readiness: { state: "building", reasons: [] } }).readinessState).toBe("building");
  });

  it("degrades an unrecognized readiness state to unknown", () => {
    expect(view({ readiness: { state: "candidate-ish", reasons: [] } }).readinessState).toBe("unknown");
  });
});

describe("buildReleasePulseView — stale sync", () => {
  it("treats missing sync evidence as stale with an honest unknown-age label", () => {
    const v = view({ releaseDeltaSyncedAt: null });
    expect(v.stale).toBe(true);
    expect(v.syncAgeLabel).toBe("release data age unknown");
  });

  it("is fresh inside the stale window", () => {
    const v = view({ releaseDeltaSyncedAt: "2026-10-30T11:30:00.000Z" });
    expect(v.stale).toBe(false);
    expect(v.syncAgeLabel).toBeNull();
  });

  it("goes stale past the window and reports the sync age", () => {
    const v = view({ releaseDeltaSyncedAt: "2026-10-28T12:00:00.000Z" });
    expect(v.stale).toBe(true);
    expect(v.syncAgeLabel).toBe("release data from 2 days ago");
  });

  it("reports sub-day staleness in hours", () => {
    const v = view({ releaseDeltaSyncedAt: "2026-10-30T09:00:00.000Z" });
    expect(v.stale).toBe(true);
    expect(v.syncAgeLabel).toBe("release data from 3 hours ago");
  });

  it("stays stale-flagged for non-ready pulses too", () => {
    const v = view({
      pulse: readyPulse({ pulseState: "no-baseline", baseline: null }),
      releaseDeltaSyncedAt: "2026-10-28T12:00:00.000Z",
    });
    expect(v.stale).toBe(true);
    expect(v.syncAgeLabel).toBe("release data from 2 days ago");
  });
});

describe("RELEASE_PULSE_STALE_MS", () => {
  it("is one hour", () => {
    expect(RELEASE_PULSE_STALE_MS).toBe(3_600_000);
  });
});

describe("releasePulseStripVisible", () => {
  it("is visible only for a single-repo filter", () => {
    expect(releasePulseStripVisible("org/repo")).toBe(true);
    expect(releasePulseStripVisible(undefined)).toBe(false);
    expect(releasePulseStripVisible(null)).toBe(false);
    expect(releasePulseStripVisible("")).toBe(false);
  });
});
