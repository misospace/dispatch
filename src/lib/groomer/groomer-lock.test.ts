import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    syncLock: {
      findUnique: vi.fn(),
      delete: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import { prisma } from "@/lib/prisma";

import { acquireGroomerLock, releaseGroomerLock } from "./groomer-lock";

const findUnique = prisma.syncLock.findUnique as ReturnType<typeof vi.fn>;
const deleteRow = prisma.syncLock.delete as ReturnType<typeof vi.fn>;
const create = prisma.syncLock.create as ReturnType<typeof vi.fn>;
const deleteMany = prisma.syncLock.deleteMany as ReturnType<typeof vi.fn>;
const transaction = prisma.$transaction as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("acquireGroomerLock", () => {
  describe("no existing lock", () => {
    it("acquires the lock and returns a token", async () => {
      findUnique.mockResolvedValueOnce(null);
      // Inside the transaction: still no existing row.
      const txMock = {
        syncLock: { findUnique: vi.fn().mockResolvedValueOnce(null), create },
      };
      create.mockResolvedValueOnce({ id: "groomer", syncRunId: "tok", acquiredAt: new Date() });
      transaction.mockImplementationOnce(async (cb: (tx: typeof txMock) => Promise<void>) =>
        cb(txMock),
      );

      const result = await acquireGroomerLock();

      expect(result).toMatchObject({ locked: true });
      if (result.locked) {
        expect(typeof result.token).toBe("string");
        expect(result.token.length).toBeGreaterThan(0);
      }
      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({ id: "groomer" }),
      });
    });
  });

  describe("active existing lock", () => {
    it("returns { locked: false } when an unexpired lock is present", async () => {
      const acquiredAt = new Date(Date.now() - 5 * 60 * 1000); // 5 min old
      findUnique.mockResolvedValueOnce({
        id: "groomer",
        syncRunId: "someone-else",
        acquiredAt,
      });

      const result = await acquireGroomerLock();

      expect(result).toEqual({ locked: false });
      expect(transaction).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it("returns { locked: false } for a brand-new (zero-age) lock", async () => {
      findUnique.mockResolvedValueOnce({
        id: "groomer",
        syncRunId: "fresh",
        acquiredAt: new Date(),
      });

      const result = await acquireGroomerLock();

      expect(result).toEqual({ locked: false });
      expect(transaction).not.toHaveBeenCalled();
    });
  });

  describe("stale existing lock", () => {
    it("clears a stale lock and acquires a fresh one", async () => {
      const acquiredAt = new Date(Date.now() - 31 * 60 * 1000); // 31 min old
      findUnique.mockResolvedValueOnce({
        id: "groomer",
        syncRunId: "old-token",
        acquiredAt,
      });
      deleteRow.mockResolvedValueOnce({ id: "groomer" });

      const txMock = {
        syncLock: { findUnique: vi.fn().mockResolvedValueOnce(null), create },
      };
      create.mockResolvedValueOnce({ id: "groomer", syncRunId: "new-token", acquiredAt: new Date() });
      transaction.mockImplementationOnce(async (cb: (tx: typeof txMock) => Promise<void>) =>
        cb(txMock),
      );

      const result = await acquireGroomerLock();

      expect(result.locked).toBe(true);
      expect(deleteRow).toHaveBeenCalledWith({ where: { id: "groomer" } });
    });

    it("treats a 30-minute-old lock as stale (boundary)", async () => {
      // Exactly at MAX_AGE_MS (30 min). The implementation uses strict `<`
      // for the still-valid check, so an age of exactly 30 min is reclaimed.
      const acquiredAt = new Date(Date.now() - 30 * 60 * 1000);
      findUnique.mockResolvedValueOnce({
        id: "groomer",
        syncRunId: "boundary",
        acquiredAt,
      });
      deleteRow.mockResolvedValueOnce({ id: "groomer" });

      const txMock = {
        syncLock: { findUnique: vi.fn().mockResolvedValueOnce(null), create },
      };
      create.mockResolvedValueOnce({ id: "groomer", syncRunId: "new", acquiredAt: new Date() });
      transaction.mockImplementationOnce(async (cb: (tx: typeof txMock) => Promise<void>) =>
        cb(txMock),
      );

      const result = await acquireGroomerLock();

      expect(result.locked).toBe(true);
      expect(deleteRow).toHaveBeenCalledWith({ where: { id: "groomer" } });
    });
  });

  describe("transaction race", () => {
    it("returns { locked: false } when the in-transaction double-check sees a new lock", async () => {
      // Outer findUnique saw nothing, but inside the transaction someone
      // beat us to it.
      findUnique.mockResolvedValueOnce(null);
      const txMock = {
        syncLock: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce({ id: "groomer", syncRunId: "racer", acquiredAt: new Date() }),
          create,
        },
      };
      transaction.mockImplementationOnce(async (cb: (tx: typeof txMock) => Promise<void>) =>
        cb(txMock),
      );

      const result = await acquireGroomerLock();

      expect(result).toEqual({ locked: false });
      expect(create).not.toHaveBeenCalled();
    });

    it("propagates non-'already_locked' errors from the transaction", async () => {
      findUnique.mockResolvedValueOnce(null);
      const txMock = {
        syncLock: { findUnique: vi.fn().mockResolvedValueOnce(null), create },
      };
      const dbError = new Error("connection refused");
      transaction.mockImplementationOnce(async (cb: (tx: typeof txMock) => Promise<void>) =>
        cb(txMock),
      );
      create.mockRejectedValueOnce(dbError);

      await expect(acquireGroomerLock()).rejects.toBe(dbError);
    });
  });

  describe("existing row with null syncRunId", () => {
    it("treats a row with a null token as no lock and proceeds to acquire", async () => {
      // Defensive: the schema marks syncRunId as nullable. A row with
      // syncRunId === null should NOT be treated as a held lock.
      findUnique.mockResolvedValueOnce({
        id: "groomer",
        syncRunId: null,
        acquiredAt: new Date(),
      });

      const txMock = {
        syncLock: { findUnique: vi.fn().mockResolvedValueOnce(null), create },
      };
      create.mockResolvedValueOnce({ id: "groomer", syncRunId: "tok", acquiredAt: new Date() });
      transaction.mockImplementationOnce(async (cb: (tx: typeof txMock) => Promise<void>) =>
        cb(txMock),
      );

      const result = await acquireGroomerLock();

      expect(result.locked).toBe(true);
    });
  });
});

describe("releaseGroomerLock", () => {
  it("deletes the row matching both id and token", async () => {
    deleteMany.mockResolvedValueOnce({ count: 1 });

    await releaseGroomerLock("my-token");

    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: "groomer", syncRunId: "my-token" },
    });
  });

  it("is a no-op (count = 0) when the token does not match", async () => {
    // Means another holder's lock is in place; we don't disturb it.
    deleteMany.mockResolvedValueOnce({ count: 0 });

    await expect(releaseGroomerLock("not-our-token")).resolves.toBeUndefined();
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: "groomer", syncRunId: "not-our-token" },
    });
  });
});