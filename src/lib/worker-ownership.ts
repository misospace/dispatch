// ─── Optional worker ownership capability (#1251) ────────────────────────────
//
// Implements the accepted optional `register` / `renew` / `disposition`
// capability from docs/ownership-reconciliation.md §6 on top of the existing
// `Lease` row (no parallel lease table) and #1256's `Lease.claimToken` as the
// fencing token (§6.1: the attempt-token discipline generalizes `claimToken`).
//
// Rules this module owns:
//
// 1. **Attempt/owner fencing.** Every operation presents the `claimToken`
//    issued on the claim. A token that does not match the live lease row is
//    rejected (`stale_claim_token`), so an old incarnation can never renew a
//    claim that was re-claimed under a fresh token. Identity fencing lives in
//    the route (`enforceWorkerAgentScope`): the bound token-derived agent must
//    equal the lease owner — no `agent/courier*`-style wildcard aliasing.
// 2. **Occurrence vs observation.** Workers may report when the event actually
//    happened (`occurredAt`); Dispatch always records the server clock
//    (observed). An invalid, future, or absurdly old occurrence silently falls
//    back to the observed time — the same posture `tasks/report` takes for its
//    optional `startedAt`.
// 3. **No releases here.** Nothing in this module mutates GitHub labels,
//    deletes a lease, or moves an issue. Terminal dispositions are durable
//    *evidence* consumed by the read model (#1251) and the later reconciler
//    (#1254). A client that never adopts the capability stays supported and
//    conservatively unverified (§6.2).
// 4. **Serialization.** Lease-mutating operations run under the per-issue
//    `IssueMutationGuard` anchor (#1259) so a renewal cannot interleave with a
//    claim or a fenced capacity release on the same issue.
// 5. **Atomicity.** The two operations that assert a *new fact* about an
//    attempt — `register` (registration + lifecycle event + audit row) and
//    `disposition` (terminal CAS + AgentWork settlement + history + lifecycle
//    event + audit row) — commit in ONE `prisma.$transaction`, the lifecycle
//    event through that transaction's client. That guard anchor has no resume
//    branch and is deleted on throw, so a CAS committed without its evidence
//    would be unreachable on retry: the replay branch would report success for
//    a disposition whose work was never settled and whose required lifecycle
//    event does not exist. `renew` is deliberately NOT in this class — it
//    extends a TTL that a retry can safely re-extend and heartbeats a
//    matching `AgentWork` as best-effort evidence whose absence it reports
//    truthfully (`agentWorkHeartbeated: false`), so there is nothing for it
//    to lie about. That heartbeat also carries the renewed expiry onto the
//    AgentWork row: the stale-work sweeper reclaims on `leaseExpiresAt` too,
//    so a renewal that moved only the heartbeat would still lose a renewed
//    long-running worker to the sweeper (#1251).

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withIssueMutationGuard } from "./issue-mutation-guard";
import { recordLifecycleEvent, lifecycleDedupeKey } from "./issue-lifecycle";
import { DEFAULT_LEASE_TTL_MS } from "./lease";

export const OWNERSHIP_DISPOSITIONS = ["completed", "released", "blocked", "handed_off"] as const;
export type OwnershipDisposition = (typeof OWNERSHIP_DISPOSITIONS)[number];

export function isOwnershipDisposition(value: unknown): value is OwnershipDisposition {
  return typeof value === "string" && (OWNERSHIP_DISPOSITIONS as readonly string[]).includes(value);
}

// ─── Windows (configuration, not code constants — design §8.3) ──────────────

const MIN_WINDOW_MS = 60_000; // 1 minute
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function readWindowEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  const value = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  return Math.min(Math.max(value, min), max);
}

/** Renewals within this window keep the claim `CLAIMED_ACTIVE`. Default 15m. */
export function ownershipActiveWindowMs(): number {
  return readWindowEnv("DISPATCH_OWNERSHIP_ACTIVE_WINDOW_MS", 15 * 60 * 1000, MIN_WINDOW_MS, 6 * 60 * 60 * 1000);
}

