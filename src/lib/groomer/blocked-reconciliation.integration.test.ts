/**
 * Blocked-reconciliation rotation (#1459) against a real PostgreSQL.
 *
 * The mocked suite proves the pass's own rotation bookkeeping, but only a
 * real database proves the scan's ORDER BY (NULLS FIRST on a nullable
 * column), the bulk consideration stamp, that the migration really added
 * the rotation column, and that the legacy branch's relation `none` filters
 * (operator evidence) hold on the scan AND on the compare-and-set write.
 * The missing-column regression class is loud here: Prisma raises on the
 * select instead of silently skipping the write.
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

  /**
   * A legacy park: a groomer verdict that omitted the action marker, so the
   * row carries no marker at all and the legacy branch has to prove ownership
   * from the row's own evidence.
   */
  function legacyPark(body: string) {
    return {
      body,
      blockedReason: `waiting on the prerequisite in ${body}`,
      nextGroomingAction: null,
      groomedBy: "hosted-groomer",
      groomedAt: PARKED_AT,
    };
  }

  async function operatorStatusEvent(issueId: string, issueNumber: number) {
    await prisma.issueLifecycleEvent.create({
      data: {
        issueId,
        repoFullName: REPO,
        issueNumber,
        kind: "status_changed",
        source: "api:status",
        actor: "operator",
        occurredAt: new Date(),
      },
    });
  }

  async function operatorStatusAudit(issueId: string, issueNumber: number, success: boolean) {
    await prisma.auditLog.create({
      data: {
        actor: "operator",
        action: "set_status",
        repoFullName: REPO,
        issueNumber,
        issueId,
        beforeLabels: ["status/backlog"],
        afterLabels: ["status/blocked"],
        success,
      },
    });
  }

  beforeEach(async () => {
    await prisma.auditLog.deleteMany({ where: { repoFullName: REPO } });
    // The lifecycle events cascade with their issue, but they are deleted
    // explicitly so the cleanup does not depend on that cascade.
    await prisma.issueLifecycleEvent.deleteMany({ where: { repoFullName: REPO } });
    await prisma.issue.deleteMany({ where: { repository: { fullName: REPO } } });
    await prisma.repository.deleteMany({ where: { fullName: REPO } });
    const repository = await prisma.repository.create({
      data: { fullName: REPO, name: "blocked-reconciliation", owner: "it-groomer", enabled: true },
    });
    repositoryId = repository.id;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { repoFullName: REPO } });
    await prisma.issueLifecycleEvent.deleteMany({ where: { repoFullName: REPO } });
    await prisma.issue.deleteMany({ where: { repository: { fullName: REPO } } });
    await prisma.repository.deleteMany({ where: { fullName: REPO } });
    await prisma.$disconnect();
  });

  it("adds the rotation column and rotates the capped scan past a row that cannot progress", async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'Issue' AND column_name = 'blockedReconciliationAt'`;
    expect(columns.map((entry) => entry.column_name)).toEqual(["blockedReconciliationAt"]);

    // Rows 1 and 2 are worker-owned: the store hands them to the pass, the
    // pass skips them in memory, so it can make no progress on them. Row 3 is
    // a plain parked block whose prerequisite closed. The scan is capped at
    // two rows, so row 3 is only reached once rows 1 and 2 rotate out.
    await issue(1, { ...parked("Waiting on the worker."), labels: ["status/blocked", "status/in-progress"] });
    await issue(2, { ...parked("Waiting on the worker."), labels: ["status/blocked", "status/in-review"] });
    await issue(3, parked("Depends on #7."));

    const store = makePrismaBlockedReconciliationStore(prisma);
    const repos = [{ id: repositoryId, fullName: REPO }];
    const budget = { maxIssuesPerRepo: 2 };

    const first = await runGroomingBlockedReconciliationPass(repos, store, budget);
    expect(first.markedStale).toEqual([]);
    expect(first.issuesConsidered).toBe(0);

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

  it("reconsiders an anchorless parked block whose prerequisite is still open", async () => {
    // The review finding, against a real PostgreSQL: an open candidate must
    // not suppress the bounded reconsideration. The pass cannot tell which
    // dependency the verdict relied on, so the row is re-groomed and the fresh
    // verdict decides whether it stays blocked. The mark is a reconsideration,
    // never an unblock: the row stays parked.
    await issue(1, parked("Depends on #5."));
    await issue(5, { body: "The prerequisite.", labels: [] });

    const store = makePrismaBlockedReconciliationStore(prisma);
    const result = await runGroomingBlockedReconciliationPass([{ id: repositoryId, fullName: REPO }], store);

    expect(result.markedStale).toEqual([{ repo: REPO, issueNumber: 1, reasons: ["evidence_incomplete"] }]);
    const marked = await prisma.issue.findFirst({ where: { repositoryId, number: 1 } });
    expect(marked?.groomingStaleAt).toBeInstanceOf(Date);
    expect(marked?.groomingStaleReasons).toEqual(["evidence_incomplete"]);
    expect(marked?.groomingStaleDetail).toContain("open now: " + REPO + "#5");
    // Still parked: the mark schedules a re-groom, it does not release the
    // issue.
    expect(marked?.blockedReason).not.toBeNull();
    expect(marked?.labels).toContain("status/blocked");
    expect(marked?.nextGroomingAction).toBe("mark_blocked");
  });

  it("reconsiders a legacy park that carries no verdict marker", async () => {
    // The review finding, against a real PostgreSQL: a park whose verdict
    // omitted the action marker has no marker at all, so a marker-only scan
    // stranded it forever. The legacy branch proves ownership from the row's
    // own evidence and reconsiders it on the same bounded window.
    await issue(1, legacyPark("Depends on #5."));

    const store = makePrismaBlockedReconciliationStore(prisma);
    const result = await runGroomingBlockedReconciliationPass([{ id: repositoryId, fullName: REPO }], store);

    expect(result.markedStale).toEqual([{ repo: REPO, issueNumber: 1, reasons: ["evidence_incomplete"] }]);
    const marked = await prisma.issue.findFirst({ where: { repositoryId, number: 1 } });
    expect(marked?.groomingStaleAt).toBeInstanceOf(Date);
    expect(marked?.groomingStaleReasons).toEqual(["evidence_incomplete"]);
    // Still parked: the mark schedules a re-groom, it never releases the
    // issue, and it never rewrites the park.
    expect(marked?.blockedReason).not.toBeNull();
    expect(marked?.labels).toContain("status/blocked");
    expect(marked?.nextGroomingAction).toBeNull();
  });

  it("never reconsiders a legacy park an operator held through the status route", async () => {
    // The status route's lifecycle event is the operator's evidence: a
    // deliberate hold the pass never revisits.
    const row = await issue(1, legacyPark("Depends on #5."));
    await operatorStatusEvent(row.id, row.number);

    const store = makePrismaBlockedReconciliationStore(prisma);
    const result = await runGroomingBlockedReconciliationPass([{ id: repositoryId, fullName: REPO }], store);

    expect(result.markedStale).toEqual([]);
    const untouched = await prisma.issue.findFirst({ where: { repositoryId, number: 1 } });
    expect(untouched?.groomingStaleAt).toBeNull();
  });

  it("never reconsiders a legacy park an operator re-blocked without a label move", async () => {
    // The same-status re-block: the status label did not move, so no
    // lifecycle event was recorded — the successful status audit row is the
    // only evidence of the hold.
    const row = await issue(1, legacyPark("Depends on #5."));
    await operatorStatusAudit(row.id, row.number, true);

    const store = makePrismaBlockedReconciliationStore(prisma);
    const result = await runGroomingBlockedReconciliationPass([{ id: repositoryId, fullName: REPO }], store);

    expect(result.markedStale).toEqual([]);
    const untouched = await prisma.issue.findFirst({ where: { repositoryId, number: 1 } });
    expect(untouched?.groomingStaleAt).toBeNull();
  });

  it("reconsiders a legacy park whose only status audit row is a failed write", async () => {
    // A failed write never changed the row, so it proves nothing about a
    // hold: the legacy branch still owns the row.
    const row = await issue(1, legacyPark("Depends on #5."));
    await operatorStatusAudit(row.id, row.number, false);

    const store = makePrismaBlockedReconciliationStore(prisma);
    const result = await runGroomingBlockedReconciliationPass([{ id: repositoryId, fullName: REPO }], store);

    expect(result.markedStale).toEqual([{ repo: REPO, issueNumber: 1, reasons: ["evidence_incomplete"] }]);
    const marked = await prisma.issue.findFirst({ where: { repositoryId, number: 1 } });
    expect(marked?.groomingStaleAt).toBeInstanceOf(Date);
  });

  it("still reconsiders a marked park", async () => {
    // The modern branch is unchanged by the legacy branch.
    await issue(1, parked("Depends on #5."));

    const store = makePrismaBlockedReconciliationStore(prisma);
    const result = await runGroomingBlockedReconciliationPass([{ id: repositoryId, fullName: REPO }], store);

    expect(result.markedStale).toEqual([{ repo: REPO, issueNumber: 1, reasons: ["evidence_incomplete"] }]);
    const marked = await prisma.issue.findFirst({ where: { repositoryId, number: 1 } });
    expect(marked?.groomingStaleAt).toBeInstanceOf(Date);
    expect(marked?.groomingStaleReasons).toEqual(["evidence_incomplete"]);
  });

  it("never reconsiders a legacy park a human decided through the status route", async () => {
    // The status route stamps the row with the actor that decided, so a hold
    // it wrote is excluded by that stamp alone — atomically with the hold,
    // which no audit row can promise.
    await issue(1, { ...legacyPark("Depends on #5."), groomedBy: "operator" });

    const store = makePrismaBlockedReconciliationStore(prisma);
    const result = await runGroomingBlockedReconciliationPass([{ id: repositoryId, fullName: REPO }], store);

    expect(result.markedStale).toEqual([]);
    const untouched = await prisma.issue.findFirst({ where: { repositoryId, number: 1 } });
    expect(untouched?.groomingStaleAt).toBeNull();
  });

  it("never reconsiders a park a human moved off the blocked column", async () => {
    // A board drag off the blocked column leaves the cached block reason
    // behind; the card is no longer a park, so the pass leaves the human's
    // move alone.
    await issue(1, { ...parked("Depends on #5."), labels: ["status/ready"] });

    const store = makePrismaBlockedReconciliationStore(prisma);
    const result = await runGroomingBlockedReconciliationPass([{ id: repositoryId, fullName: REPO }], store);

    expect(result.markedStale).toEqual([]);
    const untouched = await prisma.issue.findFirst({ where: { repositoryId, number: 1 } });
    expect(untouched?.groomingStaleAt).toBeNull();
  });

  it("drops the stale mark when a legacy row gains operator evidence after the read", async () => {
    // The compare-and-set fence must work inside updateMany, not only in the
    // scan: the relation `none` filters have to hold on the write too, or the
    // mark would land on a row a human held in the meantime.
    const row = await issue(1, legacyPark("Depends on #5."));
    const store = makePrismaBlockedReconciliationStore(prisma);

    const scanned = await store.findParkedBlockedIssues(repositoryId, 10);
    expect(scanned.map((entry) => entry.number)).toEqual([1]);

    // The operator holds the issue after the scan read it.
    await operatorStatusEvent(row.id, row.number);

    const wrote = await store.markStale(
      scanned[0],
      { reasons: ["evidence_incomplete"], detail: "dependency evidence incomplete" },
      new Date(),
    );
    expect(wrote).toBe(false);
    const untouched = await prisma.issue.findFirst({ where: { repositoryId, number: 1 } });
    expect(untouched?.groomingStaleAt).toBeNull();
  });
});
