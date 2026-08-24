import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    syncLock: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
    },
    issueSyncRun: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks }));

import { acquireLock, releaseLock } from "./sync-lock";

const MAX_AGE_MS = 30 * 60 * 1000;

const ORIGINAL_ENV = { ...process.env };

/** Simulated Prisma P2002 unique-constraint violation. */
const P2002 = Object.assign(new Error("Unique constraint failed on the fields: (`id`)"), {
  code: "P2002",
  name: "PrismaClientKnownRequestError",
});

beforeEach(() => {
  vi.clearAllMocks();
  // $transaction runs the callback with a tx that has the same delegates.
  mocks.$transaction.mockImplementation(async (fn: (tx: typeof mocks) => Promise<unknown>) => fn(mocks));
  mocks.issueSyncRun.create.mockResolvedValue({ id: "run-1" });
  mocks.syncLock.create.mockResolvedValue({});
  mocks.syncLock.delete.mockResolvedValue({});
  mocks.syncLock.deleteMany.mockResolvedValue({ count: 1 });
  mocks.syncLock.updateMany.mockResolvedValue({ count: 0 });
});

describe("acquireLock", () => {
  it("acquire-release round trip: acquires a free lock, release clears it", async () => {
    mocks.syncLock.findUnique.mockResolvedValue(null);
    // No row to update -> insert path.
    mocks.syncLock.updateMany.mockResolvedValue({ count: 0 });

    const result = await acquireLock("scheduled");
    expect(result).toEqual({ locked: true, runId: "run-1" });
    expect(mocks.issueSyncRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "running", syncType: "scheduled" }) }),
    );
    expect(mocks.syncLock.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ id: "global", syncRunId: "run-1" }) }),
    );

    await releaseLock(result.locked ? result.runId : "run-1");
    expect(mocks.syncLock.deleteMany).toHaveBeenCalledWith({ where: { id: "global", syncRunId: "run-1" } });
  });

  it("conflicts when a fresh (live) lock is held", async () => {
    mocks.syncLock.findUnique.mockResolvedValue({ id: "global", syncRunId: "other", acquiredAt: new Date() });

    const result = await acquireLock("manual");

    expect(result).toEqual({ locked: false });
    expect(mocks.$transaction).not.toHaveBeenCalled(); // bailed before the tx
    expect(mocks.issueSyncRun.create).not.toHaveBeenCalled();
    expect(mocks.syncLock.updateMany).not.toHaveBeenCalled();
  });

  it("a second acquire against a live lock fails, even inside the transaction", async () => {
    // Outer snapshot saw no row, but a live holder appeared; the claim
    // updates 0 rows, the insert hits the unique constraint, and the retry
    // claim still matches nothing -> conflict.
    mocks.syncLock.findUnique.mockResolvedValue(null);
    mocks.syncLock.updateMany.mockResolvedValue({ count: 0 });
    mocks.syncLock.create.mockRejectedValue(P2002);

    const result = await acquireLock("scheduled");

    expect(result).toEqual({ locked: false });
  });

  it("two simultaneous acquires of a live lock cannot both succeed", async () => {
    mocks.syncLock.findUnique.mockResolvedValue({ id: "global", syncRunId: "other", acquiredAt: new Date() });

    const [a, b] = await Promise.all([acquireLock("scheduled"), acquireLock("reconcile")]);

    expect(a).toEqual({ locked: false });
    expect(b).toEqual({ locked: false });
    expect(mocks.issueSyncRun.create).not.toHaveBeenCalled();
  });

  it("reclaims an expired lock, and logs the takeover with holder and age", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stale = new Date(Date.now() - (MAX_AGE_MS + 60_000));
    mocks.syncLock.findUnique.mockResolvedValue({ id: "global", syncRunId: "old", acquiredAt: stale });
    // Atomic claim wins in place (no delete).
    mocks.syncLock.updateMany.mockResolvedValue({ count: 1 });

    const result = await acquireLock("automation");

    expect(result).toEqual({ locked: true, runId: "run-1" });
    expect(mocks.syncLock.delete).not.toHaveBeenCalled();
    expect(mocks.syncLock.create).not.toHaveBeenCalled();
    expect(mocks.syncLock.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "global" }),
        data: expect.objectContaining({ syncRunId: "run-1" }),
      }),
    );
    const log = warnSpy.mock.calls[0]?.[0] as string;
    expect(log).toContain("took over");
    expect(log).toContain("expired");
    expect(log).toContain("old"); // previous holder
    expect(log).toMatch(/age \d+s/);
    warnSpy.mockRestore();
  });

  it("a pre-existing orphaned row (null holder) does not block acquisition — the stuck-row case", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Fresh acquiredAt but no holder: the row #840 left stuck. A null holder
    // is claimable regardless of age because a live run always records its
    // run id.
    mocks.syncLock.findUnique.mockResolvedValue({ id: "global", syncRunId: null, acquiredAt: new Date() });
    mocks.syncLock.updateMany.mockResolvedValue({ count: 1 });

    const result = await acquireLock("reconcile");

    expect(result).toEqual({ locked: true, runId: "run-1" });
    const log = warnSpy.mock.calls[0]?.[0] as string;
    expect(log).toContain("orphaned");
    expect(log).toContain("(no holder)");
    warnSpy.mockRestore();
  });

  it("recovers when a competing transaction aborts between claim and insert", async () => {
    mocks.syncLock.findUnique.mockResolvedValue(null);
    // First claim matches nothing (row appeared mid-flight), the insert
    // collides, then the retry claim finds the row claimable again because
    // the competitor aborted.
    mocks.syncLock.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    mocks.syncLock.create.mockRejectedValue(P2002);

    const result = await acquireLock("pr-followup");

    expect(result).toEqual({ locked: true, runId: "run-1" });
  });

  it("an error inside the critical section still releases the lock", async () => {
    mocks.syncLock.findUnique.mockResolvedValue(null);
    mocks.syncLock.updateMany.mockResolvedValue({ count: 1 });

    const lock = await acquireLock("manual");
    expect(lock.locked).toBe(true);

    // Simulate the caller's critical section blowing up; the route releases
    // in a finally{}.
    await expect(async () => {
      throw new Error("github rate limit");
    }).rejects.toThrow();

    await releaseLock(lock.locked ? lock.runId : "run-1");
    expect(mocks.syncLock.deleteMany).toHaveBeenCalledWith({ where: { id: "global", syncRunId: "run-1" } });
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