/**
 * Sustained silence beyond the active window but within this grace stays
 * `CLAIMED_LONG_RUNNING` (escalated observation, never release). Default 45m;
 * never below the active window.
 */
export function ownershipLongRunGraceMs(): number {
  return readWindowEnv("DISPATCH_OWNERSHIP_LONG_RUN_GRACE_MS", 45 * 60 * 1000, ownershipActiveWindowMs(), MAX_WINDOW_MS);
}

/** TTL a renewed lease receives. Default equals the standard 30m lease TTL. */
export function ownershipRenewTtlMs(): number {
  return readWindowEnv("DISPATCH_OWNERSHIP_RENEW_TTL_MS", DEFAULT_LEASE_TTL_MS, MIN_WINDOW_MS, MAX_WINDOW_MS);
}

// ─── Occurrence-time normalization ───────────────────────────────────────────

/**
 * Accept a worker-reported occurrence timestamp: extended ISO 8601 with
 * timezone, parseable, not in the future (1 minute skew allowed), not more
 * than 24 hours in the past. Anything else yields null (caller falls back to
 * the observed/server time). Never rejects the whole request for a bad clock.
 */
export function normalizeOwnershipOccurredAt(raw: unknown, now: Date = new Date()): Date | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const parsed = new Date(raw);
  const time = parsed.getTime();
  if (!Number.isFinite(time)) return null;
  if (time > now.getTime() + 60_000) return null;
  if (time < now.getTime() - 24 * 60 * 60 * 1000) return null;
  return parsed;
}

// ─── Result types ────────────────────────────────────────────────────────────

export type OwnershipOpCode =
  | "issue_not_found"
  | "no_active_claim"
  | "stale_claim_token"
  | "disposed"
  | "disposition_conflict"
  | "mutation_busy";

export interface OwnershipOpFailure {
  ok: false;
  httpStatus: number;
  code: OwnershipOpCode;
  message: string;
}

const FAILURE_META: Record<OwnershipOpCode, { httpStatus: number; message: string }> = {
  issue_not_found: { httpStatus: 404, message: "Issue not found in local cache" },
  no_active_claim: { httpStatus: 409, message: "No lease exists for this agent on this issue; claim the issue first" },
  stale_claim_token: { httpStatus: 409, message: "claimToken does not match the current claim; this attempt is fenced out" },
  disposed: { httpStatus: 409, message: "Ownership already carries a terminal disposition" },
  disposition_conflict: { httpStatus: 409, message: "Ownership already carries a different terminal disposition" },
  mutation_busy: { httpStatus: 409, message: "Issue mutation is in progress; retry shortly" },
};

function fail(code: OwnershipOpCode, message?: string): OwnershipOpFailure {
  const meta = FAILURE_META[code];
  return { ok: false, httpStatus: meta.httpStatus, code, message: message ?? meta.message };
}

// ─── Shared input + guard plumbing ───────────────────────────────────────────

export interface OwnershipOpInput {
  agentName: string;
  issueId: string;
  /** The claim receipt issued on claim / surfaced by active-work resume. */
  claimToken: string;
  /** Optional worker-reported occurrence time (ISO 8601). */
  occurredAt?: unknown;
  /** Audit actor: the bound worker's agent name, or the operator for maintainer calls. */
  actor: string;
  now?: Date;
}

export interface OwnershipExternalWait {
  reason: string;
  retryAfter: Date;
}

async function withOwnershipGuard<T>(
  input: OwnershipOpInput,
  fn: () => Promise<{ ok: true; value: T } | OwnershipOpFailure>,
): Promise<{ ok: true; value: T } | OwnershipOpFailure> {
  const guarded = await withIssueMutationGuard(
    { issueId: input.issueId, operation: "ownership", agentName: input.agentName, claimToken: input.claimToken },
    async () => ({ complete: true, value: await fn() }),
  );
  if (guarded.status === "busy") return fail("mutation_busy");
  return guarded.value;
}

