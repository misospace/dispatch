import { describe, expect, it } from "vitest";
import {
  buildReleasePulse,
  RELEASE_PULSE_MAX_HIGHLIGHTS,
  type ReleasePulseEventInput,
  type ReleasePulseIssueInput,
  type ReleasePulseRepoInput,
} from "./release-pulse";

/**
 * Pure-fixture tests: plain rows exactly as a prisma query would yield
 * them — no mocks, no clock, no I/O (dispatch#1482).
 */

const BASELINE = "2026-10-01T00:00:00.000Z";
const REPO = "octocat/hello-world";

function repoInput(overrides: Partial<ReleasePulseRepoInput> = {}): ReleasePulseRepoInput {
  return {
    fullName: REPO,
    releaseState: "ahead",
    releaseBaselineTag: "v1.2.0",
    releaseBaselineSha: "baseline0",
    releaseBaselinePublishedAt: BASELINE,
    releaseHeadSha: "head0",
    releaseAheadBy: 5,
    ...overrides,
  };
}

function issueInput(
  overrides: Partial<ReleasePulseIssueInput> & { number: number },
): ReleasePulseIssueInput {
  return {
    title: `Issue ${overrides.number}`,
    url: `https://github.com/${REPO}/issues/${overrides.number}`,
    state: "open",
    closedAt: null,
    labels: [],
    releaseSignal: null,
    decomposed: false,
    followUpUrls: [],
    ...overrides,
  };
}

function mergeEvent(
issueNumber: number,
prNumber: number,
occurredAt: Date | string,
overrides: Partial<ReleasePulseEventInput> = {},
): ReleasePulseEventInput {
  // Mirrors the writer's metadata shape (issue-lifecycle.ts recordPrMergedEvent):
// `metadata.mergedAt` carries the ISO merge time when parseable, otherwise the
// raw text survives as `mergedAtRaw` and `occurredAt` degrades to the
// observation time.
const mergedIso =
typeof occurredAt === "string" && Number.isNaN(Date.parse(occurredAt))
? null
: new Date(occurredAt).toISOString();
return {
issueNumber,
kind: "pr_merged",
source: "reconciler",
actor: "alpha",
agentName: "alpha",
fromStatus: null,
toStatus: null,
sourceEventId: `pr-${prNumber}`,
occurredAt: mergedIso ?? "2026-10-06T00:00:00.000Z",
observedAt: mergedIso ?? "2026-10-06T00:00:00.000Z",
metadata: {
pullRequestNumber: prNumber,
pullRequestUrl: `https://github.com/${REPO}/pull/${prNumber}`,
mergeCommitSha: `merge${prNumber}`,
...(mergedIso ? { mergedAt: mergedIso } : { mergedAtRaw: String(occurredAt) }),
},
...overrides,
};
}

function signal(kind: string, headline: string, significance: string = "notable") {
  return { kind, headline, significance, evidenceRefs: [`gh:${headline}`] };
}

function issueUrl(n: number): string {
  return `https://github.com/${REPO}/issues/${n}`;
}

