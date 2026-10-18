import { getAgentFromLabels } from "@/types";

/**
 * Durable lifecycle event stream for a work item (#1202).
 *
 * `Issue` holds current state and `AuditLog` holds best-effort per-call
 * history, but neither preserves the claim → release → reclaim sequence a
 * later claim-to-merge read needs: audit rows are per-request, are not
 * deduplicated, and a first claim cannot be told apart from later attempts.
 * `IssueLifecycleEvent` is that record — append-only, ordered by when the
 * transition happened, attributed to the writer that produced it.
 *
 * Three rules the whole codebase depends on:
 *
 * 1. **One contract.** Every status writer (claim, unclaim/stale recovery,
 *    board move, manual status, hosted groomer, reconciler, sync, webhook,
 *    worker report) goes through `recordStatusTransition` /
 *    `recordLifecycleEvent` instead of hand-rolling an event insert, so the
 *    taxonomy, the idempotency rules and the timestamps cannot drift per route.
 * 2. **Events record transitions, not writes.** `recordStatusTransition` is a
 *    no-op when the status label did not change, so a redelivered claim or a
 *    repeated set-status cannot inflate the stream, while a genuine
 *    release → reclaim pair still records both attempts and leaves the first
 *    claim intact.
 * 3. **Observation is never backdated.** A write Dispatch authors records
 *    `occurredAt` = `observedAt` = now. An externally observed event keeps the
 *    source's own occurrence time in `occurredAt` and the wall clock in
 *    `observedAt`. Events are never replayed onto `Issue` state, so a late or
 *    out-of-order delivery cannot move the present status.
 */

export const LIFECYCLE_EVENT_KINDS = [
  /** An agent took ownership of the work item (claim/unclaim pairs bracket it). */
  "claim",
  /** Ownership was given up: unclaim, operator release, or stale recovery. */
  "claim_released",
  /** A worker reported a failed or blocked attempt on this item. */
  "attempt_failed",
  /** The `status/*` label moved. from/to carry the label values. */
  "status_changed",
  /** A worker report closed the item as already done (status/done + close). */
  "completed",
  /** The GitHub issue was observed closing. */
  "issue_closed",
  /** The GitHub issue was observed reopening after a close. */
  "issue_reopened",
  /** A PR that references this item was observed merged. */
  "pr_merged",
] as const;

export type LifecycleEventKind = (typeof LIFECYCLE_EVENT_KINDS)[number];

export const LIFECYCLE_SOURCES = [
  /** POST /api/issues/claim */
  "api:claim",
  /** POST /api/issues/unclaim (agent self-release and operator release) */
  "api:unclaim",
  /** POST /api/issues/move (board drag-and-drop) */
  "api:move",
  /** POST /api/issues/status (agent/operator status set) */
  "api:status",
  /** POST /api/issues/groom (operator grooming decision) */
  "api:groom",
  /** Scheduled stale-AgentWork sweep releasing an abandoned claim. */
  "stale-recovery",
  /** The hosted groomer applying a grooming plan. */
  "hosted-groomer",
  /** POST /api/issues/reconcile reacting to PR state. */
  "reconciler",
  /** Issue sync ingesting GitHub state. */
  "sync",
  /** POST /api/issues/webhook ingesting a GitHub delivery. */
  "webhook",
  /** POST /api/agents/{agent}/tasks/report. */
  "agent-report",
  /** A bounded backfill over already-observed records (#1203). */
  "backfill",
] as const;

export type LifecycleSource = (typeof LIFECYCLE_SOURCES)[number];

/** The single `status/*` label on an issue, or null when it carries none. */
export function lifecycleStatusLabel(labels: readonly string[]): string | null {
  return labels.find((label) => label.startsWith("status/")) ?? null;
}

export interface LifecycleTransition {
  from: string | null;
  to: string | null;
}

/**
 * The status transition between two label sets, or null when the status label
 * is unchanged. Data-quality inputs can carry more than one `status/*` label;
 * the first is treated as the status so an issue with two never reads as a
 * transition on every sync.
 */
