/**
 * A pure, order-invariant projection of one work item's execution evidence
 * into a typed "work-item attempt chain" (#1183).
 *
 * The lifecycle timeline (`issue-lifecycle-read.ts`) answers what happened to
 * the work item. This module answers a different question: *who executed it,
 * how many times, and how did each execution end*. It links every execution
 * attempt and every PR-fix round of ONE work item into a single delivery
 * chain from plain data — the same `IssueLifecycleEvent` rows the timeline
 * reads, the `AgentRun` rows attached to the issue, and the `PrFixQueueItem`
 * rows for the item's PRs — so a reader sees one ordered chain:
 *
 * - `attempts` in oldest-first order: one `exec-<hash12>` per observed
 *   claim (a content-derived id over the claim event's identity fields —
 *   stable even when backfilled evidence arrives out of order), one
 *   `fix-<itemId>-g<generation>` per PR-fix generation.
 * - `totalExecutionWallTimeMs`: the union of ALL execution-interval evidence
 *   across attempts and fix rounds, so overlapping intervals are never
 *   double-counted.
 *
 * Three rules keep it honest, mirroring the timeline's:
 *
 * 1. **Unknown is a value.** A claim time with no claim event, a start/end
 *    with no AgentRun interval, a merge with no `pr_merged` row — all stay
 *    null. Claimed time is never inferred from the issue's creation or from
 *    run timestamps; start/end come only from AgentRun intervals, because
 *    claim/admission time and actual execution time are different facts.
 * 2. **Conservative classification.** An attempt is `active-execution` only
 *    when a run interval overlaps its window; anything else (queued,
 *    waiting-review, waiting-ci) stays `unclassified` unless explicit
 *    evidence says otherwise (a release that deliberately retained
 *    `status/in-review`). When in doubt, unclassified.
 * 3. **Every attempt is preserved.** Failures, blocked runs, attempts
 *    superseded by a newer claim or a newer fix generation, and open
 *    attempts all appear with their outcome — the chain never drops an
 *    attempt, and a worker success report never becomes merge evidence:
 *    merges live only in the timeline's `pr_merged` events.
 *
 * The function is pure: no Prisma, no I/O, no clock reads, and its output is
 * invariant to the order the rows arrive in.
 */

import { createHash } from "node:crypto";

import type {
  LifecycleEventRecord,
  LifecycleProvenance,
} from "./issue-lifecycle-read";

export interface WorkAttemptRunRecord {
  id: string;
  agentName: string | null;
  runType: string;
  status: string;
  startedAt: Date | string;
  finishedAt: Date | string | null;
  executionMetadata: Record<string, unknown> | null;
}

export interface WorkAttemptHistoryRecord {
  at: Date | string;
  action: string;
  status: string | null;
  outcome: string | null;
}

export interface WorkAttemptPrFixItemRecord {
  id: string;
  repo: string;
  pr: number;
  issue: number | null;
  generation: number;
  fixAttempts: number;
  status: string;
  outcome: string | null;
  queuedAt: Date | string;
  history: readonly WorkAttemptHistoryRecord[];
}

export type WorkItemAttemptKind = "execution" | "fix-round";

export type WorkItemAttemptOutcome =
  | "success"
  | "failed"
  | "blocked"
  | "abandoned"
  | "superseded"
  | "unclassified";

export type WorkItemAttemptClassification =
  | "active-execution"
  | "waiting-review"
  | "unclassified";

export interface WorkItemAttemptExecutionMetadata {
  workerProduct: string | null;
  model: string | null;
  reasoningEffort: string | null;
  runtimeRevision: string | null;
  cohortLabel: string | null;
}

export interface WorkItemAttemptArtifacts {
  agentRunIds: string[];
  pullRequestNumbers: number[];
}

export interface WorkItemAttempt {
  attemptId: string;
  kind: WorkItemAttemptKind;
  agentName: string | null;
  claimedAt: { at: string | null; provenance: LifecycleProvenance };
  startedAt: string | null;
  endedAt: string | null;
  reportedAt: string | null;
  outcome: WorkItemAttemptOutcome;
  classification: WorkItemAttemptClassification;
  executionMetadata: WorkItemAttemptExecutionMetadata;
  artifacts: WorkItemAttemptArtifacts;
  wallTimeMs: number | null;
  // The PR-fix queue item behind a fix-round attempt (#1183 review): the
  // attemptId keys off the item id — unique even when two items share the
  // same repo#pr — so this field carries the coordinates. null for
  // execution attempts.
  prFix: { itemId: string; repo: string; pr: number } | null;
}