describe("buildReleasePulse", () => {
  it("surfaces a merged feature after the baseline exactly once with its groomer headline", () => {
    const snapshot = buildReleasePulse(
      repoInput(),
      [
        issueInput({
          number: 10,
          labels: ["type/feature"],
          releaseSignal: signal("feature", "Add dark mode"),
        }),
      ],
      [mergeEvent(10, 5, "2026-10-05T00:00:00.000Z")],
    );
    expect(snapshot.pulseState).toBe("ready");
    expect(snapshot.deliveredIssueCount).toBe(1);
    expect(snapshot.highlights).toHaveLength(1);
    expect(snapshot.highlights[0]).toMatchObject({
      kind: "feature",
      headline: "Add dark mode",
      issueNumber: 10,
      significance: "notable",
      confidence: "high",
      provenance: "groomer-release-signal",
      deliveredAt: "2026-10-05T00:00:00.000Z",
    });
    expect(snapshot.highlights[0].prs).toEqual([
      {
        prNumber: 5,
        prUrl: "https://github.com/octocat/hello-world/pull/5",
        mergeCommitSha: "merge5",
        mergedAt: "2026-10-05T00:00:00.000Z",
      },
    ]);
  });

  it("does not surface a merge entirely before the baseline", () => {
    const snapshot = buildReleasePulse(
      repoInput(),
      [issueInput({ number: 10, labels: ["type/feature"], releaseSignal: signal("feature", "Old work") })],
      [mergeEvent(10, 5, "2026-09-20T00:00:00.000Z")],
    );
    expect(snapshot.deliveredIssueCount).toBe(0);
    expect(snapshot.highlights).toEqual([]);
  });

  it("does not surface an already_done groomer closure after the baseline as shipped", () => {
    const snapshot = buildReleasePulse(
      repoInput(),
      [issueInput({ number: 10, state: "closed", closedAt: "2026-10-06T00:00:00.000Z" })],
      [
        {
          issueNumber: 10,
          kind: "issue_closed",
          source: "hosted-groomer",
          actor: "groomer",
          agentName: null,
          fromStatus: "status/in-progress",
          toStatus: "status/done",
          sourceEventId: null,
          occurredAt: "2026-10-06T00:00:00.000Z",
          observedAt: "2026-10-06T00:00:00.000Z",
          metadata: null,
        },
      ],
    );
    expect(snapshot.deliveredIssueCount).toBe(0);
    expect(snapshot.highlights).toEqual([]);
  });

  it("does not surface a done/closed issue with no merge (closed-unmerged)", () => {
    const snapshot = buildReleasePulse(
      repoInput(),
      [issueInput({ number: 10, state: "closed", closedAt: "2026-10-06T00:00:00.000Z" })],
      [],
    );
    expect(snapshot.deliveredIssueCount).toBe(0);
    expect(snapshot.highlights).toEqual([]);
  });

  it("collapses a multi-PR issue into ONE highlight with multiple PR evidence links", () => {
    const snapshot = buildReleasePulse(
      repoInput(),
      [issueInput({ number: 10, labels: ["type/feature"], releaseSignal: signal("feature", "Big feature") })],
      [
        mergeEvent(10, 6, "2026-10-04T00:00:00.000Z"),
        mergeEvent(10, 5, "2026-10-02T00:00:00.000Z"),
      ],
    );
    expect(snapshot.highlights).toHaveLength(1);
    expect(snapshot.deliveredIssueCount).toBe(1);
    expect(snapshot.highlights[0].deliveredAt).toBe("2026-10-02T00:00:00.000Z");
    expect(snapshot.highlights[0].prs.map((pr) => pr.prNumber)).toEqual([5, 6]);
  });

  describe("umbrella milestones", () => {
    function umbrellaFixtures() {
      return {
        issues: [
          issueInput({
            number: 1,
            title: "Umbrella: revamp auth",
            state: "closed",
            closedAt: "2026-10-10T00:00:00.000Z",
            decomposed: true,
            followUpUrls: [issueUrl(2), issueUrl(3)],
          }),
          issueInput({ number: 2, state: "closed", closedAt: "2026-10-05T00:00:00.000Z" }),
          issueInput({ number: 3, state: "closed", closedAt: "2026-10-06T00:00:00.000Z" }),
        ],
        events: [] as ReleasePulseEventInput[],
      };
    }

    it("produces exactly one umbrella_completed milestone with children listed", () => {
      const { issues, events } = umbrellaFixtures();
      const snapshot = buildReleasePulse(repoInput(), issues, events);
      expect(snapshot.completedUmbrellaCount).toBe(1);
      expect(snapshot.highlights).toHaveLength(1);
      expect(snapshot.highlights[0]).toMatchObject({
        kind: "umbrella_completed",
        headline: "Umbrella: revamp auth",
        issueNumber: 1,
        deliveredAt: "2026-10-10T00:00:00.000Z",
        confidence: "high",
        provenance: "lifecycle-decomposition",
        prs: [],
      });
      expect(snapshot.highlights[0].children).toEqual([
        { number: 2, url: issueUrl(2), closedAt: "2026-10-05T00:00:00.000Z" },
        { number: 3, url: issueUrl(3), closedAt: "2026-10-06T00:00:00.000Z" },
      ]);
    });

    it("prefers the parent's releaseSignal headline over the title", () => {
      const { issues, events } = umbrellaFixtures();
      issues[0].releaseSignal = signal("architecture", "Auth redesigned");
      const snapshot = buildReleasePulse(repoInput(), issues, events);
      expect(snapshot.highlights[0].headline).toBe("Auth redesigned");
    });

    it("is prevented by a reopened parent", () => {
      const { issues, events } = umbrellaFixtures();
      events.push({
        issueNumber: 1,
        kind: "issue_reopened",
        source: "webhook",
        actor: "octocat",
        agentName: null,
        fromStatus: null,
        toStatus: null,
        sourceEventId: null,
        occurredAt: "2026-10-11T00:00:00.000Z",
        observedAt: "2026-10-11T00:00:00.000Z",
        metadata: null,
      });
      const snapshot = buildReleasePulse(repoInput(), issues, events);
      expect(snapshot.completedUmbrellaCount).toBe(0);
      expect(snapshot.highlights).toEqual([]);
    });

    it("is prevented by a child still open", () => {
      const { issues, events } = umbrellaFixtures();
      issues[2].state = "open";
      issues[2].closedAt = null;
      const snapshot = buildReleasePulse(repoInput(), issues, events);
      expect(snapshot.completedUmbrellaCount).toBe(0);
      expect(snapshot.highlights).toEqual([]);
    });

    it("is prevented by a child closed then reopened", () => {
      const { issues, events } = umbrellaFixtures();
      events.push({
        issueNumber: 3,
        kind: "issue_reopened",
        source: "webhook",
        actor: "octocat",
        agentName: null,
        fromStatus: null,
        toStatus: null,
        sourceEventId: null,
        occurredAt: "2026-10-07T00:00:00.000Z",
        observedAt: "2026-10-07T00:00:00.000Z",
        metadata: null,
      });
      const snapshot = buildReleasePulse(repoInput(), issues, events);
      expect(snapshot.completedUmbrellaCount).toBe(0);
      expect(snapshot.highlights).toEqual([]);
    });

    it("fails closed on an unresolvable or cross-repo child reference", () => {
      const { issues, events } = umbrellaFixtures();
      issues[0].followUpUrls = [issueUrl(2), "https://github.com/octocat/hello-world/issues/999"];
      expect(buildReleasePulse(repoInput(), issues, events).completedUmbrellaCount).toBe(0);

      issues[0].followUpUrls = [
        issueUrl(2),
        "https://github.com/other-org/other-repo/issues/3",
      ];
      expect(buildReleasePulse(repoInput(), issues, events).completedUmbrellaCount).toBe(0);

      issues[0].followUpUrls = [issueUrl(2), "not a url"];
      expect(buildReleasePulse(repoInput(), issues, events).completedUmbrellaCount).toBe(0);
    });

    it("does not block on pull-request followUp references (they are not child issues)", () => {
      const { issues, events } = umbrellaFixtures();
      issues[0].followUpUrls = [...issues[0].followUpUrls, `https://github.com/${REPO}/pull/77`];
      expect(buildReleasePulse(repoInput(), issues, events).completedUmbrellaCount).toBe(1);
    });

    it("fails closed on a self-referencing followUp (the parent cannot complete itself)", () => {
      const { issues, events } = umbrellaFixtures();
      issues[0].followUpUrls = [issueUrl(2), issueUrl(1)];
      const snapshot = buildReleasePulse(repoInput(), issues, events);
      expect(snapshot.completedUmbrellaCount).toBe(0);
      expect(snapshot.highlights).toEqual([]);
    });

    it("dedupes duplicate followUp URLs into one child entry", () => {
      const { issues, events } = umbrellaFixtures();
      issues[0].followUpUrls = [issueUrl(2), issueUrl(2)];
      const snapshot = buildReleasePulse(repoInput(), issues, events);
      expect(snapshot.completedUmbrellaCount).toBe(1);
      expect(snapshot.highlights[0].children).toHaveLength(1);
    });

    it("overrides a merge highlight for a parent that also has merge-delivery evidence", () => {
      const { issues, events } = umbrellaFixtures();
      issues[0].labels = ["type/feature"];
      issues[0].releaseSignal = signal("feature", "Auth redesigned");
      events.push(mergeEvent(1, 9, "2026-10-09T00:00:00.000Z"));
      const snapshot = buildReleasePulse(repoInput(), issues, events);
      expect(snapshot.highlights).toHaveLength(1);
      expect(snapshot.highlights[0].kind).toBe("umbrella_completed");
      expect(snapshot.completedUmbrellaCount).toBe(1);
      // The parent is still merge-delivered.
      expect(snapshot.deliveredIssueCount).toBe(1);
    });
  });

  describe("legacy fallback (no release signal)", () => {
    it("emits a low-confidence highlight from type labels", () => {
      const snapshot = buildReleasePulse(
        repoInput(),
        [issueInput({ number: 10, title: "Fix login crash", labels: ["type/bug"] })],
        [mergeEvent(10, 5, "2026-10-05T00:00:00.000Z")],
      );
      expect(snapshot.highlights).toHaveLength(1);
      expect(snapshot.highlights[0]).toMatchObject({
        kind: "fix",
        headline: "Fix login crash",
        significance: null,
        confidence: "low",
        provenance: "legacy-issue-metadata",
      });
    });

    it("treats an unmatchable type label (type/chore) as internal-equivalent: delivered, no highlight", () => {
      const snapshot = buildReleasePulse(
        repoInput(),
        [issueInput({ number: 10, labels: ["type/chore"] })],
        [mergeEvent(10, 5, "2026-10-05T00:00:00.000Z")],
      );
      expect(snapshot.deliveredIssueCount).toBe(1);
      expect(snapshot.highlights).toEqual([]);
    });

    it("maps type/security to fix and type/feature to feature", () => {
      const snapshot = buildReleasePulse(
        repoInput(),
        [
          issueInput({ number: 1, labels: ["type/security"] }),
          issueInput({ number: 2, labels: ["type/feature"] }),
        ],
        [
          mergeEvent(1, 5, "2026-10-03T00:00:00.000Z"),
          mergeEvent(2, 6, "2026-10-04T00:00:00.000Z"),
        ],
      );
      expect(snapshot.highlights.map((h) => h.kind)).toEqual(["feature", "fix"]);
      expect(snapshot.deliveredIssueCount).toBe(2);
    });
  });

  it("treats a tombstoned releaseSignal like null", () => {
    const snapshot = buildReleasePulse(
      repoInput(),
      [
        issueInput({
          number: 10,
          labels: ["type/feature"],
          releaseSignal: { tombstone: true, provenance: { appliedAt: "2026-10-02T00:00:00.000Z" } },
        }),
      ],
      [mergeEvent(10, 5, "2026-10-05T00:00:00.000Z")],
    );
    expect(snapshot.highlights).toHaveLength(1);
    expect(snapshot.highlights[0].provenance).toBe("legacy-issue-metadata");
    expect(snapshot.highlights[0].confidence).toBe("low");
  });

  it("counts an internal releaseSignal as delivered but emits no highlight", () => {
    const snapshot = buildReleasePulse(
      repoInput(),
      [issueInput({ number: 10, releaseSignal: signal("internal", "Chores") })],
      [mergeEvent(10, 5, "2026-10-05T00:00:00.000Z")],
    );
    expect(snapshot.deliveredIssueCount).toBe(1);
    expect(snapshot.highlights).toEqual([]);
  });

  it.each(["diverged", "unknown", "no-baseline"] as const)(
    "gates out %s release state: explicit non-ready pulse, zero highlights",
    (releaseState) => {
      const snapshot = buildReleasePulse(
        repoInput({ releaseState }),
        [
          issueInput({
            number: 10,
            labels: ["type/feature"],
            releaseSignal: signal("feature", "Should not appear"),
          }),
        ],
        [mergeEvent(10, 5, "2026-10-05T00:00:00.000Z")],
      );
      expect(snapshot.pulseState).toBe(releaseState === "no-baseline" ? "no-baseline" : "unknown");
      expect(snapshot.baseline).toBeNull();
      expect(snapshot.highlights).toEqual([]);
      expect(snapshot.deliveredIssueCount).toBe(0);
      expect(snapshot.completedUmbrellaCount).toBe(0);
      expect(snapshot.unknownDeliveryCount).toBe(0);
      expect(snapshot.unreleasedCommits).toEqual({ state: releaseState, count: null });
      expect(snapshot.highlightsTruncated).toBe(false);
    },
  );

  it("gates out an ahead state with a missing baseline publication time", () => {
    const snapshot = buildReleasePulse(
      repoInput({ releaseBaselinePublishedAt: null }),
      [
        issueInput({
          number: 10,
          labels: ["type/feature"],
          releaseSignal: signal("feature", "Should not appear"),
        }),
      ],
      [mergeEvent(10, 5, "2026-10-05T00:00:00.000Z")],
    );
    expect(snapshot.pulseState).toBe("unknown");
    expect(snapshot.baseline).toBeNull();
    expect(snapshot.highlights).toEqual([]);
    expect(snapshot.deliveredIssueCount).toBe(0);
  });

  it("gates out an unparseable baseline publication time", () => {
    const snapshot = buildReleasePulse(
      repoInput({ releaseBaselinePublishedAt: "not-a-date" }),
      [issueInput({ number: 10, labels: ["type/feature"] })],
      [mergeEvent(10, 5, "2026-10-05T00:00:00.000Z")],
    );
    expect(snapshot.pulseState).toBe("unknown");
    expect(snapshot.highlights).toEqual([]);
  });

  describe("unknown delivery", () => {
    it("counts a merged PR with unusable merge time as unknown delivery, not a highlight", () => {
      const snapshot = buildReleasePulse(
        repoInput(),
        [issueInput({ number: 10, labels: ["type/feature"] })],
        [mergeEvent(10, 5, "not-a-timestamp")],
      );
      expect(snapshot.unknownDeliveryCount).toBe(1);
      expect(snapshot.deliveredIssueCount).toBe(0);
      expect(snapshot.highlights).toEqual([]);
    });

    it("counts an unresolvable timeline delivery as unknown delivery", () => {
      // Closed, then reopened while still closed: delivery cannot be resolved.
      const snapshot = buildReleasePulse(
        repoInput(),
        [issueInput({ number: 10, state: "closed", closedAt: "2026-10-02T00:00:00.000Z" })],
        [
          {
            issueNumber: 10,
            kind: "issue_reopened",
            source: "webhook",
            actor: "octocat",
            agentName: null,
            fromStatus: null,
            toStatus: null,
            sourceEventId: null,
            occurredAt: "2026-10-03T00:00:00.000Z",
            observedAt: "2026-10-03T00:00:00.000Z",
            metadata: null,
          },
        ],
      );
      expect(snapshot.unknownDeliveryCount).toBe(1);
      expect(snapshot.deliveredIssueCount).toBe(0);
    });

    it("counts an issue once even when several merge observations are unusable", () => {
      const snapshot = buildReleasePulse(
        repoInput(),
        [issueInput({ number: 10 })],
        [mergeEvent(10, 5, "not-a-timestamp"), mergeEvent(10, 6, "also-bad")],
      );
      expect(snapshot.unknownDeliveryCount).toBe(1);
    });

    it("prefers usable delivery: a delivered issue with an extra unusable merge is not unknown", () => {
      const snapshot = buildReleasePulse(
        repoInput(),
        [issueInput({ number: 10, labels: ["type/feature"] })],
        [mergeEvent(10, 5, "2026-10-05T00:00:00.000Z"), mergeEvent(10, 6, "not-a-timestamp")],
      );
      expect(snapshot.deliveredIssueCount).toBe(1);
      expect(snapshot.unknownDeliveryCount).toBe(0);
    });
  });

  it("truncates highlights at the cap while counts reflect the full set", () => {
    const total = RELEASE_PULSE_MAX_HIGHLIGHTS + 10;
    const issues: ReleasePulseIssueInput[] = [];
    const events: ReleasePulseEventInput[] = [];
    for (let i = 1; i <= total; i += 1) {
      issues.push(
        issueInput({
          number: i,
          labels: ["type/feature"],
          releaseSignal: signal("feature", `Feature ${i}`),
        }),
      );
      events.push(mergeEvent(i, i, `2026-10-${String((i % 26) + 2).padStart(2, "0")}T00:00:00.000Z`));
    }
    const snapshot = buildReleasePulse(repoInput(), issues, events);
    expect(snapshot.highlights).toHaveLength(RELEASE_PULSE_MAX_HIGHLIGHTS);
    expect(snapshot.highlightsTruncated).toBe(true);
    expect(snapshot.deliveredIssueCount).toBe(total);
    // Newest first: the kept window is the newest 50.
    expect(snapshot.highlights[0].deliveredAt).toBe("2026-10-27T00:00:00.000Z");
    expect(snapshot.highlights[0].issueNumber).toBe(25);
  });

  it("sorts highlights by deliveredAt descending with issueNumber ascending tie-break", () => {
    const snapshot = buildReleasePulse(
      repoInput(),
      [
        issueInput({ number: 2, labels: ["type/feature"] }),
        issueInput({ number: 1, labels: ["type/feature"] }),
        issueInput({ number: 3, labels: ["type/feature"] }),
      ],
      [
        mergeEvent(2, 2, "2026-10-02T00:00:00.000Z"),
        mergeEvent(1, 1, "2026-10-02T00:00:00.000Z"),
        mergeEvent(3, 3, "2026-10-05T00:00:00.000Z"),
      ],
    );
    expect(snapshot.highlights.map((h) => h.issueNumber)).toEqual([3, 1, 2]);
  });

  it("is deterministic: the same inputs produce a deep-equal snapshot", () => {
    const issues = [
      issueInput({ number: 1, labels: ["type/feature"], releaseSignal: signal("feature", "One") }),
      issueInput({ number: 2, labels: ["type/bug"] }),
      issueInput({
        number: 3,
        title: "Umbrella",
        state: "closed",
        closedAt: "2026-10-10T00:00:00.000Z",
        decomposed: true,
        followUpUrls: [issueUrl(2)],
      }),
    ];
    const events = [
      mergeEvent(2, 5, "2026-10-04T00:00:00.000Z"),
      mergeEvent(1, 6, "2026-10-08T00:00:00.000Z"),
    ];
    const first = buildReleasePulse(repoInput(), issues, events);
    const second = buildReleasePulse(repoInput(), [...issues].reverse(), [...events].reverse());
    expect(second).toEqual(first);
  });

  it("accepts Date objects and normalizes all emitted timestamps to ISO strings", () => {
    const snapshot = buildReleasePulse(
      repoInput({ releaseBaselinePublishedAt: new Date(BASELINE) }),
      [issueInput({ number: 10, labels: ["type/feature"] })],
      [mergeEvent(10, 5, new Date("2026-10-05T00:00:00.000Z"))],
    );
    expect(snapshot.baseline?.publishedAt).toBe(BASELINE);
    expect(snapshot.highlights[0].deliveredAt).toBe("2026-10-05T00:00:00.000Z");
  });

  it("reports the unreleased commit count only for identical/ahead states", () => {
    const ahead = buildReleasePulse(repoInput({ releaseAheadBy: 7 }), [], []);
    expect(ahead.unreleasedCommits).toEqual({ state: "ahead", count: 7 });
    const identical = buildReleasePulse(repoInput({ releaseState: "identical", releaseAheadBy: null }), [], []);
    expect(identical.unreleasedCommits).toEqual({ state: "identical", count: 0 });
  });

  it("carries the head sha through a non-ready pulse", () => {
    const snapshot = buildReleasePulse(repoInput({ releaseState: "unknown" }), [], []);
    expect(snapshot.headSha).toBe("head0");
  });

  it("delivers a PR re-merge observed after baseline even though the PR's earliest observation predates it", () => {
    const snapshot = buildReleasePulse(
      repoInput(),
      [issueInput({ number: 10, labels: ["type/feature"], releaseSignal: signal("feature", "Re-merged work") })],
      [
        mergeEvent(10, 5, "2026-09-20T00:00:00.000Z"),
        mergeEvent(10, 5, "2026-10-05T00:00:00.000Z"),
      ],
    );
    expect(snapshot.deliveredIssueCount).toBe(1);
    expect(snapshot.highlights).toHaveLength(1);
    // The evidence entry keeps the PR's earliest observed merge time, while
    // delivery placement comes from the post-baseline re-merge observation —
    // not the per-PR timeline projection masking it.
    expect(snapshot.highlights[0].deliveredAt).toBe("2026-10-05T00:00:00.000Z");
    expect(snapshot.highlights[0].prs).toEqual([
      {
        prNumber: 5,
        prUrl: "https://github.com/octocat/hello-world/pull/5",
        mergeCommitSha: "merge5",
        mergedAt: "2026-09-20T00:00:00.000Z",
      },
    ]);
  });

  it("retains a pre-baseline merged PR in a delivered multi-PR issue's evidence", () => {
    // #1482: a deduped multi-PR highlight keeps links to ALL authoritative
    // merged PRs, including ones merged before the baseline; only the
    // delivery placement is baseline-scoped.
    const snapshot = buildReleasePulse(
      repoInput(),
      [issueInput({ number: 10, labels: ["type/feature"], releaseSignal: signal("feature", "Multi-PR") })],
      [
        mergeEvent(10, 5, "2026-09-20T00:00:00.000Z"),
        mergeEvent(10, 6, "2026-10-04T00:00:00.000Z"),
      ],
    );
    expect(snapshot.deliveredIssueCount).toBe(1);
    expect(snapshot.highlights).toHaveLength(1);
    expect(snapshot.highlights[0].deliveredAt).toBe("2026-10-04T00:00:00.000Z");
    expect(snapshot.highlights[0].prs.map((pr) => pr.prNumber)).toEqual([5, 6]);
  });

  it("treats a merge observation whose source stamp was unparseable as unknown delivery, never placed at observation time", () => {
    // Writer shape for an unparseable source stamp: occurredAt degrades to
    // the observation time and the raw text survives as mergedAtRaw, so a
    // pre-baseline merge observed after the baseline must NOT become a
    // highlight placed at write time.
    const snapshot = buildReleasePulse(
      repoInput(),
      [issueInput({ number: 10, labels: ["type/feature"], releaseSignal: signal("feature", "Would be false") })],
      [
        mergeEvent(10, 5, "2026-10-06T00:00:00.000Z", {
          metadata: { pullRequestNumber: 5, mergedAtRaw: "not-a-timestamp" },
        }),
      ],
    );
    expect(snapshot.deliveredIssueCount).toBe(0);
    expect(snapshot.unknownDeliveryCount).toBe(1);
    expect(snapshot.highlights).toEqual([]);
  });

  it("does not count a merge row observed at or before the baseline as unknown delivery", () => {
    // Writer shape for an unparseable source stamp: occurredAt degrades to
    // the observation time. A merge observed at or before the baseline
    // necessarily predates it, so its placement is not unknowable — it is
    // simply not this interval's delivery.
    const snapshot = buildReleasePulse(
      repoInput(),
      [issueInput({ number: 10, labels: ["type/feature"] })],
      [
        mergeEvent(10, 5, "2026-09-20T00:00:00.000Z", {
          metadata: { pullRequestNumber: 5, mergedAtRaw: "not-a-timestamp" },
        }),
      ],
    );
    expect(snapshot.deliveredIssueCount).toBe(0);
    expect(snapshot.unknownDeliveryCount).toBe(0);
    expect(snapshot.highlights).toEqual([]);
  });

  it("excludes a merge exactly at the baseline instant without counting it unknown", () => {
    const snapshot = buildReleasePulse(
      repoInput(),
      [issueInput({ number: 10, labels: ["type/feature"], releaseSignal: signal("feature", "Boundary") })],
      [mergeEvent(10, 5, BASELINE)],
    );
    expect(snapshot.deliveredIssueCount).toBe(0);
    expect(snapshot.unknownDeliveryCount).toBe(0);
    expect(snapshot.highlights).toEqual([]);
  });

  it("never highlights from a worker completion event alone", () => {
    const snapshot = buildReleasePulse(
      repoInput(),
      [issueInput({ number: 10, state: "closed", closedAt: "2026-10-05T00:00:00.000Z", labels: ["status/done", "type/feature"], releaseSignal: signal("feature", "Worker says done") })],
      [
        {
          issueNumber: 10,
          kind: "completed",
          source: "agent-work",
          actor: "alpha",
          agentName: "alpha",
          fromStatus: "status/in-progress",
          toStatus: "status/done",
          sourceEventId: null,
          occurredAt: "2026-10-05T00:00:00.000Z",
          observedAt: "2026-10-05T00:00:00.000Z",
          metadata: null,
        },
      ],
    );
    expect(snapshot.deliveredIssueCount).toBe(0);
    expect(snapshot.highlights).toEqual([]);
  });

  it("never highlights from a release signal without merge evidence", () => {
    const snapshot = buildReleasePulse(
      repoInput(),
      [issueInput({ number: 10, state: "closed", closedAt: "2026-10-05T00:00:00.000Z", releaseSignal: signal("feature", "Signal only") })],
      [],
    );
    expect(snapshot.deliveredIssueCount).toBe(0);
    expect(snapshot.highlights).toEqual([]);
  });
});