type GuardedLeaseResult =
  | { ok: false; failure: OwnershipOpFailure }
  | { ok: true; issue: IssueWithRepo; lease: LeaseWithOwnership };

type IssueWithRepo = Prisma.IssueGetPayload<{ include: { repository: true } }>;
type LeaseWithOwnership = Prisma.LeaseGetPayload<Record<string, never>>;

async function loadGuardedLease(input: OwnershipOpInput): Promise<GuardedLeaseResult> {
  const issue = await prisma.issue.findUnique({
    where: { id: input.issueId },
    include: { repository: true },
  });
  if (!issue) return { ok: false, failure: fail("issue_not_found") };

  const lease = await prisma.lease.findUnique({
    where: { agentName_issueId: { agentName: input.agentName, issueId: input.issueId } },
  });
  if (!lease) return { ok: false, failure: fail("no_active_claim") };
  // Fencing: the presented token must match the live claim. A lease created
  // before #1256 carries no token — it cannot be renewed through this
  // capability until it is re-claimed (fail-closed, §6.1).
  if (!lease.claimToken || lease.claimToken !== input.claimToken) {
    return { ok: false, failure: fail("stale_claim_token") };
  }
  return { ok: true, issue, lease };
}

function externalWaitData(externalWait?: OwnershipExternalWait | null): Record<string, unknown> {
  if (externalWait === null) return { retryAfter: null, waitReason: null };
  if (externalWait === undefined) return {};
  return { retryAfter: externalWait.retryAfter, waitReason: externalWait.reason };
}

/**
 * The deterministic pick of the CURRENT claim's `AgentWork` row.
 *
 * Several active rows for the same (agent, issue) are reachable (`start`
 * releases only the CLAIMED/IN_PROGRESS ones, so an older BLOCKED row can
 * survive next to the current IN_PROGRESS row). The current claim's work is
 * the FRESHEST active row — the one the latest start/heartbeat moved — with
 * `createdAt` then `id` as deterministic tie-breaks so the pick never depends
 * on database row order. Renewal heartbeat, ownership inspect and terminal
 * disposition all select through this one rule, so "the row this claim owns"
 * is the same row everywhere: a terminal disposition can never settle an
 * older sibling while the current attempt stays active.
 */
export const CURRENT_CLAIM_WORK_ORDER_BY = [
  { lastHeartbeatAt: "desc" as const },
  { createdAt: "desc" as const },
  { id: "desc" as const },
];

function findCurrentClaimWork<T extends { agentWork: { findFirst: (args: any) => Promise<any> } }>(
  client: T,
  agentName: string,
  issueId: string,
) {
  return client.agentWork.findFirst({
    where: { agentName, issueId, state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] } },
    orderBy: CURRENT_CLAIM_WORK_ORDER_BY,
  });
}

/**
 * Refresh the matching active `AgentWork` row of an ownership operation.
 *
 * The row carries the *execution* lease the sweeper reads: `sweepStaleWork`
 * reclaims an active row whose `lastHeartbeatAt` OR whose `leaseExpiresAt`
 * fell past its cutoff. Moving only the heartbeat therefore leaves a renewed
 * long-running worker reclaimable — the old `leaseExpiresAt` (5 minutes, set
 * by `startAgentWork`/`checkpointAgentWork`) passes the cutoff and the sweeper
 * marks the freshly renewed worker STALE and deletes its lease. So the expiry
 * is propagated here too, and both values are the operation's own clock and
 * expiry — the very ones written to the `Lease` row — never a second
 * `new Date()` that could drift from them.
 *
 * The row refreshed is the CURRENT claim's work (`findCurrentClaimWork`), so
 * the row a renewal is about cannot be a sibling the renewal left behind.
 */
