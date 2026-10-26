/**
 * PrFixType persistence against a real PostgreSQL (#1327).
 *
 * The `PrFixQueueItem.type` column is a Postgres enum. A mocked client
 * assigns any string into any object, so a queue type the database enum lacks
 * passes every unit test and then fails on the first real write — the mocked
 * suite cannot fail for the reason production did.
 *
 * This test enqueues a REBASE item (the mechanical rebase lane) through the
 * real write path and reads it back, so the enum, the schema, and the
 * migration are proven to agree against a live database.
 *
 * Opt-in via RUN_DB_INTEGRATION=1 (same gating as the other integration
 * tests). The database-integration CI job applies the migrations and opts in
 * explicitly.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueuePrFixItem, hasInFlightRebaseHandout, listQueuedPrFixItems, toAgentQueuePrFixItem, withRebaseLaneAdmission, REBASE_LANE_ADVISORY_LOCK_KEY } from "./pr-fix-queue";

vi.mock("./pr-fix-surfacing", () => ({
  surfacePrFixBlocked: vi.fn().mockResolvedValue({ labelApplied: false, commentPosted: false, errors: [] }),
  surfacePrFixRequeued: vi.fn().mockResolvedValue({ labelRemoved: false, commentUpdated: false, errors: [] }),
  surfacePrFixUnblocked: vi.fn().mockResolvedValue({ labelRemoved: false, commentUpdated: false, errors: [] }),
  surfacePrFixParked: vi.fn().mockResolvedValue({ labelRemoved: false, commentPosted: false, errors: [] }),
  extractUrlsFromText: vi.fn(() => []),
}));

const url = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(url);
const suite = enabled ? describe : describe.skip;

const REPO = "integration/rebase-type";

suite("PrFixType REBASE against a real PostgreSQL (#1327)", () => {
  beforeAll(() => {
    void prisma.$connect?.();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.prFixQueueItem.deleteMany({ where: { repo: REPO } });
  });

  it("stores a REBASE queue item and reads it back unchanged", async () => {
    const enqueued = await enqueuePrFixItem(prisma, {
      repo: REPO,
      pr: 1,
      lane: "NORMAL",
      type: "REBASE",
      reason: "Mechanical rebase: PR dirty against base (#1327)",
      feedback: "Mechanical rebase required: this PR is dirty against its base branch (#1327).",
      evidenceKey: "merge_state:integration/rebase-type#1",
    });

    expect(enqueued.type, "the enqueued row must carry the REBASE type").toBe("REBASE");

    const row = await prisma.prFixQueueItem.findUnique({ where: { id: enqueued.id } });
    expect(row?.type, "the persisted row must carry the REBASE type").toBe("REBASE");

    const queued = await listQueuedPrFixItems(prisma, { lane: "NORMAL" });
    const surfaced = queued.map(toAgentQueuePrFixItem).find((item) => item.id === enqueued.id);
    expect(surfaced?.fixType, "the queue listing must surface the REBASE fix type").toBe("REBASE");
  });

  it("hands out exactly one live rebase under concurrent admission (concurrency 1 at the DB boundary, #1327 review)", async () => {
    // The unit suite drives the gate through mocks that execute admissions
    // one after another — a check-then-write gate passes its own test and
    // still fans out in production, because the overlap is a DATABASE
    // interleaving. Here two admissions run truly concurrently: without the
    // advisory transaction lock serializing them (the pre-review shape),
    // both read the idle lane during the deliberate window and BOTH stamp a
    // hand-out. With `withRebaseLaneAdmission` the loser blocks on the
    // lock, re-reads the gate after the winner commits, and defers.
    await enqueuePrFixItem(prisma, {
      repo: REPO,
      pr: 2,
      lane: "NORMAL",
      type: "REBASE",
      reason: "Mechanical rebase: PR dirty against base (#1327)",
      feedback: "Mechanical rebase required: this PR is dirty against its base branch (#1327).",
      evidenceKey: "merge_state:integration/rebase-type#2",
    });

    const admit = async (agent: string): Promise<"admitted" | "deferred"> =>
      withRebaseLaneAdmission(prisma, async (tx) => {
        if (await hasInFlightRebaseHandout(tx)) return "deferred";
        // Widen the historical check-then-write window: the loser of an
        // unlocked race reads here AFTER the winner's read and BEFORE its
        // commit, then would push a second live hand-out.
        await new Promise((resolve) => setTimeout(resolve, 75));
        const claimed = await tx.prFixQueueItem.updateMany({
          where: {
            repo: REPO,
            pr: 2,
            status: "QUEUED",
            NOT: { agentHandouts: { has: `${agent}@1` } },
          },
          data: {
            attemptType: "REBASE",
            dispatchedAt: new Date(),
            dispatchedGeneration: 1,
            agentHandouts: { push: [`${agent}@1`] },
          },
        });
        return claimed.count === 1 ? "admitted" : "deferred";
      });

    const results = await Promise.all([admit("agent-a"), admit("agent-b")]);
    expect(results.filter((r) => r === "admitted"), `admissions must serialize to exactly one hand-out, got ${JSON.stringify(results)}`).toHaveLength(1);

    const row = await prisma.prFixQueueItem.findUnique({ where: { repo_pr: { repo: REPO, pr: 2 } } });
    expect(row?.agentHandouts, "exactly one live rebase hand-out may exist on the branch").toHaveLength(1);
  });

  it("fails closed with no hand-out when the advisory lock cannot be taken (#1327 review)", async () => {
    // The review finding: the lock-timeout fallback restored an unlocked
    // check-then-write, so an admission that could NOT take the advisory lock
    // could still issue a second live rebase. Here the lane's advisory lock
    // is held in a SEPARATE session, so the admission waits and PostgreSQL
    // cancels it at the 3s `lock_timeout`: the admission must reject and NO
    // hand-out may be written. The route's fail-closed path then defers the
    // candidate — never hands it out unlocked.
    await enqueuePrFixItem(prisma, {
      repo: REPO,
      pr: 3,
      lane: "NORMAL",
      type: "REBASE",
      reason: "Mechanical rebase: PR dirty against base (#1327)",
      feedback: "Mechanical rebase required: this PR is dirty against its base branch (#1327).",
      evidenceKey: "merge_state:integration/rebase-type#3",
    });

    let admissionError: unknown = null;
    await prisma.$transaction(
      async (holder) => {
        await holder.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${REBASE_LANE_ADVISORY_LOCK_KEY})`);
        try {
          await withRebaseLaneAdmission(prisma, async (tx) => {
            await tx.prFixQueueItem.updateMany({
              where: { repo: REPO, pr: 3, status: "QUEUED" },
              data: {
                attemptType: "REBASE",
                dispatchedAt: new Date(),
                dispatchedGeneration: 1,
                agentHandouts: { push: ["agent-c@1"] },
              },
            });
            return "admitted";
          });
        } catch (error) {
          admissionError = error;
        }
      },
      // The outer holder transaction outlives the inner 3s lock wait.
      { timeout: 30000 },
    );

    expect(admissionError, "an admission that cannot take the advisory lock must fail").not.toBeNull();
    const row = await prisma.prFixQueueItem.findUnique({ where: { repo_pr: { repo: REPO, pr: 3 } } });
    expect(row?.agentHandouts ?? [], "a failed admission must not write a hand-out").toHaveLength(0);
    expect(row?.attemptType ?? null, "a failed admission must not stamp the dispatched lane").toBeNull();
    expect(await hasInFlightRebaseHandout(prisma), "the failed admission must not occupy the lane").toBe(false);
  });
});
