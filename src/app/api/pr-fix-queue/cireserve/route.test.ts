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

// The reserve state machine runs UNMOCKED against the stateful store: the
// route-level pins (the echoed grant body, the refactor codes, the replay
// bookkeeping) exercise production behavior.
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
// The handout marker lifecycle notices bind to (#495) — built with the same
// helper next-task writes handout records with.
const MARKER = agentHandoutToken("worker", GEN);

function asNextRequest(r: Request): any {
  return r;
}

function postRequest(body: unknown, opts: { includeAuth?: boolean; token?: string; agentName?: string | null } = {}) {
  const { includeAuth = true, token = mockToken, agentName = "worker" } = opts;
  return POST(
    asNextRequest(
      authedRequest("http://localhost/api/pr-fix-queue/cireserve", {
        method: "POST",
        body,
        includeAuth,
        // `agentName: null` sends NO identity header — the deployed Courier
        // client's shape: it names the per-binding agent in the BODY only.
        headers: agentName ? { "x-agent-name": agentName } : {},
        token,
      } as any),
    ),
  );
}

async function parkActiveSeed() {
  const item = harness.makeItem({ agentHandouts: [MARKER] });
  harness.items.push(item);
  // Establish the deferral over the REAL park route machinery (lib level):
  // a direct lib call keeps this test focused on reserve.
  const { ciParkPrFixItem } = await import("@/lib/pr-fix-ci-park");
  await ciParkPrFixItem(harness.prisma, { repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "park-key" });
  return item;
}

