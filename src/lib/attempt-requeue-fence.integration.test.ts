/**
 * Fenced attempt-requeue fence, against a real PostgreSQL (#1491).
 *
 * The mocked route suite re-implements the CAS in JavaScript: it compares the
 * pinned hand-out arrays element by element and lets the test decide what the
 * row looks like. That cannot prove the two things the fence actually rests
 * on against a real engine:
 *
 *   1. Prisma's `equals` pin on a `String[]` column behaves the way the fence
 *      assumes — including the EMPTY-array case (the mocked suite re-implements
 *      `equals: []`, the happy path, so a mismatch there would only ever show
 *      up in production, where every retry would fail its own CAS);
 *   2. a hand-out that COMMITS between the transaction's read and its
 *      compare-and-swap loses the CAS, so the transition mutates nothing and
 *      the settlement rolls back with it — the "a retry never touches the
 *      current owner" guarantee, which is a DATABASE guarantee (READ COMMITTED
 *      re-evaluates the WHERE against the latest committed row).
 *
 * A mock can only assert that the code asked for a pin; only a real
 * PostgreSQL can prove the pin bites.
 *
 * Opt-in via RUN_DB_INTEGRATION=1 (same gating as the other integration
 * tests). The database-integration CI job applies the migrations and opts in
 * explicitly.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { attemptRequeuePrFixItem, type AttemptRequeuePrFixInput } from "./issue-requeue";

const url = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(url);
const suite = enabled ? describe : describe.skip;

const REPO = "integration/attempt-requeue-fence";
const AGENT = "worker";
const OTHER_AGENT = "other-agent";
const FENCE_TOKEN = "hnd_0123456789abcdef";
const OTHER_TOKEN = "hnd_fedcba9876543210";

/** Seed a PARKED item at the fenced generation, with its issuance proof. */
async function seedItem(opts: {
  pr: number;
  generation?: number;
  receipts?: string[];
  handouts?: string[];
  issued?: boolean;
}) {
  const generation = opts.generation ?? 3;
  const item = await prisma.prFixQueueItem.create({
    data: {
      repo: REPO,
      pr: opts.pr,
      lane: "NORMAL",
      reason: "integration: fenced attempt-requeue fence",
      feedback: [],
      evidenceKeys: [],
      status: "PARKED",
      outcome: "infra_failure",
      generation,
      staleDisposition: true,
      handoutReceipts: opts.receipts ?? [],
      agentHandouts: opts.handouts ?? [],
    },
  });
  if (opts.issued !== false) {
    await prisma.attemptIssuance.create({
      data: {
        surface: "pr-fix",
        attemptId: item.id,
        agentName: AGENT,
        token: FENCE_TOKEN,
        generation,
      },
    });
  }
  return item;
}

function input(pr: number, generation = 3, idempotencyKey = `key-${pr}`): AttemptRequeuePrFixInput {
  return {
    repo: REPO,
    pr,
    generation,
    agentName: AGENT,
    fenceToken: FENCE_TOKEN,
    idempotencyKey,
    note: null,
  };
}