export interface WorkItemDeliveryChain {
  schema: "dispatch.work-item-attempt-chain/v1";
  units: "milliseconds";
  workItem: { repoFullName: string; issueNumber: number };
  attempts: WorkItemAttempt[];
  totalExecutionWallTimeMs: number | null;
  notes: string[];
}

export interface WorkItemChainInput {
  repoFullName: string;
  issueNumber: number;
}

/** Parse a defensive timestamp: unparseable (or absent) values yield null. */
function toMillis(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function isBackfilled(metadata: Record<string, unknown> | null): boolean {
  return metadata?.backfilled === true;
}

/**
 * Which PR a `pr_merged` row is about: the metadata's number when it carries
 * one, else the `pr-<n>` sourceEventId. Mirrors the timeline's resolver so
 * both readers agree on a merge's identity.
 */
function resolvePrNumber(row: LifecycleEventRecord): number | null {
  const metadata = row.metadata ?? {};
  if (typeof metadata.pullRequestNumber === "number" && Number.isFinite(metadata.pullRequestNumber)) {
    return metadata.pullRequestNumber;
  }
  const match = row.sourceEventId?.match(/^pr-(\d+)$/);
  return match ? Number(match[1]) : null;
}

function contentKey(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Content-derived execution-attempt identity (#1183 review): sha256 over a
 * stable join of the claim event's identity fields (kind, actor, source,
 * agentName, occurredAtMs, fromStatus, toStatus) AFTER the projection's
 * dedupe, first 12 hex chars. The status labels are in the join so the id is
 * at least as discriminating as the dedupe key itself: two claim rows that
 * survive dedupe can never share an attempt id. A positional `exec-<ordinal>`
 * would rename every attempt when a
 * backfilled EARLIER claim arrives — the ordinal shifts, the content id
 * does not. `node:crypto` createHash is used instead of an inline FNV-1a/
 * djb2 to keep a hand-rolled hash out of the identity path; the module
 * stays pure (deterministic, no I/O, no clock reads).
 */
function executionAttemptId(claim: { row: LifecycleEventRecord; occurredAtMs: number }): string {
  const key = JSON.stringify([
    claim.row.kind,
    claim.row.actor,
    claim.row.source,
    claim.row.agentName,
    claim.occurredAtMs,
    claim.row.fromStatus,
    claim.row.toStatus,
  ]);
  return `exec-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/**
 * The timeline's exact-duplicate collapse, applied to the same rows: the
 * same transition observed twice (the documented api-vs-webhook pair) is one
 * fact and must not inflate the attempt count. `source` is deliberately not
 * part of the identity; `agentName` is. A merge's identity additionally
 * includes its PR number. Rows come back in occurredAt order.
 */
function dedupeEvents(
  events: readonly LifecycleEventRecord[],
  addNote: (note: string) => void,
): Array<{ row: LifecycleEventRecord; occurredAtMs: number }> {
  const ordered = [...events].sort((a, b) =>
    contentKey([
      a.kind,
      a.source,
      a.actor,
      a.agentName,
      a.fromStatus,
      a.toStatus,
      a.sourceEventId,
      toMillis(a.occurredAt),
      toMillis(a.observedAt),
      a.metadata,
    ]) < contentKey([
      b.kind,
      b.source,
      b.actor,
      b.agentName,
      b.fromStatus,
      b.toStatus,
      b.sourceEventId,
      toMillis(b.occurredAt),
      toMillis(b.observedAt),
      b.metadata,
    ])
      ? -1
      : 1,
  );

  const deduped: Array<{ row: LifecycleEventRecord; occurredAtMs: number }> = [];
  const seen = new Set<string>();
  let collapsed = false;
  for (const row of ordered) {
    const occurredAtMs = toMillis(row.occurredAt);
    if (occurredAtMs === null) {
      addNote(`event ${row.kind} (${row.source}) skipped: unparseable occurredAt`);
      continue;
    }
    const key = [
      row.kind,
      row.fromStatus ?? "",
      row.toStatus ?? "",
      occurredAtMs,
      row.agentName ?? "",
      row.kind === "pr_merged" ? (resolvePrNumber(row) ?? "") : "",
    ].join("\u0000");
    if (seen.has(key)) {
      collapsed = true;
      continue;
    }
    seen.add(key);
    deduped.push({ row, occurredAtMs });
  }
  if (collapsed) addNote("duplicate observation collapsed");

  deduped.sort(
    (a, b) =>
      a.occurredAtMs - b.occurredAtMs ||
      (a.row.kind < b.row.kind ? -1 : a.row.kind > b.row.kind ? 1 : 0),
  );
  return deduped;
}

/** Union length of closed intervals: overlapping intervals are counted once,
 * never summed. Null when there are no intervals at all. */
function unionLength(intervals: Array<{ start: number; end: number }>): number | null {
  if (intervals.length === 0) return null;
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let currentStart = sorted[0].start;
  let currentEnd = sorted[0].end;
  for (const interval of sorted.slice(1)) {
    if (interval.end > currentEnd) {
      if (interval.start > currentEnd) {
        total += currentEnd - currentStart;
        currentStart = interval.start;
      }
      currentEnd = interval.end;
    }
  }
  return total + (currentEnd - currentStart);
}

const EXECUTION_METADATA_FIELDS: Array<[keyof WorkItemAttemptExecutionMetadata, string]> = [
  ["workerProduct", "worker"],
  ["model", "model"],
  ["reasoningEffort", "reasoningEffort"],
  ["runtimeRevision", "runtimeRevision"],
  ["cohortLabel", "cohortLabel"],
];

function emptyExecutionMetadata(): WorkItemAttemptExecutionMetadata {
  return {
    workerProduct: null,
    model: null,
    reasoningEffort: null,
    runtimeRevision: null,
    cohortLabel: null,
  };
}

/** First non-null per field across the matched runs, in run order. Values
 * are taken verbatim from the run's stored executionMetadata — never
 * inferred from timestamps or deployment data. */
function executionMetadataFromRuns(
  runs: ReadonlyArray<WorkAttemptRunRecord>,
): WorkItemAttemptExecutionMetadata {
  const merged = emptyExecutionMetadata();
  for (const run of runs) {
    const metadata = run.executionMetadata;
    for (const [field, key] of EXECUTION_METADATA_FIELDS) {
      if (merged[field] !== null) continue;
      const value = metadata?.[key];
      if (typeof value === "string" && value.length > 0) merged[field] = value;
    }
  }
  return merged;
}

const CLOSING_KINDS = new Set(["attempt_failed", "completed", "claim_released"]);

/**
 * Build the delivery chain for one work item. Inputs are plain data — a
 * prisma result, a webhook payload, or a test fixture — and the projection
 * is invariant to the order rows arrive in.
 */
export function buildWorkItemDeliveryChain(
  workItem: WorkItemChainInput,
  inputs: {
    events: readonly LifecycleEventRecord[];
    runs: readonly WorkAttemptRunRecord[];
    prFixItems: readonly WorkAttemptPrFixItemRecord[];
  },
): WorkItemDeliveryChain {
  const notes: string[] = [];
  const addNote = (note: string) => {
    if (!notes.includes(note)) notes.push(note);
  };

  const events = dedupeEvents(inputs.events, addNote);

  // Runs are deduped by id: two identical reports land on one AgentRun row
  // (the report dedupe reuses it), so a replayed run must contribute one
  // attempt's worth of evidence, not two. Conflicting duplicates (same id,
  // different content) keep the first row in content order so the result
  // stays order-invariant.
  const sortedRuns = [...inputs.runs].sort((a, b) =>
    contentKey([a.id, a.agentName, a.runType, a.status, toMillis(a.startedAt), toMillis(a.finishedAt), a.executionMetadata]) <
    contentKey([b.id, b.agentName, b.runType, b.status, toMillis(b.startedAt), toMillis(b.finishedAt), b.executionMetadata])
      ? -1
      : 1,
  );
  const seenRunIds = new Set<string>();
  const runIntervals: Array<{ run: WorkAttemptRunRecord; start: number; end: number }> = [];
  let runsCollapsed = false;
  for (const run of sortedRuns) {
    if (seenRunIds.has(run.id)) {
      runsCollapsed = true;
      continue;
    }
    seenRunIds.add(run.id);
    const start = toMillis(run.startedAt);
    if (start === null) {
      addNote(`agent run ${run.id} skipped: unparseable startedAt`);
      continue;
    }
    const finishedMs = toMillis(run.finishedAt);
    if (finishedMs === null && run.finishedAt !== null && run.finishedAt !== undefined) {
      addNote(`agent run ${run.id} finishedAt unparseable; treated as not finished`);
    }
    // A still-running (or unparseable-finishedAt) run is a zero-length
    // instant at its start: it evidences execution without inventing an end.
    const end = finishedMs !== null && finishedMs > start ? finishedMs : start;
    runIntervals.push({ run, start, end });
  }
  if (runsCollapsed) addNote("duplicate agent run collapsed");

  // Every run interval is execution-interval evidence for the item, so the
  // total unions them all — overlapping intervals across attempts and fix
  // rounds are never double-counted.
  const totalExecutionWallTimeMs = unionLength(
    runIntervals.map(({ start, end }) => ({ start, end })),
  );

  // Each ordered entry carries the attempt plus its private ordering anchor;
  // the anchor is stripped before the chain is returned.
  interface OrderedAttempt {
    attempt: WorkItemAttempt;
    anchorMs: number | null;
    kindRank: number;
    ordinal: number;
  }
  const ordered: OrderedAttempt[] = [];

  // Execution attempts: one per claim event, in claim order. Each attempt's
  // window is [claim, first closing evidence) where closing evidence is an
  // attempt_failed, a completed, a claim_released — or the next claim, which
  // supersedes the attempt without erasing it.
  let ordinal = 0;
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const claim = events[eventIndex];
    if (claim.row.kind !== "claim") continue;
    ordinal += 1;
    const windowStart = claim.occurredAtMs;

    let closeIndex: number | null = null;
    let supersededByClaim = false;
    for (let i = eventIndex + 1; i < events.length; i += 1) {
      const kind = events[i].row.kind;
      if (kind === "claim") {
        closeIndex = i;
        supersededByClaim = true;
        break;
      }
      if (CLOSING_KINDS.has(kind)) {
        closeIndex = i;
        break;
      }
    }
    const closing = closeIndex !== null ? events[closeIndex] : null;
    const windowEnd = closing !== null ? closing.occurredAtMs : Number.POSITIVE_INFINITY;
    if (supersededByClaim) {
      addNote("attempt closed by a newer claim without a release");
    }

    // Runs whose interval lies within/overlaps the attempt window supply the
    // attempt's actual execution start/end and its wall time. Matched runs
    // are ordered by start (then id) so the metadata union is order-invariant.
    const matched = runIntervals
      .filter(({ start, end }) => start <= windowEnd && end >= windowStart)
      .sort((a, b) => a.start - b.start || (a.run.id < b.run.id ? -1 : a.run.id > b.run.id ? 1 : 0));

    const startedAtMs = matched.length > 0 ? Math.min(...matched.map((m) => m.start)) : null;
    const endedAtMs = matched.length > 0 ? Math.max(...matched.map((m) => m.end)) : null;

    // Merge evidence stays lifecycle-owned: PR numbers come only from
    // pr_merged events whose occurrence falls in the attempt window, and a
    // merge never decides an attempt's outcome.
    const pullRequestNumbers = [
      ...new Set(
        events
          .filter(
            (event) =>
              event.row.kind === "pr_merged" &&
              event.occurredAtMs >= windowStart &&
              event.occurredAtMs <= windowEnd &&
              resolvePrNumber(event.row) !== null,
          )
          .map((event) => resolvePrNumber(event.row) as number),
      ),
    ].sort((a, b) => a - b);

    let outcome: WorkItemAttemptOutcome = "unclassified";
    if (supersededByClaim) {
      outcome = "superseded";
    } else if (
      closing !== null &&
      (closing.row.kind === "completed" || closing.row.kind === "attempt_failed")
    ) {
      // Outcome attribution requires the closing report's agent to match the
      // claim's agent (#1183 review): a closing event from a DIFFERENT agent
      // still ends the window (reportedAt is set) but never decides the
      // outcome — the attempt stays unclassified.
      const claimAgent = claim.row.agentName;
      const closingAgent = closing.row.agentName;
      if (
        claimAgent !== null &&
        closingAgent !== null &&
        closingAgent !== claimAgent
      ) {
        addNote("closing report from a different agent ignored for outcome attribution");
      } else if (closing.row.kind === "completed") {
        outcome = "success";
      } else {
        const reported = (closing.row.metadata ?? {}).outcome;
        if (reported === "failed") outcome = "failed";
        else if (reported === "blocked") outcome = "blocked";
      }
    }
    // A claim_released alone never certifies success or failure: the release
    // leaves the attempt unclassified regardless of the status it retained.

    let classification: WorkItemAttemptClassification = "unclassified";
    if (matched.length > 0) {
      classification = "active-execution";
    } else if (
      closing !== null &&
      !supersededByClaim &&
      closing.row.kind === "claim_released" &&
      closing.row.toStatus === "status/in-review"
    ) {
      // Explicit evidence only: the release deliberately retained
      // status/in-review. A merged PR in the window is NOT derivable as
      // waiting-review and stays unclassified.
      classification = "waiting-review";
    }

    const agentName =
      claim.row.agentName ??
      closing?.row.agentName ??
      (matched.length > 0 ? matched[0].run.agentName : null) ??
      null;

    ordered.push({
      attempt: {
        attemptId: executionAttemptId(claim),
        kind: "execution",
        agentName,
        claimedAt: {
          at: toIso(windowStart),
          provenance: isBackfilled(claim.row.metadata) ? "backfilled" : "observed",
        },
        startedAt: startedAtMs !== null ? toIso(startedAtMs) : null,
        endedAt: endedAtMs !== null ? toIso(endedAtMs) : null,
        reportedAt: closing !== null ? toIso(closing.occurredAtMs) : null,
        outcome,
        classification,
        executionMetadata: executionMetadataFromRuns(matched.map((m) => m.run)),
        artifacts: {
          agentRunIds: matched.map((m) => m.run.id),
          pullRequestNumbers,
        },
        wallTimeMs:
          matched.length > 0
            ? unionLength(matched.map((m) => ({ start: m.start, end: m.end })))
            : null,
        prFix: null,
      },
      anchorMs: windowStart,
      kindRank: 0,
      ordinal,
    });
  }

  // PR-fix rounds: one per generation the item records, in generation order —
  // exactly one round per generation 1..item.generation. `fixAttempts` is the
  // worker-execution count (#1103), not a work identity, and must never
  // fabricate extra rounds. The history stream carries no generation
  // attribution, so a fix round's claim time and agent stay unknown — never
  // guessed from queue or history timestamps. The attemptId keys off the
  // item id, which stays unique even when two items share the same repo#pr.
  const sortedItems = [...inputs.prFixItems].sort((a, b) =>
    contentKey([a.repo, a.pr, a.id]) < contentKey([b.repo, b.pr, b.id]) ? -1 : 1,
  );
  for (const item of sortedItems) {
    const historyTimes = item.history
      .map((entry) => ({ entry, ms: toMillis(entry.at) }))
      .filter((entry): entry is { entry: WorkAttemptHistoryRecord; ms: number } => entry.ms !== null)
      .sort(
        (a, b) =>
          a.ms - b.ms ||
          (a.entry.action < b.entry.action ? -1 : a.entry.action > b.entry.action ? 1 : 0),
      );
    if (historyTimes.length < item.history.length) {
      addNote(`pr-fix item ${item.repo}#${item.pr} history entry skipped: unparseable at`);
    }
    const queuedAtMs = toMillis(item.queuedAt);
    if (queuedAtMs === null) {
      addNote(`pr-fix item ${item.repo}#${item.pr} queuedAt unparseable`);
    }

    const lastGeneration = item.generation;
    for (let generation = 1; generation <= lastGeneration; generation += 1) {
      let outcome: WorkItemAttemptOutcome;
      if (generation < lastGeneration) {
        // A newer generation exists on the same item: this round was
        // superseded, not deleted.
        outcome = "superseded";
      } else if (item.status === "FIXED") {
        outcome = "success";
      } else if (item.status === "BLOCKED") {
        outcome = "blocked";
      } else if (item.status === "PARKED") {
        outcome = "abandoned";
      } else {
        outcome = "unclassified";
      }

      ordered.push({
        attempt: {
          attemptId: `fix-${item.id}-g${generation}`,
          kind: "fix-round",
          agentName: null,
          claimedAt: { at: null, provenance: "unknown" },
          startedAt: null,
          endedAt: null,
          reportedAt: null,
          outcome,
          classification: "unclassified",
          executionMetadata: emptyExecutionMetadata(),
          artifacts: { agentRunIds: [], pullRequestNumbers: [] },
          wallTimeMs: null,
          prFix: { itemId: item.id, repo: item.repo, pr: item.pr },
        },
        // The round's oldest evidence — its first history entry, else the
        // queue time — orders it against the execution attempts.
        anchorMs: historyTimes.length > 0 ? historyTimes[0].ms : queuedAtMs,
        kindRank: 1,
        ordinal: generation,
      });
    }
  }

  // Oldest-first: by anchor time, execution attempts before fix rounds at an
  // equal instant, then execution ordinal / fix generation, then arrival
  // index as the final tie-break — a deterministic total order independent of
  // row arrival order.
  ordered.sort((a, b) => {
    const anchorA = a.anchorMs ?? Number.MAX_SAFE_INTEGER;
    const anchorB = b.anchorMs ?? Number.MAX_SAFE_INTEGER;
    if (anchorA !== anchorB) return anchorA - anchorB;
    if (a.kindRank !== b.kindRank) return a.kindRank - b.kindRank;
    if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
    return 0;
  });

  return {
    schema: "dispatch.work-item-attempt-chain/v1",
    units: "milliseconds",
    workItem: { repoFullName: workItem.repoFullName, issueNumber: workItem.issueNumber },
    attempts: ordered.map(({ attempt }) => attempt),
    totalExecutionWallTimeMs,
    notes,
  };
}