export function lifecycleStatusTransition(
  before: readonly string[],
  after: readonly string[],
): LifecycleTransition | null {
  const from = lifecycleStatusLabel(before);
  const to = lifecycleStatusLabel(after);
  if (from === to) return null;
  return { from, to };
}

export interface LifecycleEventWrite {
  issueId: string;
  repoFullName: string;
  issueNumber: number;
  kind: LifecycleEventKind;
  source: LifecycleSource;
  /** The identity responsible: an agent name, an operator actor, or the writer's own name. */
  actor: string;
  agentName?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  /**
   * Identity of the event in the source system (GitHub delivery id, merged-PR
   * identity). Provenance only — never used to deduplicate.
   */
  sourceEventId?: string | null;
  /**
   * Uniqueness identity for an externally observed event. Present, the write
   * is an upsert: redelivery lands on the existing row instead of duplicating
   * it. Absent, the caller has established the write is a real transition.
   */
  dedupeKey?: string | null;
  /** When the transition happened. Defaults to now for Dispatch-authored writes. */
  occurredAt?: Date;
  /** When Dispatch saw it. Defaults to now. */
  observedAt?: Date;
  metadata?: Record<string, unknown> | null;
}

/**
 * The write surface a lifecycle record needs. Both `prisma` and a
 * `Prisma.TransactionClient` satisfy it, so a writer can persist the event in
 * the same transaction as the local state it describes. The argument types are
 * deliberately loose (`any`), the same way the other hand-rolled client
 * interfaces in this codebase accept Prisma's generic method signatures.
 */
export interface LifecycleEventClient {
  issueLifecycleEvent: {
    create(args: any): Promise<unknown>;
    upsert(args: any): Promise<unknown>;
  };
}

/**
 * Build the idempotency identity for an observed event out of stable parts.
 * Every part must come from the source system, never from when Dispatch
 * happened to look, or a repeated observation would not collapse.
 */
export function lifecycleDedupeKey(...parts: Array<string | number | null | undefined>): string {
  return parts.map((part) => (part === null || part === undefined ? "" : String(part))).join("|");
}

/**
 * Persist one lifecycle event. A write carrying a `dedupeKey` is an upsert, so
 * a redelivered webhook or a repeated sync lands on the row that already holds
 * that identity instead of appending a second one — and, because the update is
 * empty, the first observation's timestamps survive redelivery untouched.
 */
export async function recordLifecycleEvent(
  client: LifecycleEventClient,
  write: LifecycleEventWrite,
): Promise<void> {
  const now = new Date();
  const occurredAt = write.occurredAt ?? now;
  const observedAt = write.observedAt ?? now;
  const data: Record<string, unknown> = {
    issueId: write.issueId,
    repoFullName: write.repoFullName,
    issueNumber: write.issueNumber,
    kind: write.kind,
    source: write.source,
    actor: write.actor,
    agentName: write.agentName ?? null,
    fromStatus: write.fromStatus ?? null,
    toStatus: write.toStatus ?? null,
    sourceEventId: write.sourceEventId ?? null,
    occurredAt,
    observedAt,
    metadata: write.metadata ?? undefined,
  };

  if (write.dedupeKey) {
    await client.issueLifecycleEvent.upsert({
      where: { dedupeKey: write.dedupeKey },
      create: { ...data, dedupeKey: write.dedupeKey },
      update: {},
    });
    return;
  }

  await client.issueLifecycleEvent.create({ data });
}

