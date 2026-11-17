/**
 * Deleted-PR reap rotation, against a real PostgreSQL (#1641 review).
 *
 * The mocked suite can Object.assign a stamp into a row and re-implement the
 * sort in JavaScript. It cannot prove how PostgreSQL placed the NULLs of the
 * rotation stamp, and that placement is the whole liveness guarantee of this
 * pass: the pass reads the rows it considered least recently first, and a
 * PostgreSQL that ranked NULL last would pin the head of the order on the
 * most recently stamped rows. The head would then never move, and a
 * confirmed deletion behind it would never be reached — the exact defect
 * this pass exists to remove. Only a real PostgreSQL proves it (the same
 * reason the #1253 external-wait rotation test joins the database job).
 *
 * Opt-in via RUN_DB_INTEGRATION=1 (same gating as the other integration
 * tests). The database-integration CI job applies the migrations and opts in
 * explicitly.
 *
 * The pass under test reads EVERY active PrFixQueueItem row — it must find a
 * deleted row whatever repo it sits in — so this file asserts on a queue that
 * contains only its own rows. That precondition is why the CI job runs this
 * file in its own vitest invocation, first, before the concurrent block
 * creates any queue rows: inside that block, foreign rows would consume the
 * probe budget, land in `checked`, and take the bulk rotation stamp. Keep it
 * a solo invocation when editing the job.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { reconcileDeletedPrFixItems, type PrFixPrPresence } from "./pr-fix-queue";

vi.mock("@/lib/pr-fix-surfacing", () => ({
  surfacePrFixBlocked: vi.fn().mockResolvedValue(null),
  surfacePrFixRequeued: vi.fn().mockResolvedValue(null),
  surfacePrFixUnblocked: vi.fn().mockResolvedValue(null),
  surfacePrFixParked: vi.fn().mockResolvedValue(null),
  extractUrlsFromText: vi.fn(() => []),
}));

const url = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(url);
const suite = enabled ? describe : describe.skip;

const REPO = "integration/deleted-pr";

suite("deleted-PR reap rotation against a real PostgreSQL", () => {
  beforeAll(() => {
    void prisma.$connect?.();
  });

  afterAll(async () => {
    // Leave the shared database as found: the reap test's rows are inert to
    // the other passes in the job, but only because nothing else scans the
    // queue by bare active status. Do not rely on that when adding passes.
    await prisma.prFixQueueItem.deleteMany({ where: { repo: REPO } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.prFixQueueItem.deleteMany({ where: { repo: REPO } });
  });

  it("reaches a confirmed deletion sitting behind more than maxProbes unknown rows (#1641 review)", async () => {
    // 21 rows that answer unknown, with the confirmed deletion behind them.
    // The ids pin the first-pass order (every stamp starts NULL, so the id
    // tiebreak decides). A rotation stamp that PostgreSQL placed wrongly
    // would leave the head on the same rows forever.
    await prisma.prFixQueueItem.createMany({
      data: Array.from({ length: 21 }, (_, index) => ({
        id: `a-deleted-pr-rot-${String(index).padStart(3, "0")}`,
        repo: REPO,
        pr: 1000 + index,
        lane: "NORMAL",
        reason: "review changes requested",
        status: "QUEUED" as const,
      })),
    });
    await prisma.prFixQueueItem.create({
      data: {
        id: "z-deleted-pr-rot-target",
        repo: REPO,
        pr: 2000,
        lane: "NORMAL",
        reason: "review changes requested",
        status: "QUEUED",
      },
    });

    const probe = vi.fn(async (_repo: string, pr: number): Promise<PrFixPrPresence> =>
      pr === 2000 ? "deleted" : "unknown",
    );
    const client = asPrFixQueueClient(prisma);

    // The probe bound stops the first pass before the target row.
    const first = await reconcileDeletedPrFixItems(client, probe, { maxProbes: 20, pageSize: 100 });
    expect(first.checked).toBe(20);
    expect(first.markedStale).toBe(0);
    const afterFirst = await prisma.prFixQueueItem.findUnique({
      where: { repo_pr: { repo: REPO, pr: 2000 } },
    });
    expect(afterFirst?.status).toBe("QUEUED");
    expect(afterFirst?.prPresenceCheckedAt).toBeNull();
    // The rotation stamp is real state, not just a count: the LAST row the
    // probe bound consumed is stamped; the first row it cut off is not, and
    // therefore leads the next pass.
    const [lastProbed, firstCut] = await Promise.all([
      prisma.prFixQueueItem.findUnique({ where: { id: "a-deleted-pr-rot-019" } }),
      prisma.prFixQueueItem.findUnique({ where: { id: "a-deleted-pr-rot-020" } }),
    ]);
    expect(lastProbed?.prPresenceCheckedAt).toBeInstanceOf(Date);
    expect(firstCut?.prPresenceCheckedAt).toBeNull();

    // A later pass rotates past the stamped head and reaches it.
    const second = await reconcileDeletedPrFixItems(client, probe, { maxProbes: 20, pageSize: 100 });
    expect(second.markedStale).toBe(1);
    const target = await prisma.prFixQueueItem.findUnique({
      where: { repo_pr: { repo: REPO, pr: 2000 } },
    });
    expect(target?.status).toBe("STALE");
    // The stamp is scoped to ACTIVE statuses, so the row this pass reaped is
    // considered but NOT stamped — a terminal row carries no rotation marker.
    expect(target?.prPresenceCheckedAt).toBeNull();
    // The unknown rows stayed in the queue: an unknown fact never reaps.
    const unknownRows = await prisma.prFixQueueItem.findMany({
      where: { repo: REPO, pr: { gte: 1000, lt: 2000 } },
    });
    expect(unknownRows).toHaveLength(21);
    expect(unknownRows.every((row) => row.status === "QUEUED")).toBe(true);
  });

  it("advances the rotation stamp without advancing updatedAt, byte for byte (#1642 review)", async () => {
    const id = "w-deleted-pr-updated-at";
    await prisma.prFixQueueItem.create({
      data: {
        id,
        repo: REPO,
        pr: 4000,
        lane: "NORMAL",
        reason: "review changes requested",
        status: "QUEUED",
      },
    });

    const readColumns = async () => {
      const rows = await prisma.$queryRaw<{ updatedAt: string; prPresenceCheckedAt: string | null }[]>`
        SELECT "updatedAt"::text AS "updatedAt",
               "prPresenceCheckedAt"::text AS "prPresenceCheckedAt"
        FROM "PrFixQueueItem" WHERE "id" = ${id}`;
      return rows[0];
    };

    const preWrite = new Date("2026-01-02T03:04:05.678Z");
    await prisma.$executeRaw`
      UPDATE "PrFixQueueItem"
      SET "updatedAt" = ${preWrite}
      WHERE "id" = ${id}`;
    const before = await readColumns();
    expect(before?.updatedAt).toBe("2026-01-02 03:04:05.678");
    expect(before?.prPresenceCheckedAt).toBeNull();

    const client = asPrFixQueueClient(prisma);
    const stamp = new Date("2026-02-03T04:05:06.789Z");
    const probe = vi.fn(async (): Promise<PrFixPrPresence> => "present");

    const result = await reconcileDeletedPrFixItems(client, probe, { now: stamp });
    expect(result.checked).toBeGreaterThanOrEqual(1);

    const after = await readColumns();
    expect(after?.prPresenceCheckedAt).toBe("2026-02-03 04:05:06.789");
    expect(after?.updatedAt).toBe("2026-01-02 03:04:05.678");
  });

  it("persists the rotation stamp as a real timestamp column and honours the due filter (#1641 review)", async () => {
    // Existence proof, loud on a missing column: the exact regression class
    // of "column PrFixQueueItem.prPresenceCheckedAt does not exist" — Prisma
    // raises on the update instead of silently skipping the write.
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'PrFixQueueItem' AND column_name = 'prPresenceCheckedAt'`;
    expect(columns.map((entry) => entry.column_name)).toEqual(["prPresenceCheckedAt"]);

    await prisma.prFixQueueItem.create({
      data: {
        id: "y-deleted-pr-stamp",
        repo: REPO,
        pr: 3000,
        lane: "NORMAL",
        reason: "review changes requested",
        status: "QUEUED",
      },
    });

    const client = asPrFixQueueClient(prisma);
    const now = new Date();
    const probe = vi.fn(async (): Promise<PrFixPrPresence> => "present");

    const first = await reconcileDeletedPrFixItems(client, probe, { now });
    expect(first.checked).toBe(1);

    const row = await prisma.prFixQueueItem.findUnique({ where: { repo_pr: { repo: REPO, pr: 3000 } } });
    expect(row?.prPresenceCheckedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(new Date(row?.prPresenceCheckedAt as Date).getTime())).toBe(false);

    // The row is inside its re-verify window, so the next pass spends no
    // forge call on it. The due filter reads the real column, not the mock.
    const second = await reconcileDeletedPrFixItems(client, probe, { now });
    expect(second.checked).toBe(0);
    expect(probe).toHaveBeenCalledTimes(1);

    // Past the window it is due again.
    const third = await reconcileDeletedPrFixItems(client, probe, {
      now: new Date(now.getTime() + 3_600_000),
    });
    expect(third.checked).toBe(1);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
