/**
 * Release Pulse (dispatch#1482): a pure, repo-level aggregation answering
 * "what meaningful chunks of work became real since the latest stable
 * release?".
 *
 * It joins four persisted sources — the release-delta state (#1480), issue
 * lifecycle evidence (#1202), the groomer's semantic release signal
 * (#1481/#1487), and decomposition state — into one typed snapshot. It reads
 * no GitHub, calls no model, and touches no database: everything arrives as
 * plain data (prisma rows or test fixtures) and the output is invariant to
 * input order.
 *
 * Two honesty rules carry over from the lifecycle reader:
 *
 * 1. **Delivery is merge evidence, not a status label.** A `status/done`
 *    label, a worker completion report, and a groomer `already_done` closure
 *    never mean shipped — only an observed PR merge after the baseline does.
 * 2. **Unknown is a value.** Merge evidence that cannot be placed in time,
 *    and timelines whose delivery cannot be resolved, surface as
 *    `unknownDeliveryCount` rather than false highlights or silent drops.
 *
 * The pulse is computable only when the release delta is `identical` or
 * `ahead` AND the baseline has a parseable publication time. Anything else
 * (`diverged`, `unknown`, `no-baseline`) yields an explicit non-ready pulse
 * with zero highlights — never fabricated ones.
 */

import {
  buildIssueLifecycleTimeline,
  type IssueLifecycleTimeline,
  type LifecycleEventRecord,
} from "./issue-lifecycle-read";
import { normalizeStoredReleaseSignal, type ReleaseSignal } from "./groomer/plan";
import type { ReleaseDeltaState } from "./automation-sync";

export type ReleasePulseHighlightKind =
  | "feature"
  | "fix"
  | "architecture"
  | "umbrella_completed";

export interface ReleasePulsePrEvidence {
  prNumber: number;
  prUrl: string | null;
  mergeCommitSha: string | null;
  mergedAt: string;
}

export interface ReleasePulseHighlight {
  kind: ReleasePulseHighlightKind;
  headline: string;
  issueNumber: number;
  issueUrl: string | null;
  /** ISO; earliest post-baseline merge observation, or the parent close time for umbrella milestones. */
  deliveredAt: string | null;
  significance: "routine" | "notable" | "major" | null;
  confidence: "high" | "low";
  provenance:
    | "groomer-release-signal"
    | "legacy-issue-metadata"
    | "lifecycle-decomposition";
  /**
   * Every authoritative merged PR for the issue across ALL release intervals
   * — deliberately uncapped: #1482 requires retaining links to ALL merged
   * PRs, and the counts must not depend on display truncation. Pre-baseline
   * merges of a delivered multi-PR issue are retained as evidence; only the
   * delivery placement (`deliveredAt`) is baseline-scoped.
   */
  prs: ReleasePulsePrEvidence[];
  /** Umbrella milestones only: durably complete child issues. */
  children?: { number: number; url: string; closedAt: string | null }[];
}

export interface ReleasePulseRepoInput {
  fullName: string;
  /** "identical" | "ahead" | "diverged" | "unknown" | "no-baseline" */
  releaseState: ReleaseDeltaState;
  releaseBaselineTag: string | null;
  releaseBaselineSha: string | null;
  releaseBaselinePublishedAt: Date | string | null;
  releaseHeadSha: string | null;
  releaseAheadBy: number | null;
}

export interface ReleasePulseIssueInput {
  number: number;
  title: string;
  url: string | null;
  /** "open" | "closed" */
  state: string;
  /** issue-cache fallback for the close time. */
  closedAt: Date | string | null;
  labels: string[];
  /** Raw persisted `Issue.releaseSignal` column value; normalized internally. */
  releaseSignal: unknown;
  decomposed: boolean;
  followUpUrls: string[];
}

/**
 * Structurally a `LifecycleEventRecord` plus the issue it belongs to, so a
 * reader can pass prisma rows through directly. Only `pr_merged`,
 * `completed`, `issue_closed`, and `issue_reopened` kinds are consumed.
 */
