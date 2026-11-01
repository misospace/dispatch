/**
 * A pure, source-neutral projection of a bounded list of `IssueLifecycleEvent`
 * rows into a typed "issue lifecycle timeline" (#1203).
 *
 * The write side (`issue-lifecycle.ts`) records what happened to a work item:
 * claims, releases, status moves, closes, reopens, and observed PR merges.
 * This module is the read side: it takes the rows as plain data — a prisma
 * result, a webhook payload, or a test fixture — and projects them into one
 * shape a UI or a duration API can consume:
 *
 * - `claims` in occurredAt order, with the first claim as the anchor;
 * - `doneAt`, `closedAt`, and `lastReopenAt` milestones;
 * - `pullRequests`, one entry per merged PR with a unioned metadata bag;
 * - `claimToDoneMs` / `claimToMergeMs` intervals measured from the first claim.
 *
 * Two rules keep it honest:
 *
 * 1. **Unknown is a value.** A timestamp no event (and, for `closedAt`, the
 *    issue cache) establishes is `{ at: null, provenance: "unknown", via: [] }`
 *    — never a zero, never the issue's createdAt. Intervals are null whenever
 *    their anchor is unknown.
 * 2. **Every fact carries provenance.** `observed` means a source recorded it
 *    at that time; `backfilled` means a backfill derived it from already
 *    observed records; `issue-cache` names the one non-event source (the
 *    cached `Issue.closedAt` fallback).
 *
 * The function is pure: no Prisma, no I/O, no clock reads, and its output is
 * invariant to the order the rows arrive in.
 */

import { toIso, toMillis } from "./time-parse";

export type LifecycleProvenance = "observed" | "backfilled" | "unknown";

export interface LifecycleEventRecord {
  kind: string;
  source: string;
  actor: string;
  agentName: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  sourceEventId: string | null;
  occurredAt: Date | string;
  observedAt: Date | string;
  metadata: Record<string, unknown> | null;
}

export interface LifecycleTimestamp {
  at: string | null;
  provenance: LifecycleProvenance;
  via: string[];
}

export interface LifecycleClaim {
  agentName: string | null;
  actor: string;
  source: string;
  at: string;
  observedAt: string;
  provenance: LifecycleProvenance;
}

export interface LifecyclePullRequest {
  prNumber: number;
  prUrl: string | null;
  mergedAt: string;
  mergeCommitSha: string | null;
  headSha: string | null;
  linkSource: string | null;
  provenance: LifecycleProvenance;
}

export type LifecycleDelivery = "merged" | "closed-unmerged" | "open" | "unknown";

export interface IssueLifecycleTimeline {
  schema: "dispatch.issue-lifecycle-timeline/v1";
  units: "milliseconds";
  claims: LifecycleClaim[];
  firstClaim: LifecycleTimestamp;
  doneAt: LifecycleTimestamp;
  closedAt: LifecycleTimestamp;
  lastClosedAt: LifecycleTimestamp;
  lastReopenAt: LifecycleTimestamp;
  pullRequests: LifecyclePullRequest[];
  firstMergedAt: LifecycleTimestamp;
  delivery: LifecycleDelivery;
  claimToDoneMs: number | null;
  claimToMergeMs: number | null;
  notes: string[];
}

export interface TimelineIssueInput {
  repoFullName: string;
  issueNumber: number;
  state: string;
  closedAt?: Date | string | null;
}

function isBackfilled(metadata: Record<string, unknown> | null): boolean {
  return metadata?.backfilled === true;
}

function firstNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A total-order key over a raw row, derived only from its content. It exists
 * so the projection is identical no matter what order the same rows arrive in:
 * a time sort cannot order rows whose times are equal or unparseable, so the
 * content key is the final tie-break (and the order in which skip notes are
 * emitted for unparseable rows).
 */
function stableKey(row: LifecycleEventRecord): string {
  return JSON.stringify([
    row.kind,
    row.source,
    row.actor,
    row.agentName,
    row.fromStatus,
    row.toStatus,
    row.sourceEventId,
    toMillis(row.occurredAt),
    toMillis(row.observedAt),
    row.metadata,
  ]);
}