async function heartbeatMatchingAgentWork(
  input: OwnershipOpInput,
  action: string,
  summary: string | null | undefined,
  now: Date,
  expiresAt: Date,
): Promise<boolean> {
  const work = await findCurrentClaimWork(prisma, input.agentName, input.issueId);
  if (!work) return false;
  await prisma.agentWork.update({
    where: { id: work.id },
    data: { lastHeartbeatAt: now, leaseExpiresAt: expiresAt },
  });
  await prisma.agentWorkHistory.create({
    data: { workId: work.id, action, summary: summary ?? undefined },
  });
  return true;
}

// ─── register ────────────────────────────────────────────────────────────────

export interface RegisterOwnershipInput extends OwnershipOpInput {
  /** Durable worker-chosen run reference recorded as provenance (≤ 500 chars). */
  runRef?: string | null;
}

export interface RegisterOwnershipSuccess {
  /**
   * True when this attempt had already registered and the persisted record is
   * returned verbatim. A replay writes nothing.
   */
  replayed: boolean;
  leaseId: string;
  registeredAt: Date;
  registrationOccurredAt: Date;
  expiresAt: Date;
}

/**
 * Record durable ownership for a live claim: proves a real process intends to
 * own the work (§6.1).
 *
 * Idempotent per (issue, agent, token): once this attempt's lease row carries
 * `registeredAt`, a repeat returns the PERSISTED registration with
 * `replayed: true` and writes nothing at all — no timestamp refresh, no run
 * reference overwrite, no lifecycle event, no audit row — so the evidence
 * describes exactly the first registration of that attempt. Reclaiming rotates
 * the claim token and resets `registeredAt` (`lease.ts`), so a fresh attempt
 * still registers normally.
 */
export async function registerOwnership(input: RegisterOwnershipInput): Promise<{ ok: true; value: RegisterOwnershipSuccess } | OwnershipOpFailure> {
  const now = input.now ?? new Date();
  const occurred = normalizeOwnershipOccurredAt(input.occurredAt, now) ?? now;
  return withOwnershipGuard(input, async (): Promise<{ ok: true; value: RegisterOwnershipSuccess } | OwnershipOpFailure> => {
    const loaded = await loadGuardedLease(input);
    if (!loaded.ok) return loaded.failure;
    const { issue, lease } = loaded;

    if (lease.disposition) return fail("disposed");

    // Replay of an already-registered attempt: hand back what the row
    // persists. Registering again would move `registeredAt` onto a clock tick
    // that observed nothing and overwrite the run reference of a live
    // registration with a retried one — provenance must describe the first
    // registration of the attempt, not the last request that mentioned it.
    if (lease.registeredAt) {
      return {
        ok: true as const,
        value: {
          replayed: true,
          leaseId: lease.id,
          registeredAt: lease.registeredAt,
          // A row written before occurrence tracking existed still answers
          // with the observed time rather than null.
          registrationOccurredAt: lease.registrationOccurredAt ?? lease.registeredAt,
          expiresAt: lease.expiredAt,
        },
      };
    }

    // One transaction: the registration, its lifecycle event and its audit row
    // are one local fact. A throw rolls all three back, so the retry re-enters
    // this path instead of short-circuiting into a register whose evidence
    // never landed.
    return prisma.$transaction(async (tx): Promise<{ ok: true; value: RegisterOwnershipSuccess } | OwnershipOpFailure> => {
      // Fenced exactly like the disposition CAS below: the write names the
      // presented token, so a lease that rotated to a fresh attempt between the
      // guarded read and here is never stamped with a retired incarnation's
      // registration (defence in depth — the issue guard already serializes
      // every lease writer, so this cannot match today).
      const updated = await tx.lease.update({
        where: { id: lease.id, claimToken: input.claimToken },
        data: {
          registeredAt: now,
          registrationOccurredAt: occurred,
          ...(input.runRef ? { runRef: input.runRef } : {}),
        },
      });

      await recordLifecycleEvent(tx, {
        issueId: issue.id,
        repoFullName: issue.repository.fullName,
        issueNumber: issue.number,
        kind: "ownership_registered",
        source: "api:ownership",
        actor: input.actor,
        agentName: input.agentName,
        dedupeKey: lifecycleDedupeKey("ownership_registered", issue.id, input.agentName, input.claimToken),
        occurredAt: occurred,
        observedAt: now,
        metadata: { runRef: input.runRef ?? lease.runRef ?? null },
      });

      await tx.auditLog.create({
        data: {
          actor: input.actor,
          action: "ownership_register",
          repoFullName: issue.repository.fullName,
          issueNumber: issue.number,
          issueId: issue.id,
          beforeLabels: issue.labels,
          afterLabels: issue.labels,
          success: true,
          notes: input.runRef ? `runRef=${input.runRef}` : undefined,
        },
      });

      return {
        ok: true as const,
        value: {
          replayed: false,
          leaseId: lease.id,
          registeredAt: now,
          registrationOccurredAt: occurred,
          expiresAt: updated.expiredAt,
        },
      };
    });
  });
}

