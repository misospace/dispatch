import { describe, expect, it, beforeEach } from "vitest";
import { enqueuePrFixItem, listQueuedPrFixItems, markPrFixItem, toAgentQueuePrFixItem, reconcileStalePrFixItems, PrFixQueueClient } from "./pr-fix-queue";

function makeClient(): PrFixQueueClient & { items: any[]; history: any[] } {
  const items: any[] = [];
  const history: any[] = [];
  let seq = 0;
  const client: any = {
    items,
    history,
    $transaction: async (fn: any) => fn(client),
    prFixQueueItem: {
      findUnique: async ({ where }: any) => items.find((i) => i.repo === where.repo_pr.repo && i.pr === where.repo_pr.pr) ?? null,
      create: async ({ data }: any) => {
        const item = {
          id: `item-${++seq}`,
          queuedAt: new Date(Date.UTC(2026, 0, 1, 0, seq)),
          updatedAt: new Date(Date.UTC(2026, 0, 1, 0, seq)),
          ...data,
        };
        items.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const idx = items.findIndex((i) => i.id === where.id);
        items[idx] = { ...items[idx], ...data, updatedAt: new Date(Date.UTC(2026, 0, 1, 1, ++seq)) };
        return items[idx];
      },
      findMany: async ({ where, orderBy }: any) => {
        let result = items.slice();
        if (where?.repo) result = result.filter((i) => i.repo === where.repo);
        if (where?.pr?.in) result = result.filter((i) => where.pr.in.includes(i.pr));
        if (where?.status) {
          result = Array.isArray(where.status.in)
            ? result.filter((i) => where.status.in.includes(i.status))
            : result.filter((i) => i.status === where.status);
        }
        if (where?.lane) result = result.filter((i) => i.lane === where.lane);
        if (orderBy) {
          result.sort((a, b) =>
            (a.queuedAt.getTime() - b.queuedAt.getTime()) ||
            a.repo.localeCompare(b.repo) ||
            a.pr - b.pr,
          );
        }
        return result;
      },
    },
    prFixHistory: {
      create: async ({ data }: any) => {
        const row = { id: `history-${history.length + 1}`, at: new Date(), ...data };
        history.push(row);
        return row;
      },
    },
  };
  return client;
}

describe("PR review-fix queue", () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
  });

  it("dedupes by repo and PR while preserving unique evidence keys and feedback", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 10,
      lane: "normal",
      reason: "review requested",
      feedback: "first comment",
      evidenceKey: "review:1",
      branch: "fix/a",
      author: "itsmiso-ai",
    });

    const updated = await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 10,
      lane: "normal",
      reason: "checks failed",
      feedback: "failing test",
      evidenceKey: "check:2",
      branch: "fix/a",
    });

    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 10,
      lane: "normal",
      reason: "duplicate evidence",
      feedback: "failing test",
      evidenceKey: "check:2",
    });

    expect(client.items).toHaveLength(1);
    expect(updated.evidenceKeys).toEqual(["review:1", "check:2"]);
    expect(client.items[0].feedback).toEqual(["first comment", "failing test"]);
    expect(client.history).toHaveLength(3);
  });

  it("orders queued items before issue work by queuedAt, repo, then PR", async () => {
    await enqueuePrFixItem(client, { repo: "z/repo", pr: 2, lane: "normal", reason: "r", feedback: "f", evidenceKey: "z" });
    await enqueuePrFixItem(client, { repo: "a/repo", pr: 1, lane: "normal", reason: "r", feedback: "f", evidenceKey: "a" });
    client.items[0].queuedAt = new Date("2026-01-02T00:00:00Z");
    client.items[1].queuedAt = new Date("2026-01-01T00:00:00Z");

    const queued = await listQueuedPrFixItems(client, { lane: "normal" });
    expect(queued.map((i) => `${i.repo}#${i.pr}`)).toEqual(["a/repo#1", "z/repo#2"]);
    expect(toAgentQueuePrFixItem(queued[0]).type).toBe("pr-review-fix");
  });

  it("filters by lane and excludes needs-human blocked items unless requested", async () => {
    await enqueuePrFixItem(client, { repo: "org/one", pr: 1, lane: "normal", reason: "r", feedback: "f", evidenceKey: "1" });
    await enqueuePrFixItem(client, { repo: "org/two", pr: 2, lane: "escalated", reason: "r", feedback: "f", evidenceKey: "2" });
    await enqueuePrFixItem(client, { repo: "org/three", pr: 3, lane: "needs-human", reason: "r", feedback: "f", evidenceKey: "3" });

    expect((await listQueuedPrFixItems(client, { lane: "normal" })).map((i) => i.pr)).toEqual([1]);
    expect((await listQueuedPrFixItems(client, { lane: "escalated" })).map((i) => i.pr)).toEqual([2]);
    expect(await listQueuedPrFixItems(client, { lane: "needs-human" })).toEqual([]);
    expect((await listQueuedPrFixItems(client, { lane: "needs-human", includeBlocked: true })).map((i) => i.pr)).toEqual([3]);
  });

  it("supports status transitions with history", async () => {
    await enqueuePrFixItem(client, { repo: "org/repo", pr: 5, lane: "normal", reason: "r", feedback: "f", evidenceKey: "e" });
    const fixed = await markPrFixItem(client, { repo: "org/repo", pr: 5, status: "fixed", note: "pushed fix + validation" });

    expect(fixed?.status).toBe("FIXED");
    expect(await listQueuedPrFixItems(client, { lane: "normal" })).toEqual([]);
    expect(client.history.at(-1)).toMatchObject({ action: "mark", status: "FIXED", note: "pushed fix + validation" });
  });
});

