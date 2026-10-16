import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { listQueuedPrFixItems, markPrFixItem, resolvePrFixFromAgentReport, type PrFixQueueClient } from "./pr-fix-queue";
import {
  evaluateExternalWaitTrigger,
  parseExternalWaitInput,
  parseStoredExternalWait,
  type ExternalWaitContract,
} from "./pr-fix-external-wait";

function clientFor(item: any, hooks: { beforeUpdate?: (where: any, data: any) => void } = {}) {
  const history: any[] = [];
  const client: any = {
    prFixQueueItem: {
      findUnique: async ({ where }: any) => where.id ? (where.id === item.id ? item : null) : item.repo === where.repo_pr.repo && item.pr === where.repo_pr.pr ? item : null,
      findMany: async ({ where }: any = {}) => {
        const statuses = where?.status?.in ?? [where?.status];
        if (where?.status && !statuses.includes(item.status)) return [];
        if (where?.retryAt && (!item.retryAt || new Date(item.retryAt).getTime() > new Date(where.retryAt.lte).getTime())) return [];
        return [item];
      },
      update: async ({ where, data }: any) => { if (where.id !== item.id) throw new Error("not found"); Object.assign(item, data); return item; },
      updateMany: async ({ where, data }: any) => {
        hooks.beforeUpdate?.(where, data);
        if (where.id !== item.id || (where.status && item.status !== where.status) || item.generation !== where.generation || (where.retryAt && item.retryAt !== where.retryAt)) return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          if (key === "generation" && typeof value === "object" && value !== null && "increment" in value) item.generation += (value as any).increment;
          else item[key] = value;
        }
        return { count: 1 };
      },
    },
    prFixHistory: {
      create: async ({ data }: any) => { history.push(data); },
      findMany: async ({ where, orderBy }: any) => history.filter((entry) => where.itemId.in.includes(item.id) && entry.status === where.status && entry.action === where.action).reverse(),
    },
    $transaction: async (fn: any) => fn(client),
  };
  return { client: client as PrFixQueueClient, history };
}

const item = () => ({ id: "pf1", repo: "org/repo", pr: 7, status: "QUEUED", lane: "NORMAL", generation: 4, fixAttempts: 5, attemptHeadSha: null as string | null, retryAt: null as Date | null, dispatchedGeneration: 4, dispatchedAt: new Date(), agentHandouts: ["worker@4"], handoutAcks: ["worker@4"], postDispatchEvidenceKeys: [] as string[], attemptEvidenceWatermark: null as number | null, outcome: null as string | null, externalWait: null as unknown });

// #1250: every new WAITING_EXTERNAL mark/report must name a concrete,
// verifiable dependency — this is the shared conforming payload.
const structuredWait = { kind: "upstream_pr", ref: "org/deps#77", evidence: "upstream PR open, not merged", trigger: { kind: "merged" } };

