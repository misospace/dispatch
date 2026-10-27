/**
 * A pure analytics projection of per-work-item delivery evidence into cohort
 * comparison statistics.
 *
 * Two functions, two levels of the pipeline:
 *
 * - `deriveDeliverySample` projects ONE work item's timeline and attempt
 *   chain into a flat `DeliverySample` with per-dimension cohort keys,
 *   duration fields, and completeness flags.
 * - `aggregateDeliveryCohorts` buckets an array of samples by a chosen
 *   `CohortGroupDimension` and computes per-cohort statistics (nearest-rank
 *   percentiles, throughput, first-pass counts).
 *
 * The module is pure: no Prisma, no I/O, no clock reads. `nowMs` is the only
 * time input (used for open-item ages).
 */

import {
  buildIssueLifecycleTimeline,
  type LifecycleDelivery,
  type LifecycleEventRecord,
  type LifecycleProvenance,
  type TimelineIssueInput,
} from "./issue-lifecycle-read";
import {
  buildWorkItemDeliveryChain,
  type WorkAttemptPrFixItemRecord,
  type WorkAttemptRunRecord,
  type WorkItemAttemptExecutionMetadata,
  type WorkItemExecutionMetadataField,
} from "./work-attempt-chain";

// ── Types ────────────────────────────────────────────────────────────────────

export type CohortGroupDimension =
  | "worker"
  | "model"
  | "reasoningEffort"
  | "runtimeRevision"
  | "cohort"
  | "repository"
  | "taskType";

export interface DeliverySampleInput {
  issue: TimelineIssueInput;
  events: readonly LifecycleEventRecord[];
  runs: readonly WorkAttemptRunRecord[];
  prFixItems: readonly WorkAttemptPrFixItemRecord[];
  labels?: readonly string[];
  /** Cached `Issue.id` for drill-down links to the per-item lifecycle route. */
  dbIssueId?: string | null;
}

/**
 * Waiting time that an existing observation actually evidences (#1184:
 * "show queue, active work and review/CI/human waiting separately where
 * observed"). Each bucket is the union of intervals with BOTH boundaries
 * observed; a bucket with no evidence stays null and its time remains in
 * `unclassifiedMs` — no breakdown is ever manufactured.
 */
export interface ObservedWaitMs {
  /** First claim → first observed execution-run start (queue/pickup wait). */
  pickupMs: number | null;
  /** Union of observed `status/in-review` label intervals (#1203 stream). */
  inReviewMs: number | null;
  /** Union of observed `status/blocked` label intervals (human wait). */
  blockedMs: number | null;
  /** Union of PR-fix queue → first fix-run hand-off waits per queue item. */
  fixQueuedMs: number | null;
}

export interface RunIntervalMs {
  startMs: number;
  endMs: number;
}

export interface DurationStats {
  samples: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
}

export interface OpenAgeStats {
  count: number;
  medianOpenMs: number | null;
  oldestOpenMs: number | null;
}

export interface CohortConfounders {
  mixedSettings: number;
  missingMetadata: number;
  distinctRuntimeRevisions: string[];
  distinctModels: string[];
  distinctWorkers: string[];
  /**
   * Load confounder (#1184): the maximum number of execution runs observed
   * overlapping inside this cohort. A load signal only — never a causal
   * claim. Null when the cohort has no positive-length run interval.
   */
  maxConcurrentRuns: number | null;
}

