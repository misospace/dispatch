import { describe, expect, it } from "vitest";

import {
  aggregateDeliveryCohorts,
  deriveDeliverySample,
  type DeliverySampleInput,
} from "./delivery-cohorts";
import type { LifecycleEventRecord, TimelineIssueInput } from "./issue-lifecycle-read";
import type {
  WorkAttemptPrFixItemRecord,
  WorkAttemptRunRecord,
} from "./work-attempt-chain";

const NOW = Date.parse("2026-10-25T00:00:00.000Z");
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const MIN = 60000;
const HOUR = 3600000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function issue(
  overrides: Partial<TimelineIssueInput> & { issueNumber: number },
): TimelineIssueInput {
  return {
    repoFullName: overrides.repoFullName ?? "octocat/hello-world",
    issueNumber: overrides.issueNumber,
    state: overrides.state ?? "open",
    closedAt: overrides.closedAt,
  };
}

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

function run(
  overrides: Partial<WorkAttemptRunRecord> & { id: string },
): WorkAttemptRunRecord {
  return {
    id: overrides.id,
    agentName: overrides.agentName ?? null,
    runType: overrides.runType ?? "agent",
    status: overrides.status ?? "FINISHED",
    startedAt: overrides.startedAt ?? "2026-10-01T00:10:00.000Z",
    finishedAt: overrides.finishedAt ?? null,
    executionMetadata: overrides.executionMetadata ?? null,
    prFixQueueItemId: overrides.prFixQueueItemId ?? null,
    prFixGeneration: overrides.prFixGeneration ?? null,
  };
}

function prFixItem(
  overrides: Partial<WorkAttemptPrFixItemRecord> & { id: string },
): WorkAttemptPrFixItemRecord {
  return {
    id: overrides.id,
    repo: overrides.repo ?? "octocat/hello-world",
    pr: overrides.pr ?? 101,
    issue: overrides.issue ?? null,
    generation: overrides.generation ?? 1,
    fixAttempts: overrides.fixAttempts ?? 1,
    status: overrides.status ?? "FIXED",
    outcome: overrides.outcome ?? null,
    type: overrides.type ?? "CI_FAILURE",
    queuedAt: overrides.queuedAt ?? "2026-10-01T00:45:00.000Z",
    history: overrides.history ?? [],
    historyTruncated: overrides.historyTruncated ?? false,
  };
}

function sample(
  overrides: Partial<DeliverySampleInput> & { issue: TimelineIssueInput },
): DeliverySampleInput {
  return {
    issue: overrides.issue,
    events: overrides.events ?? [],
    runs: overrides.runs ?? [],
    prFixItems: overrides.prFixItems ?? [],
    labels: overrides.labels,
    dbIssueId: overrides.dbIssueId,
  };
}

// ── 1. merged first-pass ────────────────────────────────────────────────────

