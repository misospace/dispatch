/**
 * The claim-path stale cleanup's delete+audit rollback, against a real
 * PostgreSQL (#1392).
 *
 * `findAndReleaseStaleAgentWorkForIssue` deletes the fenced-AgentWork
 * candidates and writes the `stale_agentwork_cleanup` audit row inside one
 * `$transaction`, so "a deletion is never left without its audit row" is a
 * TRANSACTION-LEVEL guarantee. The mocked suite in agent-work.test.ts cannot
 * prove it: its fake `$transaction` simply invokes the callback with a client
 * and never rolls back, so a regression that dropped the deletes out of the
 * transaction (or wrote the audit after the commit) would only be caught by
 * that suite's shape assertions — not by an abort.
 *
 * Here the audit write is made to fail INSIDE the transaction (a real
 * PostgreSQL trigger raises an exception on the audit INSERT, scoped to
 * this test's seeded issue id) and the test asserts the `AgentWork` row and
 * its `AgentWorkHistory` cascade SURVIVE the aborted transaction — not that
 * the deletion was left without its audit row. Because the function only
 * reaches the audit INSERT after at least one candidate delete consumed a
 * row (`deletedIds.length === 0` returns early), the trigger firing at all
 * proves the deletes had already landed inside the same transaction — and
 * since the row survives, those deletes rolled back with the audit.
 *
 * Opt-in via RUN_DB_INTEGRATION=1, NOT merely DATABASE_URL: that variable is
 * set workflow-wide in ci.yaml, so gating on it alone would make this file
 * run in the ordinary Tests job, which has no postgres service. `npm test`
 * on a laptop is unaffected; the database-integration CI job opts in
 * explicitly. No GitHub access: this path is repository-local.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const url = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(url);
// Vitest's conditional-suite form: no explicit opt-in, no run.
const suite = enabled ? describe : describe.skip;

const REPO_PREFIX = "integration/agent-work-stale-cleanup-";

// The cleanup takes its client as a parameter, but importing the module
// transitively imports the app's Prisma singleton; point it at THIS test's
// client so the import chain stays hermetic even without DATABASE_URL.
const { holder } = vi.hoisted(() => ({ holder: { prisma: null as unknown } }));
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return holder.prisma;
  },
}));

import { findAndReleaseStaleAgentWorkForIssue } from "./agent-work";

// The audit-fail mechanism: a BEFORE INSERT trigger on AuditLog raises an
// exception so that THIS cleanup's audit INSERT is the statement that fails
// inside the transaction. Names are test-scoped.
const BLOCK_FUNCTION = "agent_work_rollback_test_raise_audit";
const BLOCK_TRIGGER = "agent_work_rollback_test_audit_block";

suite("the claim-path stale cleanup's delete+audit rollback against a real PostgreSQL", () => {
  let db: PrismaClient;
  let issueId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url as string }) });
    holder.prisma = db;
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${BLOCK_TRIGGER}" ON "AuditLog"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${BLOCK_FUNCTION}"()`);
  });

  afterAll(async () => {
    // Leave the shared database as this file found it, even on a failure.
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${BLOCK_TRIGGER}" ON "AuditLog"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${BLOCK_FUNCTION}"()`);
    await db.$disconnect();
  });

  beforeEach(async () => {
    const repo = await db.repository.create({
      data: {
        name: REPO_PREFIX,
        owner: "integration",
        fullName: `${REPO_PREFIX}repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
    });
    const issue = await db.issue.create({
      data: {
        number: 1,
        repositoryId: repo.id,
        title: "stale cleanup rollback",
        state: "open",
        url: "https://example.test/stale-cleanup-rollback",
        labels: [],
        assignees: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    issueId = issue.id;
  });

  afterEach(async () => {
    // AgentWork rows first: deleting the issue would only null their FK
    // (the relationship is optional, so Prisma's default action is
    // SetNull), which would leave orphaned rows behind.
    await db.agentWork.deleteMany({ where: { issueId } });
    await db.issue.deleteMany({ where: { id: issueId } });
    // Same SetNull shape applies to the positive control's committed audit
    // row once the issue is gone; remove it by the test's repo prefix so
    // nothing accumulates on a reused database.
    await db.auditLog.deleteMany({ where: { repoFullName: { startsWith: REPO_PREFIX } } });
    await db.repository.deleteMany({ where: { fullName: { startsWith: REPO_PREFIX } } });
  });

  /**
   * Seed one stale candidate for the issue: an active-shaped AgentWork row
   * whose agent holds no Lease (so the scan matches it), with two history
   * entries the delete's onDelete: Cascade would take with it.
   */
  async function seedStaleWork(agentName: string) {
    const work = await db.agentWork.create({
      data: { agentName, issueId, state: "IN_PROGRESS" },
    });
    await db.agentWorkHistory.create({
      data: { workId: work.id, action: "started" },
    });
    await db.agentWorkHistory.create({
      data: { workId: work.id, action: "checkpoint" },
    });
    return work;
  }

  /**
   * Make THIS issue's `stale_agentwork_cleanup` audit write fail: the
   * trigger's BEFORE INSERT action is keyed on the audit row's issueId, so
   * only this test's transaction is affected even though the suite shares
   * the database with the other integration files.
   */
  async function installAuditBlocker(): Promise<void> {
    await db.$executeRawUnsafe(
      `CREATE FUNCTION "${BLOCK_FUNCTION}"() RETURNS trigger LANGUAGE plpgsql AS $func$ BEGIN
        RAISE EXCEPTION 'agent-work rollback test: the stale_agentwork_cleanup audit write was blocked';
      END $func$;`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER "${BLOCK_TRIGGER}" BEFORE INSERT ON "AuditLog"
        FOR EACH ROW
        WHEN (NEW."action" = 'stale_agentwork_cleanup' AND NEW."issueId" = '${issueId}')
        EXECUTE FUNCTION "${BLOCK_FUNCTION}"();`,
    );
  }

  it("(rollback) the deletes had consumed the row inside the transaction, the audit write fails, and the row plus its history survive", async () => {
    const work = await seedStaleWork("alpha");

    // The trigger must be gone whether or not the assertion below holds.
    try {
      await installAuditBlocker();

      // The rejection is the RAISE from the trigger, fired by the audit
      // INSERT — and that INSERT is only reached after at least one delete
      // consumed a row, so the deletes DID land inside the transaction.
      const cleanedUp = findAndReleaseStaleAgentWorkForIssue(db, issueId, `${REPO_PREFIX}rollback`);
      await expect(cleanedUp).rejects.toThrow(/stale_agentwork_cleanup audit write was blocked/);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${BLOCK_TRIGGER}" ON "AuditLog"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${BLOCK_FUNCTION}"()`);
    }

    // The transaction aborted: the delete rolled back, the row is where it
    // started, its history cascade is intact, and no audit row claims a
    // deletion that this feature's contract says cannot exist unaudited.
    const survivor = await db.agentWork.findUnique({ where: { id: work.id } });
    expect(survivor).not.toBeNull();
    expect(survivor?.state).toBe("IN_PROGRESS");
    expect(await db.agentWorkHistory.count({ where: { workId: work.id } })).toBe(2);
    expect(
      await db.auditLog.findMany({ where: { issueId, action: "stale_agentwork_cleanup" } }),
    ).toEqual([]);
  });

  it("(positive control) with a working audit write the cleanup deletes the row, its history cascade, and writes the audit row", async () => {
    const work = await seedStaleWork("alpha");

    const count = await findAndReleaseStaleAgentWorkForIssue(
      db,
      issueId,
      `${REPO_PREFIX}positive-${Date.now()}`,
    );

    // The scan matched the one candidate and the fence consumed it.
    expect(count).toBe(1);
    expect(await db.agentWork.findUnique({ where: { id: work.id } })).toBeNull();
    // The REAL delete carries its cascade: the history rows went with it.
    expect(await db.agentWorkHistory.count({ where: { workId: work.id } })).toBe(0);
    // And the audit row travelled with the deletion in the COMMITTED state.
    const audit = await db.auditLog.findMany({ where: { issueId, action: "stale_agentwork_cleanup" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: "system",
      success: true,
      repoFullName: expect.stringMatching(new RegExp(`^${REPO_PREFIX}positive-`)),
    });
    expect(audit[0]?.notes).toContain(work.id);
  });
});