export interface LifecycleStatusTransitionInput {
  issueId: string;
  repoFullName: string;
  issueNumber: number;
  kind: LifecycleEventKind;
  source: LifecycleSource;
  actor: string;
  agentName?: string | null;
  /** Label set before the write. */
  before: readonly string[];
  /** Label set after the write — the same set the writer mirrored locally. */
  after: readonly string[];
  /**
   * The label set Dispatch last mirrored into the cache. A fallback only: it
   * becomes the before-state when `before` no longer shows the change, which
   * is what happens when the GitHub write of a Dispatch-authored change landed
   * but the local transaction that mirrors it and records the evidence rolled
   * back — the live labels already carry the change while the cache still
   * holds the state from before it. Absent, `before` is used exactly as it is
   * today.
   */
  mirroredBefore?: readonly string[] | null;
  sourceEventId?: string | null;
  dedupeKey?: string | null;
  occurredAt?: Date;
  observedAt?: Date;
  metadata?: Record<string, unknown> | null;
}

/**
 * Decide which label set to read a Dispatch-authored change's "before" state
 * from, and describe the change it shows.
 *
 * `observed` is what the writer passed as `before`; `resolve` returns the
 * change it describes, or null when there is none. A mirrored fallback (the
 * cache row the writer last wrote) is consulted only when `observed` no longer
 * shows the change — the shape of a retry after a rolled-back local write,
 * where the GitHub mutation already landed and the live labels therefore read
 * as "already in the after state". Recovering the evidence of the first attempt
 * matters more than the extra write: without it the attempt is lost forever,
 * because nothing downstream can reconstruct a transition the cache no longer
 * shows. A row written this way is marked `recoveredFromMirroredState`.
 */
function resolveBeforeState<T>(
  input: LifecycleStatusTransitionInput,
  resolve: (before: readonly string[], after: readonly string[]) => T | null,
): { before: readonly string[]; recoveredFromMirroredState: boolean; change: T } | null {
  const observed = resolve(input.before, input.after);
  if (observed) {
    return { before: input.before, recoveredFromMirroredState: false, change: observed };
  }

  const mirrored = input.mirroredBefore;
  if (mirrored) {
    const fromMirror = resolve(mirrored, input.after);
    if (fromMirror) {
      return { before: mirrored, recoveredFromMirroredState: true, change: fromMirror };
    }
  }

  return null;
}

/**
 * Persist the status transition implied by a label-set change, or nothing when
 * the status label did not move. Callers pass the exact before/after label
 * sets they wrote, so the guard reflects the write that actually happened
 * rather than a re-read that may have moved underneath them.
 */
export async function recordStatusTransition(
  client: LifecycleEventClient,
  input: LifecycleStatusTransitionInput,
): Promise<boolean> {
  const resolved = resolveBeforeState(input, lifecycleStatusTransition);
  if (!resolved) return false;

  await recordLifecycleEvent(client, {
    issueId: input.issueId,
    repoFullName: input.repoFullName,
    issueNumber: input.issueNumber,
    kind: input.kind,
    source: input.source,
    actor: input.actor,
    agentName: input.agentName ?? null,
    fromStatus: resolved.change.from,
    toStatus: resolved.change.to,
    sourceEventId: input.sourceEventId ?? null,
    dedupeKey: input.dedupeKey ?? null,
    occurredAt: input.occurredAt,
    observedAt: input.observedAt,
    metadata: resolved.recoveredFromMirroredState
      ? { ...input.metadata, recoveredFromMirroredState: true }
      : input.metadata ?? null,
  });
  return true;
}

/**
 * Record a claim.
 *
 * A claim is a status transition *or* an ownership change, and the second case
 * is real: a force-claim that takes an in-progress issue from one agent to
 * another never moves the status label, yet it is a new attempt. Recording
 * only status moves would drop those, and recording on every call would
 * duplicate a redelivered claim of an already-claimed issue — so this fires
 * exactly when the status label moved or the assigned `agent/*` label changed.
 */