export interface DeliverySample {
  issueId: string;
  dbIssueId: string | null;
  repoFullName: string;
  issueNumber: number;
  delivery: LifecycleDelivery;
  firstClaimAt: string | null;
  firstMergedAt: string | null;
  doneAt: string | null;
  doneAtProvenance: LifecycleProvenance | null;
  claimToDoneMs: number | null;
  claimToMergeMs: number | null;
  workerTimeMs: number | null;
  observedWaits: ObservedWaitMs;
  /**
   * claim→done minus the UNION of all classified intervals (the item's
   * observed run intervals and the observed wait buckets, clipped to the
   * claim→done window), clamped at zero — overlapping observations subtract once, never
   * twice. Null only when claim→done itself is unknown — known span time that
   * no bucket evidences stays visible here, never dropped.
   */
  unclassifiedMs: number | null;
  firstPass: boolean | null;
  executionAttempts: number;
  fixRounds: number;
  failedAttempts: number;
  cohortKeys: Record<CohortGroupDimension, string>;
  mixedSettings: boolean;
  settings: {
    worker: string | null;
    model: string | null;
    reasoningEffort: string | null;
    runtimeRevision: string | null;
  };
  missing: Array<"claim" | "done" | "merge" | "attempts" | "metadata">;
  excludedFromDurations: boolean;
  ageMs: number | null;
  taskType: string;
  /** Positive-length execution-run intervals for the cohort load confounder. */
  runIntervalsMs: RunIntervalMs[];
}

export interface CohortStats {
  key: string;
  sampleCount: number;
  delivery: Record<LifecycleDelivery, number>;
  completionRate: number | null;
  claimToDone: DurationStats | null;
  claimToMerge: DurationStats | null;
  workerTimeMs: number | null;
  firstPass: { true: number; false: number; null: number };
  mergedThroughputPerDay: number;
  openAges: OpenAgeStats;
  fixRounds: { total: number; itemsWithFixes: number };
  // activeExecutionMs stays null (unknown) when no sample carries run
  // evidence — an unobserved worker time never renders as zero. The wait
  // buckets follow the same rule: null when no sample in the cohort carries
  // evidence for that wait, the summed observation otherwise.
  waiting: {
    activeExecutionMs: number | null;
    pickupMs: number | null;
    inReviewMs: number | null;
    blockedMs: number | null;
    fixQueuedMs: number | null;
    unclassifiedMs: number;
  };
  confounders: CohortConfounders;
}

export interface CohortReportOptions {
  dimension: CohortGroupDimension;
  windowSinceMs: number | null;
  windowUntilMs: number | null;
}

export interface CohortReport {
  cohorts: CohortStats[];
  totals: CohortStats;
}

// ── Constants ────────────────────────────────────────────────────────────────

const SETTING_DIMENSIONS: readonly CohortGroupDimension[] = [
  "worker",
  "model",
  "reasoningEffort",
  "runtimeRevision",
];

const METADATA_FIELD: Record<string, WorkItemExecutionMetadataField> = {
  worker: "workerProduct",
  model: "model",
  reasoningEffort: "reasoningEffort",
  runtimeRevision: "runtimeRevision",
  cohort: "cohortLabel",
};

const FAILED_OUTCOMES = new Set(["failed", "abandoned", "superseded"]);

