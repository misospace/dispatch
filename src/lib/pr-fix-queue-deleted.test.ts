import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetGitHubAppState } from "./github-auth";
import { createPrFixPrPresenceProbe, probePrFixPrPresence, reconcileDeletedPrFixItems, type PrFixPrPresence, type PrFixQueueClient } from "./pr-fix-queue";

vi.mock("./pr-fix-surfacing", () => ({
  surfacePrFixBlocked: vi.fn(async () => null),
  surfacePrFixRequeued: vi.fn(async () => null),
  extractUrlsFromText: vi.fn(() => []),
}));

type FakeItem = {
  id: string;
  repo: string;
  pr: number;
  status: string;
  lane: string;
  generation: number;
  /** #1641 rotation stamp: NULL = never considered by the deleted-PR reap. */
  prPresenceCheckedAt: Date | null;
  attemptEvidenceWatermark?: number | null;
};

/** Minimal stand-in for the Prisma where-clause the reap uses. */
function matches(item: FakeItem, where: any): boolean {
  if (where?.status !== undefined) {
    if (typeof where.status === "string") {
      if (item.status !== where.status) return false;
    } else {
      const allowed = Array.isArray(where.status) ? where.status : (where.status?.in ?? []);
      if (!allowed.includes(item.status)) return false;
    }
  }
  if (where?.id !== undefined) {
    if (typeof where.id === "string") {
      if (item.id !== where.id) return false;
    } else if (Array.isArray(where.id?.in) && !where.id.in.includes(item.id)) {
      return false;
    }
  }
  if (where?.generation !== undefined && item.generation !== where.generation) return false;
  if (Array.isArray(where?.OR)) {
    // The reap's due set: never considered (NULL) or considered long enough ago.
    const matched = where.OR.some((cond: any) => {
      if (!("prPresenceCheckedAt" in cond)) return true;
      const bound = cond.prPresenceCheckedAt;
      if (bound === null) return item.prPresenceCheckedAt === null;
      if (bound?.lte instanceof Date) {
        return item.prPresenceCheckedAt !== null && item.prPresenceCheckedAt.getTime() <= bound.lte.getTime();
      }
      return true;
    });
    if (!matched) return false;
  }
  return true;
}

function makeClient(items: FakeItem[]): PrFixQueueClient & { items: FakeItem[]; history: any[]; rawQueries: any[] } {
  const history: any[] = [];
  const rawQueries: any[] = [];
  const client: any = {
    items,
    history,
    rawQueries,
    $transaction: async (fn: any) => fn(client),
    $executeRaw: async (query: any) => {
      rawQueries.push(query);
      const values: unknown[] = query.values ?? [];
      const stamp = values.find((value) => value instanceof Date) as Date | undefined;
      const ids = new Set(items.map((item) => item.id));
      const bound = values.filter((value): value is string => typeof value === "string");
      const rowIds = new Set(bound.filter((value) => ids.has(value)));
      const statuses = new Set(bound.filter((value) => !ids.has(value)));
      let count = 0;
      for (const row of items) {
        if (!rowIds.has(row.id) || !statuses.has(row.status)) continue;
        row.prPresenceCheckedAt = stamp ?? null;
        count++;
      }
      return count;
    },
    issue: { findFirst: async () => null },
    prFixQueueItem: {
      findUnique: async ({ where }: any) =>
        items.find((i) => i.repo === where.repo_pr.repo && i.pr === where.repo_pr.pr) ?? null,
      // The reap reads least-recently-considered first with an explicit
      // NULLS FIRST, then `id` as the deterministic tiebreak.
      findMany: async ({ where, take }: any) => {
        const selected = items.filter((i) => matches(i, where));
        selected.sort((a, b) => {
          const av = a.prPresenceCheckedAt ? a.prPresenceCheckedAt.getTime() : null;
          const bv = b.prPresenceCheckedAt ? b.prPresenceCheckedAt.getTime() : null;
          if (av === bv) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          if (av === null) return -1; // NULLS FIRST
          if (bv === null) return 1;
          return av - bv;
        });
        return typeof take === "number" ? selected.slice(0, take) : selected;
      },
      create: async () => {
        throw new Error("unused");
      },
      update: async ({ where, data }: any) =>
        Object.assign(items.find((i) => i.id === where.id) as FakeItem, data),
      // #1253: the reap writes are generation-AND-status pinned updateMany
      // calls; the fake honors the where clause like the real client so a
      // concurrent requeue in the read→write gap no-ops the reap. The #1641
      // rotation stamp is a bulk write scoped to the active statuses.
      updateMany: async ({ where, data }: any) => {
        const hits = items.filter((i) => matches(i, where));
        for (const hit of hits) Object.assign(hit, data);
        return { count: hits.length };
      },
    },
    prFixHistory: { create: async ({ data }: any) => history.push(data) },
  };
  return client;
}

