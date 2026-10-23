import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { githubCallBudgetMs } from "@/lib/github-auth";

export interface IssueMutationRequest {
  issueId: string;
  operation: string;
  agentName?: string;
  claimToken?: string;
  /**
   * #1254: maintainer-only deliberate override (the claim route's force=true
   * path). Takes over a guard whose holder has gone SILENT past
   * `GUARD_OVERRIDE_MIN_AGE_MS` — a crashed (or wedged-loop, or
   * DB-starved) process is the operator decision the fail-closed posture
   * defers to. Never used by automation: a normal conflicting writer still
   * gets `busy`. A holder that is alive and stamping is NEVER override-
   * eligible, however slow it is — recovering such a holder means restarting
   * its process, not stealing the anchor.
   */
  override?: boolean;
}

/**
 * #1254 review (round 4): while the callback runs, the holder stamps its
 * guard every interval, so `updatedAt` on an `executing` guard is a LIVE
 * liveness signal, not just the creation time. A live process that is merely
 * SLOW keeps stamping (the interval runs independently of the callback, and
 * the stamp uses the holder's clock — single-replica assumption inherited
 * from the scheduler, like every other window here); silence means the
 * holder could not prove liveness: dead, event-loop-blocked, or unable to
 * reach the database.
 */
export const GUARD_HEARTBEAT_MS = 60_000;

/**
 * #1254 review: minimum silence (guard `updatedAt` age while still
 * `executing`) before an operator override may clear the guard. Two enforced
 * premises make SILENCE evidence the holder cannot prove liveness
 * (crashed, loop-blocked, or DB-starved — all safe to override, see below):
 * 1. `GUARD_HEARTBEAT_MS` — every reachable live holder stamps the guard
 *    every minute (a stamping holder is never old enough to be overridden);
 * 2. #1347 — every remote call a holder can make is hard-bounded
 *    (`AbortSignal.timeout` per attempt + capped backoff in `fetchWithRetry`),
 *    so no reachable healthy operation waits on a stalled socket past the
 *    fence.
 * A silent-but-actually-live holder that resumes after an override loses
 * cleanly on the ownerToken CAS — the accepted cost of the deliberate
 * override, unchanged. The guard itself is NEVER time-expired: this bounds
 * only the deliberate, maintainer-only operator override, never an
 * automatic steal.
 */
export const GUARD_OVERRIDE_MIN_AGE_MS = 5 * GUARD_HEARTBEAT_MS;

/** Slack for the region's own local writes on top of the forge call's bound. */
const FENCED_WRITE_SLACK_MS = 15_000;

/**
 * The transaction budget of a fenced remote write (#1254 review).
 *
 * A fenced region holds the guard row's EXCLUSIVE row lock across the forge
 * call, so the transaction must NOT expire while that call is in flight: a
 * mid-flight abort would release the lock with the remote effect still
 * in flight and reopen exactly the hole the fence closes.
 *
 * The budget is the worst case of ONE mutating forge call
 * (`githubCallBudgetMs()` — the attempt chain, the capped retry backoff and a
 * cold App installation-token fetch, every term bounded by #1347) plus slack
 * for the local writes a region carries alongside its forge call.
 *
 * It is deliberately SHORTER than the override's silence window
 * (`GUARD_OVERRIDE_MIN_AGE_MS`): the fence re-stamps the guard row, and a
 * region that ran longer than the silence window would leave the row looking
 * stale the moment it committed (the heartbeat's own stamp waits behind the
 * row lock), so an operator override could steal the guard right after the
 * region's writes landed. One mutating forge call per region keeps the
 * region inside that window.
 */
export function fencedWriteTimeoutMs(): number {
  return githubCallBudgetMs() + FENCED_WRITE_SLACK_MS;
}


/**
 * The outcome of a fenced remote write: either the remote write happened
 * (while the guard row's lock was held) or the guard was lost before the
 * write could start — in which case the forge function was NEVER called.
 */
