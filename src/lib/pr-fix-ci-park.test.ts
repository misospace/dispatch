import { describe, expect, it } from "vitest";
import {
  ciParkPrFixItem,
  ciReservePrFixItem,
  ciRepairPrFixItem,
  parseCIParkInput,
  parseCIReserveInput,
  parseCIRepairInput,
} from "./pr-fix-ci-park";
import { agentHandoutToken, freshAttemptGeneration, type PrFixQueueClient } from "./pr-fix-queue";
import type { CIParkCallResult } from "./pr-fix-ci-park";
import { matchesCIParkWhere, p2002Error } from "@/test/pr-fix-ci-park-harness";

// Mirror of Courier's fixtures (internal/source/dispatch/cipark_test.go):
// acme/widgets#77, generation 3, two full-length heads.
const REPO = "acme/widgets";
const GEN = 3;
const HEAD1 = "aaaaaaaa11111111bbbbbbbb22222222cccccccc";
const HEAD2 = "dddddddd33333333eeeeeeee44444444ffffffff";
// The handout marker the lifecycle notices bind to (#495): built with the
// SAME helper next-task writes records with, so a format drift breaks these
// pins instead of silently re-binding the notices.
const MARKER = agentHandoutToken("worker", GEN);

function parkInput(overrides: Record<string, unknown> = {}) {
  return { repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "park-1", ...overrides };
}

function reserveInput(overrides: Record<string, unknown> = {}) {
  return { repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "reserve-1", fenceToken: "fence-one", ...overrides };
}

function repairInput(overrides: Record<string, unknown> = {}) {
  return {
    repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "outcome-1",
    result: "repushed" as const, fenceToken: "fence-one", head: HEAD2,
    ...overrides,
  };
}

/**
 * Stateful PrFixQueueClient exercising the REAL state machines: items stored
 * with the full row shape, a P2002-throwing ledger (unless `withLedger: false`
 * for the legacy clients), and an updateMany whose where evaluation carries
 * the Prisma nullable-column semantics the lifecycle writes rely on. Every
 * updateMany call is recorded so tests assert both the pinned patch and the
 * EXACT-ONCE "no second update" property. A one-shot `beforeUpdateMany` hook
 * lets a test flip row state inside the outer-read→CAS gap to pin a race
 * interleave (mirrors the #1119 hook pattern in pr-fix-queue.test.ts).
 */
function makeCiParkClient(options: { withLedger?: boolean } = {}) {
  const { withLedger = true } = options;
  const items: any[] = [];
  const ledger: any[] = [];
  const updateCalls: Array<{ where: any; data: any }> = [];
  const hooks: { beforeUpdateMany: ((where: any) => void) | null } = { beforeUpdateMany: null };

  const makeItem = (overrides: Record<string, unknown> = {}) => ({
    id: "fix-1",
    repo: REPO,
    pr: 77,
    status: "QUEUED",
    generation: GEN,
    // Default: the row WAS handed to the lifecycle's agent at the fixture
    // generation — the precondition every lifecycle notice has in the field
    // (a live run born of Dispatch's handout). Tests that need an un-handed
    // row override this to [].
    agentHandouts: [MARKER],
    queuedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ciParkState: null,
    ciParkHead: null,
    ciParkKey: null,
    ciParkFence: null,
    ciParkAt: null,
    ...overrides,
  });

  const client: any = {
    items,
    ledger,
    updateCalls,
    hooks,
    makeItem,
    $transaction: async (fn: any) => fn(client),
    prFixQueueItem: {
      findMany: async ({ where }: any) => items.filter((row) => matchesCIParkWhere(row, where)),
      findUnique: async ({ where }: any) => items.find((row) => row.id === where.id) ?? null,
      updateMany: async ({ where, data }: any) => {
        updateCalls.push({ where, data });
        // One-shot race hook: fires before the FIRST CAS evaluation so a test
        // can flip row state inside the outer-read→CAS gap (#1415 sims).
        if (hooks.beforeUpdateMany) {
          const hook = hooks.beforeUpdateMany;
          hooks.beforeUpdateMany = null;
          hook(where);
        }
        let count = 0;
        for (const row of items) {
          if (!matchesCIParkWhere(row, where)) continue;
          count++;
          Object.assign(row, data, { updatedAt: new Date("2026-01-02T00:00:00Z") });
        }
        return { count };
      },
    },
    prFixCIParkLedger: withLedger
      ? {
          findUnique: async ({ where }: any) => {
            const w = where.itemId_kind_key;
            return ledger.find((row) => row.itemId === w.itemId && row.kind === w.kind && row.key === w.key) ?? null;
          },
          create: async ({ data }: any) => {
            if (ledger.some((row) => row.itemId === data.itemId && row.kind === data.kind && row.key === data.key)) {
              throw p2002Error();
            }
            const row = { id: `ledger-${ledger.length + 1}`, createdAt: new Date("2026-01-01T00:00:00Z"), ...data };
            ledger.push(row);
            return row;
          },
        }
      : undefined,
  };
  return client as PrFixQueueClient & ReturnType<typeof Object>;
}

const ok = (result: CIParkCallResult) => {
  expect(result.ok).toBe(true);
  return result as Extract<CIParkCallResult, { ok: true }>;
};
const refused = (result: any, reason: string) => expect(result).toEqual({ ok: false, reason });

