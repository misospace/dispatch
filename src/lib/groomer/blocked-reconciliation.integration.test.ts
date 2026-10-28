/**
 * Blocked-reconciliation rotation (#1459) against a real PostgreSQL.
 *
 * The mocked suite proves the pass's own rotation bookkeeping, but only a
 * real database proves the scan's ORDER BY (NULLS FIRST on a nullable
 * column), the bulk consideration stamp, and that the migration really added
 * the rotation column. The missing-column regression class is loud here:
 * Prisma raises on the select instead of silently skipping the write.
 *
 * Opt-in via RUN_DB_INTEGRATION=1 (the database-integration CI job), like
 * apply.integration.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { makePrismaBlockedReconciliationStore, runGroomingBlockedReconciliationPass } from "./blocked-reconciliation";

const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL);
const suite = enabled ? describe : describe.skip;

const REPO = "it-groomer/blocked-reconciliation";
/** Old enough that the 24h reconsideration window has elapsed. */
const PARKED_AT = new Date("2020-01-01T00:00:00.000Z");

suite("blocked reconciliation rotation against a real PostgreSQL", () => {
  let repositoryId: string;

  async function issue(number: number, extra: Record<string, unknown> = {}) {
    return prisma.issue.create({
      data: {
        number,
        repositoryId,
        title: `Parked issue ${number}`,
        body: null,
        state: "open",
        url: `https://github.com/${REPO}/issues/${number}`,
        labels: ["status/blocked"],
        assignees: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        ...extra,
      },
    });
  }

  function parked(body: string) {
    return {
      body,
      blockedReason: `waiting on the prerequisite in ${body}`,
      nextGroomingAction: "mark_blocked",
      groomedAt: PARKED_AT,
    };
  }

  beforeEach(async () => {
    await prisma.auditLog.deleteMany({ where: { repoFullName: REPO } });
    await prisma.issue.deleteMany({ where: { repository: { fullName: REPO } } });
    await prisma.repository.deleteMany({ where: { fullName: REPO } });
    const repository = await prisma.repository.create({
      data: { fullName: REPO, name: "blocked-reconciliation", owner: "it-groomer", enabled: true },
    });
    repositoryId = repository.id;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { repoFullName: REPO } });
    await prisma.issue.deleteMany({ where: { repository: { fullName: REPO } } });
    await prisma.repository.deleteMany({ where: { fullName: REPO } });
    await prisma.$disconnect();
  });

  it("adds the rotation column and rotates the capped scan past a row that cannot progress", async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'Issue' AND column_name = 'blockedReconciliationAt'`;
    expect(columns.map((entry) => entry.column_name)).toEqual(["blockedReconciliationAt"]);

    // Rows 1 and 2 wait on an open prerequisite (#5); row 3 waits on a
    // prerequisite that is not open (#7 does not exist). The scan is capped at
    // two rows, so row 3 is only reached once rows 1 and 2 rotate out.
    await issue(1, parked("Depends on #5."));
    await issue(2, parked("Depends on #5."));
    await issue(3, parked("Depends on #7."));
    await issue(5, { body: "The prerequisite." });

    const store = makePrismaBlockedReconciliationStore(prisma);
    const repos = [{ id: repositoryId, fullName: REPO }];
    const budget = { maxIssuesPerRepo: 2 };

    const first = await runGroomingBlockedReconciliationPass(repos, store, budget);
    expect(first.markedStale).toEqual([]);
    expect(first.issuesConsidered).toBe(2);

    // The rows the scan reached carry the consideration stamp, so they rotate
    // to the back of the order.
    const stamped = await prisma.issue.findMany({ where: { repositoryId, number: { in: [1, 2, 3] } }, orderBy: { number: "asc" } });
    expect(stamped[0].blockedReconciliationAt).toBeInstanceOf(Date);
    expect(stamped[1].blockedReconciliationAt).toBeInstanceOf(Date);
    expect(stamped[2].blockedReconciliationAt).toBeNull();

    const second = await runGroomingBlockedReconciliationPass(repos, store, budget);
    expect(second.markedStale).toEqual([{ repo: REPO, issueNumber: 3, reasons: ["evidence_incomplete"] }]);

    const marked = await prisma.issue.findFirst({ where: { repositoryId, number: 3 } });
    expect(marked?.groomingStaleAt).toBeInstanceOf(Date);
    expect(marked?.groomingStaleReasons).toEqual(["evidence_incomplete"]);
    const audits = await prisma.auditLog.findMany({ where: { repoFullName: REPO, action: "grooming_stale" } });
    expect(audits.map((entry) => entry.issueNumber)).toEqual([3]);
  });
});
