// ─── Bounded ownership reconciliation (#1254) ────────────────────────────────
//
// Implements the §8 reconciliation of docs/ownership-reconciliation.md on top
// of the #1251 evidence model (`deriveOwnershipState`, optional worker
// capability) and #1259's `IssueMutationGuard` / `Lease.claimToken` machinery —
// no parallel lock or lease (§11).
//
// Rules this module owns:
//
// 1. **Default-off.** `DISPATCH_OWNERSHIP_RECONCILE_MODE` is `off` unless the
//    operator opts into `audit` (annotate only — no forge writes, no release
//    mutations, persisted candidate state read-only) or `enforce` (release
//    confirmed-abandoned claims through the
//    §8.7 protocol). Missing telemetry is never abandonment: a release only
//    follows the §8.2 confirmation ladder (sustained stale observations) or
//    positive terminal-disposition evidence, and a bounded reclaim counter
//    parks a flapping claim as needs-human instead of churning it.
// 2. **Two-sided boundary (§8.7).** The remote `agent/*` label write cannot be
//    fenced — GitHub's label API has no conditional mutation — so every
//    automation side commits a Postgres intent under the per-issue
//    `IssueMutationGuard` anchor before touching the forge:
//    - the reconciler's release intent (`OwnershipReleaseIntent`) is committed
//      in Phase A (CAS-fenced on the claim epoch, token retired) and holds the
//      claim path (409) until the Phase C settle clears it;
//    - the claim path's intent is the `Lease` row itself (its `claimToken` is
//      the attempt token), committed before the remote add.
//    Phase B is the only remote mutation of a release, and it runs only while
//    a matching pending intent exists — never speculatively, never for a label
//    an intent does not name. The three deliberate intent-free writers (the
//    owning agent's unclaim, the maintainer force-claim, direct assign) stay
//    exempt, but when they coincide with a pending intent they supersede it
//    (audited) rather than race it — `supersedeOwnershipReleaseIntent`.
// 3. **Fail closed.** A forge read failure skips the candidate without
//    advancing the ladder; a forge write failure leaves the intent pending for
//    bounded replay, then parks it for the operator (§8.7 fail-closed). A
//    guard left `executing` by a crashed process stays fail-closed exactly
//    like every other guard operation — operator-visible, never silently
//    stolen.
// 4. **Bounded.** One pass examines at most `DISPATCH_RECONCILE_BATCH_SIZE`
//    candidates; per-item failures are reported, never fatal to the batch.

import { AGENT_PREFIX } from "@/types";
import { prisma } from "@/lib/prisma";
import { getLiveIssueLabels } from "@/lib/claim-gate";
import { removeIssueLabel } from "@/lib/github";
import { withIssueMutationGuard } from "@/lib/issue-mutation-guard";
import { transitionIssueStatus } from "@/lib/issue-status";
import {
  lifecycleDedupeKey,
  recordLifecycleEvent,
  lifecycleStatusLabel,
} from "@/lib/issue-lifecycle";
import {
  CURRENT_CLAIM_WORK_ORDER_BY,
  ownershipActiveWindowMs,
  ownershipLongRunGraceMs,
} from "@/lib/worker-ownership";
import {
  deriveOwnershipState,
  type OwnershipAgentWorkEvidence,
  type OwnershipEvidence,
  type OwnershipLeaseEvidence,
} from "@/lib/ownership-state";

// ─── Configuration (§8.3: windows are configuration, not code constants) ─────

const MIN_WINDOW_MS = 60_000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

function readWindowEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  const value = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  return Math.min(Math.max(value, min), max);
}

export type OwnershipReconcileMode = "off" | "audit" | "enforce";

const RECONCILE_MODES: ReadonlySet<string> = new Set(["off", "audit", "enforce"]);

/** off (default — no automatic release) / audit (annotate only) / enforce. */
export function ownershipReconcileMode(): OwnershipReconcileMode {
  const raw = (process.env.DISPATCH_OWNERSHIP_RECONCILE_MODE ?? "").trim().toLowerCase();
  return RECONCILE_MODES.has(raw) ? (raw as OwnershipReconcileMode) : "off";
}

/** Per-claim reclaim counter cap (§8.2 item 4). Default 3. */
export function reconcileMaxReclaims(): number {
  return readWindowEnv("DISPATCH_RECONCILE_MAX_RECLAIMS", 3, 1, 10);
}

/** Candidates examined per pass (the per-run/page quota, §8.1). Default 25. */
export function reconcileBatchSize(): number {
  return readWindowEnv("DISPATCH_RECONCILE_BATCH_SIZE", 25, 1, 200);
}

/** Separation between the two confirmation observations. Default 5m (one tick). */
export function reconcileRecheckIntervalMs(): number {
  return readWindowEnv("DISPATCH_RECONCILE_RECHECK_INTERVAL_MS", 5 * 60 * 1000, MIN_WINDOW_MS, MAX_WINDOW_MS);
}

/** Minimum spacing between release attempts on the same claim. Default = recheck. */
export function reconcileReclaimCooldownMs(): number {
  const rawEnv = process.env.DISPATCH_RECONCILE_RECLAIM_COOLDOWN_MS;
  // Number("") is 0, not NaN — an unset/blank variable must fall back.
  const raw = rawEnv === undefined || rawEnv.trim() === "" ? Number.NaN : Number(rawEnv);
  if (!Number.isFinite(raw) || raw < 0) return reconcileRecheckIntervalMs();
  return Math.min(raw, MAX_WINDOW_MS);
}

/** Bounded Phase-B forge retries before the intent is parked (§8.7). Default 5. */
export function reconcileMaxForgeRetries(): number {
  return readWindowEnv("DISPATCH_RECONCILE_MAX_FORGE_RETRIES", 5, 1, 20);
}

// ─── Client shapes (narrow, stale-work style) ────────────────────────────────

export interface OwnershipReconcileForge {
  getLiveIssueLabels(repoFullName: string, issueNumber: number): Promise<string[]>;
  removeIssueLabel(repoFullName: string, issueNumber: number, label: string): Promise<void>;
}

interface LifecycleEventStore {
  create: (args: any) => Promise<unknown>;
  upsert: (args: any) => Promise<unknown>;
}

