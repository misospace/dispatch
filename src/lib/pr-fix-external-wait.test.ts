import { describe, expect, it, vi } from "vitest";
import { listQueuedPrFixItems, markPrFixItem, resolvePrFixFromAgentReport, type PrFixQueueClient } from "./pr-fix-queue";

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
    prFixHistory: { create: async ({ data }: any) => { history.push(data); } },
    $transaction: async (fn: any) => fn(client),
  };
  return { client: client as PrFixQueueClient, history };
}

const item = () => ({ id: "pf1", repo: "org/repo", pr: 7, status: "QUEUED", lane: "NORMAL", generation: 4, fixAttempts: 5, attemptHeadSha: null as string | null, retryAt: null as Date | null, dispatchedGeneration: 4, dispatchedAt: new Date(), agentHandouts: ["worker@4"], handoutAcks: ["worker@4"], postDispatchEvidenceKeys: [] });

describe("external prerequisite waits (#1231)", () => {
  it("marks a generation once without charging attempts, and accepts repeats idempotently", async () => {
    const row = item();
    const { client, history } = clientFor(row);
    const first = await markPrFixItem(client, { repo: row.repo, pr: row.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4, note: "CI dependency" });
    const deadline = row.retryAt;
    const repeated = await markPrFixItem(client, { repo: row.repo, pr: row.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4, note: "duplicate" });
    expect(first.mutated).toBe(true);
    expect(repeated.mutated).toBe(true);
    expect(row.status).toBe("WAITING_EXTERNAL");
    expect(row.fixAttempts).toBe(5);
    expect(row.retryAt).toBe(deadline);
    expect(history).toHaveLength(1);
  });

  it("reissues a due wait as a clean new generation without changing attempt budget", async () => {
    const row = { ...item(), status: "WAITING_EXTERNAL", retryAt: new Date(Date.now() - 1), dispatchedAt: new Date(), agentHandouts: ["worker@4"], handoutAcks: ["worker@4"] };
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
    const staleResult = await markPrFixItem(clientFor(stale).client, { repo: stale.repo, pr: stale.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4 });
    expect(staleResult).toEqual({ mutated: false, reason: "generation-mismatch" });
    for (const status of ["BLOCKED", "PARKED"]) {
      const sticky = { ...item(), status };
      const result = await markPrFixItem(clientFor(sticky).client, { repo: sticky.repo, pr: sticky.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4 });
      expect(result).toEqual({ mutated: false, reason: "generation-mismatch" });
      expect(sticky.status).toBe(status);
    }
  });

  it("routes waiting-external reports through the same generation-fenced transition", async () => {
    const row = item();
    const { client } = clientFor(row);
    const result = await resolvePrFixFromAgentReport({ repoFullName: row.repo, pullRequestNumber: row.pr, outcome: "waiting-external", attempt: { itemId: row.id, generation: 4 }, client });
    expect(result.action).toBe("deferred");
    expect(row.status).toBe("WAITING_EXTERNAL");
    expect(row.fixAttempts).toBe(5);
    expect(row.lane).toBe("NORMAL");
  });

  it("allows repeated external waits across the attempt cap without charging attempts", async () => {
    const row = { ...item(), fixAttempts: 5 };
    const { client, history } = clientFor(row);
    for (let cycle = 0; cycle < 3; cycle++) {
      await markPrFixItem(client, { repo: row.repo, pr: row.pr, status: "WAITING_EXTERNAL", expectedGeneration: row.generation });
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
      await resolvePrFixFromAgentReport({ repoFullName: row.repo, pullRequestNumber: row.pr, outcome: "waiting-external", attempt: { itemId: row.id, generation: 4 }, client });
      await markPrFixItem(client, { repo: row.repo, pr: row.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4 });
    } else {
      await markPrFixItem(client, { repo: row.repo, pr: row.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4 });
      await resolvePrFixFromAgentReport({ repoFullName: row.repo, pullRequestNumber: row.pr, outcome: "waiting-external", attempt: { itemId: row.id, generation: 4 }, client });
    }
    const deadline = row.retryAt;
    await resolvePrFixFromAgentReport({ repoFullName: row.repo, pullRequestNumber: row.pr, outcome: "waiting-external", attempt: { itemId: row.id, generation: 4 }, client });
    expect(row.retryAt).toBe(deadline);
    expect(history).toHaveLength(1);
  });

  it("preserves a concurrent BLOCKED transition", async () => {
    const row = item();
    let raced = false;
    const { client, history } = clientFor(row, { beforeUpdate: () => { if (!raced) { raced = true; row.status = "BLOCKED"; } } });
    const result = await markPrFixItem(client, { repo: row.repo, pr: row.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4 });
    expect(result).toEqual({ mutated: false, reason: "generation-mismatch" });
    expect(row.status).toBe("BLOCKED");
    expect(history).toHaveLength(0);
  });

  it("accepts a concurrent wait winner as duplicate success", async () => {
    const row = item();
    let raced = false;
    const { client, history } = clientFor(row, { beforeUpdate: () => { if (!raced) { raced = true; row.status = "WAITING_EXTERNAL"; row.retryAt = new Date(Date.now() + 60_000); } } });
    const result = await markPrFixItem(client, { repo: row.repo, pr: row.pr, status: "WAITING_EXTERNAL", expectedGeneration: 4 });
    expect(result.mutated).toBe(true);
    expect(row.status).toBe("WAITING_EXTERNAL");
    expect(history).toHaveLength(0);
  });

  it("does not overwrite status or generation changed during due-wait reactivation", async () => {
    const row = { ...item(), status: "WAITING_EXTERNAL", retryAt: new Date(Date.now() - 1000) };
    const { client, history } = clientFor(row, { beforeUpdate: () => { row.status = "BLOCKED"; row.generation = 8; } });
    await listQueuedPrFixItems(client);
    expect(row.status).toBe("BLOCKED");
    expect(row.generation).toBe(8);
    expect(history).toHaveLength(0);
  });

  it("keeps attempt count through due reactivation and subsequent FIXED settlement", async () => {
    const row = { ...item(), status: "WAITING_EXTERNAL", retryAt: new Date(Date.now() - 1000) };
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