export interface ReleasePulseEventInput extends LifecycleEventRecord {
  issueNumber: number;
}

export interface ReleasePulseSnapshot {
  schema: "dispatch.release-pulse/v1";
  repoFullName: string;
  pulseState: "ready" | "unknown" | "no-baseline";
  /** Null whenever the pulse is not ready. */
  baseline: { tag: string | null; sha: string | null; publishedAt: string | null } | null;
  headSha: string | null;
  /** Count only when the state is identical|ahead, else null. */
  unreleasedCommits: { state: ReleaseDeltaState; count: number | null };
  deliveredIssueCount: number;
  highlights: ReleasePulseHighlight[];
  highlightsTruncated: boolean;
  /**
   * Semantic "feature shipped" count over the FULL highlight set, computed
   * BEFORE the `RELEASE_PULSE_MAX_HIGHLIGHTS` cap slices the exposed list:
   * feature/architecture highlights with notable/major significance.
   * Consumers deciding anything from highlights must gate on this count —
   * the cap is a presentation bound, never an evidence bound, so filtering
   * the exposed array alone could hide a trigger past the cap.
   */
  notableDeliveryCount: number;
  completedUmbrellaCount: number;
  /** Issues with merge evidence but unusable/unknown merge times, or otherwise unresolvable delivery. */
  unknownDeliveryCount: number;
}

export const RELEASE_PULSE_MAX_HIGHLIGHTS = 50;

/**
 * The single gate rule, shared by the pure module and the Prisma reader so
 * the two can never drift: the pulse is computable only when the delta state
 * is `identical`/`ahead` AND the baseline has a parseable publication time.
 */
export function isReleasePulseReady(repo: ReleasePulseRepoInput): boolean {
  return (
    (repo.releaseState === "identical" || repo.releaseState === "ahead") &&
    toMillis(repo.releaseBaselinePublishedAt) !== null
  );
}

const FOLLOW_UP_URL_PATTERN =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)$/;

