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
}

export interface DeliverySample {
  issueId: string;
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
  // evidence — an unobserved worker time never renders as zero.
  waiting: { activeExecutionMs: number | null; unclassifiedMs: number };
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

const METADATA_FIELD: Record<string, keyof WorkItemAttemptExecutionMetadata> = {
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
  settings: "cohort keys and mixed labels are derived across ALL attempts; a lifecycle spanning settings is mixed, never attributed to the setting active at merge",
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

/**
 * Derive the per-dimension cohort keys and settings for one work item's
 * attempt chain.
 *
 * The four settings dimensions (worker, model, reasoningEffort,
 * runtimeRevision) and cohortLabel are read across ALL attempts (execution
 * and fix rounds). A dimension with >1 distinct non-null values is "mixed";
 * zero distinct values is "unknown". The `settings` object carries the
 * single value for each of the four settings fields, or null when the
 * dimension is mixed or unknown.
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
      const value = attempt.executionMetadata[field];
      if (value !== null && value.length > 0) {
        values.add(value);
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
  const { issue, events, runs, prFixItems } = input;
  const labels = input.labels ?? [];

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

  const unclassifiedMs =
    claimToDoneMs !== null && workerTimeMs !== null
      ? Math.max(0, claimToDoneMs - workerTimeMs)
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
  const distinctRuntimeRevisions = new Set<string>();
  const distinctModels = new Set<string>();
  const distinctWorkers = new Set<string>();
  for (const s of members) {
    fixRoundsTotal += s.fixRounds;
    if (s.fixRounds > 0) itemsWithFixes += 1;
    if (s.unclassifiedMs !== null) unclassifiedMs += s.unclassifiedMs;
    if (s.mixedSettings) mixedSettings += 1;
    if (s.missing.includes("metadata")) missingMetadata += 1;
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
      unclassifiedMs,
    },
    confounders: {
      mixedSettings,
      missingMetadata,
      distinctRuntimeRevisions: [...distinctRuntimeRevisions].sort(),
      distinctModels: [...distinctModels].sort(),
      distinctWorkers: [...distinctWorkers].sort(),
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