describe("external prerequisite waits (#1231)", () => {

  it("marks a generation once without charging attempts, and accepts repeats idempotently", async () => {
    const row = item();
    const { client, history } = clientFor(row);
    const first = await markPrFixItem(client, { repo: row.repo, pr: row.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4, note: "CI dependency", externalWait: structuredWait });
    const deadline = row.retryAt;
    const repeated = await markPrFixItem(client, { repo: row.repo, pr: row.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4, note: "duplicate", externalWait: structuredWait });
    expect(first.mutated).toBe(true);
    expect(repeated.mutated).toBe(true);
    expect(row.status).toBe("WAITING_EXTERNAL");
    expect(row.fixAttempts).toBe(5);
    expect(row.retryAt).toBe(deadline);
    expect(row.externalWait).toEqual(structuredWait);
    expect(history).toHaveLength(1);
  });

  it("reissues a due wait as a clean new generation without changing attempt budget", async () => {
    const row = { ...item(), status: "WAITING_EXTERNAL", retryAt: new Date(Date.now() - 1), dispatchedAt: new Date(), agentHandouts: ["worker@4"], handoutAcks: ["worker@4"], externalWait: structuredWait };
    const { client, history } = clientFor(row);
    const queued = await listQueuedPrFixItems(client);
    expect(queued.map((x: any) => x.status)).toEqual(["QUEUED"]);
    expect(row.generation).toBe(5);
    expect(row.fixAttempts).toBe(5);
    expect(row.retryAt).toBeNull();
    expect(row.dispatchedAt).toBeNull();
    expect(row.dispatchedGeneration).toBeNull();
    expect(row.postDispatchEvidenceKeys).toEqual([]);
    expect(row.agentHandouts).toEqual([]);
    expect(row.handoutAcks).toEqual([]);
    expect(row.attemptHeadSha).toBeNull();
    expect(history).toHaveLength(1);
  });

  it("does not let stale wait marks overwrite an updated generation or sticky decisions", async () => {
    const stale = item();
    stale.generation = 5;
    const staleResult = await markPrFixItem(clientFor(stale).client, { repo: stale.repo, pr: stale.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4, externalWait: structuredWait });
    expect(staleResult).toEqual({ mutated: false, reason: "generation-mismatch" });
    for (const status of ["BLOCKED", "PARKED"]) {
      const sticky = { ...item(), status };
      const result = await markPrFixItem(clientFor(sticky).client, { repo: sticky.repo, pr: sticky.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4, externalWait: structuredWait });
      expect(result).toEqual({ mutated: false, reason: "generation-mismatch" });
      expect(sticky.status).toBe(status);
    }
  });

  it("routes waiting-external reports through the same generation-fenced transition", async () => {
    const row = item();
    const { client } = clientFor(row);
    const result = await resolvePrFixFromAgentReport({ repoFullName: row.repo, pullRequestNumber: row.pr, outcome: "waiting-external", attempt: { itemId: row.id, generation: 4 }, externalWait: structuredWait, client });
    expect(result.action).toBe("deferred");
    expect(row.status).toBe("WAITING_EXTERNAL");
    expect(row.fixAttempts).toBe(5);
    expect(row.lane).toBe("NORMAL");
  });

  it("allows repeated external waits across the attempt cap without charging attempts", async () => {
    const row = { ...item(), fixAttempts: 5 };
    const { client, history } = clientFor(row);
    for (let cycle = 0; cycle < 3; cycle++) {
      await markPrFixItem(client, { repo: row.repo, pr: row.pr, status: "WAITING_EXTERNAL", expectedGeneration: row.generation, externalWait: structuredWait });
      expect(row.fixAttempts).toBe(5);
      row.status = "QUEUED";
      row.generation += 1;
      row.retryAt = null;
    }
    expect(history).toHaveLength(3);
  });

  it("does not resume a future cooldown", async () => {
    const row = { ...item(), status: "WAITING_EXTERNAL", retryAt: new Date(Date.now() + 60_000) };
    const { client, history } = clientFor(row);
    const historyBefore = history.length;
    const queued = await listQueuedPrFixItems(client);
    expect(queued).toEqual([]);
    expect(row.status).toBe("WAITING_EXTERNAL");
    expect(row.generation).toBe(4);
    expect(history).toHaveLength(historyBefore);
  });

  it.each(["report-first", "mark-first"]) ("deduplicates report/mark in %s order", async (order) => {
    const row = item();
    const { client, history } = clientFor(row);
    if (order === "report-first") {
      await resolvePrFixFromAgentReport({ repoFullName: row.repo, pullRequestNumber: row.pr, outcome: "waiting-external", error: "missing prerequisite: X", attempt: { itemId: row.id, generation: 4 }, externalWait: structuredWait, client });
      expect(history).toHaveLength(1);
      expect(history[0].note).toBe("missing prerequisite: X");
      await markPrFixItem(client, { repo: row.repo, pr: row.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4, note: "actual mark note", externalWait: structuredWait });
    } else {
      await markPrFixItem(client, { repo: row.repo, pr: row.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4, note: "actual mark note", externalWait: structuredWait });
      await resolvePrFixFromAgentReport({ repoFullName: row.repo, pullRequestNumber: row.pr, outcome: "waiting-external", error: "missing prerequisite: X", attempt: { itemId: row.id, generation: 4 }, externalWait: structuredWait, client });
    }
    const deadline = row.retryAt;
    await resolvePrFixFromAgentReport({ repoFullName: row.repo, pullRequestNumber: row.pr, outcome: "waiting-external", attempt: { itemId: row.id, generation: 4 }, client });
    expect(row.retryAt).toBe(deadline);
    expect(history).toHaveLength(1);
    expect(history[0].note).toBe(order === "report-first" ? "missing prerequisite: X" : "actual mark note");
  });

  it("sanitizes and bounds the stored external-wait note", async () => {
    const row = item();
    const { client, history } = clientFor(row);
    const secretError = `token=${"s".repeat(700)}`;
    await resolvePrFixFromAgentReport({ repoFullName: row.repo, pullRequestNumber: row.pr, outcome: "waiting-external", error: secretError, attempt: { itemId: row.id, generation: 4 }, externalWait: structuredWait, client });
    expect(history[0].note).toContain("token=");
    expect(history[0].note.length).toBeLessThanOrEqual(500);
    expect(history[0].note).not.toContain("s".repeat(700));
  });

  it("preserves a concurrent BLOCKED transition", async () => {
    const row = item();
    let raced = false;
    const { client, history } = clientFor(row, { beforeUpdate: () => { if (!raced) { raced = true; row.status = "BLOCKED"; } } });
    const result = await markPrFixItem(client, { repo: row.repo, pr: row.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4, externalWait: structuredWait });
    expect(result).toEqual({ mutated: false, reason: "generation-mismatch" });
    expect(row.status).toBe("BLOCKED");
    expect(history).toHaveLength(0);
  });

  it("accepts a concurrent wait winner as duplicate success", async () => {
    const row = item();
    let raced = false;
    const { client, history } = clientFor(row, { beforeUpdate: () => { if (!raced) { raced = true; row.status = "WAITING_EXTERNAL"; row.retryAt = new Date(Date.now() + 60_000); } } });
    const result = await markPrFixItem(client, { repo: row.repo, pr: row.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4, externalWait: structuredWait });
    expect(result.mutated).toBe(true);
    expect(row.status).toBe("WAITING_EXTERNAL");
    expect(history).toHaveLength(0);
  });

  it("does not overwrite status or generation changed during due-wait reactivation", async () => {
    const row = { ...item(), status: "WAITING_EXTERNAL", retryAt: new Date(Date.now() - 1000), externalWait: structuredWait };
    const { client, history } = clientFor(row, { beforeUpdate: () => { row.status = "BLOCKED"; row.generation = 8; } });
    await listQueuedPrFixItems(client);
    expect(row.status).toBe("BLOCKED");
    expect(row.generation).toBe(8);
    expect(history).toHaveLength(0);
  });

  it("keeps attempt count through due reactivation and subsequent FIXED settlement", async () => {
    const row = { ...item(), status: "WAITING_EXTERNAL", retryAt: new Date(Date.now() - 1000), externalWait: structuredWait };
    const { client } = clientFor(row);
    await listQueuedPrFixItems(client);
    const generation = row.generation;
    await markPrFixItem(client, { repo: row.repo, pr: row.pr, status: "FIXED", expectedGeneration: generation });
    expect(row.status).toBe("FIXED");
    expect(row.generation).toBe(generation);
    expect(row.fixAttempts).toBe(5);
  });

  it("reconciles closed and archived WAITING_EXTERNAL items using the real reconciliation functions", async () => {
    const { reconcileArchivedRepoPrFixItems, reconcileStalePrFixItems } = await import("./pr-fix-queue");
    const closed = { ...item(), status: "WAITING_EXTERNAL" };
    const closedFixture = clientFor(closed);
    expect(await reconcileStalePrFixItems(closedFixture.client, new Map([[closed.repo, new Set([closed.pr])]]), new Map([[closed.repo, new Map([[closed.pr, "closed"]])]]))).toMatchObject({ checked: 1, markedStale: 1, errored: 0 });
    expect(closed.status).toBe("STALE");
    const archived = { ...item(), status: "WAITING_EXTERNAL" };
    const archivedFixture = clientFor(archived);
    expect(await reconcileArchivedRepoPrFixItems(archivedFixture.client, async () => true)).toMatchObject({ checked: 1, markedStale: 1, errored: 0 });
    expect(archived.status).toBe("STALE");
  });

  it("does not treat an old attempt as a repeat of a newer external wait", async () => {
    const row = { ...item(), status: "WAITING_EXTERNAL", generation: 5 };
    const result = await resolvePrFixFromAgentReport({ repoFullName: row.repo, pullRequestNumber: row.pr, outcome: "waiting-external", attempt: { itemId: row.id, generation: 4 }, client: clientFor(row).client });
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("stale attempt generation");
  });
});