suite("fenced attempt-requeue fence against a real PostgreSQL (#1491)", () => {
  beforeAll(() => {
    void prisma.$connect?.();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    const items = await prisma.prFixQueueItem.findMany({ where: { repo: REPO }, select: { id: true } });
    await prisma.attemptIssuance.deleteMany({
      where: { attemptId: { in: items.map((item) => item.id) } },
    });
    // The settlement rows cascade with the item.
    await prisma.prFixQueueItem.deleteMany({ where: { repo: REPO } });
  });

  it("applies the transition when the fence is provable and no other owner is live", async () => {
    const item = await seedItem({ pr: 1 });
    const result = await attemptRequeuePrFixItem(asPrFixQueueClient(prisma), input(1));

    expect(result).toEqual({ ok: true, replayed: false, itemId: item.id, generation: 4 });

    const row = await prisma.prFixQueueItem.findUnique({ where: { id: item.id } });
    expect(row?.status).toBe("QUEUED");
    expect(row?.generation).toBe(4);
    // The transition owns the hand-out state — it cleared it.
    expect(row?.handoutReceipts).toEqual([]);
    expect(row?.agentHandouts).toEqual([]);
    const settlements = await prisma.prFixRequeueSettlement.findMany({ where: { itemId: item.id } });
    expect(settlements).toHaveLength(1);
    expect(settlements[0].requeuedGeneration).toBe(4);
  });

  it("refuses stale-generation and mutates nothing when ANOTHER live receipt shares the fenced generation", async () => {
    const item = await seedItem({
      pr: 2,
      receipts: [`${FENCE_TOKEN}@${AGENT}@3`, `${OTHER_TOKEN}@${OTHER_AGENT}@3`],
      handouts: [`${AGENT}@3`, `${OTHER_AGENT}@3`],
    });

    const result = await attemptRequeuePrFixItem(asPrFixQueueClient(prisma), input(2));

    expect(result).toEqual({ ok: false, refusal: "stale-generation" });

    const row = await prisma.prFixQueueItem.findUnique({ where: { id: item.id } });
    // The other owner's hand-out survives; nothing was transitioned.
    expect(row?.status).toBe("PARKED");
    expect(row?.generation).toBe(3);
    expect(row?.handoutReceipts).toEqual([
      `${FENCE_TOKEN}@${AGENT}@3`,
      `${OTHER_TOKEN}@${OTHER_AGENT}@3`,
    ]);
    expect(row?.agentHandouts).toEqual([`${AGENT}@3`, `${OTHER_AGENT}@3`]);
    expect(await prisma.prFixRequeueSettlement.count({ where: { itemId: item.id } })).toBe(0);
  });

  it("refuses stale-generation when a same-generation receipt carries the presented token under ANOTHER agent", async () => {
    const item = await seedItem({
      pr: 3,
      receipts: [`${FENCE_TOKEN}@${OTHER_AGENT}@3`],
      handouts: [`${AGENT}@3`],
    });

    const result = await attemptRequeuePrFixItem(asPrFixQueueClient(prisma), input(3));

    expect(result).toEqual({ ok: false, refusal: "stale-generation" });
    const row = await prisma.prFixQueueItem.findUnique({ where: { id: item.id } });
    expect(row?.status).toBe("PARKED");
    expect(row?.generation).toBe(3);
    expect(row?.handoutReceipts).toEqual([`${FENCE_TOKEN}@${OTHER_AGENT}@3`]);
    expect(await prisma.prFixRequeueSettlement.count({ where: { itemId: item.id } })).toBe(0);
  });

  it("proves the CAS pin bites: a hand-out that changed the pinned arrays loses the compare-and-swap", async () => {
    // The fence's WHERE pins the hand-out arrays by equality. Prove against
    // the real engine that a changed array matches NO row (the mocked suite
    // re-implements this comparison in JavaScript).
    const item = await seedItem({
      pr: 4,
      receipts: [`${FENCE_TOKEN}@${AGENT}@3`],
      handouts: [`${AGENT}@3`],
    });

    const matching = await prisma.prFixQueueItem.updateMany({
      where: {
        id: item.id,
        generation: 3,
        handoutReceipts: { equals: [`${FENCE_TOKEN}@${AGENT}@3`] },
        agentHandouts: { equals: [`${AGENT}@3`] },
      },
      data: { status: "QUEUED" },
    });
    expect(matching.count).toBe(1);

    // A hand-out landed in the read→write window: the pinned arrays no longer
    // match, so the transition's CAS matches NO row and mutates nothing.
    await prisma.prFixQueueItem.update({
      where: { id: item.id },
      data: {
        handoutReceipts: [`${FENCE_TOKEN}@${AGENT}@3`, `${OTHER_TOKEN}@${OTHER_AGENT}@3`],
        agentHandouts: [`${AGENT}@3`, `${OTHER_AGENT}@3`],
      },
    });
    const stale = await prisma.prFixQueueItem.updateMany({
      where: {
        id: item.id,
        generation: 3,
        handoutReceipts: { equals: [`${FENCE_TOKEN}@${AGENT}@3`] },
        agentHandouts: { equals: [`${AGENT}@3`] },
      },
      data: { status: "QUEUED", generation: 4 },
    });
    expect(stale.count).toBe(0);
    const row = await prisma.prFixQueueItem.findUnique({ where: { id: item.id } });
    expect(row?.generation).toBe(3);
  });

  it("mutates nothing when a hand-out COMMITS inside the transaction window (the CAS loses, the settlement rolls back)", async () => {
    const item = await seedItem({ pr: 5 });

    // Inject the concurrent hand-out right before the transition's CAS: the
    // row is updated by a separate connection (autocommit), so the CAS's WHERE
    // is re-evaluated against the NEW row and matches nothing.
    let injected = false;
    const extended = prisma.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }: any) {
            if (!injected && model === "PrFixQueueItem" && operation === "updateMany") {
              injected = true;
              await prisma.prFixQueueItem.update({
                where: { id: item.id },
                data: {
                  handoutReceipts: [`${OTHER_TOKEN}@${OTHER_AGENT}@3`],
                  agentHandouts: [`${OTHER_AGENT}@3`],
                },
              });
            }
            return query(args);
          },
        },
      },
    });

    const result = await attemptRequeuePrFixItem(
      asPrFixQueueClient(extended as unknown as typeof prisma),
      input(5),
    );

    expect(injected).toBe(true);
    expect(result).toEqual({ ok: false, refusal: "stale-generation" });
    // The transition rolled back: the item is untouched and the settlement
    // (written before the CAS in the same transaction) never committed.
    const row = await prisma.prFixQueueItem.findUnique({ where: { id: item.id } });
    expect(row?.status).toBe("PARKED");
    expect(row?.generation).toBe(3);
    expect(row?.handoutReceipts).toEqual([`${OTHER_TOKEN}@${OTHER_AGENT}@3`]);
    expect(row?.agentHandouts).toEqual([`${OTHER_AGENT}@3`]);
    expect(await prisma.prFixRequeueSettlement.count({ where: { itemId: item.id } })).toBe(0);
    expect(await prisma.prFixHistory.count({ where: { itemId: item.id } })).toBe(0);
  });
});