export interface OwnershipReconcileTransactionClient {
  issue: {
    update: (args: any) => Promise<any>;
    findUnique: (args: any) => Promise<any>;
  };
  prFixQueueItem: {
    findFirst: (args: any) => Promise<any>;
  };
  lease: {
    findFirst: (args: any) => Promise<any>;
    updateMany: (args: any) => Promise<{ count: number }>;
    deleteMany: (args: any) => Promise<{ count: number }>;
  };
  agentWork: {
    findFirst: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  agentWorkHistory: {
    create: (args: any) => Promise<unknown>;
  };
  ownershipReleaseIntent: {
    findUnique: (args: any) => Promise<any>;
    findFirst: (args: any) => Promise<any>;
    create: (args: any) => Promise<unknown>;
    updateMany: (args: any) => Promise<{ count: number }>;
    deleteMany: (args: any) => Promise<{ count: number }>;
  };
  ownershipReconcileCandidate: {
    update: (args: any) => Promise<any>;
    upsert: (args: any) => Promise<any>;
    deleteMany: (args: any) => Promise<{ count: number }>;
  };
  auditLog: {
    create: (args: any) => Promise<unknown>;
  };
  issueLifecycleEvent: LifecycleEventStore;
}

export interface OwnershipReconcileClient {
  issue: {
    findMany: (args: any) => Promise<any[]>;
    findUnique: (args: any) => Promise<any>;
  } & OwnershipReconcileTransactionClient["issue"];
  lease: {
    findMany: (args: any) => Promise<any[]>;
    findUnique: (args: any) => Promise<any>;
  } & OwnershipReconcileTransactionClient["lease"];
  agentWork: {
    findMany: (args: any) => Promise<any[]>;
  } & OwnershipReconcileTransactionClient["agentWork"];
  agentWorkHistory: OwnershipReconcileTransactionClient["agentWorkHistory"];
  ownershipReleaseIntent: {
    findMany: (args: any) => Promise<any[]>;
  } & OwnershipReconcileTransactionClient["ownershipReleaseIntent"];
  ownershipReconcileCandidate: {
    findMany: (args: any) => Promise<any[]>;
    findUnique: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
    upsert: (args: any) => Promise<any>;
    deleteMany: (args: any) => Promise<{ count: number }>;
  };
  prFixQueueItem: {
    findFirst: (args: any) => Promise<any>;
  };
  auditLog: OwnershipReconcileTransactionClient["auditLog"];
  issueLifecycleEvent: LifecycleEventStore;
  $transaction: <T>(fn: (tx: OwnershipReconcileTransactionClient) => Promise<T>) => Promise<T>;
}

// ─── Shared constants ────────────────────────────────────────────────────────

const ACTIVE_AGENT_WORK_STATES = ["CLAIMED", "IN_PROGRESS", "BLOCKED"] as const;
/** Terminal dispositions: positive evidence the owner is gone (§5 tier 3). */
const TERMINAL_DISPOSITIONS = ["completed", "released", "handed_off"] as const;

/** The PR-fix queue states that represent work still in flight. */
const OPEN_PR_FIX_STATES = ["QUEUED", "BLOCKED", "PARKED", "WAITING_EXTERNAL"] as const;

const BLOCKED_LABEL = "status/blocked";
const IN_REVIEW_LABEL = "status/in-review";
const MERGED_PR_STATE = "merged";

// ─── Report ──────────────────────────────────────────────────────────────────

export interface OwnershipReconcileReport {
  mode: OwnershipReconcileMode;
  examined: number;
  /** Phase C settled (fresh release or replay). */
  released: number;
  /** Ladder not yet complete, renewed mid-ladder, cooldown, forge-unverifiable. */
  retained: number;
  /** Reclaim limit reached → needs-human park (no release). */
  held: number;
  /** Superseded intents cleared on replay (the exempt path won). */
  superseded: number;
  /** Pending intents progressed by the replay (B retried, or B+C completed). */
  replayed: number;
  /** Intents parked after bounded Phase-B forge failures (operator-only). */
  parked: number;
  /** Busy guard, epoch moved, forge read failure, etc. */
  skipped: number;
  errors: string[];
}

function emptyReport(mode: OwnershipReconcileMode): OwnershipReconcileReport {
  return {
    mode,
    examined: 0,
    released: 0,
    retained: 0,
    held: 0,
    superseded: 0,
    replayed: 0,
    parked: 0,
    skipped: 0,
    errors: [],
  };
}

// ─── §8.5 release selection (never force `ready` blindly) ────────────────────

/**
 * The next status after a reconciled release, mirroring `releaseIssueClaim`'s
 * resting-status policy (§8.5): an unexplained in-progress or an unexplained
 * blocked returns to ready, a deliberate block and an in-review issue keep
 * their status, and anything else is left for the board/sync path. Returning
 * null means "no status change".
 */
export function selectNextStatusAfterRelease(
  labels: readonly string[],
  blockedReason?: string | null,
): string | null {
  if (labels.includes("status/in-progress")) return "status/ready";
  if (labels.includes("status/blocked")) {
    return (blockedReason ?? "").trim().length > 0 ? null : "status/ready";
  }
  return null;
}

// ─── Audit helper ────────────────────────────────────────────────────────────

interface AuditIssueRef {
  id: string;
  number: number;
  repository: { fullName: string };
}

async function auditReconcileEvent(
  client: Pick<OwnershipReconcileTransactionClient, "auditLog">,
  input: {
    action: string;
    issue?: AuditIssueRef | null;
    issueId?: string;
    beforeLabels?: string[];
    afterLabels?: string[];
    success?: boolean;
    errorMessage?: string;
    notes?: string;
  },
): Promise<void> {
  await client.auditLog.create({
    data: {
      actor: "reconciler",
      action: input.action,
      repoFullName: input.issue?.repository.fullName ?? "",
      issueNumber: input.issue?.number,
      issueId: input.issue?.id ?? input.issueId,
      beforeLabels: input.beforeLabels ?? [],
      afterLabels: input.afterLabels ?? [],
      success: input.success ?? true,
      errorMessage: input.errorMessage,
      notes: input.notes,
    },
  });
}

// ─── Supersede (§8.7 exemptions) ─────────────────────────────────────────────

/**
 * An explicit operator/pipeline decision (owner unclaim, maintainer
 * force-claim, direct assign) supersedes a pending reconciler release intent
 * instead of racing it: the intent is marked `superseded` (audited) and the
 * explicit path's own idempotent label writes then converge the state. The
 * reconciler's replay deletes superseded intents without any forge call, so a
 * new owner's label is never a delete target.
 */
export async function supersedeOwnershipReleaseIntent(input: {
  issueId: string;
  actor: string;
  reason: string;
  prisma?: OwnershipReconcileClient;
}): Promise<boolean> {
  const client = input.prisma ?? (prisma as unknown as OwnershipReconcileClient);
  return client.$transaction(async (tx) => {
    const intent = await tx.ownershipReleaseIntent.findFirst({
      where: { issueId: input.issueId, phase: "pending" },
    });
    if (!intent) return false;
    const updated = await tx.ownershipReleaseIntent.updateMany({
      where: { id: intent.id, phase: "pending" },
      data: { phase: "superseded" },
    });
    if (updated.count !== 1) return false;
    await auditReconcileEvent(tx, {
      action: "ownership_release_intent_superseded",
      issueId: input.issueId,
      notes: `intent ${intent.id} (${intent.agentLabel}) superseded by ${input.actor}: ${input.reason}`,
    });
    return true;
  });
}

// ─── Phase helpers ───────────────────────────────────────────────────────────

/** Thrown inside a Phase A transaction so an aborted CAS rolls everything back. */
class EpochMovedError extends Error {
  constructor() {
    super("claim epoch moved; release aborted");
    this.name = "EpochMovedError";
  }
}

interface ReleaseOutcome {
  kind: "released" | "skipped" | "parked" | "error";
  error?: string;
}

/**
 * §8.5 next-status application for a settled release. The decision base is the
 * LIVE label set read fresh from the forge (#1037 — decisions are made against
 * what GitHub currently has, not the Prisma cache): the cache snapshot can be
 * behind GitHub, and transitionIssueStatus removes only the status labels it
 * believes exist. Runs AFTER the intent is cleared and the barrier lifted:
 * status labels are disjoint from the `agent/*` label the release deleted, so
 * this write cannot collide with Phase B, and any claim that lands afterwards
 * re-evaluates the settled state.
 */
async function applyNextStatus(
  deps: ResolvedDeps,
  issue: AuditIssueRef,
  now: Date,
): Promise<{ labels: string[]; error?: string }> {
  let liveLabels: string[];
  try {
    liveLabels = await deps.forge.getLiveIssueLabels(issue.repository.fullName, issue.number);
  } catch (error) {
    return {
      labels: [],
      error: `post-release status selection skipped: live label read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const { blockedReason } = await deps.prisma.issue.findUnique({
    where: { id: issue.id },
    select: { blockedReason: true },
  }) ?? { blockedReason: null };
  const target = selectNextStatusAfterRelease(liveLabels, blockedReason);
  const current = liveLabels.find((l) => l.startsWith("status/")) ?? null;
  if (!target || target === current) return { labels: [...liveLabels] };
  try {
    const updated = await transitionIssueStatus(
      issue.repository.fullName,
      issue.number,
      liveLabels,
      target,
    );
    return { labels: updated };
  } catch (error) {
    return {
      labels: [...liveLabels],
      error: `post-release status transition failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** A pending intent the release protocol drives. */
interface ReleaseIntentRef {
  id: string;
  issueId: string;
  agentName: string;
  agentLabel: string;
  attemptToken: string | null;
}

/**
 * Phase B → C (forge write + settle), shared by the fresh release and the
 * replay. The whole segment runs inside one guard window: the intent re-check
 * and any supersede are serialized by the anchor, so the delete can never land
 * behind a superseding explicit write that re-added the label.
 *
 * The intent is resolved by `(issueId, agentLabel)` inside the guard — never
 * from a stale caller-side id — so a superseded intent (zero forge calls, per
 * the crash/replay matrix) and a parked intent are both handled on current
 * state.
 */
async function driveReleaseIntent(
  deps: ResolvedDeps,
  intent: ReleaseIntentRef,
  issue: (AuditIssueRef & { labels: string[]; blockedReason: string | null }) | null,
  now: Date,
): Promise<ReleaseOutcome> {
  const { prisma: client, forge, guard } = deps;
  const maxRetries = reconcileMaxForgeRetries();

  const guarded = await guard(
    { issueId: intent.issueId, operation: "reconcile-release", agentName: intent.agentName },
    async (_tx, { stillHoldsGuard }): Promise<{ complete: boolean; value: ReleaseOutcome }> => {
      try {
        // #1254 acceptance ("re-check … at commit time") extended to the
        // replay entry: the same hold/review/external-wait re-check runs
        // directly before the remote delete. A maintainer hold or review
        // ownership that landed while the intent was pending (after its
        // Phase A commit) withholds Phase B and the intent stays pending
        // (fail closed, retried next pass; the exempt operator paths
        // supersede it). It runs BEFORE the attempt bump: a withheld pass
        // is not a forge failure and must not consume the bounded retry
        // budget (a long human hold would otherwise park the intent and
        // wedge the claim barrier past the hold's own lifetime). The
        // pending-intent authorization itself is still re-checked inside
        // the bump transaction below, which is what gates the delete.
        if (issue) {
          let replayLiveLabels: string[];
          try {
            replayLiveLabels = await forge.getLiveIssueLabels(issue.repository.fullName, issue.number);
          } catch (error) {
            return {
              complete: true,
              value: {
                kind: "skipped",
                error: `forge read failed before Phase B: ${error instanceof Error ? error.message : String(error)}`,
              },
            };
          }
          const withheld = await releaseWithheldAtCommitTime(
            client,
            {
              issue: { id: issue.id, number: issue.number, repository: issue.repository },
              agentLabel: intent.agentLabel,
              hasLeaseEpoch: intent.attemptToken != null,
            },
            replayLiveLabels,
            now,
          );
          if (withheld) {
            return { complete: true, value: { kind: "skipped", error: `release withheld before Phase B: ${withheld}` } };
          }
        }

        // Re-check + attempt bump, one transaction: the pending intent is the
        // only thing authorizing this remote delete. A superseded or settled
        // intent names nothing — zero forge calls (crash-matrix row 4). The
        // attempt token is re-checked too (§8.7 Phase C wording).
        const checked = await client.$transaction(async (tx) => {
          const current = await tx.ownershipReleaseIntent.findUnique({
            where: { issueId_agentLabel: { issueId: intent.issueId, agentLabel: intent.agentLabel } },
          });
          if (!current || current.phase !== "pending") return { proceed: false as const };
          if (intent.attemptToken != null && current.attemptToken !== intent.attemptToken) {
            return { proceed: false as const };
          }
          if (current.parkedAt != null) return { proceed: false as const };
          if ((current.attempts ?? 0) >= maxRetries) {
            await tx.ownershipReleaseIntent.updateMany({
              where: { id: current.id, phase: "pending", parkedAt: null },
              data: { parkedAt: now },
            });
            return { proceed: false as const, parked: true as const };
          }
          await tx.ownershipReleaseIntent.updateMany({
            where: { id: current.id, phase: "pending" },
            data: { attempts: { increment: 1 } },
          });
          return { proceed: true as const, intentId: current.id as string };
        });

        if (!checked.proceed) {
          if ("parked" in checked && checked.parked) {
            await auditReconcileEvent(client, {
              action: "ownership_reconcile_intent_parked",
              issueId: intent.issueId,
              notes: `release intent for ${intent.agentLabel} parked after ${maxRetries} forge failures; operator release required`,
            });
            return { complete: true, value: { kind: "parked" } };
          }
          return { complete: true, value: { kind: "skipped" } };
        }

        if (!issue) {
          return { complete: true, value: { kind: "error", error: "settle skipped: issue row missing" } };
        }

        // #1254: anchor tripwire immediately before the ONLY remote write.
        // The intent re-check above authorizes the delete; this re-check proves
        // this holder still owns the guard it runs under, so a maintainer
        // override that cleared a silent reconcile-release guard cannot be
        // followed by a stale forge delete from the abandoned attempt.
        if (!(await stillHoldsGuard())) {
          return {
            complete: true,
            value: { kind: "skipped", error: "release skipped: mutation guard no longer held (superseded before Phase B)" },
          };
        }

        // Phase B — the ONLY remote mutation of a release. Targeted delete of
        // exactly the label the intent names. The forge adapter already
        // swallows 404s, so ANY error here is a real failure: fail closed and
        // leave the intent pending for the next pass (§10 "forge outage").
        try {
          await forge.removeIssueLabel(issue.repository.fullName, issue.number, intent.agentLabel);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { complete: true, value: { kind: "error", error: `forge delete failed: ${message}` } };
        }

        // Phase C — settle (Postgres only). The pending intent exists is the
        // idempotency key, so a double-settle cannot happen. The lease state
        // is re-checked here: a lease that still carries its live token, or a
        // fresh lease behind a token-less intent, means a NEW claim owns the
        // issue — never settle over it.
        let alreadyReleasedElsewhere = false;
        try {
          const settled = await client.$transaction(async (tx) => {
            const current = await tx.ownershipReleaseIntent.findUnique({
              where: { issueId_agentLabel: { issueId: intent.issueId, agentLabel: intent.agentLabel } },
            });
            if (!current || current.phase !== "pending" || current.agentLabel !== intent.agentLabel) {
              return false;
            }
            if (intent.attemptToken != null && current.attemptToken !== intent.attemptToken) {
              return false;
            }
            const lease = await tx.lease.findFirst({
              where: { agentName: intent.agentName, issueId: intent.issueId },
            });
            if (lease) {
              if (intent.attemptToken != null) {
                // The Phase A commit retired this token (claimToken → null). A
                // lease still carrying the attempt token means Phase A never
                // fenced this epoch — do not settle.
                if (lease.claimToken === intent.attemptToken) return false;
              } else {
                // Intent-only release: a lease appearing after the decision is
                // a fresh claim — never destroy it (§8.7 fail-closed).
                return false;
              }
            } else if (intent.attemptToken != null) {
              // No lease at all: another writer (operator release, stale-work
              // sweep) already released this claim. Clear the intent without
              // a second settle — no double lifecycle event, no status move.
              alreadyReleasedElsewhere = true;
              await tx.ownershipReleaseIntent.deleteMany({ where: { id: current.id, phase: "pending" } });
              return true;
            }

            await tx.ownershipReleaseIntent.deleteMany({ where: { id: current.id, phase: "pending" } });

            // Finalize the release locally (§8.7 Phase C): retire the lease
            // row (the token was retired at Phase A), settle the current
            // claim AgentWork, mirror the cache, record the lifecycle event
            // — all one fact — and drop the ladder row (the claim is gone).
            await tx.lease.deleteMany({ where: { agentName: intent.agentName, issueId: intent.issueId } });

            const work = await tx.agentWork.findFirst({
              where: {
                agentName: intent.agentName,
                issueId: intent.issueId,
                state: { in: [...ACTIVE_AGENT_WORK_STATES] },
              },
              orderBy: CURRENT_CLAIM_WORK_ORDER_BY,
            });
            if (work) {
              await tx.agentWork.update({
                where: { id: work.id },
                data: { state: "RELEASED", leaseExpiresAt: now },
              });
              await tx.agentWorkHistory.create({
                data: {
                  workId: work.id,
                  action: "ownership_reconciled",
                  state: "RELEASED",
                  summary: "released by the ownership reconciler (#1254)",
                },
              });
            }

            const labelsAfter = issue.labels.filter((l) => l !== intent.agentLabel);
            await tx.issue.update({
              where: { id: issue.id },
              data: { labels: labelsAfter, lastSyncedAt: now },
            });
            // Reset the ladder row but KEEP the reclaim counter and cooldown:
            // release/reclaim churn across claim epochs must stay bounded
            // (§8.2 item 4). Upsert: the bounded cleanup may legitimately have
            // removed a zero-history row mid-release, and a missing row must
            // never fail the settle (the old deleteMany never threw). The
            // "healthy claim" branch deletes the row outright.
            await tx.ownershipReconcileCandidate.upsert({
              where: { issueId: intent.issueId },
              create: {
                issueId: intent.issueId,
                agentName: intent.agentName,
                staleCount: 0,
                reclaimCount: 1,
                lastReclaimAt: now,
              },
              update: { agentName: intent.agentName, staleCount: 0, firstStaleAt: null, lastObservedAt: null },
            });
            await recordLifecycleEvent(
              { issueLifecycleEvent: tx.issueLifecycleEvent },
              {
                issueId: issue.id,
                repoFullName: issue.repository.fullName,
                issueNumber: issue.number,
                kind: "claim_released",
                source: "ownership-reconcile",
                actor: "reconciler",
                agentName: intent.agentName,
                fromStatus: lifecycleStatusLabel(issue.labels),
                toStatus: lifecycleStatusLabel(labelsAfter),
                dedupeKey: lifecycleDedupeKey("claim-released", issue.id, intent.agentLabel, current.id),
              },
            );
            return true;
          });

          if (!settled) return { complete: true, value: { kind: "skipped" } };
          if (alreadyReleasedElsewhere) {
            // Mirror the cache to the label-free state (the forge delete was a
            // no-op — the label was already gone) but record nothing else.
            const labelsAfter = issue.labels.filter((l) => l !== intent.agentLabel);
            try {
              await client.issue.update({
                where: { id: issue.id },
                data: { labels: labelsAfter, lastSyncedAt: now },
              });
            } catch {
              // Best effort; the report still counts the intent as handled.
            }
            return { complete: true, value: { kind: "skipped" } };
          }

          // §8.5 next-status selection, after the barrier lifted with the
          // settle commit — computed against the LIVE label set (#1037), not
          // the cache snapshot. Status labels are disjoint from the agent/*
          // label Phase B deleted, so this write cannot collide with it.
          const statusResult = await applyNextStatus(deps, issue, now);
          if (!statusResult.error) {
            try {
              await client.issue.update({
                where: { id: issue.id },
                data: { labels: statusResult.labels, lastSyncedAt: now },
              });
            } catch (error) {
              return {
                complete: true,
                value: {
                  kind: "released",
                  error: `cache mirror after status transition failed: ${error instanceof Error ? error.message : String(error)}`,
                },
              };
            }
          }
          return {
            complete: true,
            value: statusResult.error
              ? { kind: "released", error: statusResult.error }
              : { kind: "released" },
          };
        } catch (error) {
          // Settlement failed: the intent stays pending and the next pass
          // replays (crash-matrix row 3). The guard is released cleanly.
          const message = error instanceof Error ? error.message : String(error);
          return { complete: true, value: { kind: "error", error: `settle failed: ${message}` } };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { complete: true, value: { kind: "error", error: message } };
      }
    },
  );

  if (guarded.status === "busy") return { kind: "skipped" };
  return guarded.value;
}

// ─── Phase A (fenced intent commit) ──────────────────────────────────────────

/**
 * #1254 acceptance: "Re-check live renewal, open linked PR/review ownership,
 * dependency and maintainer holds at commit time." Renewal is pinned by the
 * epoch CAS; these are the facts the CAS cannot pin — the live forge labels,
 * the deliberate block, the review owner, and the external-wait marker —
 * re-derived under the anchor so a hold or review ownership that landed
 * after the ladder decision cannot be released over. Mirrors the
 * terminal short-circuits of `deriveOwnershipState` (§4 tiers HELD /
 * EXTERNAL_WAIT / REVIEW_OWNED). Returns a machine-readable reason to
 * withhold, or null when the commit may proceed.
 */
async function releaseWithheldAtCommitTime(
  tx: OwnershipReconcileTransactionClient,
  input: { issue: AuditIssueRef; agentLabel: string; hasLeaseEpoch: boolean },
  liveLabels: string[],
  now: Date,
): Promise<string | null> {
  const issueRow = await tx.issue.findUnique({
    where: { id: input.issue.id },
    select: { blockedReason: true, linkedPrNumber: true, linkedPrMergeState: true },
  });
  if (!issueRow) return "issue row missing at commit time";

  // Maintainer hold: a deliberate block (status/blocked + non-blank reason).
  const blockedReason = (issueRow.blockedReason ?? "").trim();
  if (liveLabels.includes(BLOCKED_LABEL) && blockedReason.length > 0) {
    return "maintainer hold observed at commit time";
  }

  // Review ownership: open linked PR or open PR-fix queue row.
  const openPrFix = await tx.prFixQueueItem.findFirst({
    where: {
      repo: input.issue.repository.fullName,
      status: { in: [...OPEN_PR_FIX_STATES] },
      OR: [
        { issue: input.issue.number },
        ...(issueRow.linkedPrNumber != null ? [{ pr: issueRow.linkedPrNumber }] : []),
      ],
    },
  });
  const openLinkedPr =
    issueRow.linkedPrNumber != null && issueRow.linkedPrMergeState !== MERGED_PR_STATE;
  if (liveLabels.includes(IN_REVIEW_LABEL) && (openPrFix || openLinkedPr)) {
    return "review ownership (open linked PR) observed at commit time";
  }
  if (openPrFix && liveLabels.includes(input.agentLabel)) {
    return "review ownership (open PR-fix queue row) observed at commit time";
  }

  // Dependency/external wait: a future retryAfter committed since the
  // decision defers the release (§4 EXTERNAL_WAIT).
  if (input.hasLeaseEpoch) {
    const leaseRow = await tx.lease.findFirst({
      where: { agentName: input.agentLabel.slice(AGENT_PREFIX.length), issueId: input.issue.id },
    });
    if (leaseRow?.retryAfter instanceof Date && leaseRow.retryAfter.getTime() > now.getTime()) {
      return "external wait (retryAfter) observed at commit time";
    }
  }
  return null;
}

interface ClaimEpochSnapshot {
  claimToken: string | null;
  expiredAt: Date;
  lastRenewalObservedAt: Date | null;
  /** Observed disposition (terminal dispositions are releasable evidence). */
  disposition: string | null;
  /** Observed AgentWork heartbeat version (§8.6 lease/heartbeat CAS). */
  work?: { id: string; lastHeartbeatAt: Date; leaseExpiresAt: Date | null };
}

interface PhaseAResult {
  kind: "committed" | "replay" | "skipped" | "busy";
  error?: string;
}

/**
 * Commit the release intent under the anchor (Postgres only). CAS-fenced on
 * the claim epoch so a renewal or re-claim that won the window makes the
 * release a no-op; retiring the token (claimToken → null) is the fence that
 * rejects a concurrent `renew(token=g)`. Label-only legacy claims (no lease
 * row) release through an intent-only Phase A: under the lock the live labels
 * must still name exactly that one agent.
 */
async function commitReleaseIntent(
  deps: ResolvedDeps,
  input: {
    issue: AuditIssueRef;
    agentName: string;
    agentLabel: string;
    epoch: ClaimEpochSnapshot | null;
    liveLabels: string[];
  },
  now: Date,
): Promise<PhaseAResult> {
  const { prisma: client, forge, guard } = deps;

  const guarded = await guard(
    { issueId: input.issue.id, operation: "reconcile-release", agentName: input.agentName },
    async (): Promise<{ complete: boolean; value: PhaseAResult }> => {
      try {
        // #1254 acceptance: commit-time re-check (fail closed on a forge read
        // failure for BOTH paths — an unverifiable live label set can never
        // authorize a release). It runs inside the same anchor window and
        // BEFORE the transaction (a network read must not hold the DB
        // transaction open, and a withheld release commits nothing, not even
        // a retired token). The claim/release writers of this label set
        // serialize on the same anchor; DB facts like `blockedReason` that
        // other routes write without the anchor keep a (pre-existing,
        // same as the pre-#1254 manual path) small race — re-deriving them
        // under the anchor shrinks it to the narrowest available window and
        // the epoch CAS still fences every lease/claim movement.
        let liveLabels: string[];
        try {
          liveLabels = await forge.getLiveIssueLabels(
            input.issue.repository.fullName,
            input.issue.number,
          );
        } catch (error) {
          return {
            complete: true,
            value: {
              kind: "skipped",
              error: `forge read failed during Phase A commit-time re-check: ${error instanceof Error ? error.message : String(error)}`,
            },
          };
        }
        const withheld = await releaseWithheldAtCommitTime(
          client,
          { issue: input.issue, agentLabel: input.agentLabel, hasLeaseEpoch: input.epoch !== null },
          liveLabels,
          now,
        );
        if (withheld) return { complete: true, value: { kind: "skipped", error: `release withheld: ${withheld}` } };

        const result = await client.$transaction(async (tx): Promise<PhaseAResult> => {
          const existing = await tx.ownershipReleaseIntent.findUnique({
            where: { issueId_agentLabel: { issueId: input.issue.id, agentLabel: input.agentLabel } },
          });
          // A superseded intent means an explicit operator/pipeline decision
          // just acted on this issue: never resurrect it this pass (the next
          // ladder run re-derives from current evidence).
          if (existing && existing.phase === "superseded") return { kind: "skipped" };
          if (existing && existing.phase === "pending") return { kind: "replay" };

          if (input.epoch) {
            // CAS the ownership row on the exact claim epoch — the snapshot of
            // {claimToken, expiredAt, lastRenewalObservedAt, disposition} the
            // decision was computed from. A renewal, re-claim or fresh claim
            // that committed inside the window moves at least one field and
            // the CAS matches nothing: the release is a no-op and no forge
            // call is ever owed. The disposition match (rather than a blanket
            // `disposition: null`) is what lets the terminal-disposition
            // evidence path (§5 tier 3) release at all.
            // §8.6: the release decision is also conditioned on the observed
            // AgentWork heartbeat version. A checkpoint that committed inside
            // the window moves `lastHeartbeatAt` and this CAS matches nothing.
            // It runs FIRST and writes only the already-observed value (a
            // no-op on match), so a failed heartbeat CAS aborts before the
            // token-retiring lease CAS below can partially commit.
            if (input.epoch.work) {
              const workCas = await tx.agentWork.updateMany({
                where: {
                  id: input.epoch.work.id,
                  lastHeartbeatAt: input.epoch.work.lastHeartbeatAt,
                },
                data: { leaseExpiresAt: input.epoch.work.leaseExpiresAt },
              });
              if (workCas.count !== 1) return { kind: "skipped" };
            }
            const cas = await tx.lease.updateMany({
              where: {
                agentName: input.agentName,
                issueId: input.issue.id,
                claimToken: input.epoch.claimToken,
                expiredAt: input.epoch.expiredAt,
                lastRenewalObservedAt: input.epoch.lastRenewalObservedAt,
                disposition: input.epoch.disposition ?? null,
              },
              data: { claimToken: null },
            });
            // Throwing rolls the whole transaction (including the heartbeat
            // CAS write above) back, so an aborted release commits nothing.
            if (cas.count !== 1) throw new EpochMovedError();
          } else {
            // Intent-only Phase A: the live `agent/*` set must still be
            // exactly this one label (the commit-time live read above,
            // §8.7) AND no lease may exist for the (agent, issue) pair — a
            // lease row here is a fresh claim the decision never saw, and
            // its label must never be deleted (fail closed, §12 "no
            // stealing").
            const agentLabels = liveLabels.filter((l) => l.startsWith(AGENT_PREFIX));
            if (!(agentLabels.length === 1 && agentLabels[0] === input.agentLabel)) {
              return { kind: "skipped" };
            }
            const freshLease = await tx.lease.findFirst({
              where: { agentName: input.agentName, issueId: input.issue.id },
            });
            if (freshLease) return { kind: "skipped" };
          }

          if (existing) {
            // Replay of an unsettled intent (crash after A, before B): reset
            // the parked state — a fresh commit re-opens the retry budget.
            await tx.ownershipReleaseIntent.updateMany({
              where: { id: existing.id, phase: "pending" },
              data: {
                attemptToken: input.epoch?.claimToken ?? null,
                parkedAt: null,
                updatedAt: now,
              },
            });
          } else {
            await tx.ownershipReleaseIntent.create({
              data: {
                issueId: input.issue.id,
                agentName: input.agentName,
                agentLabel: input.agentLabel,
                attemptToken: input.epoch?.claimToken ?? null,
                phase: "pending",
              },
            });
          }
          // §8.2 item 4 / §8.3: the reclaim counter and its cooldown stamp are
          // part of the fenced commit, so a release that churns cannot recur
          // unboundedly — the ladder parks the claim once the cap is reached.
          await tx.ownershipReconcileCandidate.upsert({
            where: { issueId: input.issue.id },
            create: {
              issueId: input.issue.id,
              agentName: input.agentName,
              reclaimCount: 1,
              lastReclaimAt: now,
            },
            update: { reclaimCount: { increment: 1 }, lastReclaimAt: now },
          });
          return { kind: "committed" };
        });

        if (result.kind === "committed") {
          await auditReconcileEvent(client, {
            action: "ownership_release_intent",
            issue: input.issue,
            beforeLabels: input.liveLabels,
            afterLabels: input.liveLabels,
            notes: `release intent committed for ${input.agentLabel} (token ${input.epoch ? "pinned" : "absent — label-only claim"})`,
          });
        }
        return { complete: true, value: result };
      } catch (error) {
        return {
          complete: true,
          value: {
            kind: "skipped",
            error: `Phase A failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
    },
  );

  if (guarded.status === "busy") return { kind: "busy" };
  return guarded.value;
}

// ─── Replay pending intents ──────────────────────────────────────────────────

/**
 * Drive every pending release intent through Phase B→C (crash/replay matrix,
 * §8.7). Replay acts ONLY on the pending intent: a settled release's stale
 * retry finds no matching intent and issues zero forge calls, so a later
 * attempt's label is never deleted. Superseded intents are deleted (the exempt
 * path already wrote its own labels idempotently).
 */
export async function replayPendingOwnershipReleases(
  deps?: Partial<OwnershipReconcileDeps>,
  now: Date = new Date(),
): Promise<{
  replayed: number;
  released: number;
  parked: number;
  superseded: number;
  skipped: number;
  errors: string[];
}> {
  // Audit mode performs NO mutations — not even settling intents that were
  // committed under a previous enforce run. Off and enforce both replay:
  // "off" releases nothing NEW, but an intent already committed before the
  // mode change must settle, or its claim barrier would hold the issue
  // forever with no self-healing path.
  if (ownershipReconcileMode() === "audit") {
    return { replayed: 0, released: 0, parked: 0, superseded: 0, skipped: 0, errors: [] };
  }

  const resolved = resolveDeps(deps);
  const result = { replayed: 0, released: 0, parked: 0, superseded: 0, skipped: 0, errors: [] as string[] };

  const intents = await resolved.prisma.ownershipReleaseIntent.findMany({
    // Parked intents stay out of the window: they are operator-only until an
    // exempt path supersedes them, and letting them occupy the take window
    // would starve live intents behind them.
    where: { phase: { in: ["pending", "superseded"] }, parkedAt: null },
    orderBy: { createdAt: "asc" },
    take: reconcileBatchSize(),
  });

  for (const intent of intents) {
    try {
      if (intent.phase === "superseded") {
        const deleted = await resolved.prisma.ownershipReleaseIntent.deleteMany({
          where: { id: intent.id, phase: "superseded" },
        });
        if (deleted.count === 1) result.superseded++;
        continue;
      }
      const issue = await resolved.prisma.issue.findUnique({
        where: { id: intent.issueId },
        include: { repository: true },
      });
      if (!issue) {
        // The issue row was pruned; nothing to settle. Drop the orphan intent.
        await resolved.prisma.ownershipReleaseIntent.deleteMany({ where: { id: intent.id } });
        result.skipped++;
        continue;
      }
      const outcome = await driveReleaseIntent(
        resolved,
        {
          id: intent.id,
          issueId: intent.issueId,
          agentName: intent.agentName,
          agentLabel: intent.agentLabel,
          attemptToken: intent.attemptToken ?? null,
        },
        issue,
        now,
      );
      if (outcome.kind === "parked") result.parked++;
      else if (outcome.kind === "released") {
        result.released++;
        result.replayed++;
        if (outcome.error) result.errors.push(`${issue.repository.fullName}#${issue.number}: ${outcome.error}`);
      } else if (outcome.kind === "error") {
        result.replayed++;
        result.errors.push(`${issue.repository.fullName}#${issue.number}: ${outcome.error}`);
      } else {
        result.skipped++;
        // A withheld replay carries its reason (hold/review/external-wait);
        // surface it instead of silently skipping.
        if (outcome.error) result.errors.push(`${issue.repository.fullName}#${issue.number}: ${outcome.error}`);
      }
    } catch (error) {
      result.errors.push(
        `replay of intent ${intent.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return result;
}

// ─── Candidate selection ─────────────────────────────────────────────────────

/**
 * Bounded, evidence-driven candidate scan (§8.1). A candidate is an open issue
 * whose ownership evidence has gone quiet: persisted ladder rows, leases with
 * a terminal disposition or an expired clock, and stale active AgentWork rows.
 * Label-only legacy claims (no Dispatch evidence at all) are never candidates
 * — they stay UNKNOWN for the operator (§5 tier 6).
 *
 * `readOnly` (audit mode) makes the scan pure: the dead-ladder housekeeping
 * delete is skipped, because audit mode promises no persisted
 * `OwnershipReconcileCandidate` mutation at all. The dead rows are harmless
 * there — they only make the bounded ladder source slightly less fresh, which
 * is exactly the trade `audit` accepts in exchange for touching nothing.
 */
async function selectCandidates(
  client: OwnershipReconcileClient,
  graceCutoff: Date,
  batchSize: number,
  readOnly = false,
): Promise<any[]> {
  // `reclaimCount` must be loaded: the dead-row cleanup below keeps rows with
  // churn history, and a select that drops it makes real Prisma rows look
  // zero-history and deletes the churn bound (#1254 review).
  const ladderRows = await client.ownershipReconcileCandidate.findMany({
    orderBy: { updatedAt: "desc" },
    take: batchSize,
    select: { issueId: true, reclaimCount: true },
  });
  const leaseRows = await client.lease.findMany({
    where: {
      OR: [
        { disposition: { in: [...TERMINAL_DISPOSITIONS] } },
        { expiredAt: { lte: graceCutoff } },
      ],
    },
    orderBy: { expiredAt: "asc" },
    take: batchSize,
    select: { issueId: true },
  });
  const workRows = await client.agentWork.findMany({
    where: {
      state: { in: [...ACTIVE_AGENT_WORK_STATES] },
      lastHeartbeatAt: { lte: graceCutoff },
    },
    orderBy: { lastHeartbeatAt: "asc" },
    take: batchSize,
    select: { issueId: true },
  });

  const ids = [...new Set([...ladderRows, ...leaseRows, ...workRows].map((row) => row.issueId))];
  if (ids.length === 0) return [];

  const issues = await client.issue.findMany({
    where: { id: { in: ids }, state: "open" },
    orderBy: { id: "asc" },
    include: { repository: true },
  });

  // Ladder rows for issues that no longer carry a claim (released, or the
  // label moved on GitHub) are dead weight: delete them so the bounded
  // ladder source stays fresh instead of degenerating into released rows.
  // Rows with reclaim history are KEPT (the churn bound must survive
  // release/reclaim cycles), and issues holding a pending intent are skipped
  // (Phase C still resets their row at settle; deleting it here would make
  // that settle throw and park the intent).
  const deadLadderIds = ladderRows
    .filter((row: any) => {
      if ((row.reclaimCount ?? 0) > 0) return false;
      const issue = issues.find((i: any) => i.id === row.issueId);
      return !issue || !issue.labels.some((label: string) => label.startsWith(AGENT_PREFIX));
    })
    .map((row: any) => row.issueId);
  if (!readOnly && deadLadderIds.length > 0) {
    await client.ownershipReconcileCandidate.deleteMany({ where: { issueId: { in: deadLadderIds } } });
  }

  // Issues already carrying an intent are replay's business (or parked for the
  // operator) — never re-examined while an intent exists.
  const intents = await client.ownershipReleaseIntent.findMany({
    where: { issueId: { in: issues.map((i) => i.id) } },
    select: { issueId: true, phase: true, parkedAt: true },
  });
  const blockedIssues = new Set(
    intents
      .filter((i) => i.phase === "pending" || i.parkedAt != null)
      .map((i) => i.issueId),
  );

  // Cap AFTER the label/intent filters: released or intent-held issues must
  // not consume the per-run quota and starve real candidates (§8.1).
  return issues
    .filter(
      (issue) =>
        issue.labels.some((label: string) => label.startsWith(AGENT_PREFIX)) &&
        !blockedIssues.has(issue.id),
    )
    .slice(0, batchSize);
}

// ─── Evidence assembly ───────────────────────────────────────────────────────

function leaseEvidence(lease: any): OwnershipLeaseEvidence {
  return {
    agentName: lease.agentName,
    expiredAt: lease.expiredAt,
    renewedAt: lease.renewedAt,
    claimToken: lease.claimToken,
    registeredAt: lease.registeredAt,
    registrationOccurredAt: lease.registrationOccurredAt,
    renewCount: lease.renewCount,
    lastRenewalObservedAt: lease.lastRenewalObservedAt,
    lastRenewalOccurredAt: lease.lastRenewalOccurredAt,
    retryAfter: lease.retryAfter,
    disposition: lease.disposition,
  };
}

function agentWorkEvidence(work: any): OwnershipAgentWorkEvidence {
  return {
    agentName: work.agentName,
    state: work.state,
    lastHeartbeatAt: work.lastHeartbeatAt,
  };
}

// ─── Deps resolution ─────────────────────────────────────────────────────────

export interface OwnershipReconcileDeps {
  prisma: OwnershipReconcileClient;
  forge: OwnershipReconcileForge;
  guard: typeof withIssueMutationGuard;
}

interface ResolvedDeps extends OwnershipReconcileDeps {}

function resolveDeps(deps?: Partial<OwnershipReconcileDeps>): ResolvedDeps {
  return {
    prisma: deps?.prisma ?? (prisma as unknown as OwnershipReconcileClient),
    forge: deps?.forge ?? { getLiveIssueLabels, removeIssueLabel },
    guard: deps?.guard ?? withIssueMutationGuard,
  };
}

// ─── The reconciliation pass ─────────────────────────────────────────────────

/**
 * One bounded reconciliation pass (§8.1): replay pending intents, then examine
 * candidates through the §8.2 confirmation ladder. `audit` mode annotates
 * only — persisted candidate state is read-only (the ladder re-derives from
 * stored state each pass, or a simulated fresh row when none exists) and it
 * never releases; `enforce` releases through the §8.7 two-sided protocol.
 * `off` does nothing.
 */
export async function reconcileOwnership(
  deps?: Partial<OwnershipReconcileDeps>,
  now: Date = new Date(),
): Promise<OwnershipReconcileReport> {
  const mode = ownershipReconcileMode();
  const report = emptyReport(mode);

  // "off" starts no new release, but intents already committed before the
  // mode change must settle - otherwise their claim barrier would hold the
  // issue forever with no self-healing path. Audit replays nothing at all.
  if (mode !== "audit") {
    try {
      const replay = await replayPendingOwnershipReleases(deps, now);
      report.released += replay.released;
      report.replayed += replay.replayed;
      report.parked += replay.parked;
      report.superseded += replay.superseded;
      report.skipped += replay.skipped;
      report.errors.push(...replay.errors);
    } catch (error) {
      report.errors.push("replay pass failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (mode === "off") return report;

  const resolved = resolveDeps(deps);
  const client = resolved.prisma;
  const batchSize = reconcileBatchSize();
  const recheckMs = reconcileRecheckIntervalMs();
  const cooldownMs = reconcileReclaimCooldownMs();
  const maxReclaims = reconcileMaxReclaims();
  const graceCutoff = new Date(now.getTime() - ownershipLongRunGraceMs());

  // 2. Candidates (the replay of pending intents already ran above, before
  //    the off-mode early-return).
  let candidates: any[];
  try {
    candidates = await selectCandidates(client, graceCutoff, batchSize, mode === "audit");
  } catch (error) {
    report.errors.push(`candidate selection failed: ${error instanceof Error ? error.message : String(error)}`);
    return report;
  }

  for (const issue of candidates) {
    report.examined++;
    const repoFullName = issue.repository.fullName;
    const agentLabels: string[] = issue.labels.filter((l: string) => l.startsWith(AGENT_PREFIX));
    const labelOwner = agentLabels.length === 1 ? agentLabels[0].slice(AGENT_PREFIX.length) : null;

    try {
      // Fail closed on a forge read failure: no observation, no mutation (§7).
      let liveLabels: string[];
      try {
        liveLabels = await resolved.forge.getLiveIssueLabels(repoFullName, issue.number);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.skipped++;
        report.errors.push(`${repoFullName}#${issue.number}: forge read failed: ${message}`);
        try {
          await auditReconcileEvent(client, {
            action: "ownership_reconcile_unverifiable",
            issue,
            beforeLabels: issue.labels,
            afterLabels: issue.labels,
            success: false,
            errorMessage: message,
            notes: "live label read failed; ladder not advanced (fail closed)",
          });
        } catch {
          // Audit failure must not mask the report's error entry.
        }
        continue;
      }

      const lease =
        labelOwner !== null
          ? await client.lease.findUnique({
              where: { agentName_issueId: { agentName: labelOwner, issueId: issue.id } },
            })
          : await client.lease.findFirst({
              where: { issueId: issue.id },
              orderBy: [{ renewedAt: "desc" }, { createdAt: "desc" }],
            });
      const work = await client.agentWork.findFirst({
        where: { issueId: issue.id, state: { in: [...ACTIVE_AGENT_WORK_STATES] } },
        orderBy: CURRENT_CLAIM_WORK_ORDER_BY,
      });
      const openPrFix = await client.prFixQueueItem.findFirst({
        where: {
          repo: repoFullName,
          status: { in: [...OPEN_PR_FIX_STATES] },
          OR: [
            { issue: issue.number },
            ...(issue.linkedPrNumber != null ? [{ pr: issue.linkedPrNumber }] : []),
          ],
        },
      });

      const evidence: OwnershipEvidence = {
        issueState: "open",
        labels: liveLabels,
        labelSource: "live",
        cachedLabels: issue.labels,
        blockedReason: issue.blockedReason,
        linkedPrNumber: issue.linkedPrNumber,
        linkedPrMergeState: issue.linkedPrMergeState,
        openPrFix: openPrFix != null,
        lease: lease ? leaseEvidence(lease) : null,
        agentWork: work ? agentWorkEvidence(work) : null,
      };
      const windows = {
        activeMs: ownershipActiveWindowMs(),
        longRunGraceMs: ownershipLongRunGraceMs(),
      };
      const assessment = deriveOwnershipState(evidence, windows, now);

      if (assessment.state !== "ABANDONED_CANDIDATE") {
        // Renewal observed mid-ladder (§8.4): candidacy is aborted, never
        // carried forward as a stale blip. Audit mode is read-only for
        // candidate state: the stored row (if any) survives untouched and
        // the annotation below is the only output of this branch.
        const deleted =
          mode === "audit"
            ? { count: 0 }
            : await client.ownershipReconcileCandidate.deleteMany({
                where: { issueId: issue.id },
              });
        report.retained++;
        if (mode === "audit" || deleted.count > 0) {
          try {
            await auditReconcileEvent(client, {
              action: "ownership_reconcile_candidate",
              issue,
              beforeLabels: issue.labels,
              afterLabels: issue.labels,
              notes: `state=${assessment.state} reasons=[${assessment.reasonCodes.join(",")}] verified=${assessment.verified}`,
            });
          } catch {
            // Annotation only.
          }
        }
        continue;
      }

      // ── ABANDONED_CANDIDATE: the confirmation ladder (§8.2) ──
      const owner = assessment.ownerAgent ?? labelOwner;
      // Audit mode performs zero candidate writes: the ladder re-derives
      // from the stored row, or from a simulated fresh row when none exists.
      // The stored row never advances in audit, so each audit pass starts
      // from the same stored state — intended, not a bug.
      const candidateRow =
        mode === "audit"
          ? (await client.ownershipReconcileCandidate.findUnique({
              where: { issueId: issue.id },
            }) ?? {
                agentName: owner ?? "unknown",
                staleCount: 0,
                firstStaleAt: null,
                lastObservedAt: null,
                reclaimCount: 0,
                lastReclaimAt: null,
              })
          : await client.ownershipReconcileCandidate.upsert({
              where: { issueId: issue.id },
              create: {
                issueId: issue.id,
                agentName: owner ?? "unknown",
                staleCount: 0,
              },
              update: {},
            });

      // A different owner inherited the previous owner observations: the
      // ladder observations and the reclaim counter are per-claim, so a new
      // owner restarts the full confirmation ladder (§8.2 — two independent
      // observations of THIS claim, not of the previous one). Audit mode
      // applies the reset to the in-memory row only (no candidate write).
      let effectiveRow = candidateRow;
      if (owner != null && candidateRow.agentName !== owner) {
        if (mode !== "audit") {
          await client.ownershipReconcileCandidate.update({
            where: { issueId: issue.id },
            data: {
              agentName: owner,
              staleCount: 0,
              firstStaleAt: null,
              lastObservedAt: null,
              reclaimCount: 0,
              lastReclaimAt: null,
            },
          });
        }
        effectiveRow = { ...candidateRow, agentName: owner, staleCount: 0, firstStaleAt: null, lastObservedAt: null, reclaimCount: 0, lastReclaimAt: null };
      }

      const lastReclaimAt = effectiveRow.lastReclaimAt ?? null;
      const reclaimCount = effectiveRow.reclaimCount ?? 0;
      if (
        lastReclaimAt !== null &&
        now.getTime() - lastReclaimAt.getTime() < cooldownMs
      ) {
        report.retained++;
        continue;
      }
      if (reclaimCount >= maxReclaims) {
        report.held++;
        try {
          await auditReconcileEvent(client, {
            action: "ownership_reconcile_parked",
            issue,
            beforeLabels: issue.labels,
            afterLabels: issue.labels,
            notes: `reclaim limit (${maxReclaims}) reached for ${assessment.ownerAgent ?? labelOwner}; needs-human, no release`,
          });
        } catch {
          // Annotation only.
        }
        continue;
      }

      const lastObserved = effectiveRow.lastObservedAt ? effectiveRow.lastObservedAt.getTime() : null;
      let staleCount: number = effectiveRow.staleCount ?? 0;
      if (lastObserved === null) {
        staleCount = 1;
      } else if (now.getTime() - lastObserved < recheckMs) {
        report.retained++;
        continue;
      } else {
        staleCount += 1;
      }

      // Audit mode is read-only for candidate state: the in-memory
      // `staleCount` still drives the report counters and the "would
      // release" annotation below, but the stored row never advances —
      // each audit pass re-derives the ladder from stored state.
      if (mode !== "audit") {
        await client.ownershipReconcileCandidate.update({
          where: { issueId: issue.id },
          data: {
            agentName: assessment.ownerAgent ?? labelOwner ?? "unknown",
            staleCount,
            firstStaleAt: effectiveRow.firstStaleAt ?? now,
            lastObservedAt: now,
            lastReasons: assessment.reasonCodes.join(","),
          },
        });
      }

      if (staleCount < 2) {
        report.retained++;
        continue;
      }

      if (mode === "audit") {
        // Audit mode annotates; it performs NO release mutations and NO forge
        // writes (acceptance: audit mode performs no mutations).
        report.retained++;
        try {
          await auditReconcileEvent(client, {
            action: "ownership_reconcile_release_withheld",
            issue,
            beforeLabels: issue.labels,
            afterLabels: issue.labels,
            notes: `mode=audit; would release ${assessment.ownerAgent ?? labelOwner} (reasons=[${assessment.reasonCodes.join(",")}], staleCount=${staleCount})`,
          });
        } catch {
          // Annotation only.
        }
        continue;
      }

      // ── Release via the §8.7 protocol ──
      if (!owner) {
        report.skipped++;
        continue;
      }
      const agentLabel = `${AGENT_PREFIX}${owner}`;
      const epoch: ClaimEpochSnapshot | null = lease
        ? {
            claimToken: lease.claimToken,
            expiredAt: lease.expiredAt,
            lastRenewalObservedAt: lease.lastRenewalObservedAt,
            disposition: lease.disposition ?? null,
            ...(work
              ? {
                  work: {
                    id: work.id,
                    lastHeartbeatAt: work.lastHeartbeatAt,
                    leaseExpiresAt: work.leaseExpiresAt ?? null,
                  },
                }
              : {}),
          }
        : null;

      const phaseA = await commitReleaseIntent(
        resolved,
        {
          issue: { id: issue.id, number: issue.number, repository: issue.repository },
          agentName: owner,
          agentLabel,
          epoch,
          liveLabels,
        },
        now,
      );

      if (phaseA.kind === "busy" || phaseA.kind === "skipped") {
        report.skipped++;
        if (phaseA.error) report.errors.push(`${repoFullName}#${issue.number}: ${phaseA.error}`);
        continue;
      }

      // Phase B → C. The intent is now (or already was) pending, so the claim
      // path is held until settle.
      const outcome = await driveReleaseIntent(
        resolved,
        {
          id: "",
          issueId: issue.id,
          agentName: owner,
          agentLabel,
          attemptToken: epoch?.claimToken ?? null,
        },
        issue,
        now,
      );

      if (outcome.kind === "released") {
        report.released++;
        if (outcome.error) report.errors.push(`${repoFullName}#${issue.number}: ${outcome.error}`);
      } else if (outcome.kind === "parked") {
        report.parked++;
      } else if (outcome.kind === "error") {
        report.replayed++;
        report.errors.push(`${repoFullName}#${issue.number}: ${outcome.error}`);
      } else {
        report.skipped++;
        // A withheld Phase B carries its reason (hold/review/external-wait);
        // surface it like the replay path does.
        if (outcome.error) report.errors.push(`${repoFullName}#${issue.number}: ${outcome.error}`);
      }
    } catch (error) {
      report.errors.push(
        `${repoFullName}#${issue.number}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return report;
}