const item = (id: string, repo: string, pr: number, status = "QUEUED"): FakeItem => ({
  id,
  repo,
  pr,
  status,
  lane: "NORMAL",
  generation: 1,
  prPresenceCheckedAt: null,
});

const NOW = new Date("2026-11-16T12:00:00.000Z");

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

    const result = await reconcileDeletedPrFixItems(client, probe as any, { now: NOW });

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
      note: "Upstream PR deleted (404 at the per-PR endpoint, repo reachable, absent from the PR listings) at reconcile time (#1641)",
    });
    // The rotation stamps every row the pass CONSIDERED, so the head moves on:
    // the deferred rows carry the stamp, the reaped rows do not (they are
    // terminal now and no longer part of the queue).
    expect(client.items[2].prPresenceCheckedAt).toEqual(NOW);
    expect(client.items[3].prPresenceCheckedAt).toEqual(NOW);
    expect(client.items[0].prPresenceCheckedAt).toBeNull();
    expect(client.items[1].prPresenceCheckedAt).toBeNull();
  });

  it("reaping to STALE retires the attempt's evidence snapshot (#1249)", async () => {
    const client = makeClient([
      { ...item("a", "org/gone", 1, "QUEUED"), attemptEvidenceWatermark: 4 },
    ]);

    await reconcileDeletedPrFixItems(client, vi.fn(async (): Promise<PrFixPrPresence> => "deleted"), { now: NOW });

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

    const result = await reconcileDeletedPrFixItems(client, vi.fn(async (): Promise<PrFixPrPresence> => "deleted"), { now: NOW });

    expect(result.markedStale).toBe(0);
    expect(client.items[0].status).toBe("QUEUED");
    expect(client.items[0].generation).toBe(4);
    expect(client.history).toHaveLength(0);
  });

  it("a probe that throws counts as errored and leaves the row untouched", async () => {
    const client = makeClient([item("a", "org/flaky", 1, "QUEUED")]);

    const result = await reconcileDeletedPrFixItems(
      client,
      vi.fn(async () => {
        throw new Error("boom");
      }),
      { now: NOW },
    );

    expect(result).toEqual({ checked: 1, markedStale: 0, errored: 1 });
    expect(client.items[0].status).toBe("QUEUED");
    expect(client.history).toHaveLength(0);
    // A failed probe still CONSIDERED the row: the rotation stamps it, so the
    // pass does not restart at the same head forever.
    expect(client.items[0].prPresenceCheckedAt).toEqual(NOW);
  });

  it("bounds the pass: it probes at most maxProbes rows and leaves the rows it did not reach unstamped", async () => {
    const client = makeClient(Array.from({ length: 10 }, (_, i) => item(`i${i}`, "org/live", i + 1)));
    const probe = vi.fn(async (): Promise<PrFixPrPresence> => "present");

    const result = await reconcileDeletedPrFixItems(client, probe, { maxProbes: 3, pageSize: 5, now: NOW });

    expect(result).toEqual({ checked: 3, markedStale: 0, errored: 0 });
    expect(probe).toHaveBeenCalledTimes(3);
    // The rows the probe bound cut off stay unstamped, so they LEAD the next
    // pass — the rotation never restarts at the same head.
    expect(client.items.slice(0, 3).every((i) => i.prPresenceCheckedAt !== null)).toBe(true);
    expect(client.items.slice(3).every((i) => i.prPresenceCheckedAt === null)).toBe(true);
  });

  it("advances across passes: a deleted PR behind healthy rows is reached and reaped", async () => {
    const client = makeClient([
      ...Array.from({ length: 5 }, (_, i) => item(`h${i}`, "org/live", i + 1)),
      item("z-gone", "org/live", 6),
    ]);
    const probe = vi.fn(async (_repo: string, pr: number): Promise<PrFixPrPresence> =>
      pr === 6 ? "deleted" : "present",
    );

    // Pass 1 and 2 only reach the healthy rows.
    const first = await reconcileDeletedPrFixItems(client, probe, { maxProbes: 2, pageSize: 2, now: NOW });
    const second = await reconcileDeletedPrFixItems(client, probe, { maxProbes: 2, pageSize: 2, now: NOW });
    expect(first.checked).toBe(2);
    expect(second.checked).toBe(2);
    expect(client.items[5].status).toBe("QUEUED");

    // Pass 3 reaches the deleted row.
    const third = await reconcileDeletedPrFixItems(client, probe, { maxProbes: 2, pageSize: 2, now: NOW });
    expect(third).toEqual({ checked: 2, markedStale: 1, errored: 0 });
    expect(client.items[5].status).toBe("STALE");
    expect(probe.mock.calls.map((call) => call[1])).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("three permanently-unknown rows no longer hide a confirmed deletion behind them in the SAME repo", async () => {
    const client = makeClient([
      item("a", "org/flaky", 1),
      item("b", "org/flaky", 2),
      item("c", "org/flaky", 3),
      item("d", "org/flaky", 4),
    ]);
    const probe = vi.fn(async (_repo: string, pr: number): Promise<PrFixPrPresence> =>
      pr === 4 ? "deleted" : "unknown",
    );

    // Pass 1: the three unknown rows. They are CONSIDERED, so they are
    // stamped and leave the head of the order.
    const first = await reconcileDeletedPrFixItems(client, probe, { maxProbes: 3, pageSize: 3, now: NOW });
    expect(first).toEqual({ checked: 3, markedStale: 0, errored: 0 });
    expect(client.items[3].status).toBe("QUEUED");
    expect(client.items.slice(0, 3).every((i) => i.prPresenceCheckedAt !== null)).toBe(true);

    // Pass 2: the confirmed deletion behind them is reached.
    const second = await reconcileDeletedPrFixItems(client, probe, { maxProbes: 3, pageSize: 3, now: NOW });
    expect(second).toEqual({ checked: 1, markedStale: 1, errored: 0 });
    expect(client.items[3].status).toBe("STALE");
    expect(probe.mock.calls.map((call) => call[1])).toEqual([1, 2, 3, 4]);
  });

  it("the rotation is not per-repo: another repo's row is not blocked by one repo's unknowns", async () => {
    const client = makeClient([
      item("a", "org/flaky", 1),
      item("b", "org/flaky", 2),
      item("c", "org/flaky", 3),
      item("d", "org/gone", 4),
    ]);
    const probe = vi.fn(async (repo: string): Promise<PrFixPrPresence> =>
      repo === "org/gone" ? "deleted" : "unknown",
    );

    const result = await reconcileDeletedPrFixItems(client, probe, { maxProbes: 10, pageSize: 10, now: NOW });

    expect(result).toEqual({ checked: 4, markedStale: 1, errored: 0 });
    expect(client.items[3].status).toBe("STALE");
  });

  it("three permanently-unknown rows do not skip the deletion behind them in the SAME repo inside one pass", async () => {
    // The pre-review pass stopped a repo after three unknown/failed probes,
    // so the fourth row of that repo was never probed. There is no per-repo
    // breaker any more: the four rows of one repo are all probed, and the
    // confirmed deletion behind the three unknowns is reaped in that pass.
    const client = makeClient([
      item("a", "org/flaky", 1),
      item("b", "org/flaky", 2),
      item("c", "org/flaky", 3),
      item("d", "org/flaky", 4),
    ]);
    const probe = vi.fn(async (_repo: string, pr: number): Promise<PrFixPrPresence> =>
      pr === 4 ? "deleted" : "unknown",
    );

    const result = await reconcileDeletedPrFixItems(client, probe, { maxProbes: 10, pageSize: 10, now: NOW });

    expect(result).toEqual({ checked: 4, markedStale: 1, errored: 0 });
    expect(client.items[3].status).toBe("STALE");
    expect(probe.mock.calls.map((call) => call[1])).toEqual([1, 2, 3, 4]);
  });

  it("does not re-probe a row before the re-verify bound elapses, and re-probes it after", async () => {
    const client = makeClient([item("a", "org/live", 1)]);
    const probe = vi.fn(async (): Promise<PrFixPrPresence> => "present");

    const first = await reconcileDeletedPrFixItems(client, probe, { now: NOW });
    expect(first.checked).toBe(1);

    // Same instant: the row is inside its re-verify window, so the pass
    // spends no forge call on it.
    const second = await reconcileDeletedPrFixItems(client, probe, { now: NOW });
    expect(second.checked).toBe(0);
    expect(probe).toHaveBeenCalledTimes(1);

    // Past the bound it is due again.
    const third = await reconcileDeletedPrFixItems(client, probe, { now: new Date(NOW.getTime() + 3_600_000) });
    expect(third.checked).toBe(1);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("stamps the rotation marker through the raw surface, so `updatedAt` is not advanced (#1642)", async () => {
    const client = makeClient([item("raw-stamp-row", "org/live", 1)]);
    const updateMany = vi.spyOn(client.prFixQueueItem, "updateMany");

    const result = await reconcileDeletedPrFixItems(
      client,
      vi.fn(async (): Promise<PrFixPrPresence> => "present"),
      { now: NOW },
    );

    expect(result).toEqual({ checked: 1, markedStale: 0, errored: 0 });
    expect(updateMany).not.toHaveBeenCalled();
    expect(client.items[0].prPresenceCheckedAt).toEqual(NOW);
    expect(client.rawQueries).toHaveLength(1);
    const query = client.rawQueries[0];
    expect(query.text).toContain('UPDATE "PrFixQueueItem"');
    expect(query.text).toContain('SET "prPresenceCheckedAt" =');
    expect(query.values).toEqual([
      NOW,
      "raw-stamp-row",
      "QUEUED",
      "BLOCKED",
      "PARKED",
      "WAITING_EXTERNAL",
    ]);
    expect(query.text).not.toContain("raw-stamp-row");
  });

  it("a client without the raw surface is errored, never falls back to a modeled write (#1642)", async () => {
    const client = makeClient([item("a", "org/live", 1)]);
    delete (client as any).$executeRaw;
    const updateMany = vi.spyOn(client.prFixQueueItem, "updateMany");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await reconcileDeletedPrFixItems(
      client,
      vi.fn(async (): Promise<PrFixPrPresence> => "present"),
      { now: NOW },
    );

    expect(result).toEqual({ checked: 1, markedStale: 0, errored: 1 });
    expect(updateMany).not.toHaveBeenCalled();
    expect(client.items[0].prPresenceCheckedAt).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("a reap write failure counts as errored and never fails the pass", async () => {
    const client = makeClient([
      item("a", "org/gone", 1),
      item("b", "org/gone", 2),
      item("c", "org/gone", 3),
      item("d", "org/gone", 4),
    ]);
    client.prFixQueueItem.updateMany = async () => {
      throw new Error("db down");
    };
    client.$executeRaw = async () => {
      throw new Error("db down");
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await reconcileDeletedPrFixItems(client, vi.fn(async (): Promise<PrFixPrPresence> => "deleted"), {
      now: NOW,
    });

    // All four rows keep being probed despite the write failures: the forge
    // answered every probe, so nothing is skipped because of a local error.
    // The failed rotation stamp counts too — a rotation that cannot advance
    // must not pass as a clean pass.
    expect(result).toEqual({ checked: 4, markedStale: 0, errored: 5 });
    expect(client.items.every((i) => i.status === "QUEUED")).toBe(true);
    warnSpy.mockRestore();
  });
});

describe("probePrFixPrPresence (#1641)", () => {
  const fetchMock = vi.fn();
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  beforeEach(() => {
    __resetGitHubAppState();
    process.env.GITHUB_TOKEN = "test-token-for-presence-tests";
    fetchMock.mockReset();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
    warnSpy.mockRestore();
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

  /** The per-PR endpoint: `/repos/<repo>/pulls/<n>`. */
  const isPerPr = (url: string) => String(url).includes("/pulls/");
  /** The PR listing endpoint: `/repos/<repo>/pulls?state=all...`. */
  const isListing = (url: string) => String(url).includes("/pulls?");
  const repoMeta = () => res(200, { full_name: "Org/Repo", default_branch: "main", archived: false });
  const listing = (numbers: number[]) => res(200, numbers.map((number) => ({ number })));

  it("a per-PR 404 at a readable repo, absent from the PR listings, is a confirmed deletion", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      isPerPr(url) ? res(404) : isListing(url) ? listing([1, 2, 3]) : repoMeta(),
    );

    expect(await probePrFixPrPresence("org/repo", 7)).toBe("deleted");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/repos/org/repo/pulls/7");
    // The reachability gate is only consulted when the PR actually 404s, and
    // the listing is read only after the gate confirms the repo is readable.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a per-PR 404 whose PR is still in the PR listings is NOT a deletion (#1641)", async () => {
    // The listing contradicts the 404: the PR exists and the per-PR answer
    // was spurious. Reaping here would retire live work.
    fetchMock.mockImplementation(async (url: string) =>
      isPerPr(url) ? res(404) : isListing(url) ? listing([7, 8]) : repoMeta(),
    );

    expect(await probePrFixPrPresence("org/repo", 7)).toBe("present");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("a per-PR 404 with a listing too large to prove absence is 'unknown' (#1641)", async () => {
    // A truncated listing makes a missing number merely unseen, so the
    // absence is unproven and the row must defer.
    fetchMock.mockImplementation(async (url: string) => {
      if (isPerPr(url)) return res(404);
      if (isListing(url)) {
        return res(200, Array.from({ length: 500 }, (_, index) => ({ number: index + 1 })));
      }
      return repoMeta();
    });

    expect(await probePrFixPrPresence("org/repo", 7)).toBe("unknown");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("a per-PR 404 whose listing could not be read is 'unknown' (#1641)", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      isPerPr(url) ? res(404) : isListing(url) ? res(500, { message: "boom" }) : repoMeta(),
    );

    expect(await probePrFixPrPresence("org/repo", 7)).toBe("unknown");
    expect(warnSpy).toHaveBeenCalled();
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
      isPerPr(url) ? res(404) : res(404, { message: "Not Found" }),
    );

    expect(await probePrFixPrPresence("org/repo", 7)).toBe("unknown");
    // The unreadable repo is logged, not swallowed: an outage must be
    // distinguishable from a healthy deferral.
    expect(warnSpy).toHaveBeenCalled();
  });

  it("a per-PR 403 (rate limit / secondary limit) is 'unknown', not a deletion", async () => {
    fetchMock.mockImplementation(async () => res(403, { message: "Forbidden" }));

    expect(await probePrFixPrPresence("org/repo", 7)).toBe("unknown");
    // No reachability gate follows a non-404 answer.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a transport failure on the per-PR probe is 'unknown'", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (isPerPr(url)) throw new Error("network down");
      return repoMeta();
    });

    expect(await probePrFixPrPresence("org/repo", 7)).toBe("unknown");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("the per-pass probe reads one PR listing per repo, not one per row (#1641)", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      isPerPr(url) ? res(404) : isListing(url) ? listing([1]) : repoMeta(),
    );

    const probe = createPrFixPrPresenceProbe();
    expect(await probe("org/repo", 7)).toBe("deleted");
    expect(await probe("org/repo", 8)).toBe("deleted");
    expect(await probe("org/other", 7)).toBe("deleted");

    const listingCalls = fetchMock.mock.calls.filter((call) => isListing(String(call[0])));
    // One listing read per repository, shared by every row of that repo.
    expect(listingCalls).toHaveLength(2);
    expect(String(listingCalls[0][0])).toContain("/repos/org/repo/pulls?");
    expect(String(listingCalls[1][0])).toContain("/repos/org/other/pulls?");
  });

  it("the per-pass probe bounds how many repositories' listings it reads (#1641)", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      isPerPr(url) ? res(404) : isListing(url) ? listing([1]) : repoMeta(),
    );

    const probe = createPrFixPrPresenceProbe(1);
    expect(await probe("org/first", 7)).toBe("deleted");
    // The budget is spent, so the second repository's listing is never read
    // and its row defers. The rotation brings it back in a later pass.
    expect(await probe("org/second", 8)).toBe("unknown");

    const listingCalls = fetchMock.mock.calls.filter((call) => isListing(String(call[0])));
    expect(listingCalls).toHaveLength(1);
    expect(String(listingCalls[0][0])).toContain("/repos/org/first/pulls?");
  });

  it("the per-pass probe raises the listing-budget signal when the budget runs out (#1641)", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      isPerPr(url) ? res(404) : isListing(url) ? listing([1]) : repoMeta(),
    );

    const onBudget = vi.fn();
    const probe = createPrFixPrPresenceProbe(1, onBudget);
    expect(await probe("org/first", 7)).toBe("deleted");
    // A repository that fits inside the budget never raises the signal.
    expect(onBudget).not.toHaveBeenCalled();
    // The budget is spent: the second repository's listing is never read, the
    // row defers, and the signal carries the reason for that deferral out of
    // band. The public result stays the tri-state "unknown".
    expect(await probe("org/second", 8)).toBe("unknown");
    expect(onBudget).toHaveBeenCalledTimes(1);
  });
});