/** The lifecycle-bearing columns of a row (JSON-comparable without wall-clock stamps). */
function lifecycleFields(item: any) {
  const { ciParkState, ciParkHead, ciParkKey, ciParkFence } = item;
  return { ciParkState, ciParkHead, ciParkKey, ciParkFence };
}

describe("CI park lifecycle — park / reserve / repair coordination (mirror of cipark_test.go TestDispatchCIParkCoordination)", () => {
  it("books one opportunity per deferral, re-parks on the repush head, and settles exactly once", async () => {
    const client = makeCiParkClient();
    const item = client.makeItem();
    client.items.push(item);

    // The park announces the deferral; the first reservation books the one
    // opportunity and echoes the presented fence token as the grant.
    ok(await ciParkPrFixItem(client, parkInput()));
    expect(item.ciParkState).toBe("active");
    expect(item.ciParkHead).toBe(HEAD1);
    expect(item.ciParkKey).toBe("park-1");
    expect(item.ciParkFence).toBeNull();

    const grant1 = ok(await ciReservePrFixItem(client, reserveInput()));
    expect(grant1.fenceToken).toBe("fence-one");
    expect(item.ciParkFence).toBe("fence-one");

    // A second worker's reservation under a different token is fenced off
    // while the reservation is still open.
    refused(await ciReservePrFixItem(client, reserveInput({ idempotencyKey: "reserve-2", fenceToken: "fence-two" })), "fence-held");

    // The repushed outcome updates the fenced opportunity on the new head and
    // closes only this reservation; the deferral stays active (the park key
    // stays the park-1 notice's).
    ok(await ciRepairPrFixItem(client, repairInput()));
    expect(item.ciParkState).toBe("active");
    expect(item.ciParkHead).toBe(HEAD2);
    expect(item.ciParkFence).toBeNull();
    expect(item.ciParkKey).toBe("park-1");
    // Same-key outcome retry before the re-park replays, never re-applies.
    const consumed = ok(await ciRepairPrFixItem(client, repairInput()));
    expect(consumed.replayed).toBe(true);
    expect(item.ciParkHead).toBe(HEAD2);
    // Re-park on the new head (a NEW notice key) and reserve the second
    // opportunity; the re-park leaves the idle fence untouched.
    ok(await ciParkPrFixItem(client, parkInput({ idempotencyKey: "park-2", head: HEAD2 })));
    expect(item.ciParkKey).toBe("park-2");
    expect(item.ciParkHead).toBe(HEAD2);
    expect(item.ciParkState).toBe("active");

    // Between the re-park and the second grant the fence is idle, so a
    // reservation pinned to the OLD head is refused on the head identity.
    refused(await ciReservePrFixItem(client, reserveInput({ idempotencyKey: "reserve-stale-head", head: HEAD1 })), "head-superseded");

    const grant2 = ok(await ciReservePrFixItem(client, reserveInput({ idempotencyKey: "reserve-3", fenceToken: "fence-two", head: HEAD2 })))
    expect(grant2.fenceToken).toBe("fence-two");
    expect(item.ciParkFence).toBe("fence-two");

    // A competing second-opportunity reservation under another token is
    // fenced off while the second reservation is still open, and the same
    // committed key replays its grant.
    refused(await ciReservePrFixItem(client, reserveInput({ idempotencyKey: "reserve-4", fenceToken: "fence-three", head: HEAD2 })), "fence-held");

    // Exhaustion hands stewardship back to Dispatch: the item settles.
    ok(await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "outcome-2", fenceToken: "fence-two", result: "exhausted", head: null })));
    expect(item.ciParkState).toBe("settled");
    expect(item.ciParkFence).toBeNull();
    expect(item.ciParkHead).toBeNull();

    // After settlement: a fresh reservation is stale work, and a lost-response
    // outcome arriving after settlement is refused, not applied.
    refused(await ciReservePrFixItem(client, reserveInput({ idempotencyKey: "reserve-restart", fenceToken: "fence-fresh-worker", head: HEAD2 })), "opportunity-missing");
    refused(
      await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "outcome-restart", fenceToken: "fence-two", result: "unsupported", head: null })),
      "fence-settled",
    );
  });

  it("replays every committed key from a fresh client without state churn", async () => {
    const client = makeCiParkClient();
    const item = client.makeItem();
    client.items.push(item);

    ok(await ciParkPrFixItem(client, parkInput()));
    ok(await ciReservePrFixItem(client, reserveInput()));
    ok(await ciRepairPrFixItem(client, repairInput()));
    ok(await ciParkPrFixItem(client, parkInput({ idempotencyKey: "park-2", head: HEAD2 })));
    ok(await ciReservePrFixItem(client, reserveInput({ idempotencyKey: "reserve-3", fenceToken: "fence-two", head: HEAD2 })));
    ok(await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "outcome-2", fenceToken: "fence-two", result: "exhausted", head: null })));

    const settledSnapshot = JSON.stringify(item);
    const ledgerRows = client.ledger.length;
    const updateCount = client.updateCalls.length;

    // Full replay of every committed key: same acceptances, no state writes.
    ok(await ciParkPrFixItem(client, parkInput()));
    ok(await ciParkPrFixItem(client, parkInput({ idempotencyKey: "park-2", head: HEAD2 })));
    const replayReserve1 = ok(await ciReservePrFixItem(client, reserveInput()));
    expect(replayReserve1.fenceToken).toBe("fence-one");
    const replayReserve3 = ok(await ciReservePrFixItem(client, reserveInput({ idempotencyKey: "reserve-3", fenceToken: "fence-two", head: HEAD2 })));
    expect(replayReserve3.fenceToken).toBe("fence-two");
    ok(await ciRepairPrFixItem(client, repairInput()));
    ok(await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "outcome-2", fenceToken: "fence-two", result: "exhausted", head: null })));

    expect(JSON.parse(JSON.stringify(item))).toEqual(JSON.parse(JSON.stringify(item)));
    expect(JSON.stringify(item)).toBe(settledSnapshot);
    expect(client.ledger).toHaveLength(ledgerRows);
    expect(client.updateCalls).toHaveLength(updateCount);
    // The census: two parks, two reservations, two outcomes — never doubled.
    const kinds = client.ledger.map((row: any) => row.kind).sort();
    expect(kinds).toEqual(["outcome", "outcome", "park", "park", "reserve", "reserve"]);
  });
});

