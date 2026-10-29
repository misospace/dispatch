import { describe, expect, it } from "vitest";

import {
  buildIssueLifecycleTimeline,
  type LifecycleEventRecord,
  type TimelineIssueInput,
} from "./issue-lifecycle-read";

/**
 * Pure-fixture tests: the projection is a function of plain rows, so no
 * client stand-in is needed here — the rows are exactly the shape a prisma
 * query or a webhook payload would yield.
 */

const issue: TimelineIssueInput = {
  repoFullName: "octocat/hello-world",
  issueNumber: 42,
  state: "open",
};

function event(
  overrides: Partial<LifecycleEventRecord> & { kind: string; occurredAt: Date | string },
): LifecycleEventRecord {
  return {
    kind: overrides.kind,
    source: overrides.source ?? "api:claim",
    actor: overrides.actor ?? "alpha",
    agentName: overrides.agentName ?? null,
    fromStatus: overrides.fromStatus ?? null,
    toStatus: overrides.toStatus ?? null,
    sourceEventId: overrides.sourceEventId ?? null,
    occurredAt: overrides.occurredAt,
    observedAt: overrides.observedAt ?? overrides.occurredAt,
    metadata: overrides.metadata ?? null,
  };
}

describe("buildIssueLifecycleTimeline", () => {
  it("keeps firstClaim unknown with null intervals when no claim event exists", () => {
    const timeline = buildIssueLifecycleTimeline(issue, [
      event({ kind: "completed", source: "agent-report", occurredAt: "2026-10-02T00:00:00.000Z" }),
    ]);

    expect(timeline.claims).toEqual([]);
    expect(timeline.firstClaim).toEqual({ at: null, provenance: "unknown", via: [] });
    // doneAt is established, but without an anchor the interval is null — never 0.
    expect(timeline.doneAt.at).toBe("2026-10-02T00:00:00.000Z");
    expect(timeline.claimToDoneMs).toBeNull();
    expect(timeline.claimToMergeMs).toBeNull();
    expect(timeline.notes).toContain("no claim events: firstClaim is unknown, not zero");
  });

  it("keeps one entry per merged PR and measures claimToMergeMs from the earliest", () => {
    const timeline = buildIssueLifecycleTimeline(
      { ...issue, state: "closed", closedAt: "2026-10-06T00:00:00.000Z" },
      [
        event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
        event({
          kind: "pr_merged",
          source: "reconciler",
          sourceEventId: "pr-7",
          occurredAt: "2026-10-04T00:00:00.000Z",
          metadata: {
            pullRequestNumber: 7,
            pullRequestUrl: "https://github.com/octocat/hello-world/pull/7",
          },
        }),
        event({
          kind: "pr_merged",
          source: "reconciler",
          sourceEventId: "pr-8",
          occurredAt: "2026-10-05T00:00:00.000Z",
          metadata: { pullRequestNumber: 8 },
        }),
      ],
    );

    expect(timeline.pullRequests).toHaveLength(2);
    expect(timeline.pullRequests.map((pr) => pr.prNumber)).toEqual([7, 8]);
    expect(timeline.pullRequests[0].mergedAt).toBe("2026-10-04T00:00:00.000Z");
    expect(timeline.pullRequests[0].prUrl).toBe("https://github.com/octocat/hello-world/pull/7");
    expect(timeline.pullRequests[1].prUrl).toBeNull();
    expect(timeline.firstMergedAt.at).toBe("2026-10-04T00:00:00.000Z");
    expect(timeline.claimToMergeMs).toBe(
      Date.parse("2026-10-04T00:00:00.000Z") - Date.parse("2026-10-01T00:00:00.000Z"),
    );
    expect(timeline.delivery).toBe("merged");
  });

  it("unions metadata across repeated observations of the same PR, first non-null wins", () => {
    const timeline = buildIssueLifecycleTimeline(issue, [
      event({
        kind: "pr_merged",
        source: "sync",
        sourceEventId: "pr-6",
        occurredAt: "2026-10-02T00:00:00.000Z",
        metadata: {
          pullRequestNumber: 6,
          pullRequestUrl: "https://github.com/octocat/hello-world/pull/6",
          headSha: "h1",
        },
      }),
      event({
        kind: "pr_merged",
        source: "reconciler",
        sourceEventId: "pr-6",
        occurredAt: "2026-10-02T01:00:00.000Z",
        metadata: { pullRequestNumber: 6, mergeCommitSha: "abc123" },
      }),
    ]);

    expect(timeline.pullRequests).toEqual([
      {
        prNumber: 6,
        prUrl: "https://github.com/octocat/hello-world/pull/6",
        mergedAt: "2026-10-02T00:00:00.000Z",
        mergeCommitSha: "abc123",
        headSha: "h1",
        linkSource: null,
        provenance: "observed",
      },
    ]);
  });

  it("resolves a PR number from the pr-<n> sourceEventId when the metadata has none", () => {
    const timeline = buildIssueLifecycleTimeline(issue, [
      event({
        kind: "pr_merged",
        source: "reconciler",
        sourceEventId: "pr-11",
        occurredAt: "2026-10-02T00:00:00.000Z",
        metadata: { pullRequestUrl: "https://github.com/octocat/hello-world/pull/11" },
      }),
    ]);

    expect(timeline.pullRequests).toEqual([
      {
        prNumber: 11,
        prUrl: "https://github.com/octocat/hello-world/pull/11",
        mergedAt: "2026-10-02T00:00:00.000Z",
        mergeCommitSha: null,
        headSha: null,
        linkSource: null,
        provenance: "observed",
      },
    ]);
  });

  it("skips a pr_merged row that identifies no PR and says so", () => {
    const timeline = buildIssueLifecycleTimeline(issue, [
      event({ kind: "pr_merged", source: "reconciler", occurredAt: "2026-10-02T00:00:00.000Z", metadata: {} }),
    ]);

    expect(timeline.pullRequests).toEqual([]);
    expect(timeline.notes).toContain("pr_merged event (reconciler) skipped: no pull request number");
    expect(timeline.delivery).toBe("open");
  });

  it("is invariant to the order the same rows arrive in", () => {
    const rows = [
      event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
      event({
        kind: "status_changed",
        source: "api:status",
        actor: "operator",
        fromStatus: "status/ready",
        toStatus: "status/in-progress",
        occurredAt: "2026-10-01T01:00:00.000Z",
      }),
      event({ kind: "issue_closed", source: "sync", actor: "github", occurredAt: "2026-10-02T00:00:00.000Z" }),
      event({
        kind: "pr_merged",
        source: "reconciler",
        sourceEventId: "pr-5",
        occurredAt: "2026-10-03T00:00:00.000Z",
        metadata: { pullRequestNumber: 5 },
      }),
    ];
    const shuffled = [rows[2], rows[0], rows[3], rows[1]];

    expect(JSON.stringify(buildIssueLifecycleTimeline(issue, shuffled))).toBe(
      JSON.stringify(buildIssueLifecycleTimeline(issue, rows)),
    );
  });

  it("collapses an api and a webhook observation of the same transition into one, with a note", () => {
    const at = "2026-10-01T05:00:00.000Z";
    const timeline = buildIssueLifecycleTimeline(issue, [
      event({ kind: "claim", agentName: "alpha", occurredAt: "2026-09-30T00:00:00.000Z" }),
      event({
        kind: "status_changed",
        source: "api:status",
        actor: "operator",
        fromStatus: "status/in-progress",
        toStatus: "status/done",
        occurredAt: at,
        observedAt: "2026-10-01T05:00:01.000Z",
      }),
      event({
        kind: "status_changed",
        source: "webhook",
        actor: "github",
        fromStatus: "status/in-progress",
        toStatus: "status/done",
        occurredAt: at,
        observedAt: "2026-10-01T05:00:02.000Z",
      }),
    ]);

    expect(timeline.notes).toContain("duplicate observation collapsed");
    expect(timeline.doneAt).toEqual({ at, provenance: "observed", via: ["status_changed"] });
  });

  it("reports closed-unmerged when the issue closed without an observed merge", () => {
    const timeline = buildIssueLifecycleTimeline(
      { ...issue, state: "closed", closedAt: "2026-10-02T00:00:00.000Z" },
      [
        event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
        event({ kind: "issue_closed", source: "sync", actor: "github", occurredAt: "2026-10-02T00:00:00.000Z" }),
      ],
    );

    expect(timeline.closedAt.at).toBe("2026-10-02T00:00:00.000Z");
    expect(timeline.delivery).toBe("closed-unmerged");
    expect(timeline.claimToMergeMs).toBeNull();
  });

  it("keeps the first claim intact through a close, a reopen, and a re-claim", () => {
    const timeline = buildIssueLifecycleTimeline(issue, [
      event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
      event({ kind: "issue_closed", source: "sync", actor: "github", occurredAt: "2026-10-02T00:00:00.000Z" }),
      event({ kind: "issue_reopened", source: "sync", actor: "github", occurredAt: "2026-10-03T00:00:00.000Z" }),
      event({ kind: "claim", agentName: "bravo", occurredAt: "2026-10-04T00:00:00.000Z" }),
    ]);

    expect(timeline.firstClaim.at).toBe("2026-10-01T00:00:00.000Z");
    expect(timeline.firstClaim.provenance).toBe("observed");
    expect(timeline.claims).toHaveLength(2);
    expect(timeline.claims.map((claim) => claim.agentName)).toEqual(["alpha", "bravo"]);
    expect(timeline.lastReopenAt.at).toBe("2026-10-03T00:00:00.000Z");
    expect(timeline.closedAt.at).toBe("2026-10-02T00:00:00.000Z");
    // The later reopen undoes the close; the issue's present state says open.
    expect(timeline.delivery).toBe("open");
  });

  it("does not call a reopened issue open when the state says something else", () => {
    const timeline = buildIssueLifecycleTimeline({ ...issue, state: "archived" }, [
      event({ kind: "issue_closed", source: "sync", actor: "github", occurredAt: "2026-10-01T00:00:00.000Z" }),
      event({ kind: "issue_reopened", source: "sync", actor: "github", occurredAt: "2026-10-02T00:00:00.000Z" }),
    ]);

    expect(timeline.delivery).toBe("unknown");
  });

  it("reports closed-unmerged again when a close follows a reopen, keeping the first close milestone", () => {
    // Regression (#1203 review): delivery follows the LATEST close/reopen
    // ordering — a close after a reopen closes the item again — while
    // `closedAt` keeps reporting the FIRST close.
    const timeline = buildIssueLifecycleTimeline(
      { ...issue, state: "closed", closedAt: "2026-10-04T00:00:00.000Z" },
      [
        event({ kind: "issue_closed", source: "sync", actor: "github", occurredAt: "2026-10-02T00:00:00.000Z" }),
        event({ kind: "issue_reopened", source: "sync", actor: "github", occurredAt: "2026-10-03T00:00:00.000Z" }),
        event({ kind: "issue_closed", source: "sync", actor: "github", occurredAt: "2026-10-04T00:00:00.000Z" }),
      ],
    );

    expect(timeline.delivery).toBe("closed-unmerged");
    expect(timeline.closedAt.at).toBe("2026-10-02T00:00:00.000Z");
    expect(timeline.lastReopenAt.at).toBe("2026-10-03T00:00:00.000Z");
    // The LATEST close evidence resolves against the reclose (#1482 review:
    // durable completion must compare the reopen with the close that
    // superseded it, not the first close).
    expect(timeline.lastClosedAt).toEqual({
      at: "2026-10-04T00:00:00.000Z",
      provenance: "observed",
      via: ["issue_closed"],
    });
    expect(timeline.notes).toContain("delivery derived from a close after a reopen");
  });

  it("carries the issue cache into lastClosedAt when it holds the latest close", () => {
    // Observed closes stop at 10-02 but the cache's closedAt (10-05) is later
    // evidence of the durable close: lastClosedAt takes the max, matching the
    // ordering delivery is derived from.
    const timeline = buildIssueLifecycleTimeline(
      { ...issue, state: "closed", closedAt: "2026-10-05T00:00:00.000Z" },
      [
        event({ kind: "issue_closed", source: "sync", actor: "github", occurredAt: "2026-10-02T00:00:00.000Z" }),
        event({ kind: "issue_reopened", source: "sync", actor: "github", occurredAt: "2026-10-03T00:00:00.000Z" }),
      ],
    );

    expect(timeline.lastClosedAt).toEqual({
      at: "2026-10-05T00:00:00.000Z",
      provenance: "observed",
      via: ["issue_closed", "issue-cache"],
    });
    // The cache's later close postdates the reopen: closed-unmerged again,
    // under the same ordering lastClosedAt reports.
    expect(timeline.delivery).toBe("closed-unmerged");
  });

  it("does not claim a close-after-reopen delivery when a merged PR decided it", () => {
    // The note reports how delivery was derived — a merged delivery was
    // decided by the merge, so the note stays silent.
    const timeline = buildIssueLifecycleTimeline(
      { ...issue, state: "closed", closedAt: "2026-10-04T00:00:00.000Z" },
      [
        event({ kind: "issue_closed", source: "sync", actor: "github", occurredAt: "2026-10-02T00:00:00.000Z" }),
        event({ kind: "issue_reopened", source: "sync", actor: "github", occurredAt: "2026-10-03T00:00:00.000Z" }),
        event({ kind: "issue_closed", source: "sync", actor: "github", occurredAt: "2026-10-04T00:00:00.000Z" }),
        event({
          kind: "pr_merged",
          source: "reconciler",
          sourceEventId: "pr-7",
          occurredAt: "2026-10-05T00:00:00.000Z",
          metadata: { pullRequestNumber: 7 },
        }),
      ],
    );

    expect(timeline.delivery).toBe("merged");
    expect(timeline.notes).not.toContain("delivery derived from a close after a reopen");
  });

  it("counts the issue cache's closedAt as the latest close when the second close has no event", () => {
    // The cache is the only evidence of the second close, so the item is
    // closed again — the milestone still reports the FIRST close.
    const timeline = buildIssueLifecycleTimeline(
      { ...issue, state: "closed", closedAt: "2026-10-04T00:00:00.000Z" },
      [
        event({ kind: "issue_closed", source: "sync", actor: "github", occurredAt: "2026-10-02T00:00:00.000Z" }),
        event({ kind: "issue_reopened", source: "sync", actor: "github", occurredAt: "2026-10-03T00:00:00.000Z" }),
      ],
    );

    expect(timeline.delivery).toBe("closed-unmerged");
    expect(timeline.closedAt.at).toBe("2026-10-02T00:00:00.000Z");
  });

  it("does not let the issue cache certify a close for an open issue", () => {
    const timeline = buildIssueLifecycleTimeline(
      { ...issue, state: "open", closedAt: "2026-10-04T00:00:00.000Z" },
      [],
    );

    expect(timeline.delivery).toBe("open");
  });

  it("establishes doneAt from a completed event or a status move to status/done", () => {
    const fromCompleted = buildIssueLifecycleTimeline(issue, [
      event({ kind: "completed", source: "agent-report", actor: "alpha", occurredAt: "2026-10-02T00:00:00.000Z" }),
    ]);
    expect(fromCompleted.doneAt).toEqual({
      at: "2026-10-02T00:00:00.000Z",
      provenance: "observed",
      via: ["completed"],
    });

    const fromStatus = buildIssueLifecycleTimeline(issue, [
      event({
        kind: "status_changed",
        source: "api:move",
        actor: "operator",
        fromStatus: "status/in-progress",
        toStatus: "status/done",
        occurredAt: "2026-10-02T00:00:00.000Z",
      }),
    ]);
    expect(fromStatus.doneAt).toEqual({
      at: "2026-10-02T00:00:00.000Z",
      provenance: "observed",
      via: ["status_changed"],
    });

    const both = buildIssueLifecycleTimeline(issue, [
      event({
        kind: "status_changed",
        source: "api:move",
        actor: "operator",
        fromStatus: "status/in-progress",
        toStatus: "status/done",
        occurredAt: "2026-10-02T00:00:00.000Z",
      }),
      event({ kind: "completed", source: "agent-report", actor: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
    ]);
    expect(both.doneAt.at).toBe("2026-10-01T00:00:00.000Z");
    expect(both.doneAt.via).toEqual(["completed", "status_changed"]);
  });

  it("marks a backfilled claim and a backfilled merge as backfilled", () => {
    const timeline = buildIssueLifecycleTimeline(issue, [
      event({
        kind: "claim",
        agentName: "alpha",
        source: "backfill",
        occurredAt: "2026-10-01T00:00:00.000Z",
        metadata: { backfilled: true },
      }),
      event({
        kind: "pr_merged",
        source: "backfill",
        sourceEventId: "pr-3",
        occurredAt: "2026-10-02T00:00:00.000Z",
        metadata: { pullRequestNumber: 3, backfilled: true },
      }),
    ]);

    expect(timeline.claims[0].provenance).toBe("backfilled");
    expect(timeline.firstClaim.provenance).toBe("backfilled");
    expect(timeline.pullRequests[0].provenance).toBe("backfilled");
    expect(timeline.firstMergedAt.provenance).toBe("backfilled");
  });

  it("preserves a negative claimToMergeMs when the merge precedes the first observed claim, and says why", () => {
    const timeline = buildIssueLifecycleTimeline(issue, [
      event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-02T00:00:00.000Z" }),
      event({
        kind: "pr_merged",
        source: "reconciler",
        sourceEventId: "pr-9",
        occurredAt: "2026-10-01T00:00:00.000Z",
        metadata: { pullRequestNumber: 9 },
      }),
    ]);

    expect(timeline.claimToMergeMs).toBe(-24 * 3600 * 1000);
    expect(timeline.notes).toContain("claimToMergeMs negative: merge precedes first observed claim");
  });

  it("falls back to the issue cache closedAt, tagged issue-cache, when no close event exists", () => {
    const timeline = buildIssueLifecycleTimeline(
      { ...issue, state: "closed", closedAt: "2026-10-02T12:00:00.000Z" },
      [],
    );

    expect(timeline.closedAt).toEqual({
      at: "2026-10-02T12:00:00.000Z",
      provenance: "observed",
      via: ["issue-cache"],
    });
    expect(timeline.delivery).toBe("closed-unmerged");
  });

  it("skips a row whose occurredAt does not parse and says which one it was", () => {
    const timeline = buildIssueLifecycleTimeline(issue, [
      event({ kind: "claim", agentName: "alpha", occurredAt: "not-a-date" }),
      event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
    ]);

    expect(timeline.notes).toContain("event claim (api:claim) skipped: unparseable occurredAt");
    expect(timeline.claims).toHaveLength(1);
    expect(timeline.firstClaim.at).toBe("2026-10-01T00:00:00.000Z");
  });

  it("reports unknown delivery for an unrecognizable state with no establishing events", () => {
    const timeline = buildIssueLifecycleTimeline({ ...issue, state: "weird" }, []);

    expect(timeline.delivery).toBe("unknown");
    expect(timeline.firstClaim).toEqual({ at: null, provenance: "unknown", via: [] });
    expect(timeline.doneAt).toEqual({ at: null, provenance: "unknown", via: [] });
    expect(timeline.closedAt).toEqual({ at: null, provenance: "unknown", via: [] });
    expect(timeline.lastReopenAt).toEqual({ at: null, provenance: "unknown", via: [] });
    expect(timeline.firstMergedAt).toEqual({ at: null, provenance: "unknown", via: [] });
  });
});