export async function recordClaimEvent(
  client: LifecycleEventClient,
  input: LifecycleStatusTransitionInput,
): Promise<boolean> {
  const resolved = resolveBeforeState(input, (before, after) => {
    const transition = lifecycleStatusTransition(before, after);
    const claimedFrom = getAgentFromLabels([...before]);
    const claimedTo = getAgentFromLabels([...after]);
    if (!transition && claimedFrom === claimedTo) return null;
    return { transition, claimedFrom, claimedTo };
  });
  if (!resolved) return false;
  const { transition, claimedFrom, claimedTo } = resolved.change;

  await recordLifecycleEvent(client, {
    issueId: input.issueId,
    repoFullName: input.repoFullName,
    issueNumber: input.issueNumber,
    kind: "claim",
    source: input.source,
    actor: input.actor,
    agentName: input.agentName ?? null,
    fromStatus: lifecycleStatusLabel(resolved.before),
    toStatus: lifecycleStatusLabel(input.after),
    sourceEventId: input.sourceEventId ?? null,
    dedupeKey: input.dedupeKey ?? null,
    occurredAt: input.occurredAt,
    observedAt: input.observedAt,
    metadata: {
      ...input.metadata,
      ...(transition
        ? null
        : { claimedFrom, claimedTo, note: "ownership changed without a status transition" }),
      ...(resolved.recoveredFromMirroredState ? { recoveredFromMirroredState: true } : null),
    },
  });
  return true;
}

/**
 * Record every lifecycle event one sync-visible change implies.
 *
 * Sync mirrors GitHub's state, so it is the last writer to learn about a move
 * made anywhere: on GitHub by a human, by a webhook, or by an agent whose
 * request already left its own event behind. All three are folded into the
 * same shape here:
 *
 * - `occurredAt` is the source's own timestamp (the issue's `updated_at`, or
 *   `closed_at` for a close) — never `now`. The observation time stays in
 *   `observedAt`, so a sync that runs an hour late is visibly late instead of
 *   rewriting when the work happened.
 * - `dedupeKey` is built from that same source timestamp plus the transition
 *   itself, so re-running the sync over unchanged GitHub state upserts the
 *   rows that already exist instead of adding a second copy. A genuine second
 *   move has a different `updated_at` and therefore a different key.
 * - Nothing here writes back to `Issue`. The events are evidence, so a late or
 *   out-of-order sync can be recorded without ever moving the present status.
 *
 * A failed event write propagates. Callers record before mirroring the change
 * into the cache, so a throw defers that issue's mirror to the next run —
 * where the same transition is re-derived from the same before-state and lands
 * on the same dedupe key — instead of leaving a cache that shows a change the
 * stream has no record of.
 */
export async function recordSyncedIssueEvents(
  client: LifecycleEventClient,
  input: {
    issueId: string;
    repoFullName: string;
    issueNumber: number;
    before: { labels: readonly string[]; state: string | null };
    after: { labels: readonly string[]; state: string; updatedAt?: Date | null; closedAt?: Date | null };
    actor?: string;
  },
): Promise<void> {
  const actor = input.actor ?? "github";
  const identity = lifecycleDedupeKey(input.repoFullName, input.issueNumber);
  const observedAt = new Date();
  const transition = lifecycleStatusTransition(input.before.labels, input.after.labels);
  const occurredAt = input.after.updatedAt ?? undefined;

  const writes: LifecycleEventWrite[] = [];

  if (transition) {
    writes.push({
      issueId: input.issueId,
      repoFullName: input.repoFullName,
      issueNumber: input.issueNumber,
      kind: "status_changed",
      source: "sync",
      actor,
      fromStatus: transition.from,
      toStatus: transition.to,
      dedupeKey: lifecycleDedupeKey(
        "sync",
        identity,
        "status_changed",
        transition.from,
        transition.to,
        occurredAt?.toISOString(),
      ),
      occurredAt,
      observedAt,
      metadata: { observedVia: "issue sync", occurredAtSource: occurredAt ? "issue.updated_at" : null },
    });
  }

  // A close and a reopen are distinct from the status label moving to
  // status/done: the label says where the card sits, the state says whether
  // GitHub considers the work finished. Both are recorded so a reader can
  // tell an abandoned card from a finished one.
  if (input.before.state !== "closed" && input.after.state === "closed") {
    writes.push({
      issueId: input.issueId,
      repoFullName: input.repoFullName,
      issueNumber: input.issueNumber,
      kind: "issue_closed",
      source: "sync",
      actor,
      toStatus: lifecycleStatusLabel(input.after.labels),
      dedupeKey: lifecycleDedupeKey(
        "sync",
        identity,
        "issue_closed",
        input.after.closedAt?.toISOString() ?? occurredAt?.toISOString(),
      ),
      occurredAt: input.after.closedAt ?? occurredAt,
      observedAt,
      metadata: { observedVia: "issue sync" },
    });
  }

  if (input.before.state === "closed" && input.after.state !== "closed") {
    writes.push({
      issueId: input.issueId,
      repoFullName: input.repoFullName,
      issueNumber: input.issueNumber,
      kind: "issue_reopened",
      source: "sync",
      actor,
      fromStatus: lifecycleStatusLabel(input.before.labels),
      toStatus: lifecycleStatusLabel(input.after.labels),
      dedupeKey: lifecycleDedupeKey("sync", identity, "issue_reopened", occurredAt?.toISOString()),
      occurredAt,
      observedAt,
      metadata: { observedVia: "issue sync" },
    });
  }

  for (const write of writes) {
    await recordLifecycleEvent(client, write);
  }
}

