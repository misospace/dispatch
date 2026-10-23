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
import { prisma } from "@/lib/prisma";
import { enqueuePrFixItem, listQueuedPrFixItems, toAgentQueuePrFixItem } from "./pr-fix-queue";

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
});
