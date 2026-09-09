/**
 * Groomer run lock.
 *
 * A DB-backed single-row lock that serializes hosted-groomer runs. Without it,
 * two concurrent runs can both select the same candidate before either acquires
 * the per-issue lease (selection in selector.ts and lease acquisition in run.ts
 * are not atomic), causing a duplicate LLM call + duplicate label writes.
 *
 * Mirrors src/lib/sync-lock.ts, reusing the generic `sync_lock` table with a
 * distinct id ("groomer") — its `syncRunId` column is a plain nullable string
 * (no FK), used here to hold a random lock token. First writer wins; a stale
 * lock is reclaimed; the lock is released in a try/finally.
 *
 * The lock is heartbeated while a run is in flight (see heartbeatGroomerLock):
 * a live holder keeps its `acquiredAt` fresh, so MAX_AGE_MS can be a small
 * multiple of the heartbeat interval rather than an upper bound on run length.
 * A holder SIGKILL'd mid-run (rollout, eviction, OOM) stops heartbeating, and
 * its orphaned lock is reclaimable in ~90s instead of 30 minutes (dispatch#967).
 */

import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";

const LOCK_ID = "groomer" as const;
/** How often a live run refreshes its lock's acquiredAt. */
export const HEARTBEAT_MS = 30 * 1000; // 30 seconds
/**
 * A lock is stale once it is older than this. Three heartbeat intervals: a
 * live holder refreshes every 30s, so a healthy lock never ages past ~30s,
 * while a dead holder's lock is reclaimable within ~90s.
 */
const MAX_AGE_MS = 3 * HEARTBEAT_MS; // 90 seconds

export type GroomerLock = { locked: true; token: string } | { locked: false };

/** Attempt to acquire the groomer run lock. */
export async function acquireGroomerLock(): Promise<GroomerLock> {
  const existing = await prisma.syncLock.findUnique({ where: { id: LOCK_ID } });
  if (existing && existing.syncRunId) {
    const age = Date.now() - existing.acquiredAt.getTime();
    if (age < MAX_AGE_MS) {
      return { locked: false };
    }
    // Stale lock — clear it and proceed.
    await prisma.syncLock.delete({ where: { id: LOCK_ID } });
  }

  const token = randomUUID();
  try {
    await prisma.$transaction(async (tx) => {
      // Double-check inside the transaction for race safety.
      const stillExisting = await tx.syncLock.findUnique({ where: { id: LOCK_ID } });
      if (stillExisting && stillExisting.syncRunId) {
        throw new Error("already_locked");
      }
      await tx.syncLock.create({ data: { id: LOCK_ID, syncRunId: token, acquiredAt: new Date() } });
    });
  } catch (err) {
    if (err instanceof Error && err.message === "already_locked") {
      return { locked: false };
    }
    throw err;
  }

  return { locked: true, token };
}

/**
 * Refresh the lock's acquiredAt so a long run is never mistaken for a stale
 * one. Conditional on the token: if the lock was reclaimed or released
 * underneath us (e.g. a takeover after a DB blip), the update matches 0 rows
 * and we simply stop heartbeating — we never refresh a lock we no longer hold.
 */
export async function heartbeatGroomerLock(token: string): Promise<void> {
  await prisma.syncLock.updateMany({
    where: { id: LOCK_ID, syncRunId: token },
    data: { acquiredAt: new Date() },
  });
}

/** Release the groomer run lock. Conditional on the token so we never release another run's lock. */
export async function releaseGroomerLock(token: string): Promise<void> {
  await prisma.syncLock.deleteMany({ where: { id: LOCK_ID, syncRunId: token } });
}