export type FencedRemoteWriteResult<T> =
  | { status: "written"; value: T }
  | { status: "guard-lost" };

export interface FencedRemoteWriteOptions {
  /**
   * The region's transaction budget, in milliseconds. The default
   * (`fencedWriteTimeoutMs()`) covers ONE mutating forge call — the region
   * invariant every fenced write follows. A region that carries MORE than one
   * mutating forge call (the capacity handoff's shared release: the
   * ownership removal plus the resting-status transition) MUST raise it to
   * the worst case of the calls it holds: a mid-region abort would release
   * the guard row's lock with a remote effect still in flight.
   */
  timeoutMs?: number;
}

export interface IssueMutationContext {
  resuming: boolean;
  /**
   * #1254: re-check that THIS holder still owns the guard. Use it for LOCAL
   * (non-forge) decisions only — a read-then-act check cannot fence a remote
   * write, because the guard can be taken between the read and the call (the
   * override's `DELETE` is a separate statement). Every remote OWNERSHIP
   * write goes through `runFencedRemoteWrite` instead, which makes the check
   * and the write one atomic step.
   */
  stillHoldsGuard: () => Promise<boolean>;
  /**
   * #1254: run a remote ownership write ATOMICALLY with the guard check.
   *
   * The implementation takes the guard row's exclusive lock (an `UPDATE`
   * inside a transaction, held until the transaction ends) and performs the
   * forge write INSIDE that lock. The override's steal (`DELETE` on the same
   * row) is therefore serialized with the write:
   *
   * - the override wins first → the guard row is gone or re-owned → the
   *   holder's `UPDATE` matches no row → `fn` is NEVER called → no forge
   *   write lands after the steal;
   * - the holder wins first → the override's `DELETE` blocks on the row lock
   *   until the holder commits, then re-evaluates its silence predicate
   *   (`updatedAt <= cutoff`) against the row the holder's `UPDATE` just
   *   re-stamped → the predicate is false → the row is skipped → the override
   *   reports `busy` and does NOT steal.
   *
   * So a steal can never commit between the check and the write THIS REGION
   * covers: there is no gap, because the check and the write share one
   * transaction. (What the fence does NOT make atomic is a SET of writes:
   * a region carries one mutating forge call, so a callback that needs two
   * writes runs two regions — and a steal between them leaves the first one
   * applied.)
   *
   * The region MUST carry exactly ONE mutating forge call by default (see
   * `fencedWriteTimeoutMs`) and MUST NOT start another interactive
   * transaction of its own — the callback receives the transaction client so
   * local writes join the fenced transaction instead of nesting.
   */
  runFencedRemoteWrite: <T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: FencedRemoteWriteOptions,
  ) => Promise<FencedRemoteWriteResult<T>>;
}
export type IssueMutationResult<T> =
  | { status: "busy"; ownerToken: string; operation: string }
  | { status: "completed"; value: T }
  | { status: "retained"; ownerToken: string; value: T };