/**
 * Record an event without letting a lifecycle failure abort the writer.
 *
 * For the sources whose job is the local mirror rather than the event
 * (webhook, reconciler, worker report, hosted groomer) those paths are periodic
 * and retried, so a failed event must cost a log line rather than the whole
 * run. Dispatch-authored writes share a transaction with the state they
 * describe and deliberately fail together instead (see the route callers).
 */
export async function recordLifecycleEventQuietly(
  client: LifecycleEventClient,
  write: LifecycleEventWrite,
  context: string,
): Promise<void> {
  try {
    await recordLifecycleEvent(client, write);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `lifecycle event ${write.kind} for ${write.repoFullName}#${write.issueNumber} was not recorded (${context}): ${message}`,
    );
  }
}

/**
 * `recordStatusTransition` with the same guarantee as above, for a writer that
 * goes through the transition guard but still must not fail over its evidence
 * row (the hosted groomer, whose mutations have already landed by then).
 * Returns whether the transition was recorded.
 */
export async function recordStatusTransitionQuietly(
  client: LifecycleEventClient,
  input: LifecycleStatusTransitionInput,
  context: string,
): Promise<boolean> {
  try {
    return await recordStatusTransition(client, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `lifecycle event ${input.kind} for ${input.repoFullName}#${input.issueNumber} was not recorded (${context}): ${message}`,
    );
    return false;
  }
}

/**
 * One merge of one PR, as observed from an authoritative source. Never build
 * this from a worker's success report: a merge is only ever evidence that
 * GitHub says the PR merged (`mergedAt`), correlated to the issue through an
 * explicit link (`linkSource`), never inferred from a PR title.
 */
export interface PrMergeObservation {
  prNumber: number;
  prUrl?: string | null;
  /** GitHub's own merge time. Required — a merge without a time is "unknown". */
  mergedAt?: Date | string | null;
  mergeCommitSha?: string | null;
  headSha?: string | null;
  /**
   * How the PR is correlated to the issue: `body-keyword` (Fixes/Closes
   * keyword in the PR body), `closing-issues-references` (GitHub's own
   * link graph), `agent-run-touch` (a worker run record naming this PR), or
   * `branch-name` (weakest — kept only so reconcile's existing close
   * heuristic stays auditable). Title matches are never a link source.
   */
  linkSource?: string | null;
}

/**
 * Canonical idempotency identity for "PR <n> merged into <repo>, closing /
 * referenced by issue <n>".
 *
 * The `reconciler` prefix is historical (it is the writer that introduced the
 * key) and deliberately shared by every merge observer — reconcile, sync, and
 * the bounded backfill — so the same physical merge observed twice lands on
 * one row instead of one row per observer. A merge without a timestamp keys on
 * the literal `unknown`, matching the pre-existing reconcile rows.
 */