describe("ciParkPrFixItem", () => {
  it("commits the full deferral record and answers nothing beyond 204 semantics", async () => {
    const client = makeCiParkClient();
    const item = client.makeItem();
    client.items.push(item);

    const result = ok(await ciParkPrFixItem(client, parkInput()));
    expect(result.replayed).toBeUndefined();
    expect(client.updateCalls).toHaveLength(1);
    // The pinned patch: state/head/key/at, and NOT the fence column.
    expect(client.updateCalls[0].data).toEqual({
      ciParkState: "active",
      ciParkHead: HEAD1,
      ciParkKey: "park-1",
      ciParkAt: expect.any(Date),
    });
    expect(Object.keys(client.updateCalls[0].data)).not.toContain("ciParkFence");
    expect(client.updateCalls[0].where).toEqual({ id: item.id, generation: GEN, status: "QUEUED" });
    expect(item.ciParkState).toBe("active");
    // The ledger carries the park's payload for replays and audit.
    expect(client.ledger[0]).toEqual(
      expect.objectContaining({ kind: "park", key: "park-1", head: HEAD1, agent: "worker" }),
    );
  });

  it("replays the same park key without a second update", async () => {
    const client = makeCiParkClient();
    client.items.push(client.makeItem());
    ok(await ciParkPrFixItem(client, parkInput()));
    ok(await ciParkPrFixItem(client, parkInput()));
    ok(await ciParkPrFixItem(client, parkInput()));
    expect(client.updateCalls).toHaveLength(1);

    const updated = ok(await ciParkPrFixItem(client, parkInput()));
    expect(updated.replayed).toBe(true);
    expect(client.updateCalls).toHaveLength(1);
  });

  it("flags the legacy generation fence as generation-mismatch (route answers the mark literal)", async () => {
    const client = makeCiParkClient();
    // The marker (worker@3) survives on the row while its CURRENT generation
    // moved to 4 — an inconsistent-but-resolvable identity: the notice still
    // BINDS (resolution precedes the fence), and the fence answers the legacy
    // literal (Courier classifies it identity/generation-advanced).
    client.items.push(client.makeItem({ generation: 4 }));
    const result = await ciParkPrFixItem(client, parkInput());
    refused(result, "generation-mismatch");

    // Order pin: without the marker the same notice never reaches the fence —
    // resolution answers opportunity-missing first.
    const unhandled = makeCiParkClient();
    unhandled.items.push(unhandled.makeItem({ generation: 4, agentHandouts: [] }));
    refused(await ciParkPrFixItem(unhandled, parkInput()), "opportunity-missing");
  });

  it("refuses a park when no row binds the notice's handout marker (#495 resolution)", async () => {
    // Zero matches cover: never handed (no marker), marker cleared by a fresh
    // attempt bump, wrong agent, or wrong repo — the notice names dead or
    // unknown work; the coded refusal is opportunity-missing.
    const client = makeCiParkClient();
    refused(await ciParkPrFixItem(client, parkInput()), "opportunity-missing"); // empty repo

    // Never handed to the notice's agent: the row exists but carries no
    // marker for (worker, 3).
    const unhandled = makeCiParkClient();
    unhandled.items.push(unhandled.makeItem({ agentHandouts: [] }));
    refused(await ciParkPrFixItem(unhandled, parkInput()), "opportunity-missing");

    // The marker was cleared by a fresh-attempt bump (freshAttemptGeneration
    // clears agentHandouts alongside the generation bump): the post-bump
    // notice binds nothing — including its own committed-park replay key.
    const bumped = makeCiParkClient();
    const bumpedItem = bumped.makeItem({ generation: 4, agentHandouts: [] });
    bumped.ledger.push({ itemId: bumpedItem.id, kind: "park", key: "park-1" }); // committed key from the pre-bump attempt
    refused(await ciParkPrFixItem(bumped, parkInput()), "opportunity-missing");

    // Handed to a DIFFERENT agent: the marker names another hand.
    const otherAgent = makeCiParkClient();
    otherAgent.items.push(otherAgent.makeItem({ agentHandouts: [agentHandoutToken("someone-else", GEN)] }));
    refused(await ciParkPrFixItem(otherAgent, parkInput()), "opportunity-missing");

    // The notice names a repo that holds no marker-carrying row.
    const cross = makeCiParkClient();
    cross.items.push(cross.makeItem({ repo: "acme/other", pr: 90 }));
    refused(await ciParkPrFixItem(cross, parkInput()), "opportunity-missing");
  });

  it("refuses a park on a non-QUEUED row (the opportunity is not dispatchable)", async () => {
    const client = makeCiParkClient();
    client.items.push(client.makeItem({ status: "BLOCKED" }));
    refused(await ciParkPrFixItem(client, parkInput()), "opportunity-missing");
  });

  it("re-parks with a new key over the parked record without touching a live fence", async () => {
    const client = makeCiParkClient();
    const item = client.makeItem();
    client.items.push(item);

    ok(await ciParkPrFixItem(client, parkInput()));
    const grant = ok(await ciReservePrFixItem(client, reserveInput()));
    expect(item.ciParkFence).toBe("fence-one");

    // A second park notice (same generation, new key, new head) overwrites
    // head/key/at but leaves the live reservation untouched.
    ok(await ciParkPrFixItem(client, parkInput({ idempotencyKey: "park-2", head: HEAD2 })));
    expect(item.ciParkKey).toBe("park-2");
    expect(item.ciParkHead).toBe(HEAD2);
    expect(item.ciParkFence).toBe("fence-one");

    // The same park-2 key replays without state churn.
    const snapshot = JSON.stringify(item);
    const updateCount = client.updateCalls.length;
    const replay = ok(await ciParkPrFixItem(client, parkInput({ idempotencyKey: "park-2", head: HEAD2 })));
    expect(replay.replayed).toBe(true);
    expect(JSON.stringify(item)).toBe(snapshot);
    expect(client.updateCalls).toHaveLength(updateCount);
  });

  it("binds the handed row over unrelated rows at the same generation, and fails closed on a marker collision", async () => {
    // Two rows in one repo share generation 3 (counts are per-item); ONLY the
    // handed one carries the marker — the notice binds exactly that row.
    const client = makeCiParkClient();
    const handed = client.makeItem();
    const unrelated = client.makeItem({ id: "fix-2", pr: 78, agentHandouts: [] });
    client.items.push(unrelated, handed);
    ok(await ciParkPrFixItem(client, parkInput()));
    expect(handed.ciParkState).toBe("active");
    expect(unrelated.ciParkState).toBeNull();

    // Two rows BOTH carrying the same (agent, generation) marker cannot come
    // out of the serial-worker flow: the identity is inconsistent, so the
    // notice files closed instead of guessing which row it suspends.
    const collision = makeCiParkClient();
    collision.items.push(collision.makeItem(), collision.makeItem({ id: "fix-2", pr: 78 }));
    refused(await ciParkPrFixItem(collision, parkInput()), "opportunity-missing");
  });
});

