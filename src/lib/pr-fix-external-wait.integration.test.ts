/**
 * External-wait contract integration test, against a real PostgreSQL (#1250).
 *
 * The mocked suite can Object.assign anything into a row, but it cannot prove
 * how Prisma serialized the nullable JSON column. This matters twice for
 * `externalWait`:
 *   - the fail-closed `invalid_wait` downgrade must write SQL NULL
 *     (`Prisma.DbNull`), not a JSON null document — `jsonb 'null'` is NOT
 *     NULL to SQL and would masquerade as legacy on read;
 *   - a stored contract must round-trip as a JSON object.
 *
 * Opt-in via RUN_DB_INTEGRATION=1 (same gating as sync-lock.integration.test.ts,
 * which explains why DATABASE_URL alone is not the gate). The database-
 * integration CI job applies the migrations and opts in explicitly.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueuePrFixItem, markPrFixItem, listQueuedPrFixItems, reconcileExternalWaitTriggers } from "./pr-fix-queue";
import { asPrFixQueueClient } from "@/lib/prisma";

vi.mock("@/lib/pr-fix-surfacing", () => ({
  surfacePrFixBlocked: vi.fn().mockResolvedValue({ labelApplied: false, commentPosted: false, errors: [] }),
  surfacePrFixRequeued: vi.fn().mockResolvedValue({ labelRemoved: false, commentUpdated: false, errors: [] }),
  surfacePrFixUnblocked: vi.fn().mockResolvedValue({ labelRemoved: false, commentUpdated: false, errors: [] }),
  surfacePrFixParked: vi.fn().mockResolvedValue({ labelRemoved: false, commentPosted: false, errors: [] }),
  extractUrlsFromText: vi.fn(() => []),
}));

import { vi } from "vitest";
import { parseStoredExternalWait, type ExternalWaitContract } from "./pr-fix-external-wait";

// Real-DB cases below must make zero network calls, so the trigger evaluator
// (the only forge read in the pass) is stubbed and keyed on the contract ref.
const evaluatorMock = vi.hoisted(() => ({
  evaluateExternalWaitTrigger: vi.fn(async (wait: ExternalWaitContract) =>
    wait.ref.endsWith("#999") ? ("satisfied" as const) : ("unsatisfied" as const),
  ),
}));

vi.mock("./pr-fix-external-wait", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pr-fix-external-wait")>()),
  evaluateExternalWaitTrigger: evaluatorMock.evaluateExternalWaitTrigger,
}));

const url = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(url);
const suite = enabled ? describe : describe.skip;

const REPO = "integration/external-wait";
const CONTRACT: ExternalWaitContract = { kind: "upstream_pr", ref: "org/deps#77", evidence: "upstream PR open, not merged", trigger: { kind: "merged" } };
const ownQueueItems = (items: any[]) => items.filter((item) => item.repo === REPO);

suite("external-wait contract against a real PostgreSQL", () => {
  beforeAll(() => {
    void prisma.$connect?.();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.prFixQueueItem.deleteMany({ where: { repo: REPO } });
  });

  it("persists a valid contract as a JSON object and reads it back", async () => {
    const enqueued = await enqueuePrFixItem(prisma, { repo: REPO, pr: 1, lane: "NORMAL", reason: "review changes requested", feedback: "f", evidenceKey: "e:1" });
    const marked = await markPrFixItem(prisma, { repo: REPO, pr: 1, status: "WAITING_EXTERNAL", expectedGeneration: enqueued.generation, note: "waiting on upstream", externalWait: CONTRACT });
    expect(marked.mutated).toBe(true);

    const row = await prisma.prFixQueueItem.findUnique({ where: { repo_pr: { repo: REPO, pr: 1 } } });
    expect(row?.status).toBe("WAITING_EXTERNAL");
    expect(parseStoredExternalWait(row?.externalWait)).toEqual(CONTRACT);
    const stored = await prisma.$queryRaw<{ typeof: string }[]>`SELECT jsonb_typeof("externalWait") AS typeof FROM "PrFixQueueItem" WHERE "repo" = ${REPO} AND "pr" = 1`;
    expect(stored[0].typeof).toBe("object");
  });

  it("writes SQL NULL (not a JSON null document) on the fail-closed invalid_wait downgrade", async () => {
    const enqueued = await enqueuePrFixItem(prisma, { repo: REPO, pr: 2, lane: "NORMAL", reason: "review changes requested", feedback: "f", evidenceKey: "e:2" });
    // No externalWait: the dependency-less wait downgrades fail-closed.
    const marked = await markPrFixItem(prisma, { repo: REPO, pr: 2, status: "WAITING_EXTERNAL", expectedGeneration: enqueued.generation, note: "no patch yet" });
    expect(marked.mutated).toBe(true);

    const row = await prisma.prFixQueueItem.findUnique({ where: { repo_pr: { repo: REPO, pr: 2 } } });
    expect(row?.status).toBe("PARKED");
    expect(row?.outcome).toBe("invalid_wait");
    expect(parseStoredExternalWait(row?.externalWait)).toBeNull();
    // The DbNull proof: a JSON null document would make jsonb_typeof 'null'
    // and `IS NULL` false. SQL NULL makes both checks pass.
    const stored = await prisma.$queryRaw<{ isNull: boolean; typeof: string | null }[]>`SELECT ("externalWait" IS NULL) AS "isNull", jsonb_typeof("externalWait") AS typeof FROM "PrFixQueueItem" WHERE "repo" = ${REPO} AND "pr" = 2`;
    expect(stored[0].isNull).toBe(true);
    expect(stored[0].typeof).toBeNull();
  });

  it("holds an expired legacy wait for operator action instead of reissuing it", async () => {
    const enqueued = await enqueuePrFixItem(prisma, { repo: REPO, pr: 3, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "e:3" });
    // Simulate a pre-#1250 free-text wait: WAITING_EXTERNAL past its
    // deadline with no contract ever written.
    const updated = await prisma.prFixQueueItem.update({
      where: { repo_pr: { repo: REPO, pr: 3 } },
      data: { status: "WAITING_EXTERNAL", retryAt: new Date(Date.now() - 1000), outcome: null },
    });
    expect(updated.generation).toBe(enqueued.generation);

    const client = asPrFixQueueClient(prisma);
    const queued = ownQueueItems(await listQueuedPrFixItems(client));
    expect(queued).toEqual([]);
    const row = await prisma.prFixQueueItem.findUnique({ where: { repo_pr: { repo: REPO, pr: 3 } } });
    expect(row?.status).toBe("WAITING_EXTERNAL");
    expect(row?.retryAt).not.toBeNull();
    expect(row?.generation).toBe(enqueued.generation);

    const surfaced = ownQueueItems(await listQueuedPrFixItems(client, { includeBlocked: true }));
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]).toMatchObject({ status: "WAITING_EXTERNAL", legacyWait: true });
  });

  it("still reissues an expired valid structured wait at its cooldown deadline", async () => {
    await enqueuePrFixItem(prisma, { repo: REPO, pr: 4, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "e:4" });
    await markPrFixItem(prisma, { repo: REPO, pr: 4, status: "WAITING_EXTERNAL", expectedGeneration: 1, externalWait: CONTRACT });
    await prisma.prFixQueueItem.update({ where: { repo_pr: { repo: REPO, pr: 4 } }, data: { retryAt: new Date(Date.now() - 1000) } });

    const client = asPrFixQueueClient(prisma);
    const queued = ownQueueItems(await listQueuedPrFixItems(client));
    expect(queued.map((entry: any) => entry.status)).toEqual(["QUEUED"]);
    const row = await prisma.prFixQueueItem.findUnique({ where: { repo_pr: { repo: REPO, pr: 4 } } });
    expect(row?.status).toBe("QUEUED");
    expect(row?.generation).toBe(2);
    expect(row?.retryAt).toBeNull();
    expect(parseStoredExternalWait(row?.externalWait)).toBeNull();
  });

  it("reactivates a valid expired wait past 120 expired legacy rows — no starvation (#1250 review)", async () => {
    // 120 pre-#1250 free-text waits past their deadline: SQL NULL contract.
    const stale = new Date(Date.now() - 60_000);
    await prisma.prFixQueueItem.createMany({
      data: Array.from({ length: 120 }, (_, index) => ({
        repo: REPO,
        pr: 1000 + index,
        lane: "NORMAL",
        reason: "legacy free-text wait",
        status: "WAITING_EXTERNAL" as const,
        retryAt: stale,
      })),
    });
    await enqueuePrFixItem(prisma, { repo: REPO, pr: 5, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "e:5" });
    await markPrFixItem(prisma, { repo: REPO, pr: 5, status: "WAITING_EXTERNAL", expectedGeneration: 1, externalWait: CONTRACT });
    await prisma.prFixQueueItem.update({ where: { repo_pr: { repo: REPO, pr: 5 } }, data: { retryAt: stale } });

    const client = asPrFixQueueClient(prisma);
    const queued = ownQueueItems(await listQueuedPrFixItems(client));
    expect(queued.map((entry: any) => entry.status)).toEqual(["QUEUED"]);

    const valid = await prisma.prFixQueueItem.findUnique({ where: { repo_pr: { repo: REPO, pr: 5 } } });
    expect(valid?.status).toBe("QUEUED");
    expect(valid?.generation).toBe(2);

    // Every legacy row stayed held, exactly as it was.
    const legacy = await prisma.prFixQueueItem.findMany({ where: { repo: REPO, pr: { gte: 1000 } } });
    expect(legacy).toHaveLength(120);
    expect(legacy.every((row) => row.status === "WAITING_EXTERNAL" && row.retryAt !== null && row.externalWait === null)).toBe(true);
  });

  it("paginates past 120 expired rows whose stored contracts no longer validate (#1250 review)", async () => {
    const stale = new Date(Date.now() - 60_000);
    // These rows carry well-formed JSON that fails contract validation, so
    // they pass the SQL-NULL database filter and must be walked past by the
    // deterministic id-cursor pagination instead.
    await prisma.prFixQueueItem.createMany({
      data: Array.from({ length: 120 }, (_, index) => ({
        // Keep these ahead of the target row in the id cursor regardless of
        // insert timing from other integration suites.
        id: `a-external-wait-${String(index).padStart(3, "0")}`,
        repo: REPO,
        pr: 2000 + index,
        lane: "NORMAL",
        reason: "r",
        status: "WAITING_EXTERNAL" as const,
        retryAt: stale,
        externalWait: { kind: "upstream_pr", ref: "garbage" } as unknown as Prisma.InputJsonValue,
      })),
    });
    await prisma.prFixQueueItem.create({
      data: {
        id: "z-external-wait-target",
        repo: REPO,
        pr: 6,
        lane: "NORMAL",
        reason: "r",
        status: "WAITING_EXTERNAL",
        retryAt: stale,
        externalWait: CONTRACT as unknown as Prisma.InputJsonValue,
      },
    });

    const client = asPrFixQueueClient(prisma);
    const queued = ownQueueItems(await listQueuedPrFixItems(client));
    expect(queued.filter((entry: any) => entry.pr === 6).map((entry: any) => ({ pr: entry.pr, status: entry.status }))).toEqual([
      { pr: 6, status: "QUEUED" },
    ]);

    const valid = await prisma.prFixQueueItem.findUnique({ where: { repo_pr: { repo: REPO, pr: 6 } } });
    expect(valid?.status).toBe("QUEUED");
    const staleRows = await prisma.prFixQueueItem.findMany({ where: { repo: REPO, pr: { gte: 2000 } } });
    expect(staleRows).toHaveLength(120);
    expect(staleRows.every((row) => row.status === "WAITING_EXTERNAL")).toBe(true);
  });

  // #1253 fairness: a rotation stamp (`triggerEvaluatedAt` ASC NULLS FIRST)
  // that was not honoured by real Postgres would re-read the same head rows
  // forever and starve a later satisfied wait. These two cases are the
  // real-DB proof; the mocked suite cannot observe NULL placement.
  const SATISFIED_REF = "org/deps#999";

  function waitContract(ref: string) {
    return { kind: "upstream_pr", ref, evidence: "upstream open", trigger: { kind: "merged" } } as unknown as Prisma.InputJsonValue;
  }

  it("reaches a satisfied wait sitting behind more than maxEvaluations unsatisfied ones (#1253 review)", async () => {
    // 21 unsatisfied live-trigger waits (more than the default 20-evaluation
    // bound) with the satisfied one behind them. Ids pin the first-pass order
    // (all stamps NULL -> id tiebreak); later passes order by the rotation
    // stamp, which is what the NULLS FIRST clause buys.
    await prisma.prFixQueueItem.createMany({
      data: Array.from({ length: 21 }, (_, index) => ({
        id: `a-external-wait-rot-${String(index).padStart(3, "0")}`,
        repo: REPO,
        pr: 3000 + index,
        lane: "NORMAL",
        reason: "waiting on upstream",
        status: "WAITING_EXTERNAL" as const,
        externalWait: waitContract(`org/deps#${index + 1}`),
      })),
    });
    await prisma.prFixQueueItem.create({
      data: {
        id: "z-external-wait-rot-target",
        repo: REPO,
        pr: 3900,
        lane: "NORMAL",
        reason: "waiting on upstream",
        status: "WAITING_EXTERNAL",
        externalWait: waitContract(SATISFIED_REF),
      },
    });

    const client = asPrFixQueueClient(prisma);
    const first = await reconcileExternalWaitTriggers(client);
    // The evaluation bound stopped the pass before the target row.
    expect(first).toEqual({ evaluated: 20, reactivated: 0 });
    const afterFirst = await prisma.prFixQueueItem.findUnique({ where: { repo_pr: { repo: REPO, pr: 3900 } } });
    expect(afterFirst?.status).toBe("WAITING_EXTERNAL");

    // A later pass rotates past the stamped head and reaches it.
    const second = await reconcileExternalWaitTriggers(client);
    expect(second.reactivated).toBe(1);
    const target = await prisma.prFixQueueItem.findUnique({ where: { repo_pr: { repo: REPO, pr: 3900 } } });
    expect(target?.status).toBe("QUEUED");
    // Uncharged recheck: no attempt consumed.
    expect(target?.fixAttempts).toBe(1);
    expect(target?.generation).toBe(2);
    expect(parseStoredExternalWait(target?.externalWait)).toBeNull();
    // Every unsatisfied wait stayed held.
    const held = await prisma.prFixQueueItem.findMany({ where: { repo: REPO, pr: { gte: 3000, lt: 3900 } } });
    expect(held).toHaveLength(21);
    expect(held.every((row) => row.status === "WAITING_EXTERNAL")).toBe(true);
  });

  it("persists the rotation stamp as a real timestamp column (#1253 review)", async () => {
    // Existence proof, loud on a missing column: the exact regression class of
    // "column PrFixQueueItem.triggerEvaluatedAt does not exist" — Prisma
    // raises on the select/update instead of silently skipping the write.
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'PrFixQueueItem' AND column_name = 'triggerEvaluatedAt'`;
    expect(columns.map((entry) => entry.column_name)).toEqual(["triggerEvaluatedAt"]);

    await prisma.prFixQueueItem.create({
      data: {
        id: "y-external-wait-stamp",
        repo: REPO,
        pr: 4000,
        lane: "NORMAL",
        reason: "waiting on upstream",
        status: "WAITING_EXTERNAL",
        externalWait: waitContract("org/deps#1"),
      },
    });

    const result = await reconcileExternalWaitTriggers(asPrFixQueueClient(prisma));
    expect(result.evaluated).toBe(1);

    const row = await prisma.prFixQueueItem.findUnique({ where: { repo_pr: { repo: REPO, pr: 4000 } } });
    expect(row?.triggerEvaluatedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(new Date(row?.triggerEvaluatedAt as Date).getTime())).toBe(false);
  });
});