export function prMergedDedupeKey(
  repoFullName: string,
  issueNumber: number,
  prNumber: number,
  mergedAt?: Date | string | null,
): string {
  return lifecycleDedupeKey(
    "reconciler",
    repoFullName,
    issueNumber,
    "pr_merged",
    prNumber,
    prMergeStamp(mergedAt),
  );
}

/**
 * Canonical stamp text for a merge identity. GitHub emits second-precision
 * `Z` timestamps and the pre-#1203 reconcile keyed on that raw string, so a
 * `Date` (which `toISOString` renders with `.000Z`) and the string form of the
 * same instant must produce the same stamp — otherwise the backfill and a
 * later reconcile would land on different keys for one physical merge. An
 * unparseable non-null value keeps its raw text as identity: it is garbage
 * input, but it must stay stable across observers.
 */
export function prMergeStamp(mergedAt?: Date | string | null): string {
  if (mergedAt === null || mergedAt === undefined) return "unknown";
  const iso = prMergeTimestamp(mergedAt);
  if (iso === null) return String(mergedAt);
  return iso.replace(/\.000Z$/, "Z");
}

/** Normalize an observation's merge time to the ISO string stored in metadata. */
export function prMergeTimestamp(mergedAt?: Date | string | null): string | null {
  if (mergedAt === null || mergedAt === undefined) return null;
  const date = mergedAt instanceof Date ? mergedAt : new Date(mergedAt);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Record `pr_merged` for one observed merge of one PR on one issue. This is
 * the single write path for merge evidence (#1203): every observer calls it so
 * the dedupe identity and the metadata shape (PR number/url, authoritative
 * merge time, head and merge commit shas, link provenance) cannot drift per
 * route. Multiple linked PRs record one row each; a redelivered observation of
 * the same PR at the same merge time upserts onto the existing row.
 */
export async function recordPrMergedEvent(
  client: LifecycleEventClient,
  input: {
    issueId: string;
    repoFullName: string;
    issueNumber: number;
    source: LifecycleSource;
    actor: string;
    pr: PrMergeObservation;
    fromStatus?: string | null;
    toStatus?: string | null;
    extraMetadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  const mergedAtIso = prMergeTimestamp(input.pr.mergedAt);
  const metadata: Record<string, unknown> = {
    pullRequestNumber: input.pr.prNumber,
    ...(input.pr.prUrl ? { pullRequestUrl: input.pr.prUrl } : null),
    ...(mergedAtIso ? { mergedAt: mergedAtIso } : null),
    // A present-but-unparseable source stamp stays visible as provenance even
    // though it cannot become the event time — no silent provenance drop.
    ...(input.pr.mergedAt !== null && input.pr.mergedAt !== undefined && mergedAtIso === null
      ? { mergedAtRaw: String(input.pr.mergedAt) }
      : null),
    ...(input.pr.mergeCommitSha ? { mergeCommitSha: input.pr.mergeCommitSha } : null),
    ...(input.pr.headSha ? { headSha: input.pr.headSha } : null),
    ...(input.pr.linkSource ? { linkSource: input.pr.linkSource } : null),
    ...input.extraMetadata,
  };

  await recordLifecycleEvent(client, {
    issueId: input.issueId,
    repoFullName: input.repoFullName,
    issueNumber: input.issueNumber,
    kind: "pr_merged",
    source: input.source,
    actor: input.actor,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    sourceEventId: `pr-${input.pr.prNumber}`,
    dedupeKey: prMergedDedupeKey(input.repoFullName, input.issueNumber, input.pr.prNumber, input.pr.mergedAt),
    occurredAt: mergedAtIso ? new Date(mergedAtIso) : undefined,
    metadata,
  });
}