describe("deriveDeliverySample", () => {
  it("derives a merged first-pass sample", () => {
    const s = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 1, state: "closed", closedAt: "2026-10-01T03:00:00.000Z" }),
        events: [
          event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
          event({ kind: "completed", agentName: "alpha", occurredAt: "2026-10-01T02:00:00.000Z" }),
          event({
            kind: "pr_merged",
            source: "reconciler",
            sourceEventId: "pr-101",
            occurredAt: "2026-10-01T02:00:00.000Z",
            metadata: { pullRequestNumber: 101 },
          }),
        ],
        runs: [
          run({
            id: "run-1",
            agentName: "alpha",
            startedAt: "2026-10-01T00:10:00.000Z",
            finishedAt: "2026-10-01T00:30:00.000Z",
            executionMetadata: { model: "gpt-5" },
          }),
        ],
      }),
      NOW,
    );

    expect(s.delivery).toBe("merged");
    expect(s.firstPass).toBe(true);
    expect(s.fixRounds).toBe(0);
    expect(s.failedAttempts).toBe(0);
    expect(s.claimToMergeMs).toBe(2 * HOUR);
    expect(s.claimToDoneMs).toBe(2 * HOUR);
    expect(s.workerTimeMs).toBe(20 * MIN);
    // Claim 00:00 → run start 00:10 is an observed pickup wait; the rest of
    // the claim→done span stays unclassified.
    expect(s.observedWaits.pickupMs).toBe(10 * MIN);
    expect(s.observedWaits.inReviewMs).toBeNull();
    expect(s.observedWaits.blockedMs).toBeNull();
    expect(s.observedWaits.fixQueuedMs).toBeNull();
    expect(s.unclassifiedMs).toBe(2 * HOUR - 20 * MIN - 10 * MIN);
    expect(s.runIntervalsMs).toEqual([
      {
        startMs: Date.parse("2026-10-01T00:10:00.000Z"),
        endMs: Date.parse("2026-10-01T00:30:00.000Z"),
      },
    ]);
    expect(s.dbIssueId).toBeNull();
    expect(s.mixedSettings).toBe(false);
    expect(s.cohortKeys.model).toBe("gpt-5");
    expect(s.cohortKeys.worker).toBe("unknown");
    expect(s.settings.model).toBe("gpt-5");
    expect(s.settings.worker).toBeNull();
    expect(s.missing).toEqual([]);
    expect(s.excludedFromDurations).toBe(false);
    expect(s.ageMs).toBeNull();
    expect(s.issueId).toBe("octocat/hello-world#1");
    expect(s.taskType).toBe("unknown");
  });

  // ── 2. multiple fix rounds → firstPass false ──────────────────────────────

  it("marks firstPass false when fix rounds exist", () => {
    const s = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 1, state: "closed", closedAt: "2026-10-01T05:00:00.000Z" }),
        events: [
          event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
          event({ kind: "completed", agentName: "alpha", occurredAt: "2026-10-01T04:00:00.000Z" }),
          event({
            kind: "pr_merged",
            source: "reconciler",
            sourceEventId: "pr-101",
            occurredAt: "2026-10-01T04:00:00.000Z",
            metadata: { pullRequestNumber: 101 },
          }),
        ],
        runs: [
          run({
            id: "run-1",
            agentName: "alpha",
            startedAt: "2026-10-01T00:10:00.000Z",
            finishedAt: "2026-10-01T00:30:00.000Z",
            executionMetadata: { model: "gpt-5" },
          }),
          run({
            id: "run-fix",
            agentName: "bravo",
            startedAt: "2026-10-01T02:00:00.000Z",
            finishedAt: "2026-10-01T02:10:00.000Z",
            executionMetadata: { model: "gpt-5" },
            prFixQueueItemId: "fi-1",
            prFixGeneration: 1,
          }),
        ],
        prFixItems: [prFixItem({ id: "fi-1", generation: 1, status: "FIXED" })],
      }),
      NOW,
    );

    expect(s.delivery).toBe("merged");
    expect(s.firstPass).toBe(false);
    expect(s.fixRounds).toBe(1);
    expect(s.failedAttempts).toBe(0);
  });

  // ── 3. mixed models (regression: failed=m-old, merged=m-new) ──────────────

  it("marks model mixed when attempts span different models", () => {
    const s = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 1, state: "closed", closedAt: "2026-10-01T05:00:00.000Z" }),
        events: [
          event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
          event({ kind: "claim", agentName: "bravo", occurredAt: "2026-10-01T01:00:00.000Z" }),
          event({
            kind: "pr_merged",
            source: "reconciler",
            sourceEventId: "pr-101",
            occurredAt: "2026-10-01T03:00:00.000Z",
            metadata: { pullRequestNumber: 101 },
          }),
        ],
        runs: [
          run({
            id: "run-a",
            agentName: "alpha",
            startedAt: "2026-10-01T00:10:00.000Z",
            finishedAt: "2026-10-01T00:50:00.000Z",
            executionMetadata: { model: "m-old" },
          }),
          run({
            id: "run-b",
            agentName: "bravo",
            startedAt: "2026-10-01T01:10:00.000Z",
            finishedAt: "2026-10-01T02:00:00.000Z",
            executionMetadata: { model: "m-new" },
          }),
        ],
      }),
      NOW,
    );

    expect(s.cohortKeys.model).toBe("mixed");
    expect(s.mixedSettings).toBe(true);
    expect(s.settings.model).toBeNull();
  });

  // ── 3b. intra-attempt setting change (#1423): one claim, two runs ─────────

  it("marks model mixed when one attempt's runs restart under another model", () => {
    const s = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 1, state: "closed", closedAt: "2026-10-01T05:00:00.000Z" }),
        events: [
          event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
          event({ kind: "completed", agentName: "alpha", occurredAt: "2026-10-01T04:00:00.000Z" }),
          event({
            kind: "pr_merged",
            source: "reconciler",
            sourceEventId: "pr-101",
            occurredAt: "2026-10-01T04:00:00.000Z",
            metadata: { pullRequestNumber: 101 },
          }),
        ],
        runs: [
          run({
            id: "run-a",
            agentName: "alpha",
            startedAt: "2026-10-01T00:10:00.000Z",
            finishedAt: "2026-10-01T00:50:00.000Z",
            executionMetadata: { model: "m-old" },
          }),
          run({
            id: "run-b",
            agentName: "alpha",
            startedAt: "2026-10-01T01:10:00.000Z",
            finishedAt: "2026-10-01T02:00:00.000Z",
            executionMetadata: { model: "m-new" },
          }),
        ],
      }),
      NOW,
    );

    // Both runs land on the SAME attempt; the union must still see the
    // intra-attempt change through the chain's distinct value sets.
    expect(s.cohortKeys.model).toBe("mixed");
    expect(s.mixedSettings).toBe(true);
    expect(s.settings.model).toBeNull();
  });

  // ── 4. missing claim ──────────────────────────────────────────────────────

  it("marks missing claim and nulls intervals when no claim event exists", () => {
    const s = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 1, state: "closed", closedAt: "2026-10-01T03:00:00.000Z" }),
        events: [
          event({
            kind: "pr_merged",
            source: "reconciler",
            sourceEventId: "pr-101",
            occurredAt: "2026-10-01T02:00:00.000Z",
            metadata: { pullRequestNumber: 101 },
          }),
        ],
        runs: [],
      }),
      NOW,
    );

    expect(s.firstClaimAt).toBeNull();
    expect(s.claimToDoneMs).toBeNull();
    expect(s.claimToMergeMs).toBeNull();
    expect(s.missing).toContain("claim");
    expect(s.missing).toContain("attempts");
    expect(s.missing).toContain("metadata");
    expect(s.workerTimeMs).toBeNull();
    expect(s.unclassifiedMs).toBeNull();
  });

  // ── 5. overlapping run intervals → union ──────────────────────────────────

  it("computes workerTimeMs as the union of overlapping run intervals", () => {
    const s = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 1 }),
        events: [
          event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
        ],
        runs: [
          run({
            id: "run-1",
            agentName: "alpha",
            startedAt: "2026-10-01T00:10:00.000Z",
            finishedAt: "2026-10-01T00:30:00.000Z",
            executionMetadata: { model: "gpt-5" },
          }),
          run({
            id: "run-2",
            agentName: "alpha",
            startedAt: "2026-10-01T00:20:00.000Z",
            finishedAt: "2026-10-01T00:40:00.000Z",
            executionMetadata: { model: "gpt-5" },
          }),
        ],
      }),
      NOW,
    );

    // Union: 00:10-00:40 = 30min, not 40min.
    expect(s.workerTimeMs).toBe(30 * MIN);
  });

  // ── 6. still-open → excludedFromDurations, ageMs ─────────────────────────

  it("marks open delivery as excluded with ageMs", () => {
    const s = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 1, state: "open" }),
        events: [
          event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
        ],
        runs: [
          run({
            id: "run-1",
            agentName: "alpha",
            startedAt: "2026-10-01T00:10:00.000Z",
            finishedAt: "2026-10-01T00:30:00.000Z",
            executionMetadata: { model: "gpt-5" },
          }),
        ],
      }),
      NOW,
    );

    expect(s.delivery).toBe("open");
    expect(s.excludedFromDurations).toBe(true);
    expect(s.ageMs).toBe(NOW - T0);
    expect(s.firstPass).toBeNull();
  });

  // ── 7. 9 items, percentiles, cohorts, throughput ──────────────────────────

  it("computes nearest-rank percentiles, cohort stats, and throughput over 9 items", () => {
    function makeAggItem(i: number, cohort: string, merged: boolean): DeliverySampleInput {
      const claimAt = T0 + (i - 1) * 1000;
      const doneAt = T0 + (i - 1) * 1000 + i * 100;
      const events: LifecycleEventRecord[] = [
        event({ kind: "claim", agentName: "w", occurredAt: iso(claimAt) }),
        event({ kind: "completed", agentName: "w", occurredAt: iso(doneAt) }),
      ];
      if (merged) {
        events.push(
          event({
            kind: "pr_merged",
            source: "reconciler",
            sourceEventId: `pr-${i}`,
            occurredAt: iso(doneAt),
            metadata: { pullRequestNumber: i },
          }),
        );
      } else {
        events.push(
          event({ kind: "issue_closed", source: "webhook", occurredAt: iso(doneAt) }),
        );
      }
      return {
        issue: issue({ issueNumber: i, state: "closed", closedAt: iso(doneAt) }),
        events,
        runs: [
          run({
            id: `run-${i}`,
            agentName: "w",
            startedAt: iso(claimAt),
            finishedAt: iso(doneAt),
            executionMetadata: { cohortLabel: cohort, model: "m" },
          }),
        ],
        prFixItems: [],
      };
    }

    const samples: DeliverySampleInput[] = [];
    for (let i = 1; i <= 5; i++) samples.push(makeAggItem(i, "cohort-A", true));
    for (let i = 6; i <= 9; i++) samples.push(makeAggItem(i, "cohort-B", false));

    const derived = samples.map((input) => deriveDeliverySample(input, NOW));
    const windowSince = T0;
    const windowUntil = T0 + 10 * 86400000;
    const report = aggregateDeliveryCohorts(derived, {
      dimension: "cohort",
      windowSinceMs: windowSince,
      windowUntilMs: windowUntil,
    });

    // Two cohorts: A (5 merged) and B (4 closed-unmerged).
    expect(report.cohorts).toHaveLength(2);
    const [cohortA, cohortB] = report.cohorts;

    // A has more samples, so it sorts first.
    expect(cohortA.key).toBe("cohort-A");
    expect(cohortA.sampleCount).toBe(5);
    expect(cohortA.delivery).toEqual({ merged: 5, "closed-unmerged": 0, open: 0, unknown: 0 });
    expect(cohortA.mergedThroughputPerDay).toBe(0.5); // 5 / 10 days

    expect(cohortB.key).toBe("cohort-B");
    expect(cohortB.sampleCount).toBe(4);
    expect(cohortB.delivery).toEqual({ merged: 0, "closed-unmerged": 4, open: 0, unknown: 0 });
    expect(cohortB.mergedThroughputPerDay).toBe(0);

    // claimToDone for cohort A: [100, 200, 300, 400, 500]
    expect(cohortA.claimToDone).toEqual({
      samples: 5,
      min: 100,
      max: 500,
      mean: 300,
      p50: 300,  // ceil(0.5*5)-1 = 2 → sorted[2] = 300
      p90: 500,  // ceil(0.9*5)-1 = 4 → sorted[4] = 500
    });
    // claimToMerge for cohort A: same values (all merged)
    expect(cohortA.claimToMerge).toEqual({
      samples: 5,
      min: 100,
      max: 500,
      mean: 300,
      p50: 300,
      p90: 500,
    });

    // claimToDone for cohort B: [600, 700, 800, 900]
    expect(cohortB.claimToDone).toEqual({
      samples: 4,
      min: 600,
      max: 900,
      mean: 750,
      p50: 700,  // ceil(0.5*4)-1 = 1 → sorted[1] = 700
      p90: 900,  // ceil(0.9*4)-1 = 3 → sorted[3] = 900
    });
    // No merges in cohort B.
    expect(cohortB.claimToMerge).toBeNull();

    // Totals: all 9 items.
    expect(report.totals.key).toBe("all");
    expect(report.totals.sampleCount).toBe(9);
    expect(report.totals.delivery).toEqual({
      merged: 5,
      "closed-unmerged": 4,
      open: 0,
      unknown: 0,
    });
    expect(report.totals.mergedThroughputPerDay).toBe(0.5);

    // claimToDone for all 9: [100..900]
    expect(report.totals.claimToDone).toEqual({
      samples: 9,
      min: 100,
      max: 900,
      mean: 500,
      p50: 500,  // ceil(0.5*9)-1 = 4 → sorted[4] = 500
      p90: 900,  // ceil(0.9*9)-1 = 8 → sorted[8] = 900
    });

    // firstPass: all 9 are first-pass (no fix rounds, no failed attempts).
    expect(report.totals.firstPass).toEqual({ true: 9, false: 0, null: 0 });
  });

  // ── 8. closed-unmerged → completed, not merged ───────────────────────────

  it("counts closed-unmerged as completed but not merged", () => {
    const s = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 1, state: "closed", closedAt: "2026-10-01T03:00:00.000Z" }),
        events: [
          event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
          event({ kind: "completed", agentName: "alpha", occurredAt: "2026-10-01T02:00:00.000Z" }),
          event({ kind: "issue_closed", source: "webhook", occurredAt: "2026-10-01T03:00:00.000Z" }),
        ],
        runs: [
          run({
            id: "run-1",
            agentName: "alpha",
            startedAt: "2026-10-01T00:10:00.000Z",
            finishedAt: "2026-10-01T00:30:00.000Z",
            executionMetadata: { model: "gpt-5" },
          }),
        ],
      }),
      NOW,
    );

    expect(s.delivery).toBe("closed-unmerged");
    expect(s.claimToDoneMs).toBe(2 * HOUR);
    expect(s.claimToMergeMs).toBeNull();
    expect(s.firstPass).toBe(true);
    expect(s.excludedFromDurations).toBe(false);
  });

  // ── 9. abandoned/superseded → failedAttempts, firstPass false ─────────────

  it("counts superseded attempts as failed and sets firstPass false", () => {
    const s = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 1, state: "closed", closedAt: "2026-10-01T04:00:00.000Z" }),
        events: [
          event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
          event({ kind: "claim", agentName: "bravo", occurredAt: "2026-10-01T01:00:00.000Z" }),
          event({
            kind: "pr_merged",
            source: "reconciler",
            sourceEventId: "pr-101",
            occurredAt: "2026-10-01T03:00:00.000Z",
            metadata: { pullRequestNumber: 101 },
          }),
        ],
        runs: [
          run({
            id: "run-a",
            agentName: "alpha",
            startedAt: "2026-10-01T00:10:00.000Z",
            finishedAt: "2026-10-01T00:50:00.000Z",
            executionMetadata: { model: "m" },
          }),
          run({
            id: "run-b",
            agentName: "bravo",
            startedAt: "2026-10-01T01:10:00.000Z",
            finishedAt: "2026-10-01T02:00:00.000Z",
            executionMetadata: { model: "m" },
          }),
        ],
      }),
      NOW,
    );

    // Alpha's attempt is superseded by bravo's claim.
    expect(s.failedAttempts).toBe(1);
    expect(s.firstPass).toBe(false);
    expect(s.delivery).toBe("merged");
  });

  // ── 10. no metadata → all "unknown" ───────────────────────────────────────

  it("marks all settings unknown when no attempt carries metadata", () => {
    const s = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 1 }),
        events: [
          event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
        ],
        runs: [
          run({
            id: "run-1",
            agentName: "alpha",
            startedAt: "2026-10-01T00:10:00.000Z",
            finishedAt: "2026-10-01T00:20:00.000Z",
          }),
        ],
      }),
      NOW,
    );

    expect(s.cohortKeys.worker).toBe("unknown");
    expect(s.cohortKeys.model).toBe("unknown");
    expect(s.cohortKeys.reasoningEffort).toBe("unknown");
    expect(s.cohortKeys.runtimeRevision).toBe("unknown");
    expect(s.cohortKeys.cohort).toBe("unknown");
    expect(s.mixedSettings).toBe(false);
    expect(s.settings).toEqual({
      worker: null,
      model: null,
      reasoningEffort: null,
      runtimeRevision: null,
    });
    expect(s.missing).toContain("metadata");
  });

  // ── 11. dimension switching ───────────────────────────────────────────────

  it("switches grouping by dimension", () => {
    const samples = [
      deriveDeliverySample(
        sample({
          issue: issue({
            issueNumber: 1,
            state: "closed",
            closedAt: "2026-10-01T02:00:00.000Z",
            repoFullName: "org/repo-a",
          }),
          events: [
            event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
            event({ kind: "completed", agentName: "alpha", occurredAt: "2026-10-01T01:00:00.000Z" }),
            event({
              kind: "pr_merged",
              source: "reconciler",
              sourceEventId: "pr-1",
              occurredAt: "2026-10-01T01:00:00.000Z",
              metadata: { pullRequestNumber: 1 },
            }),
          ],
          runs: [
            run({
              id: "r-1",
              agentName: "alpha",
              startedAt: "2026-10-01T00:10:00.000Z",
              finishedAt: "2026-10-01T00:20:00.000Z",
              executionMetadata: { model: "gpt-5" },
            }),
          ],
          labels: ["type/bug"],
        }),
        NOW,
      ),
      deriveDeliverySample(
        sample({
          issue: issue({
            issueNumber: 2,
            state: "closed",
            closedAt: "2026-10-01T02:00:00.000Z",
            repoFullName: "org/repo-b",
          }),
          events: [
            event({ kind: "claim", agentName: "bravo", occurredAt: "2026-10-01T00:00:00.000Z" }),
            event({ kind: "completed", agentName: "bravo", occurredAt: "2026-10-01T01:00:00.000Z" }),
            event({
              kind: "pr_merged",
              source: "reconciler",
              sourceEventId: "pr-2",
              occurredAt: "2026-10-01T01:00:00.000Z",
              metadata: { pullRequestNumber: 2 },
            }),
          ],
          runs: [
            run({
              id: "r-2",
              agentName: "bravo",
              startedAt: "2026-10-01T00:10:00.000Z",
              finishedAt: "2026-10-01T00:20:00.000Z",
              executionMetadata: { model: "claude" },
            }),
          ],
          labels: ["type/feature"],
        }),
        NOW,
      ),
    ];

    const noWindow = { windowSinceMs: null, windowUntilMs: null };

    const byModel = aggregateDeliveryCohorts(samples, { dimension: "model", ...noWindow });
    expect(byModel.cohorts.map((c) => c.key)).toEqual(["claude", "gpt-5"]);

    const byRepo = aggregateDeliveryCohorts(samples, { dimension: "repository", ...noWindow });
    expect(byRepo.cohorts.map((c) => c.key)).toEqual(["org/repo-a", "org/repo-b"]);

    const byType = aggregateDeliveryCohorts(samples, { dimension: "taskType", ...noWindow });
    expect(byType.cohorts.map((c) => c.key)).toEqual(["bug", "feature"]);
  });
});