describe("deleted-PR reap with the real probe (#1641)", () => {
  const fetchMock = vi.fn();
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  beforeEach(() => {
    __resetGitHubAppState();
    process.env.GITHUB_TOKEN = "test-token-for-presence-tests";
    fetchMock.mockReset();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
    warnSpy.mockRestore();
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

  it("reaps a row whose PR is absent from the listings and keeps a row the listings still show (#1641)", async () => {
    const client = makeClient([item("a", "org/gone", 1), item("b", "org/live", 2)]);
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/pulls/")) return res(404);
      if (u.includes("/repos/org/gone/pulls?")) {
        return res(200, [{ number: 9 }, { number: 10 }]);
      }
      if (u.includes("/repos/org/live/pulls?")) {
        // The listing still shows PR 2: the per-PR 404 was spurious, so the
        // row must survive.
        return res(200, [{ number: 2 }, { number: 3 }]);
      }
      return res(200, { full_name: "Org/Repo", default_branch: "main", archived: false });
    });

    const result = await reconcileDeletedPrFixItems(client, undefined, { now: NOW });

    expect(result).toEqual({ checked: 2, markedStale: 1, errored: 0 });
    expect(client.items[0].status).toBe("STALE");
    expect(client.items[1].status).toBe("QUEUED");
    expect(client.history).toHaveLength(1);
  });

  it("a confirmed deletion behind ten unconfirmable repositories is reached in the next pass (#1641)", async () => {
    // The cross-repository starvation defect: a pass reads the PR listings of
    // at most 10 repositories, and the rows behind that budget used to be
    // stamped anyway. The same first 10 repositories then consumed the whole
    // budget on every pass, so a confirmed deletion in a later repository was
    // never confirmed and never reaped, no matter how many passes ran.
    const unconfirmable = Array.from({ length: 10 }, (_, index) =>
      item(`u${String(index).padStart(2, "0")}`, `org/unconfirmable-${index}`, index + 1),
    );
    const target = item("z-target", "org/target", 99);
    const client = makeClient([...unconfirmable, target]);

    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/pulls/")) return res(404);
      if (u.includes("/pulls?")) {
        // Every unconfirmable repository's listing still shows its own PR, so
        // the 404 is spurious and the row is not a deletion. The target's
        // listing is complete and does not show the target PR.
        const repo = /\/repos\/([^/]+\/[^/]+)\/pulls\?/.exec(u)?.[1] ?? "";
        if (repo === "org/target") return res(200, [{ number: 1 }]);
        const index = Number(/unconfirmable-(\d+)/.exec(repo)?.[1] ?? "-1");
        return res(200, [{ number: index + 1 }]);
      }
      return res(200, { full_name: "Org/Repo", default_branch: "main", archived: false });
    });

    // Pass 1: the ten unconfirmable repositories consume the whole listing
    // budget. The target's listing read is refused, so the target was never
    // considered: it stays QUEUED and unstamped, and the pass stops there.
    const first = await reconcileDeletedPrFixItems(client, undefined, { now: NOW });
    expect(first).toEqual({ checked: 10, markedStale: 0, errored: 0 });
    expect(unconfirmable.every((row) => row.prPresenceCheckedAt === NOW)).toBe(true);
    expect(target.status).toBe("QUEUED");
    expect(target.prPresenceCheckedAt).toBeNull();
    // The budget refused the target's listing, so the target's repository was
    // never listed at all.
    const listingCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/pulls?"));
    expect(listingCalls).toHaveLength(10);

    // Pass 2: the target still leads the rotation because it is unstamped, so
    // its listing is read inside a fresh budget and the confirmed deletion is
    // reaped.
    const second = await reconcileDeletedPrFixItems(client, undefined, { now: NOW });
    expect(second).toEqual({ checked: 1, markedStale: 1, errored: 0 });
    expect(target.status).toBe("STALE");
    expect(client.history).toHaveLength(1);

    // Pass 3: the target is terminal and the unconfirmable rows are inside
    // their re-verify window, so nothing of that row is left to starve.
    const third = await reconcileDeletedPrFixItems(client, undefined, { now: NOW });
    expect(third).toEqual({ checked: 0, markedStale: 0, errored: 0 });
    expect(target.status).toBe("STALE");
  });
});
