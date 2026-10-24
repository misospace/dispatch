import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  TEST_AGENT_TOKEN as mockToken,
  makeDispatchEnvMockWithSafeEqual,
  authedRequest,
} from "@/test/route-helpers";
import { makeCIParkPrismaMocks } from "@/test/pr-fix-ci-park-harness";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () =>
  makeDispatchEnvMockWithSafeEqual(mockToken, { "test-worker-token": "worker" }, { "bound-token": "alpha" }),
);

vi.mock("@/lib/auth-next", () => ({
  auth: vi.fn(),
}));

// The repair state machine runs UNMOCKED against the stateful store: the
// route-level pins (204 exact-once replays, the ordered refactor codes, and
// the parser's head/fence rules) exercise production behavior.
const { harnessHolder } = vi.hoisted(() => ({ harnessHolder: { current: null as any } }));

vi.mock("@/lib/prisma", () => {
  harnessHolder.current ??= makeCIParkPrismaMocks();
  return {
    prisma: harnessHolder.current.prisma,
    asPrFixQueueClient: (client: unknown) => client,
  };
});

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";
import { agentHandoutToken } from "@/lib/pr-fix-queue";

const harness = harnessHolder.current as NonNullable<typeof harnessHolder.current>;

const REPO = "acme/widgets";
const GEN = 3;
const HEAD1 = "aaaaaaaa11111111bbbbbbbb22222222cccccccc";
const HEAD2 = "dddddddd33333333eeeeeeee44444444ffffffff";
// The handout marker lifecycle notices bind to (#495) — built with the same
// helper next-task writes handout records with.
const MARKER = agentHandoutToken("worker", GEN);

function asNextRequest(r: Request): any {
  return r;
}

function postRequest(body: unknown, opts: { includeAuth?: boolean; token?: string; agentName?: string } = {}) {
  const { includeAuth = true, token = mockToken, agentName = "worker" } = opts;
  return POST(
    asNextRequest(
      authedRequest("http://localhost/api/pr-fix-queue/cirepair", {
        method: "POST",
        body,
        includeAuth,
        headers: { "x-agent-name": agentName },
        token,
      } as any),
    ),
  );
}

async function seededPark(options: { reserve?: boolean } = {}) {
  const item = harness.makeItem({ agentHandouts: [MARKER] });
  harness.items.push(item);
  const lib = await import("@/lib/pr-fix-ci-park");
  await lib.ciParkPrFixItem(harness.prisma, { repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "park-key" });
  if (options.reserve) {
    await lib.ciReservePrFixItem(harness.prisma, { repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "reserve-key", fenceToken: "fence-one" });
  }
  return item;
}