/** Parse a defensive timestamp: unparseable (or absent) values yield null. */
function toMillis(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Which PR a `pr_merged` row is about: the metadata's number when it carries
 * one, else the `pr-<n>` sourceEventId. Mirrors the lifecycle reader's own
 * resolution so "merge evidence the timeline could not turn into PR
 * evidence" is detected identically.
 */
function prNumberOf(row: {
  sourceEventId: string | null;
  metadata: Record<string, unknown> | null;
}): number | null {
  const metadata = row.metadata ?? {};
  if (typeof metadata.pullRequestNumber === "number" && Number.isFinite(metadata.pullRequestNumber)) {
    return metadata.pullRequestNumber;
  }
  const match = row.sourceEventId?.match(/^pr-(\d+)$/);
  return match ? Number(match[1]) : null;
}

/** Legacy type-label fallback: deterministic kind, or null when internal-equivalent. */
function legacyKindFromLabels(labels: string[]): "feature" | "fix" | null {
  if (labels.includes("type/bug") || labels.includes("type/security")) return "fix";
  if (labels.includes("type/feature")) return "feature";
  return null;
}

interface IssueDelivery {
  issue: ReleasePulseIssueInput;
  timeline: IssueLifecycleTimeline;
  /** All merged PR evidence (every interval), mergedAt ascending. */
  prs: ReleasePulsePrEvidence[];
  /** Earliest post-baseline merge observation; non-null iff merge-delivered in this interval. */
  deliveredAtMs: number | null;
  /** Merge evidence exists but cannot be placed in time (or delivery unresolvable). */
  unknown: boolean;
}

interface UsableMergeObservation {
  prNumber: number;
  occurredAtMs: number;
  prUrl: string | null;
  mergeCommitSha: string | null;
}

/**
 * Classify one raw `pr_merged` row. `null` = not a merge row. The writer
 * (`recordPrMergedEvent`) stamps rows whose source merge time was
 * unparseable with `occurredAt = observation time` and keeps the raw text in
 * `metadata.mergedAtRaw` — such a row carries NO usable merge time, so it
 * must surface as unresolvable evidence instead of a false post-baseline
 * highlight placed at write time.
 */
function mergeObservationOf(
  event: LifecycleEventRecord,
): UsableMergeObservation | "unresolvable" | null {
  if (event.kind !== "pr_merged") return null;
  const occurredMs = toMillis(event.occurredAt);
  const prNumber = prNumberOf(event);
  const metadata = event.metadata ?? {};
  const hasUnparseableSourceStamp =
    (typeof metadata.mergedAtRaw === "string" && metadata.mergedAtRaw.length > 0) ||
    toMillis(typeof metadata.mergedAt === "string" ? metadata.mergedAt : null) === null;
  if (occurredMs === null || prNumber === null || hasUnparseableSourceStamp) {
    return "unresolvable";
  }
  return {
    prNumber,
    occurredAtMs: occurredMs,
    prUrl: firstNonEmptyString(metadata.pullRequestUrl),
    mergeCommitSha: firstNonEmptyString(metadata.mergeCommitSha),
  };
}

function firstNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** One entry per PR: earliest observation time, unioned metadata. */
function mergePrEvidence(observations: UsableMergeObservation[]): ReleasePulsePrEvidence[] {
  const byPr = new Map<number, { mergedAtMs: number; prUrl: string | null; mergeCommitSha: string | null }>();
  for (const observation of observations) {
    const existing = byPr.get(observation.prNumber);
    if (existing) {
      existing.mergedAtMs = Math.min(existing.mergedAtMs, observation.occurredAtMs);
      existing.prUrl = existing.prUrl ?? observation.prUrl;
      existing.mergeCommitSha = existing.mergeCommitSha ?? observation.mergeCommitSha;
    } else {
      byPr.set(observation.prNumber, {
        mergedAtMs: observation.occurredAtMs,
        prUrl: observation.prUrl,
        mergeCommitSha: observation.mergeCommitSha,
      });
    }
  }
  return [...byPr.entries()]
    .map(([prNumber, evidence]) => ({
      prNumber,
      prUrl: evidence.prUrl,
      mergeCommitSha: evidence.mergeCommitSha,
      mergedAt: toIso(evidence.mergedAtMs),
    }))
    .sort(
      (a, b) =>
        (a.mergedAt < b.mergedAt ? -1 : a.mergedAt > b.mergedAt ? 1 : 0) || a.prNumber - b.prNumber,
    );
}

/**
 * Delivery is time-correlated with the baseline publication, not
 * commit-correlated: the issue cache carries no commit-membership data, so a
 * merge strictly after `releaseBaselinePublishedAt` is the best available
 * evidence the work landed in this interval. Evidence is read from the raw
 * `pr_merged` rows, not the timeline's per-PR projection: the timeline keeps
 * each PR's EARLIEST merge time, so a re-merge observation after the baseline
 * would be masked by a pre-baseline one there.
 *
 * PR evidence is retained across ALL intervals (#1482: a deduped multi-PR
 * highlight keeps links to every authoritative merged PR, including
 * pre-baseline ones); only the delivery placement is baseline-scoped. An
 * unresolvable merge row (no usable merge time) makes delivery unknown only
 * when it was OBSERVED after the baseline — a merge observed at or before it
 * necessarily predates the baseline, so its placement is neither deliverable
 * here nor unknowable.
 */
function resolveDelivery(
  issue: ReleasePulseIssueInput,
  baselineMs: number,
  eventsForIssue: LifecycleEventRecord[],
  timeline: IssueLifecycleTimeline,
): IssueDelivery {
  const observations: UsableMergeObservation[] = [];
  const postBaseline: UsableMergeObservation[] = [];
  let unresolvableAfterBaseline = false;
  for (const event of eventsForIssue) {
    const parsed = mergeObservationOf(event);
    if (parsed === null) continue;
    if (parsed === "unresolvable") {
      const observedMs = toMillis(event.occurredAt);
      if (observedMs === null || observedMs > baselineMs) unresolvableAfterBaseline = true;
      continue;
    }
    observations.push(parsed);
    if (parsed.occurredAtMs > baselineMs) postBaseline.push(parsed);
  }

  const prs = mergePrEvidence(observations);
  if (postBaseline.length > 0) {
    const deliveredAtMs = Math.min(
      ...postBaseline.map((observation) => observation.occurredAtMs),
    );
    return { issue, timeline, prs, deliveredAtMs, unknown: false };
  }

  // No post-baseline merge. Merge evidence that cannot be placed in time, or
  // a timeline whose delivery cannot be resolved, is unknown — never
  // silently dropped, never a highlight.
  const unknown = unresolvableAfterBaseline || timeline.delivery === "unknown";
  return { issue, timeline, prs, deliveredAtMs: null, unknown };
}

/**
 * Whether a child issue is expected to deliver code: the groomer release
 * signal kinds it `feature`/`fix`/`architecture` (implementation intent), or
 * — legacy issues without a signal — its type labels do (`type/feature`,
 * `type/bug`, `type/security`). Contradictory data fails closed: a signal
 * alone is never enough to downgrade implementation labels. Everything else
 * (design/docs/chore/research/unlabeled) may complete by durable closure
 * alone.
 */
function expectsCodeDelivery(issue: ReleasePulseIssueInput): boolean {
  const signal = normalizeStoredReleaseSignal(issue.releaseSignal);
  if (signal && signal.kind !== "internal") return true;
  return legacyKindFromLabels(issue.labels) !== null;
}

/**
 * No reopen observable after the close time; an incomparable pair fails
 * closed. Callers pass the timeline's `lastClosedAt` — the LATEST close
 * evidence, the same ordering the projection's `delivery` uses — so a
 * close→reopen→reclose sequence resolves against the reclose (durable
 * completion), not against the superseded first close.
 */
function reopenedAfterClose(timeline: IssueLifecycleTimeline, closeMs: number | null): boolean {
  const reopenMs = toMillis(timeline.lastReopenAt.at);
  if (reopenMs === null) return false;
  return closeMs === null || reopenMs > closeMs;
}

/**
 * Semantic "feature shipped" delivery: a feature/architecture highlight with
 * notable/major significance. Umbrella milestones and routine/significance-
 * less legacy deliveries are volume evidence, never this.
 */
export function isNotableDelivery(highlight: ReleasePulseHighlight): boolean {
  return (
    (highlight.kind === "feature" || highlight.kind === "architecture") &&
    (highlight.significance === "notable" || highlight.significance === "major")
  );
}

export function buildReleasePulse(
  repo: ReleasePulseRepoInput,
  issues: ReleasePulseIssueInput[],
  events: ReleasePulseEventInput[],
): ReleasePulseSnapshot {
  const baselineMs = toMillis(repo.releaseBaselinePublishedAt);
  if (!isReleasePulseReady(repo) || baselineMs === null) {
    return {
      schema: "dispatch.release-pulse/v1",
      repoFullName: repo.fullName,
      pulseState: repo.releaseState === "no-baseline" ? "no-baseline" : "unknown",
      baseline: null,
      headSha: repo.releaseHeadSha,
      unreleasedCommits: { state: repo.releaseState, count: null },
      deliveredIssueCount: 0,
      highlights: [],
      highlightsTruncated: false,
      notableDeliveryCount: 0,
      completedUmbrellaCount: 0,
      unknownDeliveryCount: 0,
    };
  }

  const eventsByIssue = new Map<number, LifecycleEventRecord[]>();
  for (const event of events) {
    const group = eventsByIssue.get(event.issueNumber) ?? [];
    group.push(event);
    eventsByIssue.set(event.issueNumber, group);
  }

  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const timelineCache = new Map<number, IssueLifecycleTimeline>();
  const timelineFor = (issue: ReleasePulseIssueInput): IssueLifecycleTimeline => {
    const cached = timelineCache.get(issue.number);
    if (cached) return cached;
    const timeline = buildIssueLifecycleTimeline(
      {
        repoFullName: repo.fullName,
        issueNumber: issue.number,
        state: issue.state,
        closedAt: issue.closedAt,
      },
      eventsByIssue.get(issue.number) ?? [],
    );
    timelineCache.set(issue.number, timeline);
    return timeline;
  };

  // Pass 1: merge-delivery resolution per issue.
  const deliveries = new Map<number, IssueDelivery>();
  for (const issue of issues) {
    const timeline = timelineFor(issue);
    deliveries.set(issue.number, resolveDelivery(issue, baselineMs, eventsByIssue.get(issue.number) ?? [], timeline));
  }

  // Pass 2: highlights for merge-delivered issues (one per issue, deduped by
  // issue number later — an umbrella milestone overrides a merge highlight).
  const highlightsByIssue = new Map<number, ReleasePulseHighlight>();
  let deliveredIssueCount = 0;
  let unknownDeliveryCount = 0;
  for (const delivery of deliveries.values()) {
    if (delivery.deliveredAtMs !== null) {
      deliveredIssueCount += 1;
      const signal = normalizeStoredReleaseSignal(delivery.issue.releaseSignal);
      let highlight: ReleasePulseHighlight | null = null;
      if (signal && signal.kind !== "internal") {
        highlight = {
          kind: signal.kind,
          headline: signal.headline,
          issueNumber: delivery.issue.number,
          issueUrl: delivery.issue.url,
          deliveredAt: toIso(delivery.deliveredAtMs),
          significance: signal.significance,
          confidence: "high",
          provenance: "groomer-release-signal",
          prs: delivery.prs,
        };
      } else if (!signal) {
        // LEGACY fallback: no groomer signal — derive a low-confidence kind
        // from type labels. Anything not clearly a feature/fix (type/chore,
        // type/research, no type label) is internal-equivalent: delivered,
        // but no highlight and never the issue title as a semantic headline.
        const legacyKind = legacyKindFromLabels(delivery.issue.labels);
        if (legacyKind) {
          highlight = {
            kind: legacyKind,
            headline: delivery.issue.title,
            issueNumber: delivery.issue.number,
            issueUrl: delivery.issue.url,
            deliveredAt: toIso(delivery.deliveredAtMs),
            significance: null,
            confidence: "low",
            provenance: "legacy-issue-metadata",
            prs: delivery.prs,
          };
        }
      }
      // `signal.kind === "internal"` counts as delivered but highlights nothing.
      if (highlight) highlightsByIssue.set(delivery.issue.number, highlight);
    } else if (delivery.unknown) {
      unknownDeliveryCount += 1;
    }
    // delivery "closed-unmerged" / "open": never shipped, never highlighted.
  }

  // Pass 3: umbrella milestones. Fail closed: any followUpUrl that is
  // unparseable, or an /issues/ reference that does not resolve to a child
  // issue in this repo's input set, blocks the milestone. PR references do
  // not count as child issues (only /issues/ does) and do not block.
  let completedUmbrellaCount = 0;
  for (const issue of issues) {
    if (!issue.decomposed || issue.followUpUrls.length === 0) continue;

    const children: { issue: ReleasePulseIssueInput; url: string }[] = [];
    const seenChildren = new Set<number>();
    let blocked = false;
    for (const url of issue.followUpUrls) {
      const match = url.match(FOLLOW_UP_URL_PATTERN);
      if (!match) {
        blocked = true;
        break;
      }
      const [, owner, name, type, number] = match;
      if (type === "pull") continue;
      const childNumber = Number(number);
      const child =
        `${owner}/${name}`.toLowerCase() === repo.fullName.toLowerCase()
          ? issueByNumber.get(childNumber)
          : undefined;
      // A follow-up pointing at the parent itself is corrupt decomposition
      // data: fail closed rather than let the umbrella complete itself.
      if (!child || childNumber === issue.number) {
        blocked = true;
        break;
      }
      if (seenChildren.has(childNumber)) continue;
      seenChildren.add(childNumber);
      children.push({ issue: child, url: child.url ?? url });
    }
    if (blocked) continue;

    const timeline = timelineFor(issue);
    if (issue.state !== "closed") continue;
    const parentCloseMs = toMillis(timeline.lastClosedAt.at);
    if (parentCloseMs === null || parentCloseMs <= baselineMs) continue;
    if (reopenedAfterClose(timeline, parentCloseMs)) continue;

    // A child is durably complete when it is closed, stays closed (no reopen
    // after its close), and closed no later than the parent. Per #1482 only
    // design/docs children may complete WITHOUT a code merge — a closed
    // implementation child (`feature`/`fix`/`architecture` signal, or legacy
    // `type/feature`/`type/bug`/`type/security` labels) that never merged
    // does not certify the umbrella.
    const childEntries: { number: number; url: string; closedAt: string | null }[] = [];
    let allComplete = true;
    for (const child of children) {
      const childTimeline = timelineFor(child.issue);
      if (child.issue.state !== "closed") {
        allComplete = false;
        break;
      }
      const closureAloneSuffices =
        childTimeline.delivery === "closed-unmerged" && !expectsCodeDelivery(child.issue);
      if (childTimeline.delivery !== "merged" && !closureAloneSuffices) {
        allComplete = false;
        break;
      }
      const childCloseMs = toMillis(childTimeline.lastClosedAt.at);
      if (childCloseMs === null || reopenedAfterClose(childTimeline, childCloseMs) || childCloseMs > parentCloseMs) {
        allComplete = false;
        break;
      }
      childEntries.push({ number: child.issue.number, url: child.url, closedAt: toIso(childCloseMs) });
    }
    if (!allComplete) continue;

    // A parent that ALSO has merge-delivery evidence produces exactly one
    // highlight: the umbrella milestone wins the dedupe by issue number.
    const signal = normalizeStoredReleaseSignal(issue.releaseSignal);
    const headline =
      signal && typeof signal.headline === "string" && signal.headline.length > 0
        ? signal.headline
        : issue.title;
    highlightsByIssue.set(issue.number, {
      kind: "umbrella_completed",
      headline,
      issueNumber: issue.number,
      issueUrl: issue.url,
      deliveredAt: toIso(parentCloseMs),
      significance: null,
      confidence: "high",
      provenance: "lifecycle-decomposition",
      prs: [],
      children: childEntries,
    });
    completedUmbrellaCount += 1;
  }

  const highlights = [...highlightsByIssue.values()].sort((a, b) => {
    const aMs = toMillis(a.deliveredAt) ?? 0;
    const bMs = toMillis(b.deliveredAt) ?? 0;
    return bMs - aMs || a.issueNumber - b.issueNumber;
  });
  const highlightsTruncated = highlights.length > RELEASE_PULSE_MAX_HIGHLIGHTS;
  // Semantic evidence is counted over the FULL set, before the cap slices
  // the exposed list: one PR can deliver several issues, so >cap highlights
  // does NOT imply >=volume commits — the count, not the array, is the
  // decision evidence consumers must read.
  const notableDeliveryCount = highlights.filter(isNotableDelivery).length;

  return {
    schema: "dispatch.release-pulse/v1",
    repoFullName: repo.fullName,
    pulseState: "ready",
    baseline: {
      tag: repo.releaseBaselineTag,
      sha: repo.releaseBaselineSha,
      publishedAt: toIso(baselineMs),
    },
    headSha: repo.releaseHeadSha,
    unreleasedCommits: {
      state: repo.releaseState,
      count: repo.releaseAheadBy ?? (repo.releaseState === "identical" ? 0 : null),
    },
    deliveredIssueCount,
    highlights: highlightsTruncated ? highlights.slice(0, RELEASE_PULSE_MAX_HIGHLIGHTS) : highlights,
    highlightsTruncated,
    notableDeliveryCount,
    completedUmbrellaCount,
    unknownDeliveryCount,
  };
}