export const COHORT_DEFINITIONS: Readonly<Record<string, string>> = Object.freeze({
  units: "milliseconds",
  percentile:
    "nearest-rank: the value at index ceil(p/100*n)-1 of the ascending known values; null when no known values",
  window: "windowSinceMs..windowUntilMs",
  claimToDone: "completed (merged|closed-unmerged) samples with non-null claimToDoneMs; open/unknown-delivery items are excluded from these percentiles, never treated as zero",
  claimToMerge: "merged samples with non-null claimToMergeMs",
  completionRate: "(merged + closed-unmerged) / sampleCount; open and unknown-delivery items stay in the denominator",
  firstPass: "boolean|null per sample: true when delivered without fix rounds or failed attempts; null when no execution-attempt evidence or still open",
  throughput: "mergedThroughputPerDay = merged count / window days (0 when window <= 0)",
  denominators: "sampleCount is the total; delivery counts are per-type; claimToDone/claimToMerge are filtered subsets",
  workerTime: "sum of workerTimeMs across the cohort's samples; workerTimeMs is the union of execution intervals (overlapping runs are not double-counted) and stays null when no run interval evidence exists",
  observedWaits: "waiting buckets shown separately ONLY where observed: pickupMs = first claim → first observed execution-run start (queue/pickup); inReviewMs = union of status/in-review label intervals from the lifecycle event stream; blockedMs = union of status/blocked label intervals (human wait); fixQueuedMs = PR-fix queue time until the first fix-run start per queue item. An interval counts only when both boundaries are observed; a bucket with no evidence is null, never zero",
  unclassified: "claimToDoneMs minus the union of all classified intervals (the item's observed run intervals plus the observed wait buckets, clipped to the claim→done window), clamped at zero; overlapping classifications subtract once, and the per-bucket totals stay per-category for presentation only; waiting time without label/run/queue evidence (for example CI waiting with no status label or queue row) stays unclassified instead of being attributed to a named bucket",
  load: "maxConcurrentRuns = maximum number of overlapping positive-length execution-run intervals observed inside the cohort; a load confounder surfaced alongside cohort stats, never a causal claim",
  settings: "cohort keys and mixed labels are derived across ALL attempts and each attempt's distinct per-field value sets (a setting that changed inside one attempt counts); a lifecycle spanning settings is mixed, never attributed to the setting active at merge",
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function toMillis(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Nearest-rank percentile: the value at rank ceil(p/100 * n) in the ascending
 * sorted sample. Null when the sample is empty. */
function nearestRankPercentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.max(0, Math.min(sorted.length - 1, rank - 1));
  return sorted[index];
}

function intervalStats(values: readonly number[]): DurationStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((acc, v) => acc + v, 0);
  return {
    samples: values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / values.length,
    p50: nearestRankPercentile(sorted, 50) as number,
    p90: nearestRankPercentile(sorted, 90) as number,
  };
}

function emptyDeliveryCounts(): Record<LifecycleDelivery, number> {
  return { merged: 0, "closed-unmerged": 0, open: 0, unknown: 0 };
}

function deriveTaskType(labels: readonly string[]): string {
  for (const label of labels) {
    if (label.startsWith("type/")) {
      const suffix = label.slice("type/".length);
      if (suffix.length > 0) return suffix;
    }
  }
  return "unknown";
}

/** Union length of closed intervals (overlapping counted once). Null when no
 * interval exists — an unobserved span is unknown, never zero. */
function unionLengthMs(intervals: readonly RunIntervalMs[]): number | null {
  if (intervals.length === 0) return null;
  const sorted = [...intervals].sort(
    (a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
  );
  let total = 0;
  let currentStart = sorted[0].startMs;
  let currentEnd = sorted[0].endMs;
  for (const interval of sorted.slice(1)) {
    if (interval.startMs > currentEnd) {
      total += currentEnd - currentStart;
      currentStart = interval.startMs;
      currentEnd = interval.endMs;
    } else if (interval.endMs > currentEnd) {
      currentEnd = interval.endMs;
    }
  }
  return total + (currentEnd - currentStart);
}

/** Maximum number of intervals overlapping at any instant (a sweep-line).
 * Touching endpoints do not overlap. Null when no interval exists. */
function maxOverlap(intervals: readonly RunIntervalMs[]): number | null {
  if (intervals.length === 0) return null;
  const points: Array<{ at: number; delta: 1 | -1 }> = [];
  for (const interval of intervals) {
    points.push({ at: interval.startMs, delta: 1 });
    points.push({ at: interval.endMs, delta: -1 });
  }
  // Ends before starts at the same instant: touching intervals never count
  // as concurrent.
  points.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let current = 0;
  let max = 0;
  for (const point of points) {
    current += point.delta;
    if (current > max) max = current;
  }
  return max;
}

/**
 * Union of observed intervals during which an issue carried a given status
 * label, derived from the `status_changed` rows of the lifecycle stream
 * (#1203). An interval opens on a move INTO the label and closes on the
 * first later move OUT of it, or on an observed terminal milestone (done /
 * close / merge) — whichever comes first. An interval whose end is never
 * observed is dropped entirely: its time stays unclassified rather than
 * being extended to "now" on an assumption.
 */
function statusLabelIntervals(
  events: readonly LifecycleEventRecord[],
  label: string,
  terminalMs: readonly number[],
): RunIntervalMs[] {
  const changes: Array<{ occurredAtMs: number; fromStatus: string | null; toStatus: string | null }> = [];
  for (const event of events) {
    if (event.kind !== "status_changed") continue;
    const occurredAtMs = toMillis(event.occurredAt);
    if (occurredAtMs === null) continue;
    changes.push({ occurredAtMs, fromStatus: event.fromStatus, toStatus: event.toStatus });
  }
  // Same-millisecond ties get a content tie-break so the open/close outcome
  // never depends on the order rows arrived in (reproducible-read rule).
  const changeKey = (c: { fromStatus: string | null; toStatus: string | null }) =>
    `${c.fromStatus ?? ""}\u0000${c.toStatus ?? ""}`;
  changes.sort(
    (a, b) =>
      a.occurredAtMs - b.occurredAtMs ||
      (changeKey(a) < changeKey(b) ? -1 : changeKey(a) > changeKey(b) ? 1 : 0),
  );

  const intervals: RunIntervalMs[] = [];
  let openStart: number | null = null;
  for (const change of changes) {
    if (openStart === null) {
      if (change.toStatus === label) openStart = change.occurredAtMs;
      continue;
    }
    if (change.fromStatus === label || change.toStatus !== label) {
      // Any later status move leaves the label's interval.
      if (change.occurredAtMs > openStart) {
        intervals.push({ startMs: openStart, endMs: change.occurredAtMs });
      }
      openStart = change.toStatus === label ? change.occurredAtMs : null;
    }
  }
  if (openStart !== null) {
    // The label is still carried at the read time. Only an OBSERVED terminal
    // milestone closes the interval; otherwise it is dropped (unclassified).
    let closeMs: number | null = null;
    for (const terminal of terminalMs) {
      if (terminal >= openStart && (closeMs === null || terminal < closeMs)) {
        closeMs = terminal;
      }
    }
    if (closeMs !== null && closeMs > openStart) {
      intervals.push({ startMs: openStart, endMs: closeMs });
    }
  }
  return intervals;
}

/**
 * Derive the per-dimension cohort keys and settings for one work item's
 * attempt chain.
 *
 * The four settings dimensions (worker, model, reasoningEffort,
 * runtimeRevision) and cohortLabel are read across ALL attempts (execution
 * and fix rounds), unioning each attempt's DISTINCT per-field value sets
 * (#1423), so a setting that changed INSIDE one attempt (a claim re-run
 * under a different model) counts exactly like a change observed across two
 * attempts. A dimension with >1 distinct non-null values is "mixed"; zero
 * distinct values is "unknown". The `settings` object carries the single
 * value for each of the four settings fields, or null when the dimension is
 * mixed or unknown.
 *
 * Repository and taskType are single-valued per issue and never mix.
 */
function deriveCohortKeys(
  attempts: readonly { executionMetadata: WorkItemAttemptExecutionMetadata }[],
  repoFullName: string,
  taskType: string,
): {
  cohortKeys: Record<CohortGroupDimension, string>;
  mixedSettings: boolean;
  settings: DeliverySample["settings"];
} {
  const cohortKeys: Record<CohortGroupDimension, string> = {
    repository: repoFullName,
    taskType,
    worker: "unknown",
    model: "unknown",
    reasoningEffort: "unknown",
    runtimeRevision: "unknown",
    cohort: "unknown",
  };

  const metadataDimensions: CohortGroupDimension[] = [
    "worker",
    "model",
    "reasoningEffort",
    "runtimeRevision",
    "cohort",
  ];

  for (const dim of metadataDimensions) {
    const field = METADATA_FIELD[dim];
    const values = new Set<string>();
    for (const attempt of attempts) {
      // Union the attempt's distinct set, not its first-non-null scalar:
      // the scalar alone would hide an intra-attempt setting change (#1423).
      for (const value of attempt.executionMetadata.distinctValues[field]) {
        if (value.length > 0) {
          values.add(value);
        }
      }
    }
    if (values.size === 1) {
      cohortKeys[dim] = [...values][0];
    } else if (values.size > 1) {
      cohortKeys[dim] = "mixed";
    }
  }

  let mixedSettings = false;
  const settings: DeliverySample["settings"] = {
    worker: null,
    model: null,
    reasoningEffort: null,
    runtimeRevision: null,
  };

  for (const dim of SETTING_DIMENSIONS) {
    const settingKey = dim as "worker" | "model" | "reasoningEffort" | "runtimeRevision";
    if (cohortKeys[dim] === "mixed") {
      mixedSettings = true;
    } else if (cohortKeys[dim] !== "unknown") {
      settings[settingKey] = cohortKeys[dim];
    }
  }

  return { cohortKeys, mixedSettings, settings };
}

// ── deriveDeliverySample ─────────────────────────────────────────────────────

export function deriveDeliverySample(
  input: DeliverySampleInput,
  nowMs: number,
): DeliverySample {
  const { issue, events, runs: rawRuns, prFixItems } = input;
  const labels = input.labels ?? [];

  // A verified `followup-pr` report can persist both `issueId` and
  // `prFixQueueItemId` on one AgentRun, so a per-item run set assembled from
  // both link paths can carry the same row twice. Canonicalize by run id once
  // so every raw-run consumer below (pickup, fix hand-off, run intervals,
  // chain) sees each run exactly once — a dual-linked run must never count as
  // two simultaneous intervals in the load confounder. Insertion order is
  // preserved and the first occurrence wins, so the result is deterministic.
  const runsById = new Map<string, WorkAttemptRunRecord>();
  for (const run of rawRuns) {
    if (!runsById.has(run.id)) runsById.set(run.id, run);
  }
  const runs = Array.from(runsById.values());

  const timeline = buildIssueLifecycleTimeline(issue, events);
  const chain = buildWorkItemDeliveryChain(
    { repoFullName: issue.repoFullName, issueNumber: issue.issueNumber },
    { events, runs, prFixItems },
  );

  const executionAttempts = chain.attempts.filter((a) => a.kind === "execution");
  const fixRoundAttempts = chain.attempts.filter((a) => a.kind === "fix-round");

  // doneAt: timeline doneAt if non-null, else closedAt fallback.
  let doneAt: string | null = null;
  let doneAtProvenance: LifecycleProvenance | null = null;
  if (timeline.doneAt.at !== null) {
    doneAt = timeline.doneAt.at;
    doneAtProvenance = timeline.doneAt.provenance;
  } else if (timeline.closedAt.at !== null) {
    doneAt = timeline.closedAt.at;
    doneAtProvenance = timeline.closedAt.provenance;
  }

  const firstClaimMs = timeline.firstClaim.at !== null ? Date.parse(timeline.firstClaim.at) : null;
  const doneAtMs = doneAt !== null ? Date.parse(doneAt) : null;
  const claimToDoneMs =
    firstClaimMs !== null && doneAtMs !== null ? doneAtMs - firstClaimMs : null;

  // workerTimeMs: the chain's total execution wall time, but only when at
  // least one execution attempt has a run interval.
  const hasRunInterval = executionAttempts.some((a) => a.wallTimeMs !== null);
  const workerTimeMs = hasRunInterval ? chain.totalExecutionWallTimeMs : null;

  // Observed wait buckets (#1184): only intervals whose BOTH boundaries come
  // from existing evidence count; everything else stays unclassified.
  const terminalMs: number[] = [];
  if (doneAtMs !== null) terminalMs.push(doneAtMs);
  if (timeline.firstMergedAt.at !== null) terminalMs.push(Date.parse(timeline.firstMergedAt.at));
  if (timeline.closedAt.at !== null) terminalMs.push(Date.parse(timeline.closedAt.at));

  const inReviewIntervals = statusLabelIntervals(events, "status/in-review", terminalMs);
  const blockedIntervals = statusLabelIntervals(events, "status/blocked", terminalMs);

  let pickupMs: number | null = null;
  let pickupInterval: RunIntervalMs | null = null;
  if (firstClaimMs !== null) {
    let firstExecutionStart: number | null = null;
    for (const run of runs) {
      // Pickup covers claim → first EXECUTION run; fix-round runs are
      // attributed to fixQueuedMs instead.
      if (run.prFixQueueItemId) continue;
      const startedMs = toMillis(run.startedAt);
      if (startedMs === null || startedMs < firstClaimMs) continue;
      if (firstExecutionStart === null || startedMs < firstExecutionStart) {
        firstExecutionStart = startedMs;
      }
    }
    if (firstExecutionStart !== null && firstExecutionStart > firstClaimMs) {
      pickupMs = firstExecutionStart - firstClaimMs;
      pickupInterval = { startMs: firstClaimMs, endMs: firstExecutionStart };
    }
  }

  const fixQueuedIntervals: RunIntervalMs[] = [];
  for (const item of prFixItems) {
    const queuedMs = toMillis(item.queuedAt);
    if (queuedMs === null) continue;
    let handoffMs: number | null = null;
    for (const run of runs) {
      if (run.prFixQueueItemId !== item.id) continue;
      const startedMs = toMillis(run.startedAt);
      if (startedMs === null || startedMs < queuedMs) continue;
      if (handoffMs === null || startedMs < handoffMs) handoffMs = startedMs;
    }
    if (handoffMs !== null && handoffMs > queuedMs) {
      fixQueuedIntervals.push({ startMs: queuedMs, endMs: handoffMs });
    }
  }

  const observedWaits: ObservedWaitMs = {
    pickupMs,
    inReviewMs: unionLengthMs(inReviewIntervals),
    blockedMs: unionLengthMs(blockedIntervals),
    fixQueuedMs: unionLengthMs(fixQueuedIntervals),
  };

  const runIntervalsMs: RunIntervalMs[] = [];
  for (const run of runs) {
    const startMs = toMillis(run.startedAt);
    const endMs = toMillis(run.finishedAt);
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    runIntervalsMs.push({ startMs, endMs });
  }

  // The remainder must subtract the UNION of all classified intervals, never
  // the per-category sum: a run can overlap a status/in-review or blocked
  // interval, and a per-category sum would subtract the same wall-clock span
  // twice and silently shrink the claim→done accounting. The named bucket
  // totals above stay per-category for presentation only. Every classified
  // interval is clipped to the claim→done window before the union, so time
  // observed outside the window never subtracts from it.
  const classifiedIntervals: RunIntervalMs[] =
    claimToDoneMs !== null && firstClaimMs !== null && doneAtMs !== null
      ? [
          ...runIntervalsMs,
          ...(pickupInterval !== null ? [pickupInterval] : []),
          ...inReviewIntervals,
          ...blockedIntervals,
          ...fixQueuedIntervals,
        ]
          .map((interval) => {
            const startMs = Math.max(interval.startMs, firstClaimMs);
            const endMs = Math.min(interval.endMs, doneAtMs);
            return endMs > startMs ? { startMs, endMs } : null;
          })
          .filter((interval): interval is RunIntervalMs => interval !== null)
      : [];

  // The known claim→done span that no evidence attributes to a named phase
  // stays visible as unclassified — minus the union of every classified
  // (worker + observed-wait) interval inside the window. Only an unknown
  // claim→done span makes it null.
  const unclassifiedMs =
    claimToDoneMs !== null
      ? Math.max(0, claimToDoneMs - (unionLengthMs(classifiedIntervals) ?? 0))
      : null;

  const fixRounds = fixRoundAttempts.length;

  const failedAttempts = chain.attempts.filter(
    (a) => FAILED_OUTCOMES.has(a.outcome),
  ).length;

  let firstPass: boolean | null = null;
  if (
    executionAttempts.length > 0 &&
    timeline.delivery !== "open" &&
    timeline.delivery !== "unknown"
  ) {
    firstPass =
      (timeline.delivery === "merged" || timeline.delivery === "closed-unmerged") &&
      fixRounds === 0 &&
      failedAttempts === 0;
  }

  const taskType = deriveTaskType(labels);

  const { cohortKeys, mixedSettings, settings } = deriveCohortKeys(
    chain.attempts,
    issue.repoFullName,
    taskType,
  );

  // missing: completeness flags in canonical order.
  const missing: Array<"claim" | "done" | "merge" | "attempts" | "metadata"> = [];
  if (timeline.firstClaim.at === null) missing.push("claim");
  if (doneAt === null) missing.push("done");
  if (timeline.firstMergedAt.at === null) missing.push("merge");
  if (executionAttempts.length === 0) missing.push("attempts");
  const hasAnyMetadata = chain.attempts.some(
    (a) =>
      a.executionMetadata.workerProduct !== null ||
      a.executionMetadata.model !== null ||
      a.executionMetadata.reasoningEffort !== null ||
      a.executionMetadata.runtimeRevision !== null ||
      a.executionMetadata.cohortLabel !== null,
  );
  if (!hasAnyMetadata) missing.push("metadata");

  const excludedFromDurations =
    timeline.delivery === "open" || timeline.delivery === "unknown";

  let ageMs: number | null = null;
  if (excludedFromDurations && timeline.firstClaim.at !== null) {
    ageMs = nowMs - Date.parse(timeline.firstClaim.at);
  }

  return {
    issueId: `${issue.repoFullName}#${issue.issueNumber}`,
    dbIssueId: input.dbIssueId ?? null,
    repoFullName: issue.repoFullName,
    issueNumber: issue.issueNumber,
    delivery: timeline.delivery,
    firstClaimAt: timeline.firstClaim.at,
    firstMergedAt: timeline.firstMergedAt.at,
    doneAt,
    doneAtProvenance,
    claimToDoneMs,
    claimToMergeMs: timeline.claimToMergeMs,
    workerTimeMs,
    observedWaits,
    unclassifiedMs,
    firstPass,
    executionAttempts: executionAttempts.length,
    fixRounds,
    failedAttempts,
    cohortKeys,
    mixedSettings,
    settings,
    missing,
    excludedFromDurations,
    ageMs,
    taskType,
    runIntervalsMs,
  };
}

// ── aggregateDeliveryCohorts ─────────────────────────────────────────────────

function computeStats(
  key: string,
  members: readonly DeliverySample[],
  windowSinceMs: number | null,
  windowUntilMs: number | null,
): CohortStats {
  const delivery = emptyDeliveryCounts();
  for (const s of members) delivery[s.delivery] += 1;

  const claimToDoneValues = members
    .filter(
      (s) =>
        (s.delivery === "merged" || s.delivery === "closed-unmerged") &&
        s.claimToDoneMs !== null,
    )
    .map((s) => s.claimToDoneMs as number);

  const claimToMergeValues = members
    .filter((s) => s.delivery === "merged" && s.claimToMergeMs !== null)
    .map((s) => s.claimToMergeMs as number);

  const workerTimes = members
    .map((s) => s.workerTimeMs)
    .filter((v): v is number => v !== null);
  const totalWorkerTimeMs =
    workerTimes.length > 0 ? workerTimes.reduce((a, v) => a + v, 0) : null;

  const fp = { true: 0, false: 0, null: 0 };
  for (const s of members) {
    if (s.firstPass === true) fp.true += 1;
    else if (s.firstPass === false) fp.false += 1;
    else fp.null += 1;
  }

  let mergedThroughputPerDay = 0;
  if (windowSinceMs !== null && windowUntilMs !== null && windowUntilMs > windowSinceMs) {
    const windowDays = (windowUntilMs - windowSinceMs) / 86400000;
    mergedThroughputPerDay = delivery.merged / windowDays;
  }

  const completedCount = delivery.merged + delivery["closed-unmerged"];
  const completionRate = members.length > 0 ? completedCount / members.length : null;

  const openAgeValues = members
    .map((s) => s.ageMs)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const openAges: OpenAgeStats = {
    count: openAgeValues.length,
    medianOpenMs:
      openAgeValues.length > 0 ? nearestRankPercentile(openAgeValues, 50) : null,
    oldestOpenMs:
      openAgeValues.length > 0 ? openAgeValues[openAgeValues.length - 1] : null,
  };

  let fixRoundsTotal = 0;
  let itemsWithFixes = 0;
  let unclassifiedMs = 0;
  let mixedSettings = 0;
  let missingMetadata = 0;
  let pickupSum: number | null = null;
  let inReviewSum: number | null = null;
  let blockedSum: number | null = null;
  let fixQueuedSum: number | null = null;
  const cohortRunIntervals: RunIntervalMs[] = [];
  const distinctRuntimeRevisions = new Set<string>();
  const distinctModels = new Set<string>();
  const distinctWorkers = new Set<string>();
  const addBucket = (current: number | null, value: number | null): number | null =>
    value === null ? current : (current ?? 0) + value;
  for (const s of members) {
    fixRoundsTotal += s.fixRounds;
    if (s.fixRounds > 0) itemsWithFixes += 1;
    if (s.unclassifiedMs !== null) unclassifiedMs += s.unclassifiedMs;
    if (s.mixedSettings) mixedSettings += 1;
    if (s.missing.includes("metadata")) missingMetadata += 1;
    pickupSum = addBucket(pickupSum, s.observedWaits.pickupMs);
    inReviewSum = addBucket(inReviewSum, s.observedWaits.inReviewMs);
    blockedSum = addBucket(blockedSum, s.observedWaits.blockedMs);
    fixQueuedSum = addBucket(fixQueuedSum, s.observedWaits.fixQueuedMs);
    cohortRunIntervals.push(...s.runIntervalsMs);
    if (s.settings.runtimeRevision !== null)
      distinctRuntimeRevisions.add(s.settings.runtimeRevision);
    if (s.settings.model !== null) distinctModels.add(s.settings.model);
    if (s.settings.worker !== null) distinctWorkers.add(s.settings.worker);
  }

  return {
    key,
    sampleCount: members.length,
    delivery,
    completionRate,
    claimToDone: intervalStats(claimToDoneValues),
    claimToMerge: intervalStats(claimToMergeValues),
    workerTimeMs: totalWorkerTimeMs,
    firstPass: fp,
    mergedThroughputPerDay,
    openAges,
    fixRounds: { total: fixRoundsTotal, itemsWithFixes },
    waiting: {
      activeExecutionMs: totalWorkerTimeMs,
      pickupMs: pickupSum,
      inReviewMs: inReviewSum,
      blockedMs: blockedSum,
      fixQueuedMs: fixQueuedSum,
      unclassifiedMs,
    },
    confounders: {
      mixedSettings,
      missingMetadata,
      distinctRuntimeRevisions: [...distinctRuntimeRevisions].sort(),
      distinctModels: [...distinctModels].sort(),
      distinctWorkers: [...distinctWorkers].sort(),
      maxConcurrentRuns: maxOverlap(cohortRunIntervals),
    },
  };
}

export function aggregateDeliveryCohorts(
  samples: readonly DeliverySample[],
  options: CohortReportOptions,
): CohortReport {
  const { dimension, windowSinceMs, windowUntilMs } = options;

  const groups = new Map<string, DeliverySample[]>();
  for (const sample of samples) {
    const key = sample.cohortKeys[dimension];
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }

  const cohorts = [...groups.entries()]
    .sort((a, b) => {
      const countA = a[1].length;
      const countB = b[1].length;
      if (countA !== countB) return countB - countA;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .map(([key, members]) => computeStats(key, members, windowSinceMs, windowUntilMs));

  const totals = computeStats("all", samples, windowSinceMs, windowUntilMs);

  return { cohorts, totals };
}
