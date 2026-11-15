import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetGitHubAppState } from "./github-auth";
import { probePrFixPrPresence, reconcileDeletedPrFixItems, type PrFixPrPresence, type PrFixQueueClient } from "./pr-fix-queue";

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
      // #1253: the reap writes are generation-AND-status pinned updateMany
      // calls; the fake honors the where clause like the real client so a
      // concurrent requeue in the read→write gap no-ops the reap.
      updateMany: async ({ where, data }: any) => {
        const hits = items.filter(
          (i) =>
            (where.id === undefined || i.id === where.id) &&
            (where.generation === undefined || i.generation === where.generation) &&
            (where.status === undefined || i.status === where.status),
        );
        for (const hit of hits) Object.assign(hit, data);
        return { count: hits.length };
      },
    },
    prFixHistory: { create: async ({ data }: any) => history.push(data) },
  };
  return client;
}

const item = (id: string, repo: string, pr: number, status: string) => ({ id, repo, pr, status, lane: "NORMAL", generation: 1 });

describe("deleted upstream PRs (#1641)", () => {
  it("reaps confirmed-deleted rows to STALE, defers present and unknown, probes active rows only once each", async () => {
    const client = makeClient([
      item("a", "org/gone", 1, "QUEUED"),
      item("b", "org/gone", 2, "BLOCKED"),
      item("c", "org/live", 3, "PARKED"),
      item("d", "org/flaky", 4, "WAITING_EXTERNAL"),
      item("e", "org/live", 5, "FIXED"),
    ]);
    const probe = vi.fn(async (repo: string) =>
      repo === "org/gone" ? "deleted" : repo === "org/live" ? "present" : "unknown",
    );

    const result = await reconcileDeletedPrFixItems(client, probe as any);

    expect(result).toEqual({ checked: 4, markedStale: 2, errored: 0 });
    expect(probe.mock.calls).toEqual([
      ["org/gone", 1],
      ["org/gone", 2],
      ["org/live", 3],
      ["org/flaky", 4],
    ]);
    expect(client.items.map((i) => `${i.id}:${i.status}`)).toEqual([
      "a:STALE",
      "b:STALE",
      "c:PARKED",
      "d:WAITING_EXTERNAL",
      "e:FIXED",
    ]);
    expect(client.history).toHaveLength(2);
    expect(client.history[0]).toMatchObject({
      action: "mark",
      status: "STALE",
      note: "Upstream PR deleted (404 at the per-PR endpoint, repo reachable) at reconcile time (#1641)",
    });
  });

  it("reaping to STALE retires the attempt's evidence snapshot (#1249)", async () => {
    const client = makeClient([
      { ...item("a", "org/gone", 1, "QUEUED"), attemptEvidenceWatermark: 4 },
    ]);

    await reconcileDeletedPrFixItems(client, vi.fn(async (): Promise<PrFixPrPresence> => "deleted"));

    expect(client.items[0].attemptEvidenceWatermark).toBeNull();
  });

  it("a concurrent requeue in the read→write gap wins over the reap (pinned write, #1253)", async () => {
    const client = makeClient([{ ...item("a", "org/gone", 1, "QUEUED"), generation: 3 }]);
    client.prFixQueueItem.updateMany = async ({ where }: any) => {
      // The concurrent requeue lands BEFORE the write evaluates: it bumped
      // the generation and re-queued the row, so the pin misses.
      client.items[0].generation = 4;
      const hit = client.items.find(
        (i: any) =>
          i.id === where.id &&
          i.status === where.status &&
          i.generation === where.generation,
      );
      return { count: hit ? 1 : 0 };
    };

    const result = await reconcileDeletedPrFixItems(client, vi.fn(async (): Promise<PrFixPrPresence> => "deleted"));

    expect(result.markedStale).toBe(0);
    expect(client.items[0].status).toBe("QUEUED");
    expect(client.items[0].generation).toBe(4);
    expect(client.history).toHaveLength(0);
  });

  it("a probe that throws counts as errored and leaves the row untouched", async () => {
    const client = makeClient([item("a", "org/flaky", 1, "QUEUED")]);

    const result = await reconcileDeletedPrFixItems(client, vi.fn(async () => {
      throw new Error("boom");
    }));

    expect(result).toEqual({ checked: 1, markedStale: 0, errored: 1 });
    expect(client.items[0].status).toBe("QUEUED");
    expect(client.history).toHaveLength(0);
  });

  it("three consecutive unknown/failed probes for ONE repo defer that repo's remaining rows without starving other repos", async () => {
    const client = makeClient([
      item("a", "org/flaky", 1, "QUEUED"), // unknown → streak 1
      item("b", "org/flaky", 2, "QUEUED"), // throws  → streak 2 (shared with unknowns)
      item("c", "org/flaky", 3, "QUEUED"), // unknown → streak 3: repo defers
      item("d", "org/flaky", 4, "QUEUED"), // never probed this pass
      item("e", "org/gone", 5, "QUEUED"),  // other repo unaffected: reaped
    ]);
    const probe = vi.fn(async (repo: string, pr: number): Promise<PrFixPrPresence> => {
      if (repo === "org/gone") return "deleted";
      if (pr === 2) throw new Error("network");
      return "unknown";
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await reconcileDeletedPrFixItems(client, probe);

    expect(result).toEqual({ checked: 4, markedStale: 1, errored: 1 });
    expect(client.items[3].status).toBe("QUEUED");
    expect(client.items[4].status).toBe("STALE");
    expect(client.history).toHaveLength(1);
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("org/flaky"))).toBe(true);
    warnSpy.mockRestore();
  });

  it("a present or deleted answer resets the repo streak — confirmed deletions behind unknowns still reap", async () => {
    const client = makeClient([
      item("a", "org/mix", 1, "QUEUED"), // unknown → 1
      item("b", "org/mix", 2, "QUEUED"), // unknown → 2
      item("c", "org/mix", 3, "QUEUED"), // deleted → reset (reaped)
      item("d", "org/mix", 4, "QUEUED"), // unknown → 1
      item("e", "org/mix", 5, "QUEUED"), // present → reset
      item("f", "org/mix", 6, "QUEUED"), // unknown → 1
      item("g", "org/mix", 7, "QUEUED"), // unknown → 2 — breaker fires only
      item("h", "org/mix", 8, "QUEUED"), //   without the present-reset
    ]);
    const probe = vi.fn(async (_repo: string, pr: number): Promise<PrFixPrPresence> =>
      pr === 3 ? "deleted" : pr === 5 ? "present" : "unknown",
    );

    const result = await reconcileDeletedPrFixItems(client, probe);

    // Both resets held: streak never reached 3, so every row got probed.
    // Dropping either reset defers h (checked 7) — the pins are independent.
    expect(result).toEqual({ checked: 8, markedStale: 1, errored: 0 });
    expect(client.items[2].status).toBe("STALE");
    expect(client.items[7].status).toBe("QUEUED");
  });

  it("a reap write failure counts as errored without feeding the probe breaker", async () => {
    const client = makeClient([
      item("a", "org/gone", 1, "QUEUED"),
      item("b", "org/gone", 2, "QUEUED"),
      item("c", "org/gone", 3, "QUEUED"),
      item("d", "org/gone", 4, "QUEUED"),
    ]);
    client.prFixQueueItem.updateMany = async () => {
      throw new Error("db down");
    };

    const result = await reconcileDeletedPrFixItems(client, vi.fn(async (): Promise<PrFixPrPresence> => "deleted"));

    // All four rows keep being probed despite three write failures: the
    // forge answered every probe, so nothing feeds the unknown breaker.
    expect(result).toEqual({ checked: 4, markedStale: 0, errored: 4 });
  });
});