// ── 12. extended cohort aggregates ──────────────────────────────────────────

describe("aggregateDeliveryCohorts extended aggregates", () => {
  const DAY = 86400000;

  function extendedSamples(): ReturnType<typeof deriveDeliverySample>[] {
    const mergedA = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 1, state: "closed", closedAt: "2026-10-01T02:00:00.000Z" }),
        events: [
          event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
          event({ kind: "completed", agentName: "alpha", occurredAt: "2026-10-01T02:00:00.000Z" }),
          event({
            kind: "pr_merged",
            source: "reconciler",
            sourceEventId: "pr-1",
            occurredAt: "2026-10-01T02:00:00.000Z",
            metadata: { pullRequestNumber: 1 },
          }),
        ],
        runs: [
          run({
            id: "run-1",
            agentName: "alpha",
            startedAt: "2026-10-01T00:10:00.000Z",
            finishedAt: "2026-10-01T01:10:00.000Z",
            executionMetadata: { cohortLabel: "A", model: "gpt-5" },
          }),
        ],
      }),
      NOW,
    );

    const closedWithFixA = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 2, state: "closed", closedAt: "2026-10-01T04:00:00.000Z" }),
        events: [
          event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
          event({ kind: "completed", agentName: "alpha", occurredAt: "2026-10-01T04:00:00.000Z" }),
          event({ kind: "issue_closed", source: "webhook", occurredAt: "2026-10-01T04:00:00.000Z" }),
        ],
        runs: [
          run({
            id: "run-2",
            agentName: "alpha",
            startedAt: "2026-10-01T00:10:00.000Z",
            finishedAt: "2026-10-01T02:10:00.000Z",
            executionMetadata: { cohortLabel: "A", model: "gpt-5" },
          }),
          run({
            id: "run-fix-2",
            agentName: "bravo",
            startedAt: "2026-10-01T02:30:00.000Z",
            finishedAt: "2026-10-01T02:40:00.000Z",
            executionMetadata: { cohortLabel: "A", model: "gpt-5" },
            prFixQueueItemId: "fi-2",
            prFixGeneration: 1,
          }),
        ],
        prFixItems: [prFixItem({ id: "fi-2", generation: 1, status: "FIXED" })],
      }),
      NOW,
    );

    const openB = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 3, state: "open" }),
        events: [event({ kind: "claim", agentName: "bravo", occurredAt: iso(T0) })],
        runs: [
          run({
            id: "run-3",
            agentName: "bravo",
            startedAt: iso(T0),
            finishedAt: iso(T0 + 30 * MIN),
            executionMetadata: { cohortLabel: "B", model: "opus" },
          }),
        ],
      }),
      NOW,
    );

    const openNoMeta = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 4, state: "open" }),
        events: [event({ kind: "claim", agentName: "solo", occurredAt: iso(T0 + DAY) })],
      }),
      NOW,
    );

    return [mergedA, closedWithFixA, openB, openNoMeta];
  }

  it("aggregates completion rate, open ages, fix rounds, waiting split and confounders", () => {
    const report = aggregateDeliveryCohorts(extendedSamples(), {
      dimension: "cohort",
      windowSinceMs: T0,
      windowUntilMs: NOW,
    });

    const byKey = new Map(report.cohorts.map((c) => [c.key, c]));
    const a = byKey.get("A");
    const b = byKey.get("B");
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    // Cohort A: both completed.
    expect(a!.sampleCount).toBe(2);
    expect(a!.completionRate).toBe(1);
    expect(a!.openAges).toEqual({ count: 0, medianOpenMs: null, oldestOpenMs: null });
    expect(a!.fixRounds).toEqual({ total: 1, itemsWithFixes: 1 });
    // active = 1h (issue 1) + 2h10m (issue 2 execution run + fix run union)
    expect(a!.waiting.activeExecutionMs).toBe(HOUR + (2 * HOUR + 10 * MIN));
    // Observed waits: both items show a 10m claim→run-start pickup; issue 2's
    // fix round was queued 00:45 and handed off at its first fix run 02:30.
    expect(a!.waiting.pickupMs).toBe(20 * MIN);
    expect(a!.waiting.fixQueuedMs).toBe(105 * MIN);
    expect(a!.waiting.inReviewMs).toBeNull();
    expect(a!.waiting.blockedMs).toBeNull();
    // unclassified: issue1 2h − 70m union (pickup 10m + run 1h) = 50m; issue2's
    // classified intervals (pickup, runs, fix-queued wait) union into
    // 00:00→02:40 = 160m, so its remainder is 4h − 160m = 80m — the overlap
    // between the fix-queued wait and the runs subtracts once, not twice.
    expect(a!.waiting.unclassifiedMs).toBe(130 * MIN);
    // run-1 and run-2 overlap inside cohort A.
    expect(a!.confounders.maxConcurrentRuns).toBe(2);
    expect(a!.confounders.mixedSettings).toBe(0);
    expect(a!.confounders.missingMetadata).toBe(0);
    expect(a!.confounders.distinctModels).toEqual(["gpt-5"]);

    // Cohort B: single open item, kept in totals with its age, never a zero duration.
    expect(b!.sampleCount).toBe(1);
    expect(b!.completionRate).toBe(0);
    expect(b!.claimToDone).toBeNull();
    expect(b!.openAges.count).toBe(1);
    expect(b!.openAges.oldestOpenMs).toBe(NOW - T0);
    expect(b!.openAges.medianOpenMs).toBe(NOW - T0);
    expect(b!.waiting.activeExecutionMs).toBe(30 * MIN);
    expect(b!.waiting.unclassifiedMs).toBe(0);
    // The run starts exactly at the claim instant — no observed pickup wait.
    expect(b!.waiting.pickupMs).toBeNull();
    expect(b!.waiting.fixQueuedMs).toBeNull();
    expect(b!.confounders.maxConcurrentRuns).toBe(1);

    // Totals: open items stay in the completion denominator and ages.
    expect(report.totals.sampleCount).toBe(4);
    expect(report.totals.completionRate).toBeCloseTo(0.5);
    expect(report.totals.openAges.count).toBe(2);
    expect(report.totals.openAges.oldestOpenMs).toBe(NOW - T0);
    expect(report.totals.fixRounds).toEqual({ total: 1, itemsWithFixes: 1 });
    expect(report.totals.mergedThroughputPerDay).toBeCloseTo(1 / 24);
    expect(report.totals.confounders.missingMetadata).toBe(1);
    expect(report.totals.confounders.distinctModels).toEqual(["gpt-5", "opus"]);
    expect(report.totals.confounders.distinctWorkers).toEqual([]);
    // Totals pool every cohort: run-1 + run-2 + openB's run all overlap at
    // 00:10–00:30.
    expect(report.totals.confounders.maxConcurrentRuns).toBe(3);
    expect(report.totals.waiting.pickupMs).toBe(20 * MIN);
    expect(report.totals.waiting.fixQueuedMs).toBe(105 * MIN);
    // issue1 50m + issue2 80m (union remainder); open items have no claim→done
    // span and contribute nothing.
    expect(report.totals.waiting.unclassifiedMs).toBe(130 * MIN);

    // Per-sample execution attempt counts ride on the samples.
    const [mergedA, closedWithFixA, openB, openNoMeta] = extendedSamples();
    expect(mergedA.executionAttempts).toBe(1);
    expect(closedWithFixA.executionAttempts).toBe(1);
    expect(closedWithFixA.fixRounds).toBe(1);
    expect(openB.executionAttempts).toBe(1);
    // A claim alone still opens an execution attempt, even without run evidence.
    expect(openNoMeta.executionAttempts).toBe(1);
    expect(openNoMeta.workerTimeMs).toBeNull();
    expect(openNoMeta.missing).toContain("metadata");
  });
});