// ─── renew ───────────────────────────────────────────────────────────────────

export interface RenewOwnershipInput extends OwnershipOpInput {
  runRef?: string | null;
  /** Set/replace the external-wait marker, or pass null to clear it. */
  externalWait?: OwnershipExternalWait | null;
}

export interface RenewOwnershipSuccess {
  leaseId: string;
  expiresAt: Date;
  renewCount: number;
  lastRenewalObservedAt: Date;
  lastRenewalOccurredAt: Date;
  /** True when an active AgentWork row was heartbeat-matched by this renewal. */
  agentWorkHeartbeated: boolean;
}

/**
 * Extend the single ownership TTL without requiring progress (§6.1).
 *
 * Accepts a renewal whose lease row has *lapsed* but still exists — that is
 * the transient-outage / restart case (a long-running worker reconnecting
 * with its original claim token keeps ownership). Rejects: no lease row at
 * all (`no_active_claim` — the claim was released or pruned), a mismatched
 * token (`stale_claim_token` — a superseded incarnation), and any lease that
 * already carries a terminal disposition (`disposed`).
 */
export async function renewOwnership(input: RenewOwnershipInput): Promise<{ ok: true; value: RenewOwnershipSuccess } | OwnershipOpFailure> {
  const now = input.now ?? new Date();
  const occurred = normalizeOwnershipOccurredAt(input.occurredAt, now) ?? now;
  return withOwnershipGuard(input, async (): Promise<{ ok: true; value: RenewOwnershipSuccess } | OwnershipOpFailure> => {
    const loaded = await loadGuardedLease(input);
    if (!loaded.ok) return loaded.failure;
    const { lease } = loaded;

    if (lease.disposition) return fail("disposed");

    const expiresAt = new Date(now.getTime() + ownershipRenewTtlMs());
    // Compare-and-set against the exact token and a still-undisposed row: a
    // disposition landing concurrently makes this renewal a no-op, never a
    // resurrection of terminal ownership.
    const updated = await prisma.lease.updateMany({
      where: { id: lease.id, claimToken: input.claimToken, disposition: null },
      data: {
        expiredAt: expiresAt,
        renewedAt: now,
        lastRenewalObservedAt: now,
        lastRenewalOccurredAt: occurred,
        renewCount: { increment: 1 },
        ...(input.runRef ? { runRef: input.runRef } : {}),
        ...externalWaitData(input.externalWait),
      },
    });
    if (updated.count === 0) return fail("stale_claim_token", "Claim changed concurrently; re-read active work and retry");

    const row = await prisma.lease.findUnique({ where: { id: lease.id } });
    // The same clock and the same expiry the lease was written with: the
    // matching active AgentWork row is refreshed to the renewed ownership
    // expiry, so the stale-work sweeper cannot reclaim a worker that is
    // still renewing (#1251).
    const agentWorkHeartbeated = await heartbeatMatchingAgentWork(
      input,
      "ownership_renewed",
      input.externalWait && typeof input.externalWait === "object" ? `external wait: ${input.externalWait.reason}` : null,
      now,
      expiresAt,
    );

    return {
      ok: true as const,
      value: {
        leaseId: lease.id,
        expiresAt,
        renewCount: row?.renewCount ?? 1,
        lastRenewalObservedAt: now,
        lastRenewalOccurredAt: occurred,
        agentWorkHeartbeated,
      },
    };
  });
}