describe("probePrFixPrPresence (#1641)", () => {
  const fetchMock = vi.fn();

  beforeAll(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  beforeEach(() => {
    __resetGitHubAppState();
    process.env.GITHUB_TOKEN = "test-token-for-presence-tests";
    fetchMock.mockReset();
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const res = (status: number, body: unknown = {}) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      json: async () => body,
      text: async () => "",
    }) as unknown as Response;

  it("a per-PR 404 at a readable repo is a confirmed deletion", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/pulls/")
        ? res(404)
        : res(200, { full_name: "Org/Repo", default_branch: "main", archived: false }),
    );

    expect(await probePrFixPrPresence("org/repo", 7)).toBe("deleted");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/repos/org/repo/pulls/7");
    // The reachability gate is only consulted when the PR actually 404s.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a present PR is 'present' and never reaches the reachability gate", async () => {
    fetchMock.mockImplementation(async () => res(200, { state: "open" }));

    expect(await probePrFixPrPresence("org/repo", 7)).toBe("present");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a per-PR 404 at an unreadable repo stays 'unknown' — never reap on an unconfirmed fact", async () => {
    // Realistic unreadable shape: the repo itself 404s (deleted/renamed-
    // without-redirect/private-to-this-token), so the PR's 404 proves nothing.
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/pulls/") ? res(404) : res(404, { message: "Not Found" }),
    );

    expect(await probePrFixPrPresence("org/repo", 7)).toBe("unknown");
  });

  it("a per-PR 403 (rate limit / secondary limit) is 'unknown', not a deletion", async () => {
    fetchMock.mockImplementation(async () => res(403, { message: "Forbidden" }));

    expect(await probePrFixPrPresence("org/repo", 7)).toBe("unknown");
    // No reachability gate follows a non-404 answer.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a transport failure on the per-PR probe is 'unknown'", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/pulls/")) throw new Error("network down");
      return res(200, { full_name: "Org/Repo", default_branch: "main" });
    });

    expect(await probePrFixPrPresence("org/repo", 7)).toBe("unknown");
  });
});
