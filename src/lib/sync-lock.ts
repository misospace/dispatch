/**
 * Shared sync-locking module.
 *
 * Provides a DB-backed single-row lock (syncLock table) that all sync
 * entry-points share to prevent overlapping concurrent runs across:
 *   - Scheduled sync (`/api/sync/scheduled`)
 *   - Manual issue sync (`/api/sync`)
 *   - Automation sync (`/api/automation/sync`)
 *
 * Lock semantics:
 *   - First writer wins; subsequent writers get a 409 Conflict.
 *   - Stale locks (>30 min) are automatically cleared.
 *   - Lock is released on successful completion or failure (via try/finally).
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

/**
 * Attempt to acquire the global sync lock.
 *
 * Returns `{ locked: true, runId }` on success or `{ locked: false }` when
 * another run already holds (or has a non-stale) lock.
 *
 * Creates an IssueSyncRun record so we can track which sync type acquired it.
 */
export async function acquireLock(
  syncType: "scheduled" | "manual" | "automation",
): Promise<AcquiredLock | LockConflict> {
  try {
    const existing = await prisma.syncLock.findUnique({ where: { id: LOCK_ID } });

    if (existing && existing.syncRunId) {
      const age = Date.now() - existing.acquiredAt.getTime();
      if (age < MAX_AGE_MS) {
        return { locked: false };
      }
      // Stale lock — clear it and proceed
      await prisma.syncLock.delete({ where: { id: LOCK_ID } });
    }

    const runId = await prisma.$transaction(async (tx) => {
      // Double-check inside the transaction for race safety
      const stillExisting = await tx.syncLock.findUnique({ where: { id: LOCK_ID } });
      if (stillExisting && stillExisting.syncRunId) {
        throw new Error("already_locked");
      }

      const run = await tx.issueSyncRun.create({
        data: { status: "running", syncType, startedAt: new Date() },
      });

      await tx.syncLock.create({
        data: { id: LOCK_ID, syncRunId: run.id, acquiredAt: new Date() },
      });

      return run.id;
    });

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