// ─── disposition ─────────────────────────────────────────────────────────────

export interface DispositionOwnershipInput extends OwnershipOpInput {
  disposition: OwnershipDisposition;
  note?: string | null;
  /** Successor agent name or PR link (e.g. for handed_off). */
  successorRef?: string | null;
  /** For `blocked`: park the claim as an external wait until this time. */
  retryAfter?: Date | null;
  waitReason?: string | null;
}

export interface DispositionOwnershipSuccess {
  replayed: boolean;
  leaseId: string;
  disposition: OwnershipDisposition;
}

const DISPOSITION_AGENT_WORK_STATE: Record<OwnershipDisposition, "DONE" | "RELEASED" | "BLOCKED"> = {
  completed: "DONE",
  released: "RELEASED",
  handed_off: "RELEASED",
  blocked: "BLOCKED",
};

/**
 * Record the terminal disposition of a claim: "I'm done" or "I died cleanly"
 * (§6.1). Durable evidence only — no GitHub label write, no lease deletion,
 * no status move (claim release stays with unclaim/#1254). Repeating the
 * same disposition is an idempotent replay; a *different* disposition after
 * a terminal one is rejected (`disposition_conflict`) — an incarnation
 * cannot rewrite its own terminal record.
 *
 * Atomicity: the terminal lease compare-and-set and every required local
 * effect (AgentWork settlement, history, lifecycle event, audit row) commit
 * as ONE `prisma.$transaction`, and the lifecycle event is written through
 * that transaction's client. The `ownership` guard has no resume branch, so a
 * throw here deletes it — a retry must re-enter the full path, which it only
 * can while the lease CAS never committed alone. Otherwise the replay branch
 * below would report success for a disposition whose AgentWork was left
 * `IN_PROGRESS` and whose `ownership_dispositioned` event never existed.
 * The guarded reads above stay outside the transaction: they only decide
 * whether there is anything to settle.
 */