/** A committed guard is a fail-closed executor fence; it is never time-expired. */
export async function withIssueMutationGuard<T>(
  request: IssueMutationRequest,
  callback: (tx: Prisma.TransactionClient | undefined, context: IssueMutationContext) => Promise<{ complete: boolean; value: T }>,
): Promise<IssueMutationResult<T>> {
  const ownerToken = crypto.randomUUID();
  let created = false;
  try {
    // `override` is a caller directive, never a column: strip it from the
    // row shape or every create fails Prisma validation.
    const { override: _override, ...createRequest } = request;
    await prisma.issueMutationGuard.create({ data: { ...createRequest, ownerToken, executing: true } });
    created = true;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) && (typeof error !== "object" || error === null || !("code" in error))) throw error;
    if ((error as { code?: string }).code !== "P2002") throw error;
  }

  let guard = created ? await prisma.issueMutationGuard.findUnique({ where: { issueId: request.issueId } }) : null;
  let resuming = false;
  let overrode = false;
  if (!created) {
    guard = await prisma.issueMutationGuard.findUnique({ where: { issueId: request.issueId } });
    if (!guard) return { status: "busy", ownerToken, operation: request.operation };
    // Operator override (maintainer force-claim): a guard left `executing` by
    // a crashed process is otherwise un-recoverable in-product; the explicit
    // operator decision removes it and the caller proceeds under a fresh
    // guard. Deliberately narrower than resuming: it does not run the stale
    // writer's callback, it discards it.
    //
    // #1254 review: the delete is age-fenced on `updatedAt`, which a live
    // holder stamps every `GUARD_HEARTBEAT_MS` (see the heartbeat below) —
    // so the fence measures SILENCE, not elapsed work. An executing guard
    // with a fresh stamp belongs to a LIVE writer (retryable busy); only one
    // silent past `GUARD_OVERRIDE_MIN_AGE_MS` — longer than any heartbeat
    // interval and any bounded remote call (#1347) — can be a crashed
    // holder. The CAS on ownerToken+executing still loses cleanly if the
    // writer finished or re-acquired first.
    //
    // #1254 review (the fenced remote write): the steal predicate now also
    // excludes a guard whose holder is INSIDE a fenced remote write. The
    // holder's fenced transaction holds the guard row's exclusive lock for
    // the whole forge call, so this `DELETE` blocks on that lock; when the
    // holder commits, the `DELETE` re-evaluates its predicate against the
    // re-stamped row (the fenced `UPDATE` refreshes `updatedAt`) — the
    // silence predicate `updatedAt <= cutoff` is false, the row is skipped,
    // `removed.count !== 1`, and the override reports `busy` WITHOUT
    // stealing. The operator's force-claim therefore WAITS for the in-flight
    // fenced write (bounded by the region's own transaction budget,
    // `fencedWriteTimeoutMs`) and is then told the issue is busy; it never
    // waits unboundedly, because that budget is what bounds the lock hold.
    // If the override's `DELETE` wins the race instead, the holder's fenced
    // `UPDATE` matches no row and the forge write is never issued
    // (`runFencedRemoteWrite` → `guard-lost`).
    if (request.override === true && guard.executing) {
      const overrideCutoff = new Date(Date.now() - GUARD_OVERRIDE_MIN_AGE_MS);
      const removed = await prisma.issueMutationGuard.deleteMany({
        where: { issueId: request.issueId, ownerToken: guard.ownerToken, executing: true, updatedAt: { lte: overrideCutoff } },
      });
      if (removed.count !== 1) return { status: "busy", ownerToken: guard.ownerToken, operation: guard.operation };
      overrode = true;
    }
  }
  if (overrode) {
    // The override removed the stale guard: acquire fresh (depth 2 — the
    // recursive create cannot hit the override branch again). A resuming
    // writer that re-acquired its guard inside the delete window loses the
    // race; its own writes are intent/epoch-fenced, so nothing is corrupted —
    // this is the accepted cost of a deliberate operator override.
    return withIssueMutationGuard(request, callback);
  }
  if (!created) {
    if (guard === null) return { status: "busy", ownerToken, operation: request.operation };
    const exactRelease = request.operation === "capacity-release" && guard.operation === request.operation
      && request.agentName !== undefined && request.claimToken !== undefined
      && guard.agentName === request.agentName && guard.claimToken === request.claimToken;
    const exactClaim = request.operation === "claim" && guard.operation === "claim"
      && request.agentName !== undefined && guard.agentName === request.agentName;
    // #1251: the stale-work sweep fences its whole decide-and-release pipeline
    // under this operation. Its recovery path is the next sweep: every step is
    // a conditional update keyed off the persisted row state (STALE + the
    // pending-release marker) and the external release is deduped per claim
    // epoch, so re-entering after a crash mid-guard is safe. A guard left
    // `executing` by a dead sweep process stays fail-closed (never
    // time-expired) exactly like a crashed claim guard: operator-visible, not
    // silently stolen.
    const exactStaleRelease = request.operation === "stale-release" && guard.operation === "stale-release"
      && request.agentName !== undefined && guard.agentName === request.agentName;
    // #1254: the reconciler's release protocol and the direct-assign path
    // resume a guard demoted by a failed attempt the same way the stale-work
    // sweep does — every step is a conditional update or an idempotent remote
    // write keyed off the persisted intent row, so re-entering after a crash
    // mid-guard is safe. A guard left `executing` by a dead process stays
    // fail-closed (never time-expired), exactly like every other operation.
    const exactReconcileRelease = request.operation === "reconcile-release" && guard.operation === "reconcile-release"
      && request.agentName !== undefined && guard.agentName === request.agentName;
    const exactAssign = request.operation === "assign" && guard.operation === "assign";
    if ((!exactRelease && !exactClaim && !exactStaleRelease && !exactReconcileRelease && !exactAssign) || guard.executing) return { status: "busy", ownerToken: guard.ownerToken, operation: guard.operation };
    const acquired = await prisma.issueMutationGuard.updateMany({
      where: { issueId: request.issueId, ownerToken: guard.ownerToken, executing: false }, data: { executing: true },
    });
    if (!acquired.count) return { status: "busy", ownerToken: guard.ownerToken, operation: guard.operation };
    resuming = true;
  }
  if (!guard) return { status: "busy", ownerToken, operation: request.operation };

  // #1254 review round 4: liveness heartbeat. While this holder runs, stamp
  // the guard every `GUARD_HEARTBEAT_MS` so an `executing` row's `updatedAt`
  // means "the owning process was alive then". The interval runs alongside
  // the callback (a slow-but-alive holder keeps stamping; a dead process,
  // a blocked event loop, or a holder that cannot reach the DB goes
  // silent), it is CAS-scoped to this owner's executing guard, and it is
  // best-effort: a missed stamp only makes a still-live row look older —
  // the residual override race it opens is the same ownerToken-CAS-losing
  // cost the deliberate override already accepts. `unref` so a pending tick
  // never pins the loop.
  const heartbeat = setInterval(() => {
    try {
      void Promise.resolve(
        prisma.issueMutationGuard.updateMany({
          where: { issueId: request.issueId, ownerToken: guard.ownerToken, executing: true },
          data: { updatedAt: new Date() },
        }),
      ).catch(() => undefined);
    } catch {
      // Best-effort liveness stamp (test fakes may not return promises).
    }
  }, GUARD_HEARTBEAT_MS);
  if (typeof (heartbeat as { unref?: () => void }).unref === "function") {
    (heartbeat as { unref: () => void }).unref();
  }

  try {
    const result = await callback(undefined, {
      resuming,
      // #1254: re-read the anchor and compare it against the token this holder
      // captured on acquisition. A deleted-or-re-owned guard means the
      // override won. This is a LOCAL decision only (a read-then-act check
      // cannot fence a remote write) — remote ownership writes go through
      // `runFencedRemoteWrite` below.
      stillHoldsGuard: async () => {
        const current = await prisma.issueMutationGuard.findUnique({ where: { issueId: request.issueId } });
        return current?.ownerToken === guard.ownerToken && current.executing === true;
      },
      // #1254 review: the ATOMIC fenced remote write. The `UPDATE` inside the
      // transaction takes the guard row's exclusive row lock (held until the
      // transaction ends) and refreshes the liveness stamp (`updatedAt`); the
      // forge write then runs INSIDE that lock. The override's steal
      // (`DELETE` on the same row) is serialized with it, so a steal can
      // never commit between the check and the write:
      // - override first → the row is gone/re-owned → `updateMany` matches no
      //   row → `fn` is NEVER called → `guard-lost`, no remote write;
      // - holder first → the override's `DELETE` blocks on the row lock and
      //   then fails its silence predicate (the `UPDATE` re-stamped
      //   `updatedAt`) → the override reports `busy` and does not steal.
      runFencedRemoteWrite: async <T>(
        fn: (tx: Prisma.TransactionClient) => Promise<T>,
        options?: FencedRemoteWriteOptions,
      ): Promise<FencedRemoteWriteResult<T>> => {
        const outcome = await prisma.$transaction(async (tx) => {
          const held = await tx.issueMutationGuard.updateMany({
            where: { issueId: request.issueId, ownerToken: guard.ownerToken, executing: true },
            // The liveness stamp is set EXPLICITLY rather than left to the
            // column's `@updatedAt` handling: the override's steal predicate
            // is `updatedAt <= cutoff` (SILENCE), so the re-stamp that keeps a
            // guard inside a fenced write un-stealable must not depend on the
            // engine refreshing an `@updatedAt` column inside this update.
            data: { executing: true, updatedAt: new Date() },
          });
          // The guard was deleted or re-owned between acquisition and this
          // write: the anchor moved on, so NO remote write may happen.
          if (held.count !== 1) return null;
          const value = await fn(tx);
          return { value };
        }, {
          // The budget must dominate the worst case of the mutating forge
          // call(s) the region holds, or the transaction could abort with a
          // remote effect still in flight (which would release the row lock
          // and reopen the hole). `maxWait` keeps pool waiters failing fast
          // instead of queueing behind the held connection.
          timeout: options?.timeoutMs ?? fencedWriteTimeoutMs(),
          maxWait: 5_000,
        });
        return outcome === null
          ? { status: "guard-lost" }
          : { status: "written", value: outcome.value };
      },
    });
    if (result.complete) {
      await prisma.issueMutationGuard.deleteMany({ where: { issueId: request.issueId, ownerToken: guard.ownerToken, executing: true } });
      return { status: "completed", value: result.value };
    }
    await prisma.issueMutationGuard.updateMany({ where: { issueId: request.issueId, ownerToken: guard.ownerToken, executing: true }, data: { executing: false } });
    return { status: "retained", ownerToken: guard.ownerToken, value: result.value };
  } catch (error) {
    // #1251: "ownership" writes are idempotent, Postgres-only, and fenced on
    // the claim token — there is no partial remote effect to preserve, so a
    // failed ownership attempt must not leave an unrecoverable guard behind
    // (its resume branch does not exist by design). Same posture as "lease".
    //
    // #1361: "unassign" joins them. It has no resume branch either (only an
    // `unassign` attempt can take over an `unassign` guard, and the route
    // never leaves one behind: it releases the guard on every handled path),
    // so a failed attempt must not leave a demoted `executing: false` row
    // behind — that row is invisible to the ownership inspect surface (which
    // lists `executing` guards only) and would wedge EVERY writer on the
    // issue, claims included, with no operator-visible way to clear it.
    //
    // #1367: same posture for "unclaim" — it also has no resume branch (only
    // an `unclaim` attempt could take over an `unclaim` guard), and its route
    // releases the anchor on every handled path (the callback catches its own
    // failures), so a failed attempt deletes its guard row instead of leaving
    // a demoted `executing: false` row that no one can resume — invisible to
    // the ownership inspect surface (which lists `executing` guards only) and
    // wedging every writer on the issue.
    if ((request.operation === "lease" || request.operation === "ownership" || request.operation === "unassign" || request.operation === "unclaim") && !resuming) {
      await prisma.issueMutationGuard.deleteMany({ where: { issueId: request.issueId, ownerToken: guard.ownerToken, executing: true } });
    } else {
      await prisma.issueMutationGuard.updateMany({ where: { issueId: request.issueId, ownerToken: guard.ownerToken, executing: true }, data: { executing: false } });
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
