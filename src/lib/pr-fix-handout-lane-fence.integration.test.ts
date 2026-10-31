/**
 * The #1503 hand-out lane-exclusivity issuance fence against a real PostgreSQL.
 *
 * The review blocker on PR #1504: the hand-out gate read `Issue.currentLane`
 * and then let `confirmPrFixHandOut`/the append condition only on the PR-fix
 * row — a parent NORMAL→frontier flip landing between the lookup and the
 * issuance write let a declared-NORMAL consumer take escalation work. The fix
 * (`withHandoutLaneExclusivityFence`) runs the classification read AND the
 * hand-out writes inside ONE interactive transaction whose authority read is a
 * LOCKING read (`SELECT ... FOR SHARE OF "Issue"` via `issue.findFirstLocked`),
 * held until the transaction commits.
 *
 * WHY THE LOCK, NOT ISOLATION (reviewer-refuted empirically on PostgreSQL 18):
 * the fence only READS the Issue row and WRITES the PrFixQueueItem row — a
 * single rw-antidependency edge is a valid serialization order (fence→flip),
 * so Serializable isolation does NOT abort the issuance when a flip commits
 * inside the read→write window. The share lock is the actual boundary:
 * - the flip commits BEFORE the locked read → the fence sees `frontier` and
 *   refuses (correcting the queued row when it is still unclaimed);
 * - the flip is concurrent with the open fence → the UPDATE BLOCKS on the
 *   share lock until the fence commits → the hand-out landed while the parent
 *   was genuinely NORMAL (valid at its commit); the next poll's gate refuses
 *   and corrects.
 *
 * A mocked suite cannot prove the locking boundary — the overlap is a
 * DATABASE interleaving, the same reason `pr-fix-rebase-type.integration.test.ts`
 * proves the #1327 advisory lock against live PostgreSQL. Here the parent is
 * reclassified by a separate connection while the fence transaction is held
 * open AFTER its locked classification read and BEFORE its issuance write;
 * without the lock the NORMAL issuance would land after the flip (the leak),
 * with it the flip must WAIT until the fence has committed.
 *
 * Opt-in via RUN_DB_INTEGRATION=1 (same gating as the other integration
 * tests). The database-integration CI job applies the migrations and opts in
 * explicitly.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { setLaneConfig, resetLaneConfig } from "./lane-config";
import { enqueuePrFixItem, withHandoutLaneExclusivityFence } from "./pr-fix-queue";

vi.mock("./pr-fix-surfacing", () => ({
  surfacePrFixBlocked: vi.fn().mockResolvedValue({ labelApplied: false, commentPosted: false, errors: [] }),
  surfacePrFixParked: vi.fn().mockResolvedValue({ labelRemoved: false, commentPosted: false, errors: [] }),
  surfacePrFixRequeued: vi.fn().mockResolvedValue({ labelRemoved: false, commentPosted: false, errors: [] }),
  surfacePrFixUnblocked: vi.fn().mockResolvedValue({ labelRemoved: false, commentPosted: false, errors: [] }),
  extractUrlsFromText: vi.fn(() => []),
}));

const url = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(url);
const suite = enabled ? describe : describe.skip;

const REPO = "integration/lane-fence";
const ESCALATION_LANE_ID = "frontier";
const LOCAL_LANE_ID = "local";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

suite("PrFix hand-out lane-exclusivity fence against a real PostgreSQL (#1503)", () => {
  beforeAll(() => {
    setLaneConfig({
      lanes: [
        { id: LOCAL_LANE_ID, title: "Local", claimable: true, role: "default", color: "#3b82f6", description: "shared lane" },
        { id: ESCALATION_LANE_ID, title: "Frontier", claimable: true, role: "escalation", color: "#ef4444", description: "exclusive escalation lane" },
      ],
    });
  });

  afterAll(async () => {
    resetLaneConfig();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.prFixQueueItem.deleteMany({ where: { repo: REPO } });
    await prisma.issue.deleteMany({ where: { repository: { fullName: REPO } } });
    await prisma.repository.deleteMany({ where: { fullName: REPO } });
  });

  /** Seed the repository + issue row at the given lane. */
  async function seedIssue(issueLane: string, issueNumber = 1) {
    const repository = await prisma.repository.create({
      data: { name: REPO.split("/")[1], owner: REPO.split("/")[0], fullName: REPO },
    });
    await prisma.issue.create({
      data: {
        repositoryId: repository.id,
        number: issueNumber,
        title: "linked issue",
        state: "OPEN",
        url: `https://github.com/${REPO}/issues/${issueNumber}`,
        labels: [],
        assignees: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        currentLane: issueLane,
      },
    });
  }

  /** Seed a local parent and enqueue its PR as NORMAL work (row lands NORMAL). */
  async function seedNormalQueueRow(issueLane: string, issueNumber = 1) {
    await seedIssue(issueLane, issueNumber);
    const enqueued = await enqueuePrFixItem(prisma, {
      repo: REPO,
      pr: 1,
      lane: "NORMAL",
      type: "REVIEW_FEEDBACK",
      reason: "PR review: CHANGES_REQUESTED",
      feedback: "fix",
      evidenceKey: "review:1",
      issue: issueNumber,
    });
    expect(enqueued.lane, "the seeded row must start on the shared lane").toBe("NORMAL");
    return enqueued;
  }

  /**
   * Seed a PRE-#1503 MISCLASSIFIED row: the parent is ALREADY frontier, but
   * the queue row was created before the fix and carries NORMAL. The row is
   * created DIRECTLY — `enqueuePrFixItem` would raise the lane at ingest (and
   * the earlier version of this seed wrongly asserted NORMAL after enqueueing
   * against a frontier parent, making the test trivially pass).
   */
  async function seedMisclassifiedQueueRow(issueLane: string, issueNumber = 1) {
    await seedIssue(issueLane, issueNumber);
    const created = await prisma.prFixQueueItem.create({
      data: {
        repo: REPO,
        pr: 1,
        issue: issueNumber,
        lane: "NORMAL",
        type: "REVIEW_FEEDBACK",
        reason: "PR review: CHANGES_REQUESTED",
        feedback: [],
        evidenceKeys: [],
        status: "QUEUED",
        generation: 1,
      },
    });
    expect(created.lane, "the seeded row must be the misclassified NORMAL row").toBe("NORMAL");
    return created;
  }

  function candidateOf(row: { id: string; repo: string; pr: number; issue: number | null; generation: number; lane: string }) {
    return { id: row.id, repo: row.repo, pr: row.pr, issue: row.issue, generation: row.generation, lane: row.lane };
  }

  it("issues shared work normally when the parent verifies NOT_ESCALATED (liveness)", async () => {
    const row = await seedNormalQueueRow(LOCAL_LANE_ID);
    const result = await withHandoutLaneExclusivityFence(asPrFixQueueClient(prisma), candidateOf(row), "NORMAL", async (tx) => {
      const stamp = await tx.prFixQueueItem.updateMany({
        where: { id: row.id, generation: row.generation, status: "QUEUED" },
        data: { agentHandouts: { push: ["agent@1"] } },
      });
      return stamp.count === 1 ? "task" : null;
    });
    expect(result, "an eligible candidate must be issued — the fence must not strand shared work").toBe("task");
    const after = await prisma.prFixQueueItem.findUnique({ where: { id: row.id } });
    expect(after?.agentHandouts).toEqual(["agent@1"]);
    expect(after?.lane).toBe("NORMAL");
  });

  it("refuses and corrects a queued row whose parent is already frontier (locked classification read inside the transaction)", async () => {
    const row = await seedMisclassifiedQueueRow(ESCALATION_LANE_ID);
    // The queue-read snapshot still says NORMAL (as a stale poll would carry).
    const candidate = { ...candidateOf(row), lane: "NORMAL" };
    let issued = false;
    const result = await withHandoutLaneExclusivityFence(asPrFixQueueClient(prisma), candidate, "NORMAL", async () => {
      issued = true;
      return "task";
    });
    expect(result, "a frontier parent must never be issued to a declared-normal consumer").toBeNull();
    expect(issued).toBe(false);
    const after = await prisma.prFixQueueItem.findUnique({ where: { id: row.id } });
    expect(after?.lane, "the fence's in-transaction correction CAS must have flipped the queued row").toBe("ESCALATED");
    expect(after?.agentHandouts).toEqual([]);
    expect(after?.dispatchedGeneration).toBeNull();
    const history = await prisma.prFixHistory.findFirst({ where: { itemId: row.id, note: { contains: "#1503" } } });
    expect(history, "the correction must leave its #1503 audit row").not.toBeNull();
  });

  it("serializes the parent flip against issuance: the flip BLOCKS on the fence's FOR SHARE lock and cannot precede the hand-out (lock race, #1503)", async () => {
    const row = await seedNormalQueueRow(LOCAL_LANE_ID);
    const candidate = candidateOf(row);

    // The fence transaction: the locked classification read happens inside the
    // fence BEFORE the callback runs; the callback then HOLDS the transaction
    // open (lock held, write pending) so the concurrent reclassification must
    // queue behind the share lock.
    let releaseFence: () => void = () => {};
    const fenceHeld = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    let stampRan = false;
    const fencePromise = withHandoutLaneExclusivityFence(asPrFixQueueClient(prisma), candidate, "NORMAL", async (tx) => {
      await fenceHeld;
      const stamp = await tx.prFixQueueItem.updateMany({
        where: { id: row.id, generation: row.generation, status: "QUEUED" },
        data: { agentHandouts: { push: ["racer@1"] } },
      });
      stampRan = stamp.count === 1;
      return stampRan ? "task" : null;
    });

    // Let the fence acquire the FOR SHARE lock, then flip the parent from a
    // separate connection. The flip is a plain READ COMMITTED UPDATE: it must
    // BLOCK on the share lock (no retry loop — a lock wait is not a
    // serialization abort). Without the lock the flip would commit here and
    // the hand-out would land AFTER it — the exact leak #1503 closes.
    await sleep(300);
    const flipPromise = prisma.issue
      .updateMany({
        where: { repository: { fullName: REPO }, number: 1 },
        data: { currentLane: ESCALATION_LANE_ID },
      })
      .then(() => "flipped" as const);
    const raced = await Promise.race([
      flipPromise,
      sleep(750).then(() => "still-blocked" as const),
    ]);
    try {
      expect(raced, "the parent flip must still be blocked by the fence's FOR SHARE lock — if it committed, the fence no longer serializes issuance against reclassification").toBe("still-blocked");
    } finally {
      // Always release the fence so a failing expectation cannot hang the
      // worker on the held lock.
      releaseFence();
    }

    // The fence commits its issuance while the parent was genuinely NORMAL —
    // valid at its commit; the flip then proceeds.
    const result = await fencePromise;
    expect(result, "issuance held the lock and must complete normally").toBe("task");
    expect(stampRan).toBe(true);
    expect(await flipPromise).toBe("flipped");

    // Post-state: the hand-out landed (issued under the lock) and the parent
    // is now frontier.
    const after = await prisma.prFixQueueItem.findUnique({ where: { id: row.id } });
    expect(after?.agentHandouts).toEqual(["racer@1"]);
    expect(after?.lane).toBe("NORMAL");
    expect(await prisma.issue.findFirst({
      where: { repository: { fullName: REPO }, number: 1 },
      select: { currentLane: true },
    })).toMatchObject({ currentLane: ESCALATION_LANE_ID });

    // The NEXT poll's fence call on the same candidate now refuses: the parent
    // is frontier, and the correction CAS correctly misses because the row
    // already carries a live hand-out at this generation (never steal an
    // issued attempt).
    let reissued = false;
    const refused = await withHandoutLaneExclusivityFence(asPrFixQueueClient(prisma), candidateOf(row), "NORMAL", async () => {
      reissued = true;
      return "task-2";
    });
    expect(refused, "the follow-up poll must refuse frontier work on the normal lane").toBeNull();
    expect(reissued).toBe(false);
    const finalRow = await prisma.prFixQueueItem.findUnique({ where: { id: row.id } });
    expect(finalRow?.agentHandouts).toEqual(["racer@1"]);
    expect(finalRow?.lane).toBe("NORMAL"); // the CAS missed: live attempt stays exactly as issued
  });
});
