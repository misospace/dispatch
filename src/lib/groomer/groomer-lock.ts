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
 * lock (>30 min) is reclaimed; the lock is released in a try/finally.
 */

import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";

const LOCK_ID = "groomer" as const;
const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

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

/** Release the groomer run lock. Conditional on the token so we never release another run's lock. */
export async function releaseGroomerLock(token: string): Promise<void> {
  await prisma.syncLock.deleteMany({ where: { id: LOCK_ID, syncRunId: token } });
}
