/**
 * Concurrency regression test for the sync lock, against a real PostgreSQL.
 *
 * This file exists because the mocked suite in sync-lock.test.ts cannot fail
 * for the reason production did. A mocked client can return a P2002-shaped
 * rejection, but it cannot reproduce PostgreSQL aborting the whole
 * transaction when a statement fails -- and that abort, not the rejection, is
 * what broke #843 in production with P2039 (#850). Two fixes to this lock have
 * now shipped green against mocks and failed in the cluster.
 *
 * Opt-in via RUN_DB_INTEGRATION=1, NOT merely DATABASE_URL: that variable is
 * set workflow-wide in ci.yaml, so gating on it alone would make this run in
 * the ordinary Tests job, which has no postgres service. `npm test` on a
 * laptop is unaffected; the database-integration CI job opts in explicitly.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { acquireLock, releaseLock } from "./sync-lock";

const url = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(url);
// Vitest's conditional-suite form: no explicit opt-in, no run.
const suite = enabled ? describe : describe.skip;

suite("sync lock against a real PostgreSQL", () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await db.syncLock.deleteMany({});
  });

  it("two overlapping acquisitions on an empty table: one wins, the loser fails cleanly", async () => {
    const results = await Promise.allSettled([acquireLock("scheduled"), acquireLock("reconcile")]);

    const won = results.filter((r) => r.status === "fulfilled" && r.value.locked);
    const conflicted = results.filter((r) => r.status === "fulfilled" && !r.value.locked);
    const threw = results.filter((r) => r.status === "rejected");

    // The specific regression: under the old create()-and-catch the loser's
    // transaction was already aborted, so it rejected with P2039 instead of
    // reporting a conflict. Anything thrown here is that class of bug.
    expect(threw.map((r) => (r as PromiseRejectedResult).reason?.code ?? String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(won).toHaveLength(1);
    expect(conflicted).toHaveLength(1);
  });

  it("two overlapping acquisitions with an unheld row present: one wins, the loser fails cleanly", async () => {
    // Exercises the UPDATE race rather than the INSERT race: the row exists
    // with no holder, so both contenders match claimableWhere().
    await db.syncLock.create({ data: { id: "global", syncRunId: null, acquiredAt: new Date() } });

    const results = await Promise.allSettled([acquireLock("scheduled"), acquireLock("manual")]);

    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(results.filter((r) => r.status === "fulfilled" && r.value.locked)).toHaveLength(1);
  });

  it("a live lock is not stolen, and releasing lets the next caller through", async () => {
    const first = await acquireLock("scheduled");
    expect(first.locked).toBe(true);

    const second = await acquireLock("reconcile");
    expect(second).toEqual({ locked: false });

    await releaseLock(first.locked ? first.runId : "");
    const third = await acquireLock("reconcile");
    expect(third.locked).toBe(true);
  });
});