describe("POST /api/pr-fix-queue/cirepair", () => {
  beforeEach(() => {
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
    harness.items.splice(0, harness.items.length);
    harness.ledger.splice(0, harness.ledger.length);
    harness.audits.splice(0, harness.audits.length);
  });

  afterEach(() => {
    resetAuthCaches();
    resetRateLimits();
  });

  it("returns 401 without auth and 400 on malformed JSON", async () => {
    const unauth = await postRequest(
      { repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k", result: "unsupported" },
      { includeAuth: false },
    );
    expect(unauth.status).toBe(401);

    const malformed = await POST(
      asNextRequest(
        new Request("http://localhost/api/pr-fix-queue/cirepair", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}`, "x-agent-name": "worker" },
          body: "not-json",
        }),
      ),
    );
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toBe("Invalid JSON body");
  });

  it("validates result families: 400 for a missing/unknown result, a head outside repushed, a missing fence for repushed/exhausted, and a fence-less exhausted/repushed", async () => {
    for (const body of [
      { repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k" },
      { repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k", result: "fixed" },
      { repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k", result: "repushed", fenceToken: "fence-one" },
      { repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k", result: "repushed", head: HEAD2 },
      { repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k", result: "exhausted", head: HEAD2, fenceToken: "fence-one" },
      { repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k", result: "exhausted" },
      { repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k", result: "unsupported", head: HEAD2 },
    ]) {
      const res = await postRequest(body);
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
    expect(harness.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("commits a repushed outcome: 204, head moved + fence cleared + deferral still active, audit success row", async () => {
    const item = await seededPark({ reserve: true });

    const res = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "outcome-key", result: "repushed", fenceToken: "fence-one", head: HEAD2 });

    expect(res.status).toBe(204);
    expect(item.ciParkState).toBe("active");
    expect(item.ciParkHead).toBe(HEAD2);
    expect(item.ciParkFence).toBeNull();
    expect(item.ciParkKey).toBe("park-key");
    // Only the ROUTE outcome is audited here — the lib-level park seed writes
    // no audit rows.
    expect(harness.audits.filter((row: any) => row.success === true)).toHaveLength(1);
    expect(harness.audits[harness.audits.length - 1]).toMatchObject({
      action: "pr_fix_ci_repair",
      success: true,
      repoFullName: REPO,
      issueNumber: null,
    });
    expect(harness.audits[harness.audits.length - 1].notes).toContain("result=repushed");
  });

  it("commits an exhausted outcome: 204, deferral settled (stewardship back to Dispatch)", async () => {
    const item = await seededPark({ reserve: true });

    const res = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "outcome-key", result: "exhausted", fenceToken: "fence-one" });

    expect(res.status).toBe(204);
    expect(item.ciParkState).toBe("settled");
    expect(item.ciParkFence).toBeNull();
    expect(item.ciParkHead).toBeNull();
  });

  it("a fence-less unsupported outcome releases by the park key: 204 and released", async () => {
    const item = await seededPark();

    const res = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "park-key", result: "unsupported" });

    expect(res.status).toBe(204);
    expect(item.ciParkState).toBe("released");
    expect(item.ciParkFence).toBeNull();
    expect(item.ciParkKey).toBe("park-key");
    // A same-key replay is 204 with NO second item update.
    const updates = (harness.prisma.prFixQueueItem.updateMany as any).mock.calls.length;
    const replay = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "park-key", result: "unsupported" });
    expect(replay.status).toBe(204);
    expect((harness.prisma.prFixQueueItem.updateMany as any).mock.calls.length).toBe(updates);
  });

  it("a same-key fenced outcome replays 204 with no second item update, even after settlement", async () => {
    const item = await seededPark({ reserve: true });
    await postRequest({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "outcome-key", result: "repushed", fenceToken: "fence-one", head: HEAD2 });

    const updates = (harness.prisma.prFixQueueItem.updateMany as any).mock.calls.length;
    const replay = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "outcome-key", result: "repushed", fenceToken: "fence-one", head: HEAD1 });
    expect(replay.status).toBe(204);
    expect((harness.prisma.prFixQueueItem.updateMany as any).mock.calls.length).toBe(updates);
    expect(item.ciParkHead).toBe(HEAD2);
  });

  it("refuses an outcome on a consumed fence with 409 fence-gone", async () => {
    await seededPark({ reserve: true });
    await postRequest({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "outcome-key", result: "repushed", fenceToken: "fence-one", head: HEAD2 });

    const res = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "outcome-late-key", result: "repushed", fenceToken: "fence-one", head: HEAD1 });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ reason: "fence-gone" });
  });

  it("refuses a different-key outcome after settlement with 409 fence-settled (before fence-gone)", async () => {
    await seededPark({ reserve: true });
    await postRequest({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "outcome-key", result: "exhausted", fenceToken: "fence-one" });

    const res = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "outcome-restart", result: "unsupported", fenceToken: "fence-one" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ reason: "fence-settled" });
  });

  it("refuses a fence-less release while a reservation is live with 409 fence-held", async () => {
    await seededPark({ reserve: true });

    const res = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "park-key", result: "unsupported" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ reason: "fence-held" });
  });

  it("refuses fence-less releases keyed differently or on a never-parked row with 409 opportunity-missing", async () => {
    await seededPark();
    const mismatchKey = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "stale-key", result: "unsupported" });
    expect(mismatchKey.status).toBe(409);
    expect(await mismatchKey.json()).toEqual({ reason: "opportunity-missing" });

    const fresh = harness.makeItem({ agentHandouts: [MARKER] });
    harness.items.splice(0, 1, fresh);
    harness.ledger.splice(0, harness.ledger.length);
    const neverParked = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "park-key", result: "unsupported" });
    expect(neverParked.status).toBe(409);
    expect(await neverParked.json()).toEqual({ reason: "opportunity-missing" });
  });

  it("answers the legacy generation fence with the mark family's literal (fenced and fence-less)", async () => {
    harness.items.push(harness.makeItem({ generation: 4, agentHandouts: [MARKER] }));
    for (const body of [
      { repo: REPO, generation: 3, agentName: "worker", idempotencyKey: "k", result: "repushed" as const, fenceToken: "fence-one", head: HEAD2 },
      { repo: REPO, generation: 3, agentName: "worker", idempotencyKey: "k", result: "unsupported" as const },
    ]) {
      const res = await postRequest(body);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(
        "PR fix queue item generation mismatch: expected generation 3 did not match the item's current generation",
      );
    }
  });

  it("returns 400 when the body's agentName disagrees with the authenticated actor", async () => {
    const res = await postRequest(
      { repo: REPO, generation: GEN, agentName: "foreign-agent", idempotencyKey: "k", result: "unsupported" },
      { agentName: "worker" },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not match the authenticated actor/);
  });

  it("returns 500 (audit success false) when the store throws", async () => {
    (harness.prisma.prFixQueueItem.findMany as any).mockRejectedValueOnce(new Error("db connection lost"));
    const res = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k", result: "unsupported" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to settle PR fix queue item CI repair");
    expect(harness.audits[0]).toMatchObject({ action: "pr_fix_ci_repair", success: false, errorMessage: "db connection lost" });
  });
});
