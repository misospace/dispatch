import { describe, expect, it, vi } from "vitest";
import { reconcileForkPrFixItems, type PrFixQueueClient } from "./pr-fix-queue";

vi.mock("./pr-fix-surfacing", () => ({
  surfacePrFixBlocked: vi.fn(async () => null),
  surfacePrFixRequeued: vi.fn(async () => null),
  surfacePrFixParked: vi.fn(async () => null),
  extractUrlsFromText: vi.fn(() => []),
  PARKED_COMMENT_MARKER: "<!-- dispatch-pr-fix-parked -->",
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
      // Honors take/orderBy/where-clauses like the real client's keyset
      // pagination (single-field ordering; the seeded keys are distinct), so
      // seek/order mismatches surface as skipped or re-read rows. The seek is
      // a plain `id: { gt }` WHERE clause — NOT cursor+skip, which the real
      // client compiles to `id >= (SELECT ...) ... OFFSET 1` and which drops a
      // still-matching row once the cursor row itself leaves the filter.
      findMany: async ({ where, take, orderBy }: any) => {
        let rows = items.filter((i) => where.status.in.includes(i.status));
        if (where.id?.gt !== undefined) rows = rows.filter((i) => i.id > where.id.gt);
        // The drain's unproven-set filter: never stamped, or stamped past the
        // re-verify bound. Honors the OR shape like the real client, so a
        // stamp that never lands (or lands on the wrong rows) surfaces as a
        // re-probed or never-probed row in the tests below.
        if (Array.isArray(where.OR)) {
          rows = rows.filter((i) =>
            where.OR.some((clause: any) => {
              const proof = clause.headRepoVerifiedAt;
              if (proof === null) return i.headRepoVerifiedAt == null;
              if (proof && proof.lt instanceof Date) {
                return i.headRepoVerifiedAt instanceof Date && i.headRepoVerifiedAt < proof.lt;
              }
              return false;
            }),
          );
        }
        const key = orderBy ? Object.keys(orderBy)[0] : null;
        if (key) {
          const dir = orderBy[key] === "desc" ? -1 : 1;
          rows = [...rows].sort((a, b) => dir * (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
        }
        return take !== undefined ? rows.slice(0, take) : rows;
      },
      update: async ({ where, data }: any) => Object.assign(items.find((i) => i.id === where.id), data),
      // #1253: the reap writes are generation-AND-status pinned updateMany
      // calls; the fake honors the where clause like the real client.
      updateMany: async ({ where, data }: any) => {
        const hits = items.filter(
          (i) =>
            (where.id === undefined || i.id === where.id) &&
            (where.generation === undefined || i.generation === where.generation) &&
            (where.status === undefined || i.status === where.status),
        );
        // @updatedAt: every write bumps updatedAt, so a mutable ordering key
        // moves the row the pass just wrote.
        for (const hit of hits) Object.assign(hit, data, { updatedAt: new Date(Date.now() + hit.pr) });
        return { count: hits.length };
      },
    },
    prFixHistory: { create: async ({ data }: any) => history.push(data) },
  };
  return client;
}

const item = (id: string, repo: string, pr: number, status: string) => ({
  id,
  repo,
  pr,
  status,
  lane: "NORMAL",
  generation: 1,
});

describe("fork PR rows drained by reconcile (#1638)", () => {
  it("reaps confirmed fork rows to STALE with a history note, one probe per row", async () => {
    const client = makeClient([
      { ...item("a", "org/repo", 1, "QUEUED"), attemptEvidenceWatermark: 4 },
      { ...item("b", "org/repo", 2, "BLOCKED") },
      item("c", "org/repo", 3, "FIXED"),
      item("d", "org/repo", 4, "STALE"),
    ]);
    const fetchHeadRepo = vi.fn(async (_repo: string, pr: number) =>
      pr === 1 ? "contributor/repo" : pr === 2 ? "contributor/repo-fork" : "org/repo",
    );

    const result = await reconcileForkPrFixItems(client, fetchHeadRepo);

    expect(result).toEqual({ checked: 2, markedStale: 2, unverifiable: 0, errored: 0 });
    // FIXED/STALE rows are never probed: the drain targets the active
    // population, like the archived-repo reap.
    expect(client.items.map((i) => `${i.pr}:${i.status}`)).toEqual(["1:STALE", "2:STALE", "3:FIXED", "4:STALE"]);
    expect(client.history).toHaveLength(2);
    expect(client.history[0]).toMatchObject({
      action: "mark",
      status: "STALE",
      note: "PR head repository contributor/repo is not the base repository at reconcile time (#1638)",
    });
    // Terminal reaping ends the attempt: the evidence watermark dies with it.
    expect(client.items[0].attemptEvidenceWatermark).toBeNull();
  });

  it("keeps a row whose head repo matches case-insensitively (#1637 semantics)", async () => {
    const client = makeClient([item("a", "org/repo", 1, "QUEUED")]);
    const fetchHeadRepo = vi.fn(async () => "Org/Repo");

    const result = await reconcileForkPrFixItems(client, fetchHeadRepo);

    expect(result).toEqual({ checked: 1, markedStale: 0, unverifiable: 0, errored: 0 });
    expect(client.items[0].status).toBe("QUEUED");
    expect(client.history).toHaveLength(0);
  });

  it("defers a row whose head repo cannot be verified — unknown facts never authorize a reap", async () => {
    const client = makeClient([item("a", "org/repo", 1, "QUEUED")]);
    const fetchHeadRepo = vi.fn(async () => null);

    const result = await reconcileForkPrFixItems(client, fetchHeadRepo);

    expect(result).toEqual({ checked: 1, markedStale: 0, unverifiable: 1, errored: 0 });
    expect(client.items[0].status).toBe("QUEUED");
    expect(client.history).toHaveLength(0);
  });

  it("a throwing probe errors the row, never the pass", async () => {
    const client = makeClient([item("a", "org/repo", 1, "QUEUED")]);
    const fetchHeadRepo = vi.fn(async () => {
      throw new Error("github unreachable");
    });

    const result = await reconcileForkPrFixItems(client, fetchHeadRepo);

    expect(result).toEqual({ checked: 1, markedStale: 0, unverifiable: 0, errored: 1 });
    expect(client.items[0].status).toBe("QUEUED");
  });

  it("pages drain the whole backlog: cursor and ordering agree on the immutable id (review round)", async () => {
    // 120 active fork rows whose id order is the REVERSE of their updatedAt
    // order, all confirmed forks so every probe reaps and reaps bump
    // @updatedAt. A cursor that does not agree with a mutable ordering key
    // stops or skips after the first page: the bumped cursor row sorts past
    // every untouched row, so pages after the first come back empty and the
    // backlog behind page one is never seen in any cycle.
    const base = Date.UTC(2026, 10, 15);
    const items = Array.from({ length: 120 }, (_, i) => ({
      ...item(`r${String(i).padStart(3, "0")}`, "org/repo", i + 1, "QUEUED"),
      updatedAt: new Date(base - i * 1000),
    }));
    const client = makeClient(items);
    const seenOrder: any[] = [];
    const findMany = client.prFixQueueItem.findMany;
    client.prFixQueueItem.findMany = (args: any) => {
      seenOrder.push(args.orderBy);
      return findMany(args);
    };
    const fetchHeadRepo = vi.fn(async (_repo: string, _pr: number) => "contributor/repo");

    const result = await reconcileForkPrFixItems(client, fetchHeadRepo, { batchSize: 50, maxPages: 3 });

    expect(result).toEqual({ checked: 120, markedStale: 120, unverifiable: 0, errored: 0 });
    // Every row probed exactly once — no re-read across page boundaries.
    const probedPrs = fetchHeadRepo.mock.calls.map(([, pr]) => pr);
    expect(new Set(probedPrs).size).toBe(120);
    // The cursor column and the ordering column must stay the same column.
    expect(seenOrder.every((o) => o && Object.keys(o).length === 1 && o.id === "asc")).toBe(true);
    // The row behind the first page — the starvation victim — is drained too.
    // r000 has the NEWEST original updatedAt, so it sits last in the asc
    // ordering: a mutable-key cursor strand leaves it unseen forever.
    expect(client.items[0].id).toBe("r000");
    expect(client.items[0].status).toBe("STALE");
  });

  it("a concurrent requeue in the read→write gap wins over the reap (pinned write, #1253)", async () => {
    const client = makeClient([{ ...item("a", "org/repo", 1, "QUEUED"), generation: 3 }]);
    client.prFixQueueItem.updateMany = async ({ where }: any) => {
      // The concurrent requeue lands BEFORE the write evaluates: it bumped
      // the generation, so the pin misses and the reap no-ops.
      client.items[0].generation = 4;
      const hit = client.items.find(
        (i: any) => i.id === where.id && i.status === where.status && i.generation === where.generation,
      );
      return { count: hit ? 1 : 0 };
    };

    const result = await reconcileForkPrFixItems(client, vi.fn(async () => "contributor/repo"));

    expect(result.markedStale).toBe(0);
    expect(client.items[0].status).toBe("QUEUED");
    expect(client.items[0].generation).toBe(4);
    expect(client.history).toHaveLength(0);
  });

  it("a population past the page budget converges: proven rows leave the probe set, the tail fork drains (review round)", async () => {
    // 121 active rows against a 100-row page budget (50 x 2). The first 120
    // are same-repo — under the old scan they stayed active forever, consumed
    // the whole budget EVERY cycle, and the fork row at the tail (r120) was
    // never probed in any cycle. Here every confirmed-same-repo probe stamps
    // the durable proof and leaves the unproven set, so cycle 2 reaches the
    // tail. This pins BOTH review findings: no tail starvation, and no
    // re-probe of rows already proven (the forge-cost finding).
    const items = Array.from({ length: 121 }, (_, i) =>
      item(`r${String(i).padStart(3, "0")}`, "org/repo", i + 1, "QUEUED"),
    );
    const client = makeClient(items);
    const fetchHeadRepo = vi.fn(async (_repo: string, pr: number) => (pr === 121 ? "contributor/repo" : "org/repo"));

    const first = await reconcileForkPrFixItems(client, fetchHeadRepo, { batchSize: 50, maxPages: 2 });
    // The budget covers r000..r099 only; nothing is a fork, the tail row is
    // simply unseen THIS cycle.
    expect(first).toEqual({ checked: 100, markedStale: 0, unverifiable: 0, errored: 0 });
    expect(client.items[120].status).toBe("QUEUED");
    // Every proved row carries the durable proof now.
    expect(client.items.slice(0, 100).every((i) => i.headRepoVerifiedAt instanceof Date)).toBe(true);

    const second = await reconcileForkPrFixItems(client, fetchHeadRepo, { batchSize: 50, maxPages: 2 });
    // The probe set is only the 21 rows r100..r120: the 100 proven rows are
    // never re-probed, and the scan reaches the tail it used to starve.
    expect(second).toEqual({ checked: 21, markedStale: 1, unverifiable: 0, errored: 0 });
    expect(client.items[120].status).toBe("STALE");
    const probedPrs = fetchHeadRepo.mock.calls.map(([, pr]) => pr);
    expect(probedPrs).toHaveLength(121);
    expect(new Set(probedPrs).size).toBe(121);
  });

  it("the slow re-verify bound re-probes a stale proof and refreshes it; a fresh proof stays out", async () => {
    const stale = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const fresh = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const client = makeClient([
      { ...item("a", "org/repo", 1, "QUEUED"), headRepoVerifiedAt: stale },
      { ...item("b", "org/repo", 2, "QUEUED"), headRepoVerifiedAt: fresh },
    ]);
    const fetchHeadRepo = vi.fn(async (_repo: string, _pr: number) => "org/repo");

    const result = await reconcileForkPrFixItems(client, fetchHeadRepo);

    // Only the past-bound row is re-probed (the PR-number-reuse corner case
    // this bound exists for); the in-bound proof stands.
    expect(result).toEqual({ checked: 1, markedStale: 0, unverifiable: 0, errored: 0 });
    expect(fetchHeadRepo.mock.calls.map(([, pr]) => pr)).toEqual([1]);
    expect(client.items[0].headRepoVerifiedAt.getTime()).toBeGreaterThan(stale.getTime());
    expect(client.items[1].headRepoVerifiedAt.getTime()).toBe(fresh.getTime());
  });
});
