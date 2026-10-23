import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

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

export interface IssueMutationContext {
  resuming: boolean;
  /**
   * #1254: re-check, before a remote ownership write, that THIS holder still
   * owns the guard. The override path can delete this holder's `executing`
   * guard between acquisition and the remote call (a maintainer force-claim
   * stealing a silent guard); this lets a callback detect that it no longer
   * holds the anchor and back off before mutating GitHub. The residual window
   * between this read and the remote call is the same accepted
   * ownerToken-CAS-losing posture the deliberate override already takes — the
   * override's CAS is the load-bearing fence, this is the pre-write tripwire.
   */
  stillHoldsGuard: () => Promise<boolean>;
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
      // override won; the holder no longer holds the fence and must not commit
      // remote ownership writes.
      stillHoldsGuard: async () => {
        const current = await prisma.issueMutationGuard.findUnique({ where: { issueId: request.issueId } });
        return current?.ownerToken === guard.ownerToken && current.executing === true;
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
    if ((request.operation === "lease" || request.operation === "ownership") && !resuming) {
      await prisma.issueMutationGuard.deleteMany({ where: { issueId: request.issueId, ownerToken: guard.ownerToken, executing: true } });
    } else {
      await prisma.issueMutationGuard.updateMany({ where: { issueId: request.issueId, ownerToken: guard.ownerToken, executing: true }, data: { executing: false } });
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