describe("ciReservePrFixItem", () => {
  it("grants by echoing EXACTLY the presented fence token", async () => {
    const client = makeCiParkClient();
    const item = client.makeItem();
    client.items.push(item);
    ok(await ciParkPrFixItem(client, parkInput()));

    const grant = ok(await ciReservePrFixItem(client, reserveInput({ fenceToken: "fence-one" })))
    // The grant must echo the presented token, not mint one: Courier's grant
    // assertion grant.FenceToken == presented pins it.
    expect(grant.fenceToken).toBe("fence-one");
    expect(item.ciParkFence).toBe("fence-one");
    expect(client.ledger[client.ledger.length - 1]).toEqual(
      expect.objectContaining({ kind: "reserve", key: "reserve-1", fence: "fence-one" }),
    );
  });

  it("refuses a competing reservation from another worker with fence-held", async () => {
    const client = makeCiParkClient();
    client.items.push(client.makeItem());
    ok(await ciParkPrFixItem(client, parkInput()));
    ok(await ciReservePrFixItem(client, reserveInput()));
    refused(await ciReservePrFixItem(client, reserveInput({ idempotencyKey: "reserve-2", fenceToken: "fence-two" })), "fence-held");
  });

  it("a re-presented pinned fence with a NEW key echoes the grant and stays one booking", async () => {
    const client = makeCiParkClient();
    const item = client.makeItem();
    client.items.push(item);
    ok(await ciParkPrFixItem(client, parkInput()));
    const grant = ok(await ciReservePrFixItem(client, reserveInput()));

    const updateCount = client.updateCalls.length;
    const ledgerCount = client.ledger.length;
    const grant2 = ok(await ciReservePrFixItem(client, reserveInput({ idempotencyKey: "reserve-beta" })));
    expect(grant2.fenceToken).toBe(grant.fenceToken);
    // The re-presented token stays one booking; only the new KEY gets a
    // replay row — the item is not re-written.
    expect(item.ciParkFence).toBe("fence-one");
    expect(client.updateCalls).toHaveLength(updateCount);
    expect(client.ledger).toHaveLength(ledgerCount + 1);
    expect(client.ledger[client.ledger.length - 1]).toEqual(
      expect.objectContaining({ kind: "reserve", key: "reserve-beta", fence: "fence-one" }),
    );
  });

  it("refuses a stale head with head-superseded", async () => {
    const client = makeCiParkClient();
    client.items.push(client.makeItem());
    ok(await ciParkPrFixItem(client, parkInput()));
    refused(await ciReservePrFixItem(client, reserveInput({ head: HEAD2 })), "head-superseded");
  });

  it("refuses without an established park with opportunity-missing", async () => {
    const client = makeCiParkClient();
    const item = client.makeItem();
    client.items.push(item);
    refused(await ciReservePrFixItem(client, reserveInput()), "opportunity-missing");

    // Released or settled deferrals are equally without a live opportunity.
    ok(await ciParkPrFixItem(client, parkInput()));
    item.ciParkState = "settled";
    item.ciParkFence = null;
    item.ciParkHead = null;
    refused(await ciReservePrFixItem(client, reserveInput()), "opportunity-missing");
  });

  it("replays a same-key booking by echoing the COMMITTED fence (not the presented one)", async () => {
    const client = makeCiParkClient();
    client.items.push(client.makeItem());
    ok(await ciParkPrFixItem(client, parkInput()));
    ok(await ciReservePrFixItem(client, reserveInput()));
    const before = JSON.stringify(client.items[0]);
    const updateCount = client.updateCalls.length;

    // Same key, DIFFERENT presented token: the committed fence wins.
    const replay: any = await ciReservePrFixItem(client, reserveInput({ fenceToken: "fence-other" }));
    ok(replay);
    expect(replay.replayed).toBe(true);
    expect(replay.fenceToken).toBe("fence-one");
    expect(JSON.stringify(client.items[0])).toBe(before);
    expect(client.updateCalls).toHaveLength(updateCount);
  });

  it("flags the generation fence and files a marker collision closed like the park", async () => {
    const client = makeCiParkClient();
    // Marker survives while the row's generation moved: the notice binds and
    // the fence answers the legacy literal.
    client.items.push(client.makeItem({ generation: 4 }));
    refused(await ciReservePrFixItem(client, reserveInput()), "generation-mismatch");

    // Order pin: without the marker the fence is never reached.
    const unhandled = makeCiParkClient();
    unhandled.items.push(unhandled.makeItem({ generation: 4, agentHandouts: [] }));
    refused(await ciReservePrFixItem(unhandled, reserveInput()), "opportunity-missing");

    // Two rows both carrying the same marker after reservations are spread
    // is an inconsistent identity: fail closed.
    const ambiguous = makeAmbiguousParkedClient();
    refused(await ciReservePrFixItem(ambiguous, reserveInput()), "opportunity-missing");
  });

  it("a concurrent re-park between the outer head check and the CAS cannot book the replaced deferral", async () => {
    const client = makeCiParkClient();
    const item = client.makeItem();
    client.items.push(item);
    ok(await ciParkPrFixItem(client, parkInput()));

    // The re-park (a committed park-2 notice on HEAD2) lands exactly in the
    // outer-read→CAS gap: the hook flips the row before the grant pin — the
    // same fields a real concurrent commit leaves behind (the hook is
    // one-shot and sync, exactly the modeled interleave).
    client.hooks.beforeUpdateMany = () => {
      item.ciParkHead = HEAD2;
      item.ciParkKey = "park-2";
    };

    // The CAS now pins the head identity (#1415): the stale-head grant
    // (presented HEAD1) cannot book the replaced deferral — count 0 — and
    // the re-derive maps the re-bound head to head-superseded BEFORE the
    // generic fence answers.
    refused(
      await ciReservePrFixItem(client, reserveInput({ idempotencyKey: "reserve-race" })),
      "head-superseded",
    );
    // No fence was committed onto the re-bound deferral.
    expect(item.ciParkFence).toBeNull();
    expect(item.ciParkHead).toBe(HEAD2);
    expect(item.ciParkKey).toBe("park-2");
  });

  function makeAmbiguousParkedClient() {
    const client = makeCiParkClient();
    client.items.push(
      { ...client.makeItem(), ciParkState: "active", ciParkKey: "park-1", ciParkHead: HEAD1, ciParkFence: null },
      { ...client.makeItem({ id: "fix-2", pr: 78 }), ciParkState: "active", ciParkKey: "park-1", ciParkHead: HEAD1, ciParkFence: null },
    );
    return client;
  }
});