describe("structured external-wait contract (#1250)", () => {
  const goodContract = { kind: "upstream_pr", ref: "org/repo#12", evidence: "PR open, unmerged", trigger: { kind: "merged" } };

  it("validates a bounded, typed contract", () => {
    expect(parseExternalWaitInput(goodContract).ok).toBe(true);
    expect(parseExternalWaitInput({ ...goodContract, trigger: { kind: "merged", note: "merge commit expected" } }).ok).toBe(true);
    expect(parseExternalWaitInput({ kind: "ci_check", ref: "check:build@abc1234", evidence: "pending", trigger: { kind: "check_success" } }).ok).toBe(true);
    expect(parseExternalWaitInput({ kind: "upstream_issue", ref: "org/repo#9", evidence: "open", trigger: { kind: "closed" } }).ok).toBe(true);
    expect(parseExternalWaitInput({ kind: "external_service", ref: "vendor:cdn", evidence: "propagating", trigger: { kind: "service_ready" } }).ok).toBe(true);
    expect(parseExternalWaitInput({ kind: "upstream_pr", ref: "org/repo#12", evidence: "e", trigger: { kind: "cooldown_recheck" } }).ok).toBe(true);
    for (const bad of [
      null,
      "wait",
      [],
      { kind: "mystery", ref: "org/repo#12", evidence: "e", trigger: { kind: "merged" } },
      { kind: "upstream_pr", evidence: "e", trigger: { kind: "merged" } },
      { kind: "upstream_pr", ref: "", evidence: "e", trigger: { kind: "merged" } },
      { kind: "upstream_pr", ref: "org/repo#12", evidence: "e" },
      { kind: "upstream_pr", ref: "x".repeat(201), evidence: "e", trigger: { kind: "merged" } },
      { kind: "upstream_pr", ref: "org/repo#12", evidence: "x".repeat(501), trigger: { kind: "merged" } },
      { kind: "upstream_pr", ref: "org/repo#12", evidence: "e", trigger: { kind: "merged", note: "x".repeat(501) } },
      { kind: "upstream_pr", ref: 7, evidence: "e", trigger: { kind: "merged" } },
      // Free-text / missing recovery predicates the evaluator would ignore:
      { kind: "upstream_pr", ref: "org/repo#12", evidence: "e", trigger: "upstream PR merged" },
      { kind: "upstream_pr", ref: "org/repo#12", evidence: "e", trigger: { kind: "someday" } },
      { kind: "upstream_pr", ref: "org/repo#12", evidence: "e", trigger: {} },
      { kind: "upstream_pr", ref: "org/repo#12", evidence: "e", trigger: null },
      // Trigger/dependency pairs without defined evaluator semantics:
      { kind: "upstream_pr", ref: "org/repo#12", evidence: "e", trigger: { kind: "closed" } },
      { kind: "upstream_issue", ref: "org/repo#9", evidence: "e", trigger: { kind: "merged" } },
      { kind: "ci_check", ref: "check:build@abc", evidence: "e", trigger: { kind: "merged" } },
      { kind: "external_service", ref: "vendor:cdn", evidence: "e", trigger: { kind: "check_success" } },
      // Authoritative reference syntax per dependency kind:
      { kind: "upstream_pr", ref: "not-a-ref", evidence: "e", trigger: { kind: "merged" } },
      { kind: "upstream_pr", ref: "org/repo", evidence: "e", trigger: { kind: "merged" } },
      { kind: "upstream_pr", ref: "org/repo#0", evidence: "e", trigger: { kind: "merged" } },
      { kind: "upstream_issue", ref: "not-a-ref", evidence: "e", trigger: { kind: "closed" } },
      { kind: "ci_check", ref: "build@abc1234", evidence: "e", trigger: { kind: "check_success" } },
      { kind: "ci_check", ref: "check:build", evidence: "e", trigger: { kind: "check_success" } },
      { kind: "ci_check", ref: "check:@abc1234", evidence: "e", trigger: { kind: "check_success" } },
    ]) {
      expect(parseExternalWaitInput(bad).ok).toBe(false);
    }
  });

  it("treats a malformed stored contract as a legacy wait", () => {
    expect(parseStoredExternalWait(null)).toBeNull();
    expect(parseStoredExternalWait({ kind: "nonsense" })).toBeNull();
    expect(parseStoredExternalWait({ kind: "upstream_pr", ref: "not-a-ref", evidence: "e", trigger: { kind: "merged" } })).toBeNull();
    expect(parseStoredExternalWait(goodContract)).toEqual({ kind: "upstream_pr", ref: "org/repo#12", evidence: "PR open, unmerged", trigger: { kind: "merged" } });
  });

  it("downgrades a dependency-less wait mark to a fail-closed PARKED, generation-pinned", async () => {
    const row = item();
    // A dispatched attempt's evidence snapshot must not survive the park
    // (#1249/#1250 boundary): a terminal disposition clears it like every
    // other sticky settle.
    row.attemptEvidenceWatermark = 3;
    row.postDispatchEvidenceKeys = ["review:org/repo#7:r1"];
    const { client, history } = clientFor(row);
    const result = await markPrFixItem(client, { repo: row.repo, pr: row.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4, note: "no patch yet" });
    expect(result.mutated).toBe(true);
    expect(row.status).toBe("PARKED");
    expect(row.lane).toBe("NORMAL");
    expect(row.outcome).toBe("invalid_wait");
    expect(row.retryAt).toBeNull();
    expect(row.attemptEvidenceWatermark).toBeNull();
    expect(row.postDispatchEvidenceKeys).toEqual([]);
    // #1250 review: the downgrade writes SQL NULL (Prisma.DbNull), not a
    // JSON null document.
    expect(row.externalWait).toBe(Prisma.DbNull);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("PARKED");
    expect(history[0].outcome).toBe("invalid_wait");
    expect(history[0].note).toContain("without a verifiable dependency");
    expect(history[0].note).toContain("no patch yet");
  });

  it("downgrades a malformed wait contract the same way", async () => {
    const row = item();
    const { client, history } = clientFor(row);
    const result = await markPrFixItem(client, { repo: row.repo, pr: row.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4, externalWait: { kind: "hope" } });
    expect(result.mutated).toBe(true);
    expect(row.status).toBe("PARKED");
    expect(row.outcome).toBe("invalid_wait");
    expect(history[0].note).toContain("externalWait.kind must be one of");
  });

  it("never lets a fail-closed downgrade clobber a newer attempt", async () => {
    const row = item();
    let raced = false;
    const { client, history } = clientFor(row, { beforeUpdate: () => { if (!raced) { raced = true; row.generation = 5; row.status = "QUEUED"; } } });
    const result = await markPrFixItem(client, { repo: row.repo, pr: row.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4 });
    expect(result).toEqual({ mutated: false, reason: "generation-mismatch" });
    expect(row.status).toBe("QUEUED");
    expect(row.generation).toBe(5);
    expect(history).toHaveLength(0);
  });

  it("downgrades a dependency-less waiting-external worker report fail-closed", async () => {
    const row = item();
    const { client, history } = clientFor(row);
    const result = await resolvePrFixFromAgentReport({ repoFullName: row.repo, pullRequestNumber: row.pr, outcome: "waiting-external", summary: "still nothing to push", attempt: { itemId: row.id, generation: 4 }, client });
    // #1250 review: truthful outcome — the report recorded a fail-closed
    // park, not a wait.
    expect(result.action).toBe("parked");
    expect(result.reason).toContain("fail-closed park");
    expect(result.reason).toContain("invalid_wait");
    expect(row.status).toBe("PARKED");
    expect(row.outcome).toBe("invalid_wait");
    expect(row.lane).toBe("NORMAL");
    expect(row.retryAt).toBeNull();
    expect(history[0].note).toContain("Fail-closed park");
    expect(history[0].note).toContain("still nothing to push");
  });

  it("reports a conforming wait as deferred, not parked", async () => {
    const row = item();
    const { client } = clientFor(row);
    const result = await resolvePrFixFromAgentReport({ repoFullName: row.repo, pullRequestNumber: row.pr, outcome: "waiting-external", summary: "blocked on upstream", attempt: { itemId: row.id, generation: 4 }, externalWait: structuredWait, client });
    expect(result.action).toBe("deferred");
    expect(result.reason).toBe("worker is waiting for an external prerequisite");
    expect(row.status).toBe("WAITING_EXTERNAL");
  });

  it("surfaces legacy free-text waits read-only in queue listings", async () => {
    const legacy = { ...item(), status: "WAITING_EXTERNAL" as const, externalWait: null };
    const structured = { ...item(), id: "item-2", repo: "org/two", pr: 2, status: "WAITING_EXTERNAL" as const, externalWait: { kind: "upstream_pr", ref: "org/deps#7", evidence: "open", trigger: { kind: "merged" } } };
    const client: any = {
      prFixQueueItem: {
        findUnique: async () => null,
        findMany: async () => [legacy, structured],
      },
      prFixHistory: { findMany: async () => [] },
    };
    const included = await listQueuedPrFixItems(client, { includeBlocked: true });
    const legacyRow = included.find((entry: any) => entry.id === legacy.id);
    const structuredRow = included.find((entry: any) => entry.id === structured.id);
    expect(legacyRow).toMatchObject({ status: "WAITING_EXTERNAL", legacyWait: true, externalWait: null });
    expect(structuredRow).toMatchObject({ status: "WAITING_EXTERNAL", legacyWait: false });
    expect(structuredRow.externalWait).toEqual({ kind: "upstream_pr", ref: "org/deps#7", evidence: "open", trigger: { kind: "merged" } });
  });

  it("does not auto-reissue an expired legacy wait; it stays held for operator action", async () => {
    const row = { ...item(), status: "WAITING_EXTERNAL", retryAt: new Date(Date.now() - 1), externalWait: null };
    const { client, history } = clientFor(row);
    const queued = await listQueuedPrFixItems(client);
    // Not reissued, and not returned as claimable QUEUED work either: the
    // item stays WAITING_EXTERNAL and is surfaced only via includeBlocked.
    expect(row.status).toBe("WAITING_EXTERNAL");
    expect(row.retryAt).not.toBeNull();
    expect(row.generation).toBe(4);
    expect(queued).toEqual([]);
    expect(history).toHaveLength(0);
    const withBlocked = await listQueuedPrFixItems(client, { includeBlocked: true });
    expect(withBlocked.map((entry: any) => entry.legacyWait)).toEqual([true]);
  });

  it("does not auto-reissue an expired wait whose stored contract no longer validates", async () => {
    const row = { ...item(), status: "WAITING_EXTERNAL", retryAt: new Date(Date.now() - 1), externalWait: { kind: "upstream_pr", ref: "garbage", evidence: "e", trigger: { kind: "merged" } } };
    const { client, history } = clientFor(row);
    await listQueuedPrFixItems(client);
    expect(row.status).toBe("WAITING_EXTERNAL");
    expect(row.generation).toBe(4);
    expect(history).toHaveLength(0);
  });

  it("still reissues an expired valid structured wait at its cooldown deadline", async () => {
    const row = { ...item(), status: "WAITING_EXTERNAL", retryAt: new Date(Date.now() - 1), externalWait: structuredWait };
    const { client, history } = clientFor(row);
    const queued = await listQueuedPrFixItems(client);
    expect(queued.map((entry: any) => entry.status)).toEqual(["QUEUED"]);
    expect(row.status).toBe("QUEUED");
    expect(row.generation).toBe(5);
    expect(row.retryAt).toBeNull();
    expect(history).toHaveLength(1);
  });

  // #1250 review: a full batch of expired legacy rows must never starve a
  // valid structured wait out of reactivation. The mock below emulates the
  // DB semantics the reactivation query relies on (status/retryAt/externalWait
  // filtering plus deterministic id-cursor pagination); the real-Postgres
  // integration suite proves the same against the actual engine.
  function dbFilteringClient(rows: any[]) {
    const history: any[] = [];
    const findManyCalls: any[] = [];
    const client: any = {
      prFixQueueItem: {
        findUnique: async () => null,
        findMany: async (args: any = {}) => {
          findManyCalls.push(args);
          const where = args.where ?? {};
          const statuses = where.status?.in ?? [where.status];
          let matched = rows.filter((row) => statuses.includes(row.status));
          if (where.retryAt) matched = matched.filter((row) => row.retryAt && new Date(row.retryAt).getTime() <= new Date(where.retryAt.lte).getTime());
          if (where.externalWait?.not === Prisma.DbNull) matched = matched.filter((row) => row.externalWait !== Prisma.DbNull);
          matched.sort((a, b) => String(a.id).localeCompare(String(b.id)));
          if (args.cursor?.id) {
            const index = matched.findIndex((row) => row.id === args.cursor.id);
            if (index >= 0) matched = matched.slice(index + (args.skip ?? 0));
          }
          return matched.slice(0, args.take ?? 100);
        },
        updateMany: async ({ where, data }: any) => {
          const row = rows.find((candidate) => candidate.id === where.id);
          if (!row || (where.status && row.status !== where.status) || (where.generation !== undefined && row.generation !== where.generation) || (where.retryAt && row.retryAt !== where.retryAt)) return { count: 0 };
          const patch = { ...data };
          if (typeof patch.generation === "object" && patch.generation !== null && "increment" in patch.generation) {
            patch.generation = (row.generation ?? 0) + patch.generation.increment;
          }
          Object.assign(row, patch);
          return { count: 1 };
        },
      },
      prFixHistory: {
        create: async ({ data }: any) => { history.push(data); },
        findMany: async () => [],
      },
      $transaction: async (fn: any) => fn(client),
    };
    return { client: client as PrFixQueueClient, history, findManyCalls };
  }

  function expiredLegacyRows(count: number, externalWait: unknown, idPrefix = "legacy"): any[] {
    return Array.from({ length: count }, (_, index) => ({
      ...item(),
      id: `${idPrefix}-${String(index).padStart(3, "0")}`,
      pr: 1000 + index,
      status: "WAITING_EXTERNAL",
      retryAt: new Date(Date.now() - 60_000),
      externalWait,
    }));
  }

  it("reactivates a valid wait past a full batch of legacy SQL-NULL rows (no starvation)", async () => {
    const valid = { ...item(), id: "zz-valid", pr: 9999, status: "WAITING_EXTERNAL", retryAt: new Date(Date.now() - 60_000), externalWait: structuredWait };
    const rows = [...expiredLegacyRows(120, null), valid];
    const { client, history, findManyCalls } = dbFilteringClient(rows);
    const queued = await listQueuedPrFixItems(client);
    expect(queued.map((entry: any) => entry.status)).toEqual(["QUEUED"]);
    expect(valid.status).toBe("QUEUED");
    expect(valid.generation).toBe(5);
    expect(rows.filter((row) => row.id.startsWith("legacy-")).every((row) => row.status === "WAITING_EXTERNAL" && row.retryAt)).toBe(true);
    expect(history).toHaveLength(1);
    // The legacy rows were excluded by the database filter, never fetched.
    expect(findManyCalls[0].where.externalWait).toEqual({ not: Prisma.DbNull });
  });

  it("paginates deterministically past >100 rows whose stored contracts no longer validate", async () => {
    const valid = { ...item(), id: "zz-valid", pr: 9999, status: "WAITING_EXTERNAL", retryAt: new Date(Date.now() - 60_000), externalWait: structuredWait };
    const rows = [...expiredLegacyRows(120, { kind: "upstream_pr", ref: "garbage" }, "stale"), valid];
    const { client, history } = dbFilteringClient(rows);
    const queued = await listQueuedPrFixItems(client);
    expect(queued.map((entry: any) => entry.status)).toEqual(["QUEUED"]);
    expect(valid.status).toBe("QUEUED");
    expect(rows.filter((row) => row.id.startsWith("stale-")).every((row) => row.status === "WAITING_EXTERNAL")).toBe(true);
    expect(history).toHaveLength(1);
  });

  it("bounds the reactivation scan so pathological skipped rows cannot make the sweep unbounded", async () => {
    const rows = expiredLegacyRows(500, { garbage: true }, "stale");
    const { client, history, findManyCalls } = dbFilteringClient(rows);
    await listQueuedPrFixItems(client);
    // 500-row scan limit / 100-row batch = at most 5 reactivation pages per
    // sweep, even though every scanned row is skipped in memory. (The final
    // findMany call is the queue listing itself, which carries no retryAt.)
    expect(findManyCalls.filter((args: any) => args.where?.retryAt).length).toBeLessThanOrEqual(5);
    expect(rows.every((row) => row.status === "WAITING_EXTERNAL")).toBe(true);
    expect(history).toHaveLength(0);
  });

  describe("read-only trigger evaluation", () => {
    const wait: ExternalWaitContract = { kind: "upstream_pr", ref: "org/deps#77", evidence: "upstream PR open", trigger: { kind: "merged" } };

    it("evaluates upstream_pr/merged: merged satisfies, open stays unsatisfied, fetch failure stays unknown", async () => {
      expect(await evaluateExternalWaitTrigger(wait, "org/repo", { fetchPullRequestState: async () => ({ state: "merged", mergedAt: "2026-10-15T00:00:00Z" }) })).toBe("satisfied");
      expect(await evaluateExternalWaitTrigger(wait, "org/repo", { fetchPullRequestState: async () => ({ state: "closed", mergedAt: null }) })).toBe("unsatisfied");
      expect(await evaluateExternalWaitTrigger(wait, "org/repo", { fetchPullRequestState: async () => ({ state: "open", mergedAt: null }) })).toBe("unsatisfied");
      expect(await evaluateExternalWaitTrigger(wait, "org/repo", { fetchPullRequestState: async () => ({ state: null, mergedAt: null }) })).toBe("unknown");
    });

    it("evaluates upstream_issue/closed: closed satisfies, open unsatisfied, unknown on failure", async () => {
      const issueWait: ExternalWaitContract = { ...wait, kind: "upstream_issue", trigger: { kind: "closed" } };
      expect(await evaluateExternalWaitTrigger(issueWait, "org/repo", { fetchIssueState: async () => ({ state: "closed" }) })).toBe("satisfied");
      expect(await evaluateExternalWaitTrigger(issueWait, "org/repo", { fetchIssueState: async () => ({ state: "open" }) })).toBe("unsatisfied");
      expect(await evaluateExternalWaitTrigger(issueWait, "org/repo", { fetchIssueState: async () => null })).toBe("unknown");
    });

    it("evaluates ci_check/check_success: success satisfies, failure unsatisfied, in-flight or missing stays unknown", async () => {
      const checkWait: ExternalWaitContract = { kind: "ci_check", ref: "check:build@abc1234", evidence: "check pending on attempt head", trigger: { kind: "check_success" } };
      expect(await evaluateExternalWaitTrigger(checkWait, "org/repo", { fetchCheckRunConclusion: async () => "success" })).toBe("satisfied");
      expect(await evaluateExternalWaitTrigger(checkWait, "org/repo", { fetchCheckRunConclusion: async () => "failure" })).toBe("unsatisfied");
      expect(await evaluateExternalWaitTrigger(checkWait, "org/repo", { fetchCheckRunConclusion: async () => null })).toBe("unknown");
      expect(await evaluateExternalWaitTrigger(checkWait, "org/repo", { fetchCheckRunConclusion: async () => "in_progress" })).toBe("unknown");
    });

    it("never silently satisfies an unverifiable dependency", async () => {
      const serviceWait: ExternalWaitContract = { kind: "external_service", ref: "vendor:cdn", evidence: "propagation pending", trigger: { kind: "service_ready" } };
      expect(await evaluateExternalWaitTrigger(serviceWait, "org/repo")).toBe("unknown");
      expect(await evaluateExternalWaitTrigger({ ...wait, ref: "not-a-ref" }, "org/repo")).toBe("unknown");
    });

    it("holds cooldown_recheck waits for their bounded deadline instead of evaluating a live predicate", async () => {
      const recheckWait: ExternalWaitContract = { ...wait, trigger: { kind: "cooldown_recheck" } };
      expect(await evaluateExternalWaitTrigger(recheckWait, "org/repo", { fetchPullRequestState: async () => ({ state: "merged", mergedAt: "2026-10-15T00:00:00Z" }) })).toBe("unknown");
    });
  });
});