describe("reconcileStalePrFixItems", () => {
  it("marks queued items stale when the upstream PR is merged/closed", async () => {
    const client = makeClient();
    await enqueuePrFixItem(client, {
      repo: "misospace/miso-chat",
      pr: 566,
      reason: "AI review failed",
      feedback: "feedback",
      evidenceKey: "k1",
    });
    await enqueuePrFixItem(client, {
      repo: "misospace/miso-chat",
      pr: 567,
      reason: "test 567",
      feedback: "f",
      evidenceKey: "k2",
    });
    await enqueuePrFixItem(client, {
      repo: "misospace/miso-chat",
      pr: 568,
      reason: "test 568",
      feedback: "f",
      evidenceKey: "k3",
    });

    const mergedOrClosed = new Map<string, Set<number>>([
      ["misospace/miso-chat", new Set([566, 568])],
    ]);
    const states = new Map<string, Map<number, "merged" | "closed">>([
      ["misospace/miso-chat", new Map([[566, "merged"], [568, "closed"]])],
    ]);

    const result = await reconcileStalePrFixItems(client, mergedOrClosed, states);
    expect(result.checked).toBe(2);
    expect(result.markedStale).toBe(2);
    expect(result.errored).toBe(0);

    const items = await listQueuedPrFixItems(client, { lane: null, includeBlocked: true });
    const byId = new Map(items.map((i) => [i.pr, i]));
    expect(byId.get(566)?.status).toBe("STALE");
    expect(byId.get(567)?.status).toBe("QUEUED"); // not in merged/closed set
    expect(byId.get(568)?.status).toBe("STALE");
  });

  it("does not touch items already in non-QUEUED status", async () => {
    const client = makeClient();
    await enqueuePrFixItem(client, {
      repo: "misospace/miso-chat",
      pr: 570,
      reason: "x",
      feedback: "f",
      evidenceKey: "k1",
    });
    await markPrFixItem(client, { repo: "misospace/miso-chat", pr: 570, status: "FIXED" });
    const mergedOrClosed = new Map<string, Set<number>>([
      ["misospace/miso-chat", new Set([570])],
    ]);
    const states = new Map<string, Map<number, "merged" | "closed">>([
      ["misospace/miso-chat", new Map([[570, "merged"]])],
    ]);
    const result = await reconcileStalePrFixItems(client, mergedOrClosed, states);
    expect(result.checked).toBe(0);
    expect(result.markedStale).toBe(0);
  });

  it("returns zero counts for repos with no merged/closed PRs", async () => {
    const client = makeClient();
    const result = await reconcileStalePrFixItems(client, new Map(), new Map());
    expect(result.checked).toBe(0);
    expect(result.markedStale).toBe(0);
  });
});