describe("ciRepairPrFixItem — fenced outcomes", () => {
  it("repushes the parked opportunity: head updated, fence cleared, deferral still active", async () => {
    const client = makeCiParkClient();
    const item = client.makeItem();
    client.items.push(item);
    ok(await ciParkPrFixItem(client, parkInput()));
    ok(await ciReservePrFixItem(client, reserveInput()));

    ok(await ciRepairPrFixItem(client, repairInput()));
    expect(item.ciParkState).toBe("active");
    expect(item.ciParkHead).toBe(HEAD2);
    expect(item.ciParkFence).toBeNull();
    // The park note is unchanged: re-parking is a NEW notice's job.
    expect(item.ciParkKey).toBe("park-1");
    expect(client.ledger.find((row: any) => row.kind === "outcome")).toEqual(
      expect.objectContaining({ kind: "outcome", key: "outcome-1", fence: "fence-one", result: "repushed", head: HEAD2 }),
    );
  });

  it("refuses an outcome on a consumed (cleared) fence with fence-gone", async () => {
    const client = makeCiParkClient();
    client.items.push(client.makeItem());
    ok(await ciParkPrFixItem(client, parkInput()));
    ok(await ciReservePrFixItem(client, reserveInput()));
    ok(await ciRepairPrFixItem(client, repairInput())); // fence cleared by repush
    refused(
      await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "outcome-late", head: HEAD1 })),
      "fence-gone",
    );
  });

  it("exhausts into a settled deferral: state settled, fence and head cleared", async () => {
    const client = makeCiParkClient();
    const item = client.makeItem();
    client.items.push(item);
    ok(await ciParkPrFixItem(client, parkInput()));
    ok(await ciReservePrFixItem(client, reserveInput()));

    ok(await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "outcome-2", result: "exhausted", head: null })));
    expect(item.ciParkState).toBe("settled");
    expect(item.ciParkFence).toBeNull();
    expect(item.ciParkHead).toBeNull();
  });

  it("refuses a DIFFERENT-key outcome after settlement with fence-settled", async () => {
    const client = makeCiParkClient();
    client.items.push(client.makeItem());
    ok(await ciParkPrFixItem(client, parkInput()));
    ok(await ciReservePrFixItem(client, reserveInput()));
    ok(await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "outcome-2", result: "exhausted", head: null })));

    refused(
      await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "outcome-late", fenceToken: "fence-two", result: "unsupported", head: null })),
      "fence-settled",
    );
  });

  it("refuses a fenced outcome on a never-parked row with fence-gone", async () => {
    const client = makeCiParkClient();
    client.items.push(client.makeItem());
    refused(await ciRepairPrFixItem(client, repairInput()), "fence-gone");
  });

  it("replays the same outcome key exactly once, without a second item update", async () => {
    const client = makeCiParkClient();
    const item = client.makeItem();
    client.items.push(item);
    ok(await ciParkPrFixItem(client, parkInput()));
    ok(await ciReservePrFixItem(client, reserveInput()));
    ok(await ciRepairPrFixItem(client, repairInput()));

    const updateCount = client.updateCalls.length;
    const replay: any = await ciRepairPrFixItem(client, repairInput());
    ok(replay);
    expect(replay.replayed).toBe(true);
    expect(client.updateCalls).toHaveLength(updateCount);

    // A SECOND cycle needs its own reservation first (the repush cleared the
    // fence); its settlement is a fresh ledger key.
    ok(await ciReservePrFixItem(client, reserveInput({ idempotencyKey: "reserve-3", fenceToken: "fence-two", head: HEAD2 })));
    ok(await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "outcome-2", result: "exhausted", fenceToken: "fence-two", head: null })));
    expect(item.ciParkState).toBe("settled");

    // Even after settlement, every committed key replays (never re-applies).
    const updateCountAfter = client.updateCalls.length;
    ok(await ciRepairPrFixItem(client, repairInput()));
    ok(await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "outcome-2", result: "exhausted", fenceToken: "fence-two", head: null })));
    expect(client.updateCalls).toHaveLength(updateCountAfter);
  });
});

