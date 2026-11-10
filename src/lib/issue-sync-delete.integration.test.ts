/**
 * #1587 excluded-reconcile prune against real PostgreSQL.
 *
 * The mocked suite in issue-sync.test.ts cannot catch the two bug classes
 * this path shipped: a row-returning `SELECT ... FOR UPDATE` issued through
 * `$executeRaw` (Prisma only returns rows through `$queryRaw`), and lock-mode
 * semantics (`FOR UPDATE` vs `FOR NO KEY UPDATE` against the `FOR KEY SHARE`
 * lock a dependent-row insert takes on the parent). Both are invisible to a
 * mocked transaction client and both break the prune in production only.
 *
 * Scenarios:
 * 1. An unguarded cached issue is pruned end-to-end (the lock query executes).
 * 2. An issue with a dependent work row is refused, row kept whole.
 * 3. A concurrent uncommitted dependent insert holds `FOR KEY SHARE` on the
 *    parent row while the prune decision runs; on commit the counts see it
 *    and the delete is refused — a landed dependent row is never
 *    cascade-deleted. On rollback the prune completes.
 *
 * Opt-in via RUN_DB_INTEGRATION=1, NOT merely DATABASE_URL: that variable
 * is set workflow-wide in ci.yaml, so gating on it alone would make this
 * file run in the ordinary Tests job, which has no postgres service.
 * `npm test` on a laptop is unaffected; the database-integration CI job
 * opts in explicitly.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const url = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(url);
// Vitest's conditional-suite form: no explicit opt-in, no run.
const suite = enabled ? describe : describe.skip;

const REPO_PREFIX = "integration/issue-sync-delete-";
const UNSET_ISSUE_ID = "integration-issue-sync-delete-unset-issue-id";

const { holder } = vi.hoisted(() => ({
  holder: { prisma: null as unknown },
}));

vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return holder.prisma;
  },
}));

const { makePrismaIssueStore } = await import("./issue-sync");

suite("the #1587 excluded-reconcile prune against a real PostgreSQL", () => {
  let db: PrismaClient;
  let other: PrismaClient;
  let issueId: string = UNSET_ISSUE_ID;
  let repoId: string = UNSET_ISSUE_ID;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url as string }) });
    other = new PrismaClient({ adapter: new PrismaPg({ connectionString: url as string }) });
    holder.prisma = db;
  });

  afterAll(async () => {
    await db.$disconnect();
    await other.$disconnect();
  });

  afterEach(async () => {
    // Issue-scoped deletes are guarded so their filters are never built from
    // an unset id (Prisma omits `undefined`, which would be unscoped).
    if (issueId !== UNSET_ISSUE_ID) {
      await db.lease.deleteMany({ where: { issueId } });
      await db.agentRun.deleteMany({ where: { issueId } });
      await db.agentWork.deleteMany({ where: { issueId } });
      await db.groomingRun.deleteMany({ where: { issueId } });
      await db.groomingApplication.deleteMany({ where: { issueId } });
      await db.issue.deleteMany({ where: { id: issueId } });
    }
    if (repoId !== UNSET_ISSUE_ID) {
      await db.repository.deleteMany({ where: { id: repoId } });
    }
  });

  async function seedIssue(): Promise<void> {
    const repo = await db.repository.create({
      data: {
        name: REPO_PREFIX,
        owner: "integration",
        fullName: `${REPO_PREFIX}repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
    });
    repoId = repo.id;
    const issue = await db.issue.create({
      data: {
        number: 1,
        repositoryId: repo.id,
        title: "zombie cache row",
        state: "open",
        url: "https://example.test/zombie",
        labels: ["wontfix"],
        assignees: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    issueId = issue.id;
  }

  it("prunes an unguarded cached issue end-to-end", async () => {
    await seedIssue();
    const store = makePrismaIssueStore();

    // With the row-returning lock SELECT on the wrong raw API this threw
    // before the checks ran, so the zombie row survived every sync.
    await expect(store.deleteIssue(issueId)).resolves.toBe(true);
    await expect(db.issue.findUnique({ where: { id: issueId } })).resolves.toBeNull();
  });

  it("refuses the prune when a dependent work row exists, keeping the row whole", async () => {
    await seedIssue();
    await db.lease.create({
      data: {
        agentName: "worker",
        issueId,
        checkpoint: "issue_claimed",
        expiredAt: new Date(Date.now() + 60_000),
      },
    });
    const store = makePrismaIssueStore();

    await expect(store.deleteIssue(issueId)).resolves.toBe(false);
    await expect(db.issue.findUnique({ where: { id: issueId } })).resolves.not.toBeNull();
    await expect(db.lease.count({ where: { issueId } })).resolves.toBe(1);
  });

  it("a dependent insert holding FOR KEY SHARE blocks the decision: commit is refused, rollback prunes", async () => {
    await seedIssue();
    const store = makePrismaIssueStore();

    // The concurrent dependent insert: an uncommitted Lease row takes a
    // FOR KEY SHARE lock on the Issue row. The gate holds the insert
    // uncommitted while the prune decision starts.
    let releaseGate: () => void = () => {};
    let signalInserted: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const inserted = new Promise<void>((resolve) => {
      signalInserted = resolve;
    });
    const dependentTx = other.$transaction(async (tx) => {
      await tx.lease.create({
        data: {
          agentName: "concurrent",
          issueId,
          checkpoint: "issue_claimed",
          expiredAt: new Date(Date.now() + 60_000),
        },
      });
      // The INSERT has executed against Postgres: the FOR KEY SHARE lock on
      // the parent row is now held uncommitted. Signal before starting the
      // prune so the prune's lock query cannot win the race.
      signalInserted();
      await gate;
      // Throw to force the rollback variant of this scenario.
      throw new Error("force-rollback");
    });
    // Swallow the intentional rollback rejection.
    const dependentSettled = dependentTx.catch((error) => String(error));

    await inserted;
    const deletePromise = store.deleteIssue(issueId);
    let deleteSettled = false;
    void deletePromise.then(
      () => {
        deleteSettled = true;
      },
      () => {
        deleteSettled = true;
      },
    );
    // The FOR UPDATE on the parent row conflicts with the held FOR KEY
    // SHARE, so the decision cannot complete while the insert is open.
    // (With FOR NO KEY UPDATE the parent lock would not conflict with the
    // held FOR KEY SHARE, so the decision could complete against the
    // uncommitted state — the counts see nothing and the delete proceeds.)
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(deleteSettled).toBe(false);

    // Rollback: the KEY SHARE releases, the counts find nothing, the prune
    // completes.
    releaseGate();
    await expect(deletePromise).resolves.toBe(true);
    expect(await dependentSettled).toContain("force-rollback");
    await expect(db.issue.findUnique({ where: { id: issueId } })).resolves.toBeNull();
  });

  it("a committed dependent insert is never cascade-deleted by the prune", async () => {
    await seedIssue();
    const store = makePrismaIssueStore();

    let releaseGate: () => void = () => {};
    let signalInserted: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const inserted = new Promise<void>((resolve) => {
      signalInserted = resolve;
    });
    const dependentTx = other.$transaction(async (tx) => {
      await tx.lease.create({
        data: {
          agentName: "concurrent",
          issueId,
          checkpoint: "issue_claimed",
          expiredAt: new Date(Date.now() + 60_000),
        },
      });
      signalInserted();
      await gate;
      // The callback's return value is the transaction's resolved value: a
      // sentinel proves the transaction COMMITTED (a rollback rejects
      // instead), which is the precondition this scenario turns on.
      return "committed" as const;
    });

    await inserted;
    const deletePromise = store.deleteIssue(issueId);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Commit: the KEY SHARE releases and the lease row becomes visible. The
    // prune decision — blocked on the parent lock the whole time — then runs
    // its counts, sees the dependent row, and refuses. The regression this
    // pins: a weaker lock (FOR NO KEY UPDATE) let the counts run first
    // against the uncommitted state, the delete then destroyed the just-
    // committed dependent work.
    releaseGate();
    await expect(dependentTx).resolves.toBe("committed");
    await expect(deletePromise).resolves.toBe(false);
    await expect(db.issue.findUnique({ where: { id: issueId } })).resolves.not.toBeNull();
    await expect(db.lease.count({ where: { issueId } })).resolves.toBe(1);
  });
});
