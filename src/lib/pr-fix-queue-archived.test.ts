import { describe, expect, it, vi } from "vitest";
import { reconcileArchivedRepoPrFixItems, requeuePrFixItem, type PrFixQueueClient } from "./pr-fix-queue";

vi.mock("./pr-fix-surfacing", () => ({
  surfacePrFixBlocked: vi.fn(async () => null),
  surfacePrFixRequeued: vi.fn(async () => null),
  extractUrlsFromText: vi.fn(() => []),
}));

function makeClient(items: any[]): PrFixQueueClient & { items: any[]; history: any[] } {
  const history: any[] = [];
  const client: any = {
    items,
    history,
    $transaction: async (fn: any) => fn(client),
    issue: { findFirst: async () => null },
    prFixQueueItem: {
      findUnique: async ({ where }: any) =>
        items.find((i) => i.repo === where.repo_pr.repo && i.pr === where.repo_pr.pr) ?? null,
      findMany: async ({ where }: any) => items.filter((i) => where.status.in.includes(i.status)),
      create: async () => {
        throw new Error("unused");
      },
      update: async ({ where, data }: any) => Object.assign(items.find((i) => i.id === where.id), data),
      updateMany: async () => ({ count: 0 }),
    },
    prFixHistory: { create: async ({ data }: any) => history.push(data) },
  };
  return client;
}

const item = (id: string, repo: string, pr: number, status: string) => ({ id, repo, pr, status, lane: "NORMAL", generation: 1 });

describe("archived repos (#1106)", () => {
  it("reaps QUEUED and BLOCKED items of archived repos to STALE, one lookup per repo", async () => {
    const client = makeClient([
      item("a", "org/archived", 1, "QUEUED"),
      item("b", "org/archived", 2, "BLOCKED"),
      item("c", "org/archived", 3, "FIXED"),
      item("d", "org/live", 4, "QUEUED"),
    ]);
    const isArchived = vi.fn(async (repo: string) => repo === "org/archived");

    const result = await reconcileArchivedRepoPrFixItems(client, isArchived);

    expect(result).toEqual({ checked: 3, markedStale: 2, errored: 0 });
    expect(isArchived).toHaveBeenCalledTimes(2);
    expect(client.items.map((i) => `${i.pr}:${i.status}`)).toEqual(["1:STALE", "2:STALE", "3:FIXED", "4:QUEUED"]);
    expect(client.history).toHaveLength(2);
    expect(client.history[0]).toMatchObject({ action: "mark", status: "STALE", note: "Upstream repo archived at reconcile time (#1106)" });
  });

  it("refuses to requeue an item in an archived repo", async () => {
    const client = makeClient([item("a", "org/archived", 1, "BLOCKED")]);

    await expect(requeuePrFixItem(client, { repo: "org/archived", pr: 1, isRepoArchived: true })).rejects.toThrow("repository is archived");
    expect(client.items[0].status).toBe("BLOCKED");
  });
});