describe("ciRepairPrFixItem — fence-less release (result 'unsupported')", () => {
  it("releases a deferral matched by its own park key", async () => {
    const client = makeCiParkClient();
    const item = client.makeItem();
    client.items.push(item);
    ok(await ciParkPrFixItem(client, parkInput()));

    // The fence-less release keys by the PARK notice's idempotency key —
    // that key produced the live deferral.
    ok(await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "park-1", result: "unsupported", fenceToken: null, head: null })));
    expect(item.ciParkState).toBe("released");
    expect(item.ciParkFence).toBeNull();
    // The park key survives for replay-by-state on ledger-less clients.
    expect(item.ciParkKey).toBe("park-1");

    ok(await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "park-1", result: "unsupported", fenceToken: null, head: null })));
    expect(client.updateCalls).toHaveLength(2);
  });

  it("replays the ledger row for a repeated release key", async () => {
    const client = makeCiParkClient();
    client.items.push(client.makeItem());
    ok(await ciParkPrFixItem(client, parkInput()));
    ok(await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "park-1", result: "unsupported", fenceToken: null, head: null })));

    const snapshot = JSON.stringify(client.items[0]);
    const updateCount = client.updateCalls.length;
    const replay: any = await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "park-1", result: "unsupported", fenceToken: null, head: null }));
    ok(replay);
    expect(replay.replayed).toBe(true);
    expect(JSON.stringify(client.items[0])).toBe(snapshot);
    expect(client.updateCalls).toHaveLength(updateCount);
  });

  it("refuses a fence-less release while a reservation is live, whatever the key match", async () => {
    const client = makeCiParkClient();
    const item = client.makeItem();
    client.items.push(item);
    ok(await ciParkPrFixItem(client, parkInput()));
    ok(await ciReservePrFixItem(client, reserveInput()));

    refused(
      await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "park-1", result: "unsupported", fenceToken: null, head: null })),
      "fence-held",
    );
    refused(
      await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "other-key", result: "unsupported", fenceToken: null, head: null })),
      "fence-held",
    );
  });

  it("an interleaved reserve between the release's outer read and CAS holds the deferral (fence-held), and the granted fence then settles coherently", async () => {
    const client = makeCiParkClient();
    const item = client.makeItem();
    client.items.push(item);
    ok(await ciParkPrFixItem(client, parkInput()));

    // The reservation opens exactly in the release's outer-read→write gap:
    // the hook pins the fence before the release CAS evaluates (#1415: the
    // release where-gate now carries the vacancy so it can never wipe it).
    // The release keys by the park key (the fence-less contract).
    client.hooks.beforeUpdateMany = () => {
      item.ciParkFence = "fence-race";
    };

    refused(
      await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "park-1", result: "unsupported", fenceToken: null, head: null })),
      "fence-held",
    );
    // The release write never landed: the item stays active with the
    // interleaved reservation's fence held.
    expect(item.ciParkState).toBe("active");
    expect(item.ciParkFence).toBe("fence-race");
    expect(item.ciParkKey).toBe("park-1");

    // Coherence of the deferral afterwards: the granted fence settles as a
    // normal fenced outcome (exhausted hands stewardship back).
    ok(await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "outcome-race", fenceToken: "fence-race", result: "exhausted", head: null })));
    expect(item.ciParkState).toBe("settled");
    expect(item.ciParkFence).toBeNull();
    expect(item.ciParkHead).toBeNull();

    // And a settled deferral refuses any further fence-less release zero-write.
    refused(
      await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "release-late", result: "unsupported", fenceToken: null, head: null })),
      "opportunity-missing",
    );
    expect(item.ciParkState).toBe("settled");
  });

  it("refuses a fence-less release keyed differently from the live deferral, and on a never-parked row", async () => {
    const client = makeCiParkClient();
    client.items.push(client.makeItem());
    ok(await ciParkPrFixItem(client, parkInput()));

    refused(
      await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "stale-key", result: "unsupported", fenceToken: null, head: null })),
      "opportunity-missing",
    );

    const fresh = makeCiParkClient();
    fresh.items.push(fresh.makeItem());
    refused(
      await ciRepairPrFixItem(fresh, repairInput({ idempotencyKey: "park-1", result: "unsupported", fenceToken: null, head: null })),
      "opportunity-missing",
    );
  });

  it("flags the generation fence and the settled state for fence-less calls", async () => {
    const client = makeCiParkClient();
    // Marker survives while the row's generation moved: the notice binds and
    // the fence answers the legacy literal.
    client.items.push(client.makeItem({ generation: 4 }));
    refused(
      await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "park-1", result: "unsupported", fenceToken: null, head: null })),
      "generation-mismatch",
    );

    // Order pin: without the marker the fence is never reached — resolution
    // answers opportunity-missing first.
    const unhandled = makeCiParkClient();
    unhandled.items.push(unhandled.makeItem({ generation: 4, agentHandouts: [] }));
    refused(
      await ciRepairPrFixItem(unhandled, repairInput({ idempotencyKey: "park-1", result: "unsupported", fenceToken: null, head: null })),
      "opportunity-missing",
    );

    const other = makeCiParkClient();
    const item = other.makeItem({ ciParkState: "settled", ciParkKey: "park-1" });
    other.items.push(item);
    refused(
      await ciRepairPrFixItem(other, repairInput({ idempotencyKey: "park-1", result: "unsupported", fenceToken: null, head: null })),
      "opportunity-missing",
    );
  });
});