describe("POST /api/pr-fix-queue/cireserve", () => {
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

  it("returns 401 without auth, 403 for a bearer-invalid, and 400 on malformed JSON", async () => {
    const body = { repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "k", fenceToken: "f" };
    const unauth = await postRequest(body, { includeAuth: false });
    expect(unauth.status).toBe(401);

    const bad = await POST(
      asNextRequest(
        new Request("http://localhost/api/pr-fix-queue/cireserve", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token", "x-agent-name": "worker" },
          body: JSON.stringify(body),
        }),
      ),
    );
    expect(bad.status).toBe(401);

    const malformed = await POST(
      asNextRequest(
        new Request("http://localhost/api/pr-fix-queue/cireserve", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}`, "x-agent-name": "worker" },
          body: "not-json",
        }),
      ),
    );
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toBe("Invalid JSON body");
  });

  it("returns 400 for missing head/fenceToken and for a bad validation enum", async () => {
    for (const body of [
      { repo: REPO, generation: GEN, agentName: "worker", idempotencyKey: "k", fenceToken: "f" },
      { repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "k" },
      { repo: REPO, generation: GEN, agentName: "worker", head: "zzzzzzz", idempotencyKey: "k", fenceToken: "f" },
    ]) {
      const res = await postRequest(body);
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
    expect(harness.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("grants by echoing EXACTLY the presented fence token (the grant body's only key)", async () => {
    const item = await parkActiveSeed();

    const res = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "reserve-key", fenceToken: "fence-one" });

    expect(res.status).toBe(200);
    // The grant pin: the echoed token is exactly the presented one and the
    // body carries nothing else (Courier asserts grant.FenceToken == presented).
    expect(await res.json()).toEqual({ fenceToken: "fence-one" });
    expect(item.ciParkFence).toBe("fence-one");
    expect(harness.audits[0]).toMatchObject({ action: "pr_fix_ci_reserve", success: true, repoFullName: REPO });
  });

  it("refuses a competing reservation token with 409 fence-held", async () => {
    await parkActiveSeed();
    await postRequest({ repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "reserve-key", fenceToken: "fence-one" });

    const res = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "reserve-key-2", fenceToken: "fence-two" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ reason: "fence-held" });
    expect(harness.ledger.filter((row: any) => row.kind === "reserve")).toHaveLength(1);
  });

  it("a re-presented fence with a NEW key echoes the grant with no extra state bookkeeping", async () => {
    const item = await parkActiveSeed();
    await postRequest({ repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "reserve-key", fenceToken: "fence-one" });
    const updates = (harness.prisma.prFixQueueItem.updateMany as any).mock.calls.length;

    const res = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "reserve-key-2", fenceToken: "fence-one" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fenceToken: "fence-one" });
    // The item write count is UNCHANGED: re-presenting the pinned fence stays
    // one booking; only the new key's replay row is added.
    expect((harness.prisma.prFixQueueItem.updateMany as any).mock.calls.length).toBe(updates);
    expect(harness.ledger.filter((row: any) => row.kind === "reserve")).toHaveLength(2);
    expect(item.ciParkFence).toBe("fence-one");
  });

  it("replays a same-key booking by echoing the COMMITTED fence from its ledger row", async () => {
    await parkActiveSeed();
    await postRequest({ repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "reserve-key", fenceToken: "fence-one" });

    const res = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "reserve-key", fenceToken: "fence-other" });

    expect(res.status).toBe(200);
    // The committed fence echoes even when the presented one differs: the
    // replay never re-books.
    expect(await res.json()).toEqual({ fenceToken: "fence-one" });
  });

  it("refuses a parked head identity mismatch with 409 head-superseded", async () => {
    await parkActiveSeed();
    const res = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", head: "dddddddd000000000000000000000000", idempotencyKey: "reserve-key", fenceToken: "fence-one" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ reason: "head-superseded" });
  });

  it("refuses without an established park (and on a settled deferral) with 409 opportunity-missing", async () => {
    const res = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "reserve-key", fenceToken: "fence-one" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ reason: "opportunity-missing" });

    const settled = harness.makeItem({ ciParkState: "settled", ciParkKey: "park-key", ciParkHead: null, ciParkFence: null, agentHandouts: [MARKER] });
    harness.items.splice(0, harness.items.length, settled);
    const settledRes = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "reserve-key-2", fenceToken: "fence-one" });
    expect(settledRes.status).toBe(409);
    expect(await settledRes.json()).toEqual({ reason: "opportunity-missing" });
  });

  it("answers the legacy generation fence with the mark family's literal", async () => {
    harness.items.push(harness.makeItem({ generation: 4, agentHandouts: [MARKER] }));
    const res = await postRequest({ repo: REPO, generation: 3, agentName: "worker", head: HEAD1, idempotencyKey: "k", fenceToken: "fence-one" });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "PR fix queue item generation mismatch: expected generation 3 did not match the item's current generation",
    );
  });

  it("a maintainer bearer with NO identity header acts for the agent the hand-out binds (the deployed Courier shape)", async () => {
    // #1415 review: the deployed Courier client names the per-binding agent
    // in the BODY and sends no `x-agent-name` header. A maintainer bearer's
    // actor then resolves to the literal placeholder "agent", so comparing
    // the body against the actor rejected every well-formed request. The
    // requested agent is authorized by the QUEUE binding — the row's hand-out
    // marker next-task wrote — not by the actor.
    const item = await parkActiveSeed();

    const res = await postRequest(
      { repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "reserve-key", fenceToken: "fence-one" },
      { agentName: null },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fenceToken: "fence-one" });
    expect(item.ciParkFence).toBe("fence-one");
    // The audit row attributes the agent the notice acted FOR, not the
    // literal placeholder actor a header-less maintainer bearer resolves to.
    expect(harness.audits.at(-1)).toMatchObject({ action: "pr_fix_ci_reserve", actor: "worker", success: true });
  });

  it("a worker-tier credential is refused by the maintainer-tier gate (403, no queue write)", async () => {
    // These routes are Courier-driven queue mutations, so they are
    // MAINTAINER-tier: a worker-tier credential — bound or legacy-unbound —
    // is refused by the route tier before the body is even read, so this test
    // pins the TIER refusal, not the identity scope.
    // `enforceWorkerAgentScope` is the defense-in-depth second layer (it
    // refuses a spoofed agent with 403); its strict-equality semantics are
    // pinned in src/lib/auth.test.ts.
    await parkActiveSeed();
    const res = await postRequest(
      { repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "k", fenceToken: "fence-one" },
      { token: "bound-token", agentName: "alpha" },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/requires a maintainer token/);
    expect(harness.items[0].ciParkFence).toBeNull();
  });

  it("a maintainer naming an agent with no live hand-out is refused by the queue binding", async () => {
    // The binding IS the authorization for a maintainer: the notice resolves
    // the row through the hand-out marker `<agentName>@<generation>`, so an
    // agent that never held the work answers the coded refusal.
    await parkActiveSeed();
    const res = await postRequest(
      { repo: REPO, generation: GEN, agentName: "other-agent", head: HEAD1, idempotencyKey: "k", fenceToken: "fence-one" },
      { agentName: null },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ reason: "opportunity-missing" });
  });

  it("returns 500 (audit success false) when the store throws", async () => {
    (harness.prisma.prFixQueueItem.findMany as any).mockRejectedValueOnce(new Error("db connection lost"));
    const res = await postRequest({ repo: REPO, generation: GEN, agentName: "worker", head: HEAD1, idempotencyKey: "k", fenceToken: "fence-one" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to reserve PR fix queue item for CI repair");
    expect(harness.audits[0]).toMatchObject({ action: "pr_fix_ci_reserve", success: false, errorMessage: "db connection lost" });
  });
});
