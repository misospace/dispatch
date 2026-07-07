import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    syncLock: { findUnique: vi.fn(), create: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    issueSyncRun: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks }));

import { acquireLock, releaseLock } from "./sync-lock";

const MAX_AGE_MS = 30 * 60 * 1000;

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  // $transaction runs the callback with a tx that has the same delegates.
  mocks.$transaction.mockImplementation(async (fn: (tx: typeof mocks) => Promise<unknown>) => fn(mocks));
  mocks.issueSyncRun.create.mockResolvedValue({ id: "run-1" });
  mocks.syncLock.create.mockResolvedValue({});
  mocks.syncLock.delete.mockResolvedValue({});
  mocks.syncLock.deleteMany.mockResolvedValue({ count: 1 });
});

describe("acquireLock", () => {
  it("acquires when no lock is held (creates a run + lock row)", async () => {
    mocks.syncLock.findUnique.mockResolvedValue(null); // both the outer + in-tx checks

    const result = await acquireLock("scheduled");

    expect(result).toEqual({ locked: true, runId: "run-1" });
    expect(mocks.issueSyncRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "running", syncType: "scheduled" }) }),
    );
    expect(mocks.syncLock.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ id: "global", syncRunId: "run-1" }) }),
    );
    expect(mocks.syncLock.delete).not.toHaveBeenCalled();
  });

  it("conflicts when a fresh lock is held", async () => {
    mocks.syncLock.findUnique.mockResolvedValue({ id: "global", syncRunId: "other", acquiredAt: new Date() });

    const result = await acquireLock("manual");

    expect(result).toEqual({ locked: false });
    expect(mocks.$transaction).not.toHaveBeenCalled(); // bailed before the tx
    expect(mocks.issueSyncRun.create).not.toHaveBeenCalled();
  });

  it("reclaims a stale lock (>30 min) then acquires", async () => {
    const stale = new Date(Date.now() - (MAX_AGE_MS + 60_000));
    // outer check sees the stale lock; the in-tx re-check sees it cleared.
    mocks.syncLock.findUnique
      .mockResolvedValueOnce({ id: "global", syncRunId: "old", acquiredAt: stale })
      .mockResolvedValueOnce(null);

    const result = await acquireLock("automation");

    expect(mocks.syncLock.delete).toHaveBeenCalledWith({ where: { id: "global" } });
    expect(result).toEqual({ locked: true, runId: "run-1" });
  });

  it("conflicts when another writer wins the race inside the transaction", async () => {
    // outer check: free; in-tx re-check: someone grabbed it first.
    mocks.syncLock.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "global", syncRunId: "racer", acquiredAt: new Date() });

    const result = await acquireLock("scheduled");

    expect(result).toEqual({ locked: false });
    expect(mocks.syncLock.create).not.toHaveBeenCalled();
  });
});

describe("releaseLock", () => {
  it("deletes only this run's lock row", async () => {
    await releaseLock("run-1");
    expect(mocks.syncLock.deleteMany).toHaveBeenCalledWith({ where: { id: "global", syncRunId: "run-1" } });
  });

  it("is a safe no-op when no matching row exists (release-on-any-path)", async () => {
    // Callers release in a finally{}, so release can run after a failure that
    // never acquired (or after the row was already cleared). deleteMany matches
    // nothing → no throw.
    mocks.syncLock.deleteMany.mockResolvedValue({ count: 0 });
    await expect(releaseLock("never-acquired")).resolves.toBeUndefined();
    expect(mocks.syncLock.deleteMany).toHaveBeenCalledWith({ where: { id: "global", syncRunId: "never-acquired" } });
  });
});

describe("MAX_AGE_MS env override", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("DISPATCH_")) delete process.env[key];
    }
  });
  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to 30 minutes when no env var is set", async () => {
    delete process.env.DISPATCH_SYNC_LOCK_MAX_AGE_MS;
    const mod = await import("./sync-lock");
    expect(mod.MAX_AGE_MS).toBe(30 * 60 * 1000);
  });

  it("uses DISPATCH_SYNC_LOCK_MAX_AGE_MS when set to a valid value", async () => {
    process.env.DISPATCH_SYNC_LOCK_MAX_AGE_MS = "120000";
    const mod = await import("./sync-lock");
    expect(mod.MAX_AGE_MS).toBe(120000);
  });

  it("falls back to the default for invalid or non-positive values", async () => {
    process.env.DISPATCH_SYNC_LOCK_MAX_AGE_MS = "not-a-number";
    expect((await import("./sync-lock")).MAX_AGE_MS).toBe(30 * 60 * 1000);

    vi.resetModules();
    process.env.DISPATCH_SYNC_LOCK_MAX_AGE_MS = "0";
    expect((await import("./sync-lock")).MAX_AGE_MS).toBe(30 * 60 * 1000);

    vi.resetModules();
    process.env.DISPATCH_SYNC_LOCK_MAX_AGE_MS = "-5";
    expect((await import("./sync-lock")).MAX_AGE_MS).toBe(30 * 60 * 1000);
  });
});