// ── 13. observed wait buckets (#1184 review) ────────────────────────────────

describe("observed wait buckets", () => {
  it("splits in-review and blocked label intervals from the event stream", () => {
    const s = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 10, state: "closed", closedAt: "2026-10-01T02:00:00.000Z" }),
        events: [
          event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
          event({
            kind: "status_changed",
            occurredAt: "2026-10-01T00:30:00.000Z",
            toStatus: "status/in-review",
          }),
          event({
            kind: "status_changed",
            occurredAt: "2026-10-01T01:30:00.000Z",
            fromStatus: "status/in-review",
            toStatus: "status/blocked",
          }),
          event({
            kind: "status_changed",
            occurredAt: "2026-10-01T02:00:00.000Z",
            fromStatus: "status/blocked",
            toStatus: "status/done",
          }),
          event({ kind: "completed", agentName: "alpha", occurredAt: "2026-10-01T02:00:00.000Z" }),
        ],
        runs: [
          run({
            id: "run-10",
            startedAt: "2026-10-01T00:05:00.000Z",
            finishedAt: "2026-10-01T00:20:00.000Z",
          }),
        ],
      }),
      NOW,
    );
    expect(s.observedWaits.pickupMs).toBe(5 * MIN);
    expect(s.observedWaits.inReviewMs).toBe(HOUR);
    expect(s.observedWaits.blockedMs).toBe(30 * MIN);
    expect(s.observedWaits.fixQueuedMs).toBeNull();
    // 2h − 15m run − 5m pickup − 60m review − 30m blocked = 10m.
    expect(s.unclassifiedMs).toBe(10 * MIN);
  });

  it("closes an open label interval on an observed terminal milestone", () => {
    const s = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 11, state: "closed", closedAt: "2026-10-01T02:00:00.000Z" }),
        events: [
          event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
          event({
            kind: "status_changed",
            occurredAt: "2026-10-01T01:00:00.000Z",
            toStatus: "status/in-review",
          }),
          event({
            kind: "pr_merged",
            source: "reconciler",
            sourceEventId: "pr-11",
            occurredAt: "2026-10-01T02:00:00.000Z",
            metadata: { pullRequestNumber: 11 },
          }),
        ],
      }),
      NOW,
    );
    expect(s.observedWaits.inReviewMs).toBe(HOUR);
    expect(s.observedWaits.pickupMs).toBeNull();
  });

  it("drops an unclosed label interval — its time stays unclassified", () => {
    const s = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 12, state: "open" }),
        events: [
          event({ kind: "claim", agentName: "alpha", occurredAt: iso(T0) }),
          event({
            kind: "status_changed",
            occurredAt: iso(T0 + HOUR),
            toStatus: "status/in-review",
          }),
        ],
      }),
      NOW,
    );
    // Still open, no terminal milestone: the interval end is unobserved.
    expect(s.observedWaits.inReviewMs).toBeNull();
    expect(s.unclassifiedMs).toBeNull();
  });

  it("attributes fix-round wait to fixQueuedMs, not pickup", () => {
    const s = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 13, state: "closed", closedAt: "2026-10-01T03:00:00.000Z" }),
        events: [
          event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
          event({ kind: "completed", agentName: "alpha", occurredAt: "2026-10-01T03:00:00.000Z" }),
        ],
        runs: [
          run({
            id: "run-13",
            startedAt: "2026-10-01T00:10:00.000Z",
            finishedAt: "2026-10-01T00:40:00.000Z",
          }),
          run({
            id: "run-fix-13",
            startedAt: "2026-10-01T02:00:00.000Z",
            finishedAt: "2026-10-01T02:05:00.000Z",
            prFixQueueItemId: "fi-13",
          }),
        ],
        prFixItems: [
          prFixItem({ id: "fi-13", queuedAt: "2026-10-01T01:00:00.000Z" }),
        ],
      }),
      NOW,
    );
    // Pickup stops at the first EXECUTION run; the fix queue wait is separate.
    expect(s.observedWaits.pickupMs).toBe(10 * MIN);
    expect(s.observedWaits.fixQueuedMs).toBe(HOUR);
  });

  it("subtracts the union of overlapping run and wait intervals once, not the per-bucket sum", () => {
    const s = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 19, state: "closed", closedAt: "2026-10-01T02:00:00.000Z" }),
        events: [
          event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
          event({
            kind: "status_changed",
            occurredAt: "2026-10-01T00:30:00.000Z",
            toStatus: "status/in-review",
          }),
          event({
            kind: "status_changed",
            occurredAt: "2026-10-01T01:30:00.000Z",
            fromStatus: "status/in-review",
            toStatus: "status/in-progress",
          }),
          event({ kind: "completed", agentName: "alpha", occurredAt: "2026-10-01T02:00:00.000Z" }),
        ],
        runs: [
          run({
            id: "run-19",
            startedAt: "2026-10-01T00:00:00.000Z",
            finishedAt: "2026-10-01T01:00:00.000Z",
          }),
        ],
      }),
      NOW,
    );
    // Named bucket totals stay per-category for presentation.
    expect(s.workerTimeMs).toBe(HOUR);
    expect(s.observedWaits.inReviewMs).toBe(HOUR);
    expect(s.observedWaits.pickupMs).toBeNull();
    // The run [00:00, 01:00) and the in-review interval [00:30, 01:30)
    // overlap for 30m. The per-category sum would subtract 2h and zero the
    // remainder; the union [00:00, 01:30) is 90m, so 30m stays unclassified.
    expect(s.unclassifiedMs).toBe(30 * MIN);
  });

  it("clips classified intervals to the claim→done window", () => {
    const s = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 20, state: "closed", closedAt: "2026-10-01T02:00:00.000Z" }),
        events: [
          event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T01:00:00.000Z" }),
          event({ kind: "completed", agentName: "alpha", occurredAt: "2026-10-01T02:00:00.000Z" }),
        ],
        runs: [
          run({
            id: "run-20",
            startedAt: "2026-10-01T00:00:00.000Z",
            finishedAt: "2026-10-01T01:30:00.000Z",
          }),
        ],
      }),
      NOW,
    );
    // The 90m run starts before the claim; only its in-window 30m may
    // subtract from the 1h claim→done span. A pre-window subtraction would
    // zero the remainder on the full interval.
    expect(s.workerTimeMs).toBe(90 * MIN);
    expect(s.unclassifiedMs).toBe(30 * MIN);
  });

  it("leaves every bucket null when no evidence exists", () => {
    const s = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 14, state: "closed", closedAt: "2026-10-01T05:00:00.000Z" }),
        events: [
          event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
          event({ kind: "completed", agentName: "alpha", occurredAt: "2026-10-01T05:00:00.000Z" }),
        ],
      }),
      NOW,
    );
    expect(s.observedWaits).toEqual({
      pickupMs: null,
      inReviewMs: null,
      blockedMs: null,
      fixQueuedMs: null,
    });
    // The whole 5h span is known and wholly unclassified — never zeroed.
    expect(s.unclassifiedMs).toBe(5 * HOUR);
  });

  it("derives identical wait buckets regardless of same-millisecond event order", () => {
    const entry = event({
      kind: "status_changed",
      occurredAt: "2026-10-01T01:00:00.000Z",
      toStatus: "status/in-review",
    });
    const blockedEntry = event({
      kind: "status_changed",
      occurredAt: "2026-10-01T01:00:00.000Z",
      fromStatus: "status/in-review",
      toStatus: "status/blocked",
    });
    const base = [
      event({ kind: "claim", agentName: "alpha", occurredAt: "2026-10-01T00:00:00.000Z" }),
      event({ kind: "completed", agentName: "alpha", occurredAt: "2026-10-01T02:00:00.000Z" }),
    ];
    const issueClosed = () =>
      issue({ issueNumber: 18, state: "closed", closedAt: "2026-10-01T02:00:00.000Z" });
    const a = deriveDeliverySample(
      sample({ issue: issueClosed(), events: [...base, entry, blockedEntry] }),
      NOW,
    );
    const b = deriveDeliverySample(
      sample({ issue: issueClosed(), events: [...base, blockedEntry, entry] }),
      NOW,
    );
    expect(b.observedWaits).toEqual(a.observedWaits);
    expect(b.unclassifiedMs).toBe(a.unclassifiedMs);
  });

  it("passes dbIssueId through for per-item drill-down links", () => {
    const s = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 15 }),
        dbIssueId: "clx-123",
      }),
      NOW,
    );
    expect(s.dbIssueId).toBe("clx-123");
  });

  it("does not count touching run intervals as concurrent", () => {
    const first = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 16 }),
        events: [event({ kind: "claim", occurredAt: iso(T0) })],
        runs: [run({ id: "ra", startedAt: iso(T0), finishedAt: iso(T0 + HOUR) })],
      }),
      NOW,
    );
    const second = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 17 }),
        events: [event({ kind: "claim", occurredAt: iso(T0 + HOUR) })],
        runs: [
          run({ id: "rb", startedAt: iso(T0 + HOUR), finishedAt: iso(T0 + 2 * HOUR) }),
        ],
      }),
      NOW,
    );
    const report = aggregateDeliveryCohorts([first, second], {
      dimension: "repository",
      windowSinceMs: null,
      windowUntilMs: null,
    });
    expect(report.totals.confounders.maxConcurrentRuns).toBe(1);
  });

  it("counts a dual-linked run (issue + pr-fix item) once in the load confounder", () => {
    // A verified followup-pr report can persist both issueId and
    // prFixQueueItemId on one AgentRun, so the route's per-item run set
    // concatenates the same run row twice (once per link path). The
    // projection must canonicalize by run id: the dual-linked run contributes
    // exactly one interval, never two simultaneous ones.
    const dualLinked = run({
      id: "run-dual",
      startedAt: iso(T0 + 30 * MIN),
      finishedAt: iso(T0 + 90 * MIN),
      prFixQueueItemId: "fi-dual",
    });
    const first = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 19 }),
        events: [event({ kind: "claim", occurredAt: iso(T0) })],
        runs: [
          run({ id: "run-a", startedAt: iso(T0), finishedAt: iso(T0 + HOUR) }),
          dualLinked,
          dualLinked,
        ],
      }),
      NOW,
    );
    expect(first.runIntervalsMs).toHaveLength(2);
    const second = deriveDeliverySample(
      sample({
        issue: issue({ issueNumber: 20 }),
        events: [event({ kind: "claim", occurredAt: iso(T0 + HOUR) })],
        runs: [
          run({
            id: "run-b",
            startedAt: iso(T0 + HOUR),
            finishedAt: iso(T0 + 2 * HOUR),
          }),
        ],
      }),
      NOW,
    );
    const report = aggregateDeliveryCohorts([first, second], {
      dimension: "repository",
      windowSinceMs: null,
      windowUntilMs: null,
    });
    // run-a ∩ run-dual overlap once (30m→60m); the duplicated dual-linked
    // row must not inflate the sweep-line to 3.
    expect(report.totals.confounders.maxConcurrentRuns).toBe(2);
  });
});
