import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for acquireLock + releaseLock.
 *
 * These cover the same surface as before — holder-scoped release, logged
 * takeover of an expired/orphaned lock, and the "two simultaneous
 * acquisitions of a live lock cannot both succeed" rule — using a mocked
 * Prisma client.
 *
 * The mocked-Prisma layer cannot exercise Postgres's aborted-transaction
 * semantics by construction: a mocked `create` that rejects with a
 * P2002-shaped object models the error being returned, but real Postgres
 * aborts the surrounding transaction on the first failing statement, and
 * nothing in application code can un-abort it (dispatch#850). That class
 * of bug is covered by `sync-lock.integration.test.ts`, which runs against
 * a real Postgres when DISPATCH_TEST_DATABASE_URL is set.
 */
describe("acquireLock + releaseLock (mocked Prisma)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("acquires the lock when no row exists and releases only when the holder matches", async () => {
    const releaseCalls: Array<{ where: { id: string; syncRunId: string } }> = [];
    vi.doMock("@/lib/prisma", () => ({
      prisma: {
        syncLock: {
          findUnique: vi.fn(async () => null),
          updateMany: vi.fn(async () => ({ count: 0 })),
          deleteMany: vi.fn(async (args: { where: { id: string; syncRunId: string } }) => {
            releaseCalls.push(args);
            return { count: args.where.syncRunId === "run-1" ? 1 : 0 };
          }),
        },
        issueSyncRun: {
          create: vi.fn(async () => ({ id: "run-1", status: "running" })),
        },
        $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
          const tx = {
            issueSyncRun: {
              create: vi.fn(async () => ({ id: "run-1" })),
            },
            syncLock: {
              updateMany: vi.fn(async () => ({ count: 0 })),
            },
            // INSERT ... ON CONFLICT DO NOTHING lives on the transaction
            // client directly, not on tx.syncLock — Prisma's typed
            // $executeRaw is part of the transaction wrapper.
            $executeRaw: vi.fn(async () => 1),
          };
          return cb(tx);
        }),
      },
    }));
    const mod = await import("./sync-lock");
    const acquireLock = mod.acquireLock as (
      t: "manual",
    ) => Promise<{ locked: boolean; runId?: string }>;
    const releaseLock = mod.releaseLock as (runId: string) => Promise<void>;

    const result = await acquireLock("manual");
    expect(result).toMatchObject({ locked: true });
    expect(typeof result.runId).toBe("string");

    // Should not throw — we hold the lock we just acquired.
    await releaseLock(result.runId as string);
    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0]?.where.syncRunId).toBe(result.runId);
  });

  it("logs a takeover of an expired lock with previous holder and age", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const oldAcquiredAt = new Date(Date.now() - 60 * 60 * 1000);
    vi.doMock("@/lib/prisma", () => ({
      prisma: {
        syncLock: {
          findUnique: vi.fn(async () => ({
            id: "global",
            syncRunId: "old-run",
            acquiredAt: oldAcquiredAt,
          })),
          updateMany: vi.fn(async () => ({ count: 1 })),
          deleteMany: vi.fn(async () => ({ count: 1 })),
        },
        issueSyncRun: {
          create: vi.fn(async () => ({ id: "run-2", status: "running" })),
        },
        $transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
          cb({
            issueSyncRun: {
              create: vi.fn(async () => ({ id: "run-2" })),
            },
            syncLock: {
              updateMany: vi.fn(async () => ({ count: 1 })),
            },
            $executeRaw: vi.fn(async () => 0),
          }),
        ),
      },
    }));
    const mod = await import("./sync-lock");
    const acquireLock = mod.acquireLock as (
      t: "manual",
    ) => Promise<{ locked: boolean; runId?: string }>;

    const result = await acquireLock("manual");
    expect(result).toMatchObject({ locked: true });
    expect(warn).toHaveBeenCalled();
    const message = String(warn.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("sync-lock");
    expect(message).toContain("old-run");
    expect(message).toContain("expired");
  });

  it("returns conflict without entering the transaction when a live lock is held", async () => {
    const freshAcquiredAt = new Date(Date.now() - 5_000);
    const txMock = vi.fn();
    vi.doMock("@/lib/prisma", () => ({
      prisma: {
        syncLock: {
          findUnique: vi.fn(async () => ({
            id: "global",
            syncRunId: "live-run",
            acquiredAt: freshAcquiredAt,
          })),
          updateMany: vi.fn(async () => ({ count: 0 })),
          deleteMany: vi.fn(async () => ({ count: 0 })),
        },
        issueSyncRun: {
          create: vi.fn(async () => ({ id: "new-run", status: "running" })),
        },
        $transaction: txMock,
      },
    }));
    const mod = await import("./sync-lock");
    const acquireLock = mod.acquireLock as (
      t: "manual",
    ) => Promise<{ locked: boolean; runId?: string }>;

    const result = await acquireLock("manual");
    expect(result).toEqual({ locked: false });
    // Fast-path conflict must NOT enter the transaction, otherwise a
    // contended scheduler tick would create a new IssueSyncRun row for
    // every tick — the loser-path tests rely on no rows being created.
    expect(txMock).not.toHaveBeenCalled();
  });
});