describe("ciRepairPrFixItem — ledger-absent clients (legacy state-only fallback)", () => {
  it("releases by state and replays by the released row's own park key", async () => {
    const client = makeCiParkClient({ withLedger: false });
    const item = client.makeItem();
    client.items.push(item);

    ok(await ciParkPrFixItem(client, parkInput()));
    expect(item.ciParkState).toBe("active");

    ok(await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "park-1", result: "unsupported", fenceToken: null, head: null })));
    expect(item.ciParkState).toBe("released");

    // Same-key re-arrival: replay-by-state (no double-apply, no churn).
    const lifeFields = JSON.stringify(lifecycleFields(item));
    const updateCount = client.updateCalls.length;
    const replay: any = await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "park-1", result: "unsupported", fenceToken: null, head: null }));
    ok(replay);
    expect(replay.replayed).toBe(true);
    expect(JSON.stringify(lifecycleFields(item))).toBe(lifeFields);
    expect(client.updateCalls).toHaveLength(updateCount);

    // A DIFFERENT key on the released deferral is stale, not a fresh release.
    refused(
      await ciRepairPrFixItem(client, repairInput({ idempotencyKey: "stale-key", result: "unsupported", fenceToken: null, head: null })),
      "opportunity-missing",
    );
  });

  it("re-applies identical park commits as same-value writes and replays the reserve echo by state", async () => {
    const client = makeCiParkClient({ withLedger: false });
    const item = client.makeItem();
    client.items.push(item);

    ok(await ciParkPrFixItem(client, parkInput()));
    const parkedFields = JSON.stringify(lifecycleFields(item));
    // Same-key park re-arrival without a ledger: same-value re-apply (the
    // state itself is the replay witness, safe by construction; only the
    // wall-clock stamp can move).
    ok(await ciParkPrFixItem(client, parkInput()));
    expect(JSON.stringify(lifecycleFields(item))).toBe(parkedFields);

    ok(await ciReservePrFixItem(client, reserveInput()));
    // The grant echoes the token while the fence lives; re-presenting stays
    // one booking.
    const regrant: any = await ciReservePrFixItem(client, reserveInput({ idempotencyKey: "reserve-beta" }));
    ok(regrant);
    expect(regrant.fenceToken).toBe("fence-one");
    expect(item.ciParkFence).toBe("fence-one");
  });
});

