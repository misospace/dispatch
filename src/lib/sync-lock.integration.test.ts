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
    // Same key: scheduled and manual both map to "issue-sync", so this is
    // still a genuine contention on the path that produced P2039.
    const results = await Promise.allSettled([acquireLock("scheduled"), acquireLock("manual")]);

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
    await db.syncLock.create({ data: { id: "issue-sync", syncRunId: null, acquiredAt: new Date() } });

    const results = await Promise.allSettled([acquireLock("scheduled"), acquireLock("manual")]);

    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(results.filter((r) => r.status === "fulfilled" && r.value.locked)).toHaveLength(1);
  });

  it("a live lock is not stolen, and releasing lets the next caller through", async () => {
    const first = await acquireLock("scheduled");
    expect(first.locked).toBe(true);

    // Same key as the holder, so this must still conflict.
    const second = await acquireLock("manual");
    expect(second).toEqual({ locked: false });

    await releaseLock(first.locked ? first.runId : "");
    const third = await acquireLock("manual");
    expect(third.locked).toBe(true);
  });
  it("different sync types acquire independently — the starvation regression", async () => {
    // The bug: every job shared one "global" row, so any job holding the lock
    // 409'd all the others. With the scheduler arming all jobs on the same
    // startup delay their ticks are phase-locked, so the same jobs lost every
    // time: pr-followup and reconcile recorded zero successful runs over a
    // pod's lifetime and no PR-fix work was ever queued.
    const results = await Promise.allSettled([
      acquireLock("scheduled"),
      acquireLock("automation"),
      acquireLock("pr-followup"),
      acquireLock("reconcile"),
      acquireLock("stale-work"),
    ]);

    const threw = results.filter((r) => r.status === "rejected");
    expect(threw).toEqual([]);

    const acquired = results
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireLock>>> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((v) => v.locked);
    // All five, concurrently. Under the shared key exactly one would win.
    expect(acquired).toHaveLength(5);

    const rows = await db.syncLock.findMany({ select: { id: true } });
    expect(rows.map((r) => r.id).sort()).toEqual(
      ["automation", "issue-sync", "pr-followup", "reconcile", "stale-work"],
    );
  });

  it("releasing one key does not free another", async () => {
    const sync = await acquireLock("scheduled");
    const rec = await acquireLock("reconcile");
    expect(sync.locked && rec.locked).toBe(true);
    if (!sync.locked || !rec.locked) return;

    await releaseLock(rec.runId);

    // The issue-sync key is still held by a live run.
    expect((await acquireLock("manual")).locked).toBe(false);
    // The reconcile key was freed by its own release.
    expect((await acquireLock("reconcile")).locked).toBe(true);
  });
});
