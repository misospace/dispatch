/**
 * Shared sync-locking module.
 *
 * Provides a DB-backed single-row lock (syncLock table) that all sync
 * entry-points share to prevent overlapping concurrent runs across:
 *   - Scheduled sync (`/api/sync/scheduled`)
 *   - Manual issue sync (`/api/sync`)
 *   - Automation sync (`/api/automation/sync`)
 *   - PR follow-up sync (`/api/pr-followup/sync`)
 *   - Issue reconciliation (`/api/issues/reconcile`)
 *
 * Lock semantics:
 *   - First writer wins; subsequent writers get a 409 Conflict.
 *   - Acquisition is an atomic conditional UPDATE (claim) with an INSERT only
 *     when no row exists — an existing row is never fatal, so a row left
 *     behind by a crashed holder cannot wedge the job (dispatch#840).
 *   - Locks expire: a row older than the TTL (default 30 min, see MAX_AGE_MS)
 *     is reclaimable, as is any row with no recorded holder (an orphaned row
 *     is by definition not held by a live run, which always records its run
 *     id). Takeovers are logged with the previous holder and its age.
 *   - Lock is released on successful completion or failure (via try/finally).
 *
 * TTL rationale: the default 30 minutes is a conservative upper bound on the
 * worst-case run of these jobs — a sync of a large repository pages through
 * thousands of GitHub API items and a reconciliation re-checks every linked
 * PR, both under GitHub rate limits. A crashed holder therefore cannot block
 * the job for more than 30 minutes. Larger deployments with runs that can
 * legitimately exceed that can raise it via DISPATCH_SYNC_LOCK_MAX_AGE_MS;
 * lowering it only makes takeover more eager (a still-live but slow run gets
 * its lock reclaimed mid-flight), so the default errs on the slow side.
 */

import { prisma } from "@/lib/prisma";

const LOCK_ID = "global" as const;
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Maximum age (ms) before a lock is considered stale and eligible for reclaim.
 *
 * Default is 30 minutes. Override with `DISPATCH_SYNC_LOCK_MAX_AGE_MS` for
 * deployments where a single sync run may take longer than 30 minutes (e.g.
 * large repos with thousands of issues spread across multiple pages). The
 * value must be at least 1 ms; invalid or missing values fall back to the
 * default.
 */
export const MAX_AGE_MS = (() => {
  const raw = process.env.DISPATCH_SYNC_LOCK_MAX_AGE_MS;
  if (!raw) return DEFAULT_MAX_AGE_MS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_AGE_MS;
})();

export interface AcquiredLock {
  locked: true;
  runId: string;
}

export interface LockConflict {
  locked: false;
}

export type SyncType =
  | "scheduled"
  | "manual"
  | "automation"
  | "pr-followup"
  | "reconcile";

/**
 * Where-clause for the atomic claim: a row is claimable when it has no
 * recorded holder (an orphan — nothing can be holding the lock without one,
 * since every acquisition records its run id) or when it is older than the
 * TTL. A fresh row with a live holder matches neither, so two simultaneous
 * acquisitions of a live lock can never both succeed.
 */
function claimableWhere(): Record<string, unknown> {
  return {
    id: LOCK_ID,
    OR: [
      { syncRunId: null },
      { acquiredAt: { lt: new Date(Date.now() - MAX_AGE_MS) } },
    ],
  };
}

/** True when Prisma reports a unique-constraint violation (P2002). */
function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/**
 * Attempt to acquire the global sync lock.
 *
 * Returns `{ locked: true, runId }` on success or `{ locked: false }` when
 * another run already holds a live (non-expired) lock.
 *
 * Creates an IssueSyncRun record so we can track which sync type acquired it.
 *
 * The claim is an atomic `UPDATE ... WHERE <claimable>` followed by an
 * `INSERT` only when no row exists. Unlike the previous check-then-create
 * flow, an existing row is never fatal: a row with a null holder (the stuck
 * row from dispatch#840) or an expired row is taken over in place, and the
 * row-level lock of the UPDATE serializes concurrent claimants so exactly
 * one wins a stale row.
 */
export async function acquireLock(
  syncType: SyncType,
): Promise<AcquiredLock | LockConflict> {
  const existing = await prisma.syncLock.findUnique({ where: { id: LOCK_ID } });

  // Fast path: a live lock conflicts without creating a run record, so
  // scheduler ticks during a running sync don't pollute the sync history.
  if (existing?.syncRunId) {
    const age = Date.now() - existing.acquiredAt.getTime();
    if (age < MAX_AGE_MS) {
      return { locked: false };
    }
  }

  try {
    const runId = await prisma.$transaction(async (tx) => {
      const run = await tx.issueSyncRun.create({
        data: { status: "running", syncType, startedAt: new Date() },
      });

      // Atomic conditional claim. count === 1 wins; count === 0 means no
      // claimable row (absent, or held live).
      const claimed = await tx.syncLock.updateMany({
        where: claimableWhere(),
        data: { syncRunId: run.id, acquiredAt: new Date() },
      });
      if (claimed.count === 1) return run.id;

      // No row to update: an insert wins only when the row is absent
      // entirely (e.g. first run, or after a release).
      try {
        await tx.syncLock.create({
          data: { id: LOCK_ID, syncRunId: run.id, acquiredAt: new Date() },
        });
        return run.id;
      } catch (err) {
        if (!isUniqueConstraintViolation(err)) throw err;
        // The row appeared between the update and the insert. If a
        // competing transaction just aborted and left the row claimable
        // again (stale or orphaned), take it; otherwise a live lock holds
        // it and we conflict. Retrying the update avoids a spurious
        // conflict in that abort race.
        const retry = await tx.syncLock.updateMany({
          where: claimableWhere(),
          data: { syncRunId: run.id, acquiredAt: new Date() },
        });
        if (retry.count === 1) return run.id;
        throw new Error("already_locked");
      }
    });

    // Log a takeover only when we actually won it, with the previous holder
    // and its age, so a recurring takeover is visible rather than silent.
    if (existing) {
      const holder = existing.syncRunId ?? "(no holder)";
      const age = Date.now() - existing.acquiredAt.getTime();
      console.warn(
        `[sync-lock] ${syncType}: took over ${existing.syncRunId ? "expired" : "orphaned"} lock row held by ${holder} (age ${Math.round(age / 1000)}s)`,
      );
    }

    return { locked: true, runId };
  } catch (err) {
    if (err instanceof Error && err.message === "already_locked") {
      return { locked: false };
    }
    throw err;
  }
}

/**
 * Release the global sync lock for the given run.
 * Uses a conditional delete to avoid releasing another run's lock.
 */
export async function releaseLock(runId: string): Promise<void> {
  await prisma.syncLock.deleteMany({
    where: { id: LOCK_ID, syncRunId: runId },
  });
}