export async function dispositionOwnership(input: DispositionOwnershipInput): Promise<{ ok: true; value: DispositionOwnershipSuccess } | OwnershipOpFailure> {
  const now = input.now ?? new Date();
  const occurred = normalizeOwnershipOccurredAt(input.occurredAt, now) ?? now;
  return withOwnershipGuard(input, async (): Promise<{ ok: true; value: DispositionOwnershipSuccess } | OwnershipOpFailure> => {
    const loaded = await loadGuardedLease(input);
    if (!loaded.ok) return loaded.failure;
    const { issue, lease } = loaded;

    if (lease.disposition) {
      if (lease.disposition === input.disposition) {
        return { ok: true as const, value: { replayed: true, leaseId: lease.id, disposition: lease.disposition as OwnershipDisposition } };
      }
      return fail("disposition_conflict");
    }

    // The external-wait marker only belongs to a `blocked` disposition. The
    // route rejects retryAfter on other kinds with 400; here, a terminal
    // non-blocked disposition additionally CLEARS any wait marker recorded by
    // an earlier renew, so a gone owner is never parked as EXTERNAL_WAIT in
    // the read model (which would shadow the terminal evidence).
    const waitPatch = input.disposition === "blocked"
      ? (input.retryAfter
          ? { retryAfter: input.retryAfter, waitReason: input.waitReason ?? input.note ?? null }
          : {})
      : { retryAfter: null, waitReason: null };

    // Everything from the terminal compare-and-set onward is one local fact
    // and commits together: a partial write would strand an IN_PROGRESS
    // AgentWork next to a terminal lease, or lose the required
    // `ownership_dispositioned` event behind a replay that reports success.
    return prisma.$transaction(async (tx): Promise<{ ok: true; value: DispositionOwnershipSuccess } | OwnershipOpFailure> => {
      const updated = await tx.lease.updateMany({
        where: { id: lease.id, claimToken: input.claimToken, disposition: null },
        data: {
          disposition: input.disposition,
          dispositionNote: input.note ?? null,
          successorRef: input.successorRef ?? null,
          dispositionOccurredAt: occurred,
          dispositionObservedAt: now,
          ...waitPatch,
        },
      });
      // Returning (rather than throwing) commits whatever ran before this
      // line — which is exactly nothing: the CAS is the transaction's first
      // statement, so a lost race commits an empty transaction. Keep it
      // first: any write placed above it would survive this early return.
      if (updated.count === 0) return fail("disposition_conflict", "Disposition changed concurrently; re-read and retry");

      // Settle the CURRENT claim's active AgentWork (if any) to its terminal
      // state so the execution record agrees with the declared disposition.
      // The selection is the shared freshest-active-row rule, never an
      // arbitrary active sibling: an older BLOCKED row surviving next to the
      // current IN_PROGRESS row must not absorb a `completed`/`released`
      // disposition while the current attempt stays active. History is
      // written by the same call; the lease row itself is retained as evidence.
      const work = await findCurrentClaimWork(tx, input.agentName, input.issueId);
      if (work) {
        const terminalState = DISPOSITION_AGENT_WORK_STATE[input.disposition];
        await tx.agentWork.update({
          where: { id: work.id },
          data: {
            state: terminalState,
            ...(input.disposition === "blocked" ? { blockerReason: input.note ?? work.blockerReason } : {}),
          },
        });
        await tx.agentWorkHistory.create({
          data: {
            workId: work.id,
            action: "ownership_dispositioned",
            state: terminalState,
            summary: input.note ?? `disposition=${input.disposition}`,
            blockerReason: input.disposition === "blocked" ? input.note ?? undefined : undefined,
          },
        });
      }

      await recordLifecycleEvent(tx, {
        issueId: issue.id,
        repoFullName: issue.repository.fullName,
        issueNumber: issue.number,
        kind: "ownership_dispositioned",
        source: "api:ownership",
        actor: input.actor,
        agentName: input.agentName,
        dedupeKey: lifecycleDedupeKey("ownership_dispositioned", issue.id, input.agentName, input.claimToken, input.disposition),
        occurredAt: occurred,
        observedAt: now,
        metadata: {
          disposition: input.disposition,
          note: input.note ?? null,
          successorRef: input.successorRef ?? null,
          retryAfter: input.retryAfter ? input.retryAfter.toISOString() : null,
        },
      });

      await tx.auditLog.create({
        data: {
          actor: input.actor,
          action: "ownership_disposition",
          repoFullName: issue.repository.fullName,
          issueNumber: issue.number,
          issueId: issue.id,
          beforeLabels: issue.labels,
          afterLabels: issue.labels,
          success: true,
          notes: [
            `disposition=${input.disposition}`,
            input.successorRef ? `successor=${input.successorRef}` : null,
            input.retryAfter ? `retryAfter=${input.retryAfter.toISOString()}` : null,
          ].filter(Boolean).join(" | ") || undefined,
        },
      });

      return { ok: true as const, value: { replayed: false, leaseId: lease.id, disposition: input.disposition } };
    });
  });
}