/**
 * Which PR a `pr_merged` row is about: the metadata's number when it carries
 * one, else the `pr-<n>` sourceEventId. Null when neither identifies a PR.
 */
function resolvePrNumber(row: LifecycleEventRecord): number | null {
  const metadata = row.metadata ?? {};
  if (typeof metadata.pullRequestNumber === "number" && Number.isFinite(metadata.pullRequestNumber)) {
    return metadata.pullRequestNumber;
  }
  const match = row.sourceEventId?.match(/^pr-(\d+)$/);
  return match ? Number(match[1]) : null;
}

interface NormalizedEvent {
  row: LifecycleEventRecord;
  occurredAtMs: number;
  observedAtMs: number;
  key: string;
}

function unknownTimestamp(): LifecycleTimestamp {
  return { at: null, provenance: "unknown", via: [] };
}

export function buildIssueLifecycleTimeline(
  issue: TimelineIssueInput,
  events: readonly LifecycleEventRecord[],
): IssueLifecycleTimeline {
  const notes: string[] = [];
  const addNote = (note: string) => {
    if (!notes.includes(note)) notes.push(note);
  };

  // Order the raw rows by content first so unparseable rows — which no time
  // sort can place — are skipped, and their notes emitted, in a stable order.
  const ordered = [...events].sort((a, b) => {
    const keyA = stableKey(a);
    const keyB = stableKey(b);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });

  const normalized: NormalizedEvent[] = [];
  for (const row of ordered) {
    const occurredAtMs = toMillis(row.occurredAt);
    if (occurredAtMs === null) {
      addNote(`event ${row.kind} (${row.source}) skipped: unparseable occurredAt`);
      continue;
    }
    // An unparseable observedAt cannot order the row, so it falls back to the
    // occurrence time rather than poisoning the sort.
    normalized.push({
      row,
      occurredAtMs,
      observedAtMs: toMillis(row.observedAt) ?? occurredAtMs,
      key: stableKey(row),
    });
  }

  normalized.sort(
    (a, b) =>
      a.occurredAtMs - b.occurredAtMs ||
      a.observedAtMs - b.observedAtMs ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  // Exact repeats are one fact: the same transition observed by two writers
  // (the documented api-vs-webhook double-record) at the same time collapses.
  // `source` is deliberately not part of the identity; `agentName` is, so a
  // genuine re-claim by another agent in the same instant stays distinct. A
  // merge's identity additionally includes its PR number.
  const deduped: NormalizedEvent[] = [];
  const seen = new Set<string>();
  let collapsed = false;
  for (const event of normalized) {
    const key = [
      event.row.kind,
      event.row.fromStatus ?? "",
      event.row.toStatus ?? "",
      event.occurredAtMs,
      event.row.agentName ?? "",
      event.row.kind === "pr_merged" ? (resolvePrNumber(event.row) ?? "") : "",
    ].join("\u0000");
    if (seen.has(key)) {
      collapsed = true;
      continue;
    }
    seen.add(key);
    deduped.push(event);
  }
  if (collapsed) addNote("duplicate observation collapsed");

  // Claims: every ownership-taking, in occurredAt order. The first is the
  // interval anchor — and a missing first claim is unknown, never zero.
  const claimEvents = deduped.filter((event) => event.row.kind === "claim");
  const claims: LifecycleClaim[] = claimEvents.map((event) => ({
    agentName: event.row.agentName,
    actor: event.row.actor,
    source: event.row.source,
    at: toIso(event.occurredAtMs),
    observedAt: toIso(event.observedAtMs),
    provenance: isBackfilled(event.row.metadata) ? "backfilled" : "observed",
  }));
  const firstClaim: LifecycleTimestamp =
    claimEvents.length === 0
      ? unknownTimestamp()
      : {
          at: toIso(claimEvents[0].occurredAtMs),
          provenance: isBackfilled(claimEvents[0].row.metadata) ? "backfilled" : "observed",
          via: ["claim"],
        };

  // Done: a worker report closing the item as already done, or the status
  // label landing on status/done. `via` lists every kind that says done.
  const doneEvents = deduped.filter(
    (event) =>
      event.row.kind === "completed" ||
      (event.row.kind === "status_changed" && event.row.toStatus === "status/done"),
  );
  const doneVia: string[] = [];
  for (const event of doneEvents) {
    if (!doneVia.includes(event.row.kind)) doneVia.push(event.row.kind);
  }
  const doneAt: LifecycleTimestamp =
    doneEvents.length === 0
      ? unknownTimestamp()
      : { at: toIso(doneEvents[0].occurredAtMs), provenance: "observed", via: doneVia };

  // Closed: an observed GitHub close, with the issue cache's closed_at as the
  // one fallback. The cache is a cache, so it only fills a gap — an observed
  // close always wins.
  const closedEvents = deduped.filter((event) => event.row.kind === "issue_closed");
  const closedAt: LifecycleTimestamp =
    closedEvents.length > 0
      ? { at: toIso(closedEvents[0].occurredAtMs), provenance: "observed", via: ["issue_closed"] }
      : issue.state === "closed"
        ? (toMillis(issue.closedAt) === null
            ? unknownTimestamp()
            : {
                at: toIso(toMillis(issue.closedAt) as number),
                provenance: "observed",
                via: ["issue-cache"],
              })
        : unknownTimestamp();

  // Reopened: the latest one is what a reader needs — a close before it does
  // not describe the item's present state.
  const reopenEvents = deduped.filter((event) => event.row.kind === "issue_reopened");
  const lastReopenAt: LifecycleTimestamp =
    reopenEvents.length === 0
      ? unknownTimestamp()
      : {
          at: toIso(reopenEvents[reopenEvents.length - 1].occurredAtMs),
          provenance: "observed",
          via: ["issue_reopened"],
        };

  // Last close: the LATEST close evidence, the same ordering `delivery` uses
  // (last observed close, with the issue cache's closedAt filling a gap or —
  // when later than every observed close — carrying the latest evidence).
  // `closedAt` keeps reporting the FIRST close milestone; a reader that needs
  // "the close with no reopen after it" (durable completion) reads this one,
  // so a close→reopen→reclose sequence resolves against the reclose.
  const lastCloseEventMs =
    closedEvents.length > 0 ? closedEvents[closedEvents.length - 1].occurredAtMs : null;
  // The issue cache's closedAt is close evidence too, but only where the
  // `closedAt` milestone accepts it: the cache fills a gap for a CLOSED
  // issue. Gating it the same way keeps delivery from certifying a close
  // the milestone itself refuses to.
  const cacheClosedMs = issue.state === "closed" ? toMillis(issue.closedAt) : null;
  const latestCloseMs =
    lastCloseEventMs === null
      ? cacheClosedMs
      : cacheClosedMs === null
        ? lastCloseEventMs
        : Math.max(lastCloseEventMs, cacheClosedMs);
  const lastClosedAt: LifecycleTimestamp =
    latestCloseMs === null
      ? unknownTimestamp()
      : lastCloseEventMs === null
        ? { at: toIso(latestCloseMs), provenance: "observed", via: ["issue-cache"] }
        : cacheClosedMs !== null && cacheClosedMs > lastCloseEventMs
          ? {
              at: toIso(latestCloseMs),
              provenance: "observed",
              via: ["issue_closed", "issue-cache"],
            }
          : { at: toIso(latestCloseMs), provenance: "observed", via: ["issue_closed"] };

  // Merges: one entry per PR. Repeated observations of the same PR keep the
  // earliest merge time and union the metadata, first non-null per field.
  const prGroups = new Map<number, NormalizedEvent[]>();
  for (const event of deduped) {
    if (event.row.kind !== "pr_merged") continue;
    const prNumber = resolvePrNumber(event.row);
    if (prNumber === null) {
      addNote(`pr_merged event (${event.row.source}) skipped: no pull request number`);
      continue;
    }
    const group = prGroups.get(prNumber) ?? [];
    group.push(event);
    prGroups.set(prNumber, group);
  }

  const pullRequests: LifecyclePullRequest[] = [];
  for (const [prNumber, group] of prGroups) {
    const anchor = group[0];
    let prUrl: string | null = null;
    let mergeCommitSha: string | null = null;
    let headSha: string | null = null;
    let linkSource: string | null = null;
    for (const event of group) {
      const metadata = event.row.metadata ?? {};
      prUrl = prUrl ?? firstNonEmptyString(metadata.pullRequestUrl);
      mergeCommitSha = mergeCommitSha ?? firstNonEmptyString(metadata.mergeCommitSha);
      headSha = headSha ?? firstNonEmptyString(metadata.headSha);
      linkSource = linkSource ?? firstNonEmptyString(metadata.linkSource);
    }
    pullRequests.push({
      prNumber,
      prUrl,
      mergedAt: toIso(anchor.occurredAtMs),
      mergeCommitSha,
      headSha,
      linkSource,
      provenance: isBackfilled(anchor.row.metadata) ? "backfilled" : "observed",
    });
  }
  pullRequests.sort(
    (a, b) =>
      (a.mergedAt < b.mergedAt ? -1 : a.mergedAt > b.mergedAt ? 1 : 0) || a.prNumber - b.prNumber,
  );
  const firstMergedAt: LifecycleTimestamp =
    pullRequests.length === 0
      ? unknownTimestamp()
      : { at: pullRequests[0].mergedAt, provenance: pullRequests[0].provenance, via: ["pr_merged"] };

  // Delivery: a merged PR is shipped. A close without an observed merge is
  // not — and delivery follows the LATEST close/reopen ordering, not the
  // first close: a close after a reopen closes the item again, so it is
  // closed-unmerged again. `closedAt` keeps reporting the FIRST close
  // milestone; only `delivery` moves.
  const reopenMs = lastReopenAt.at !== null ? Date.parse(lastReopenAt.at) : null;
  let delivery: LifecycleDelivery;
  if (pullRequests.length > 0) {
    delivery = "merged";
  } else if (latestCloseMs !== null) {
    // Close evidence exists. A reopen AFTER the latest close undoes it, so the
    // issue's present state decides; otherwise the item is closed-unmerged.
    delivery =
      reopenMs !== null && reopenMs > latestCloseMs
        ? issue.state === "open"
          ? "open"
          : "unknown"
        : "closed-unmerged";
  } else {
    // No close evidence at all: the issue's present state decides. A reopen
    // without a close says nothing about delivery, so it never turns a closed
    // issue "unknown" on its own.
    delivery =
      issue.state === "closed"
        ? "closed-unmerged"
        : issue.state === "open"
          ? "open"
          : "unknown";
  }
  // The note marks the case the first-close comparison could not see: a close
  // that came after a reopen. It stays silent when no reopen is involved, so
  // it never reports a delivery change that did not happen — and it stays
  // silent for a merged delivery, which no close decided.
  if (
    delivery !== "merged" &&
    latestCloseMs !== null &&
    reopenMs !== null &&
    latestCloseMs > reopenMs
  ) {
    addNote("delivery derived from a close after a reopen");
  }

  // Intervals measured from the first observed claim. Negative values are kept
  // — an authoritative event can predate the first claim Dispatch saw (a
  // merge observed before a late-arriving claim) — but they are called out.
  const firstClaimMs = firstClaim.at !== null ? Date.parse(firstClaim.at) : null;

  let claimToDoneMs: number | null = null;
  const doneMs = doneAt.at !== null ? Date.parse(doneAt.at) : null;
  if (firstClaimMs !== null && doneMs !== null) {
    claimToDoneMs = doneMs - firstClaimMs;
    if (claimToDoneMs < 0) {
      addNote("claimToDoneMs negative: done precedes first observed claim");
    }
  }

  let claimToMergeMs: number | null = null;
  const mergedMs = firstMergedAt.at !== null ? Date.parse(firstMergedAt.at) : null;
  if (firstClaimMs !== null && mergedMs !== null) {
    claimToMergeMs = mergedMs - firstClaimMs;
    if (claimToMergeMs < 0) {
      addNote("claimToMergeMs negative: merge precedes first observed claim");
    }
  }

  if (claims.length === 0) {
    addNote("no claim events: firstClaim is unknown, not zero");
  }

  return {
    schema: "dispatch.issue-lifecycle-timeline/v1",
    units: "milliseconds",
    claims,
    firstClaim,
    doneAt,
    closedAt,
    lastClosedAt,
    lastReopenAt,
    pullRequests,
    firstMergedAt,
    delivery,
    claimToDoneMs,
    claimToMergeMs,
    notes,
  };
}
