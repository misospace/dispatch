/**
 * The fenced remote write against a real PostgreSQL (#1254 review).
 *
 * The mocked suite in issue-mutation-guard.test.ts can prove that the forge
 * function is ISSUED from inside the `$transaction` callback — it cannot
 * prove the thing the fence actually rests on: that the guard row's
 * EXCLUSIVE lock is HELD across the forge call, and that the maintainer
 * override's steal is therefore serialized with it. Those are database
 * guarantees (an `UPDATE` inside a transaction holds the row lock until the
 * transaction ends; a concurrent `DELETE` on the same row waits for it and
 * then re-evaluates its predicate against the committed row).
 *
 * Both interleavings are exercised here, against real PostgreSQL:
 *
 *   (A) the fenced write holds the lock → the override's `DELETE` (the
 *       production predicate) BLOCKS, and once the region commits it
 *       re-evaluates the silence predicate against the re-stamped row,
 *       matches 0 rows and reports `busy` — no steal. The forge function DID
 *       run.
 *   (B) the override's `DELETE` commits first → the fenced `UPDATE` matches
 *       0 rows → `guard-lost`, and the forge function is NEVER called.
 *   (C) the region OUTRAN the override's silence window → the region
 *       back-dates the guard row inside its own transaction (what its
 *       opening stamp looks like after a long region) → the blocked steal
 *       re-evaluates its predicate against the COMMITTED row, which the
 *       commit-time re-stamp made FRESH → the steal is refused (`busy`).
 *       Without that re-stamp the committed row would carry the stale stamp,
 *       the steal's predicate would be TRUE and the force-claim would
 *       SUCCEED.
 *
 * This exercises the guard module's OWN fenced-write helper (the real
 * `withIssueMutationGuard` / `runFencedRemoteWrite` code path) against the
 * real database — the module's Prisma singleton is pointed at this test's
 * client through the `@/lib/prisma` mock below. No GitHub access: the forge
 * call is a local stub.
 *
 * Opt-in via RUN_DB_INTEGRATION=1, NOT merely DATABASE_URL: that variable is
 * set workflow-wide in ci.yaml, so gating on it alone would make this run in
 * the ordinary Tests job, which has no postgres service. `npm test` on a
 * laptop is unaffected; the database-integration CI job opts in explicitly.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const url = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(url);
// Vitest's conditional-suite form: no explicit opt-in, no run.
const suite = enabled ? describe : describe.skip;

// The guard module talks to the app's Prisma singleton. Point it at THIS
// test's client so the fenced write runs against the real database. The
// getter keeps the binding live: the client is created in `beforeAll`, long
// after this module graph is imported.
const { holder } = vi.hoisted(() => ({ holder: { prisma: null as unknown } }));
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return holder.prisma;
  },
}));

import { withIssueMutationGuard, GUARD_OVERRIDE_MIN_AGE_MS } from "./issue-mutation-guard";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

suite("the fenced remote write against a real PostgreSQL", () => {
  let db: PrismaClient;
  let issueId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url as string }) });
    holder.prisma = db;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    const repo = await db.repository.create({
      data: {
        name: "fence",
        owner: "integration",
        fullName: `integration/fence-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
    });
    const issue = await db.issue.create({
      data: {
        number: 1,
        repositoryId: repo.id,
        title: "fenced write",
        state: "open",
        url: "https://example.test/fenced-write",
        labels: [],
        assignees: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    issueId = issue.id;
  });

  afterEach(async () => {
    await db.issue.deleteMany({ where: { id: issueId } });
    await db.repository.deleteMany({ where: { fullName: { startsWith: "integration/fence-" } } });
  });

  /**
   * Make this holder's guard look SILENT — older than the override's age
   * fence — so the steal below is ELIGIBLE on its predicate. The fence, not
   * the predicate, is what must stop it.
   */
  async function makeGuardSilent(): Promise<void> {
    await db.$executeRaw`
      UPDATE "IssueMutationGuard"
      SET "updatedAt" = ${new Date(Date.now() - 2 * GUARD_OVERRIDE_MIN_AGE_MS)}
      WHERE "issueId" = ${issueId}
    `;
  }

  it("(A) the override's steal BLOCKS on the guard row lock and steals nothing; the forge write still runs", async () => {
    let overrideSettled = false;
    let stealBlockedDuringRegion: boolean | null = null;

    const forge = vi.fn(async () => {
      // The region is open, so the guard row's lock is held. The override's
      // `DELETE` was issued against that row a moment ago: it can only be
      // BLOCKED on the lock, so it cannot have settled yet.
      await sleep(250);
      stealBlockedDuringRegion = !overrideSettled;
      return "written";
    });

    const holder = await withIssueMutationGuard(
      { issueId, operation: "claim", agentName: "alpha" },
      async (_tx, context) => {
        await makeGuardSilent();

        // The maintainer force-claim: the PRODUCTION override path (its
        // `deleteMany` carries the same predicate the module uses).
        const override = withIssueMutationGuard(
          { issueId, operation: "claim", agentName: "beta", override: true },
          async () => ({ complete: false, value: "stolen" }),
        ).then((result) => {
          overrideSettled = true;
          return result;
        });

        const outcome = await context.runFencedRemoteWrite(forge);

        // The override answers only once the region committed and released
        // the lock: it re-evaluates its silence predicate against the
        // re-stamped row, matches nothing and reports `busy`.
        const overrideResult = await override;
        expect(overrideResult).toMatchObject({ status: "busy" });
        return { complete: false, value: outcome };
      },
    );

    // The steal was serialized by the lock, not merely ineligible.
    expect(stealBlockedDuringRegion).toBe(true);
    expect(forge).toHaveBeenCalledOnce();
    expect(holder).toMatchObject({ status: "retained" });

    // The guard is still this holder's: nothing was stolen.
    const row = await db.issueMutationGuard.findUnique({ where: { issueId } });
    expect(row?.agentName).toBe("alpha");
  });

  it("(B) the override's steal commits first: the fenced write reports guard-lost and the forge function never runs", async () => {
    const forge = vi.fn(async () => "written");
    let outcome: { status: string } | undefined;

    const holder = await withIssueMutationGuard(
      { issueId, operation: "claim", agentName: "alpha" },
      async (_tx, context) => {
        await makeGuardSilent();

        // The override wins the race outright: it deletes this holder's
        // guard and takes the issue over BEFORE the fenced region opens.
        const override = await withIssueMutationGuard(
          { issueId, operation: "claim", agentName: "beta", override: true },
          async () => ({ complete: false, value: "stolen" }),
        );
        expect(override).toMatchObject({ status: "retained", value: "stolen" });

        outcome = await context.runFencedRemoteWrite(forge);
        return { complete: true, value: outcome };
      },
    );

    // The guard is gone/re-owned → the fenced `UPDATE` matched no row → the
    // forge function was NEVER called.
    expect(outcome).toEqual({ status: "guard-lost" });
    expect(forge).not.toHaveBeenCalled();
    expect(holder).toMatchObject({ status: "completed" });

    // The abandoned holder did not delete or reclaim the override's guard.
    const row = await db.issueMutationGuard.findUnique({ where: { issueId } });
    expect(row?.agentName).toBe("beta");
  });

  it("(C) a region that outran the silence window still cannot be stolen: the commit-time re-stamp", async () => {
    // (A) proves the LOCK alone serializes the steal; it does not prove the
    // COMMITTED row is FRESH. This test covers the case the lock cannot: a
    // region that runs LONGER than the override's silence window
    // (`GUARD_OVERRIDE_MIN_AGE_MS`, 5 min). The fence's OPENING stamp is then
    // as old as the region, and the heartbeat's own stamp cannot land while
    // the region holds the row lock — so the COMMITTED row's freshness is
    // carried by the COMMIT-TIME RE-STAMP alone.
    let overrideSettled = false;
    let stealBlockedDuringRegion: boolean | null = null;
    let outcome: { status: string } | undefined;

    const forge = vi.fn(async (tx: Prisma.TransactionClient) => {
      // Back-date the guard row INSIDE the region's own transaction: this is
      // what the region's OPENING stamp looks like once the region has
      // outrun the silence window. WITHOUT the commit-time re-stamp the
      // COMMITTED row would carry this stale stamp, so the blocked steal's
      // silence predicate (`updatedAt <= cutoff`) would be TRUE.
      const staleStamp = new Date(Date.now() - 10 * GUARD_OVERRIDE_MIN_AGE_MS);
      await tx.issueMutationGuard.updateMany({ where: { issueId }, data: { updatedAt: staleStamp } });
      // The same stale stamp, pinned with raw SQL: an `@updatedAt` column is
      // only auto-refreshed when the client does not supply a value, and the
      // discrimination must not rest on that nuance.
      await tx.$executeRaw`
        UPDATE "IssueMutationGuard" SET "updatedAt" = ${staleStamp} WHERE "issueId" = ${issueId}
      `;
      // The override's `DELETE` was issued against that row a moment ago: it
      // can only be BLOCKED on the lock, so it cannot have settled yet.
      await sleep(250);
      stealBlockedDuringRegion = !overrideSettled;
      return "written";
    });

    const holder = await withIssueMutationGuard(
      { issueId, operation: "claim", agentName: "alpha" },
      async (_tx, context) => {
        await makeGuardSilent();

        // The maintainer force-claim: the PRODUCTION override path (its
        // `deleteMany` carries the same predicate the module uses). It is
        // started WITHOUT being awaited so it can race the region.
        const override = withIssueMutationGuard(
          { issueId, operation: "claim", agentName: "beta", override: true },
          async () => ({ complete: false, value: "stolen" }),
        ).then((result) => {
          overrideSettled = true;
          return result;
        });

        outcome = await context.runFencedRemoteWrite(forge);

        // The override answers only once the region committed and released
        // the lock: it re-evaluates its silence predicate against the
        // COMMITTED row.
        //
        // WITH the commit-time re-stamp that row is FRESH (the re-stamp
        // overwrites the back-dated stamp the region wrote above), so the
        // predicate `updatedAt <= cutoff` is FALSE, the row is skipped and
        // the steal is refused with `busy`.
        //
        // WITHOUT the commit-time re-stamp the committed row would carry the
        // back-dated stamp: the blocked steal's predicate would be TRUE, the
        // row would be DELETED, and the force-claim would SUCCEED — the
        // anchor would be taken right after the region's writes landed,
        // while the callback is still running. That is what this test
        // discriminates.
        const overrideResult = await override;
        expect(overrideResult).toMatchObject({ status: "busy" });
        return { complete: false, value: outcome };
      },
    );

    // The steal was serialized by the lock, not merely ineligible.
    expect(stealBlockedDuringRegion).toBe(true);
    // The region's own write landed: the guard was never lost under it.
    expect(outcome).toMatchObject({ status: "written" });
    expect(forge).toHaveBeenCalledOnce();
    expect(holder).toMatchObject({ status: "retained" });

    // The guard is still this holder's: nothing was stolen.
    const row = await db.issueMutationGuard.findUnique({ where: { issueId } });
    expect(row?.agentName).toBe("alpha");
  });
});