describe("input parsing (route 400 contract)", () => {
  it("parses the pinned bodies and ignores unknown fields", () => {
    expect(parseCIParkInput({ repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "k" })).toEqual(
      { repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "k" },
    );
    expect(
      parseCIParkInput({ repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "k", pr: 77, prFixId: "x", handoutToken: "t" }),
    ).toEqual({ repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "k" });
    // No pr travels: it is NOT parsed even when present (bodies pinned by
    // cipark_test.go carry none, and the resolution pivots by generation).
    expect("pr" in (parseCIParkInput({ repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "k", pr: 77 }) as object)).toBe(false);
  });

  it("validates repo, generation, agentName, and idempotencyKey", () => {
    const bad = (body: unknown) => parseCIParkInput(body as Record<string, unknown>);
    expect(bad({})).toEqual({ error: "Missing required field: repo" });
    expect(bad({ repo: "org/repo" })).toEqual({ error: "generation must be an integer >= 1" });
    expect(bad({ repo: "org/repo", generation: 0 })).toEqual({ error: "generation must be an integer >= 1" });
    expect(bad({ repo: "org/repo", generation: 1.5 })).toEqual({ error: "generation must be an integer >= 1" });
    expect(bad({ repo: "org/repo", generation: GEN, head: HEAD1 })).toEqual({ error: "Missing required field: agentName" });
    expect(bad({ repo: "org/repo", generation: GEN, head: HEAD1, agentName: "x" })).toEqual({ error: "Missing required field: idempotencyKey" });
    expect(bad({ repo: "org/repo", generation: GEN, head: HEAD1, agentName: "x", idempotencyKey: "k".repeat(513) })).toEqual(
      { error: "idempotencyKey must be at most 512 characters" },
    );
    expect("error" in bad({ repo: "org/repo", generation: GEN, head: "0000", agentName: "x", idempotencyKey: "k" })).toBe(true);
    expect("error" in bad({ repo: "org/repo", generation: GEN, head: "zzzzzzz", agentName: "x", idempotencyKey: "k" })).toBe(true);
    expect("error" in bad({ repo: "org/repo", generation: GEN, head: "       ", agentName: "x", idempotencyKey: "k" })).toBe(true);
    expect(bad("nope")).toEqual({ error: "Invalid JSON body" });
  });

  it("validates the reserve body: fence required, head required", () => {
    const bad = (body: unknown) => parseCIReserveInput(body as Record<string, unknown>);
    // The shared base fields validate first (mark-family parse order).
    expect(bad({ repo: REPO, generation: GEN, agentName: "worker", head: HEAD1 })).toEqual({ error: "Missing required field: idempotencyKey" });
    expect(bad({ repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "k" })).toEqual({ error: "Missing required field: fenceToken" });
    expect(bad({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k", fenceToken: "f" })).toEqual({ error: "Missing required field: head" });
    expect(bad({ repo: REPO, generation: GEN, agentName: "worker", head: "zzzzzzz", idempotencyKey: "k", fenceToken: "f" })).toEqual({ error: "Invalid head" });
    expect("error" in bad({ repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "k", fenceToken: "f".repeat(1025) })).toBe(true);
  });

  it("validates result families on repair and hard-pins the repush/other head rule", () => {
    const bad = (body: unknown) => parseCIRepairInput(body as Record<string, unknown>);
    // Unknown/empty result.
    expect(bad({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k" })).toEqual({ error: "Missing required field: result" });
    expect(bad({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k", result: "fixed" })).toEqual({ error: "Invalid result" });
    // repushed needs head AND fence.
    expect(bad({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k", result: "repushed", fenceToken: "f" })).toEqual({ error: "Missing required field: head" });
    expect(bad({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k", result: "repushed", head: HEAD2 })).toEqual({ error: "Missing required field: fenceToken" });
    // exhausted/unsupported must NOT carry head.
    const withHead = { repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k", head: HEAD2 };
    expect(bad({ ...withHead, result: "exhausted", fenceToken: "f" })).toEqual({ error: "head is only allowed on a repushed outcome" });
    expect(bad({ ...withHead, result: "unsupported" })).toEqual({ error: "head is only allowed on a repushed outcome" });
    // Fence-less exhausted/repushed is a 400; fence-less unsupported is fine
    // (fence-less RELEASE, harness asserts the state machine separately).
    expect(bad({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k", result: "exhausted" })).toEqual({ error: "Missing required field: fenceToken" });
    expect(bad({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k", result: "repushed", head: HEAD2 })).toEqual({ error: "Missing required field: fenceToken" });
    expect(parseCIRepairInput({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k", result: "unsupported" })).toEqual({
      repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k", result: "unsupported", head: null,
    });
  });
});

describe("the leash: freshAttemptGeneration auto-clears every deferral column", () => {
  it("clears ciParkState/Head/Key/Fence/At alongside the generation bump", () => {
    // #495: no TTL and no new env var — the sole generation-bump helper is
    // the expiry. Every requeue, external-wait reactivation, reclaim, and
    // mark bump spreads this patch in the SAME write, so a deferral can never
    // strand an item into a fresh attempt, and a crashed Courier cycle is
    // bounded by the stale-handout reclaim which bumps through this helper.
    expect(freshAttemptGeneration()).toEqual({
      generation: { increment: 1 },
      attemptEvidenceWatermark: null,
      ciParkState: null,
      ciParkHead: null,
      ciParkKey: null,
      ciParkFence: null,
      ciParkAt: null,
      // #1327: the DISPATCHED lane resets with the attempt too — the merged
      // helper clears every reset-on-bump column in one write.
      attemptType: null,
    });
  });
});
