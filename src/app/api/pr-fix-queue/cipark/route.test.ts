import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  TEST_AGENT_TOKEN as mockToken,
  makeDispatchEnvMockWithSafeEqual,
  authedRequest,
} from "@/test/route-helpers";
import { makeCIParkPrismaMocks, matchesCIParkWhere } from "@/test/pr-fix-ci-park-harness";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () =>
  makeDispatchEnvMockWithSafeEqual(mockToken, { "test-worker-token": "worker" }, { "bound-token": "alpha" }),
);

vi.mock("@/lib/auth-next", () => ({
  auth: vi.fn(),
}));

// The CI park lifecycle state machines run UNMOCKED against the stateful
// store, so the route-level pins (response codes, audit rows, the exact
// legacy mismatch literal) exercise the production behavior. The store is
// created inside the (hoisted) factory and re-read after the imports.
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

const HEAD1 = "aaaaaaaa11111111bbbbbbbb22222222cccccccc";
// The handout marker lifecycle notices bind to (#495): agent "worker" handed
// generation 3 — built with the same helper next-task writes records with.
const MARKER = agentHandoutToken("worker", 3);

function asNextRequest(r: Request): any {
  return r;
}

function postRequest(body: unknown, opts: { includeAuth?: boolean; token?: string; agentName?: string | null } = {}) {
  const { includeAuth = true, token = mockToken, agentName = "worker" } = opts;
  const req = authedRequest("http://localhost/api/pr-fix-queue/cipark", {
    method: "POST",
    body,
    includeAuth,
    // `agentName: null` sends NO identity header — the deployed Courier
    // client's shape: it names the per-binding agent in the BODY only.
    headers: agentName ? { "x-agent-name": agentName } : {},
    token,
  } as any);
  return POST(asNextRequest(req));
}

describe("POST /api/pr-fix-queue/cipark", () => {
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

  it("returns 401 when no auth header is present", async () => {
    const res = await postRequest(
      { repo: "acme/widgets", generation: 3, agentName: "worker", head: HEAD1, idempotencyKey: "k" },
      { includeAuth: false },
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 for a basic-auth session (bearer-only park)", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "op-pass";
    resetAuthCaches();
    try {
      const basic = Buffer.from("operator:op-pass").toString("base64");
      const res = await POST(
        asNextRequest(
          new Request("http://localhost/api/pr-fix-queue/cipark", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Basic ${basic}`, "x-agent-name": "worker" },
            body: JSON.stringify({ repo: "acme/widgets", generation: 3, agentName: "worker", head: HEAD1, idempotencyKey: "k" }),
          }),
        ),
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/bearer token/i);
    } finally {
      delete process.env.DISPATCH_AUTH_MODE;
      delete process.env.DISPATCH_AUTH_USERNAME;
      delete process.env.DISPATCH_AUTH_PASSWORD;
      resetAuthCaches();
    }
  });

  it("returns 400 on malformed JSON", async () => {
    const res = await POST(
      asNextRequest(
        new Request("http://localhost/api/pr-fix-queue/cipark", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}`, "x-agent-name": "worker" },
          body: "not-json",
        }),
      ),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON body");
  });

  it("rejects a bad head, an empty key, and an over-size key with 400", async () => {
    for (const body of [
      { repo: "acme/widgets", generation: 3, agentName: "worker", head: "0000", idempotencyKey: "k" },
      { repo: "acme/widgets", generation: 3, agentName: "worker", head: HEAD1, idempotencyKey: "" },
      { repo: "acme/widgets", generation: 3, agentName: "worker", head: HEAD1, idempotencyKey: "k".repeat(513) },
      { repo: "acme/widgets", generation: 0, agentName: "worker", head: HEAD1, idempotencyKey: "k" },
    ]) {
      const res = await postRequest(body);
      expect(res.status).toBe(400);
      const result = await res.json();
      expect(typeof result.error).toBe("string");
      expect(harness.prisma.auditLog.create).not.toHaveBeenCalled();
    }
  });

  it("a maintainer bearer with NO identity header acts for the agent the hand-out binds (the deployed Courier shape)", async () => {
    // #1415 review: the deployed Courier client names the per-binding agent
    // in the BODY and sends no `x-agent-name` header. A maintainer bearer's
    // actor then resolves to the literal placeholder "agent", so comparing
    // the body against the actor rejected every well-formed request. The
    // requested agent is authorized by the QUEUE binding — the row's hand-out
    // marker next-task wrote — not by the actor.
    harness.items.push(harness.makeItem({ agentHandouts: [MARKER] }));
    const res = await postRequest(
      { repo: "acme/widgets", generation: 3, agentName: "worker", head: HEAD1, idempotencyKey: "park-key" },
      { agentName: null },
    );
    expect(res.status).toBe(204);
    expect(harness.items[0].ciParkState).toBe("active");
    // The audit row attributes the agent the notice acted FOR, not the
    // literal placeholder actor a header-less maintainer bearer resolves to.
    expect(harness.audits.at(-1)).toMatchObject({ action: "pr_fix_ci_park", actor: "worker", success: true });
  });

  it("a worker-tier credential is refused by the maintainer-tier gate (403, no queue write)", async () => {
    // These routes are Courier-driven queue mutations, so they are
    // MAINTAINER-tier: a worker-tier credential — bound or legacy-unbound —
    // is refused by the route tier before the body is even read, so this test
    // pins the TIER refusal, not the identity scope.
    // `enforceWorkerAgentScope` is the defense-in-depth second layer (it
    // refuses a spoofed agent with 403); its strict-equality semantics are
    // pinned in src/lib/auth.test.ts.
    harness.items.push(harness.makeItem({ agentHandouts: [MARKER] }));
    const res = await postRequest(
      { repo: "acme/widgets", generation: 3, agentName: "worker", head: HEAD1, idempotencyKey: "k" },
      { token: "bound-token", agentName: "alpha" },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/requires a maintainer token/);
    expect(harness.items[0].ciParkState).toBeNull();
  });

  it("a maintainer naming an agent with no live hand-out is refused by the queue binding", async () => {
    // The binding IS the authorization for a maintainer: the notice resolves
    // the row through the hand-out marker `<agentName>@<generation>`, so an
    // agent that never held the work answers the coded refusal.
    harness.items.push(harness.makeItem({ agentHandouts: [MARKER] }));
    const res = await postRequest(
      { repo: "acme/widgets", generation: 3, agentName: "other-agent", head: HEAD1, idempotencyKey: "k" },
      { agentName: null },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ reason: "opportunity-missing" });
  });

  it("commits a fresh park: 204, item event data recorded, audit success row", async () => {
    harness.items.push(harness.makeItem({ agentHandouts: [MARKER] }));
    const res = await postRequest({ repo: "acme/widgets", generation: 3, agentName: "worker", head: HEAD1, idempotencyKey: "park-key" });

    expect(res.status).toBe(204);
    const item = harness.items[0];
    expect(item.ciParkState).toBe("active");
    expect(item.ciParkHead).toBe(HEAD1);
    expect(item.ciParkKey).toBe("park-key");
    expect(item.ciParkAt).toBeInstanceOf(Date);
    expect(item.ciParkFence).toBeNull();

    // The row is normalized: a differently-cased repo hits the same key.
    const replay = await postRequest({ repo: "ACME/WIDGETS", generation: 3, agentName: "worker", head: HEAD1, idempotencyKey: "park-key" });
    expect(replay.status).toBe(204);

    const committed = harness.audits.filter((row: any) => row.success === true);
    expect(committed).toHaveLength(2);
    for (const row of committed) {
      expect(row.action).toBe("pr_fix_ci_park");
      expect(row.repoFullName).toBe("acme/widgets");
      expect(row.issueNumber).toBeNull();
      expect(row.notes).toContain("generation=3");
      expect(row.notes).toMatch(/result=(committed|replayed)/);
    }
  });

  it("a same-key replay is 204 with NO second item update (the exact-once pin)", async () => {
    harness.items.push(harness.makeItem({ agentHandouts: [MARKER] }));
    await postRequest({ repo: "acme/widgets", generation: 3, agentName: "worker", head: HEAD1, idempotencyKey: "park-key" });
    const updates = (harness.prisma.prFixQueueItem.updateMany as any).mock.calls.length;

    const res = await postRequest({ repo: "acme/widgets", generation: 3, agentName: "worker", head: HEAD1, idempotencyKey: "park-key" });

    expect(res.status).toBe(204);
    expect((harness.prisma.prFixQueueItem.updateMany as any).mock.calls.length).toBe(updates);
    // The replay commits no second ledger row either.
    expect(harness.ledger).toHaveLength(1);
  });

  it("answers the legacy generation fence with the mark family's literal", async () => {
    harness.items.push(harness.makeItem({ generation: 4, agentHandouts: [MARKER] }));
    const res = await postRequest({ repo: "acme/widgets", generation: 3, agentName: "worker", head: HEAD1, idempotencyKey: "k" });

    expect(res.status).toBe(409);
    // Courier's superseded sniff matches substrings "generation mismatch" and
    // "expected generation"; assert the full literal verbatim.
    expect((await res.json()).error).toBe(
      "PR fix queue item generation mismatch: expected generation 3 did not match the item's current generation",
    );
  });

  it.each([
    { name: "a missing row", row: null },
    { name: "a seeded but never-handed row (no handout marker to bind)", row: harness.makeItem({ agentHandouts: [] }) },
    { name: "a resolved but non-QUEUED row", row: harness.makeItem({ status: "FIXED", agentHandouts: [MARKER] }) },
  ])("refuses %s with 409 opportunity-missing", async ({ row }) => {
    if (row) harness.items.push(row);
    const res = await postRequest({ repo: "acme/widgets", generation: 3, agentName: "worker", head: HEAD1, idempotencyKey: "k" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ reason: "opportunity-missing" });
    // A refused park never settles state; its audit carries the code.
    expect(harness.items[0]?.ciParkState ?? null).toBeNull();
    const refusedAudit = harness.audits.find((audit: any) => audit.success === false && audit.errorMessage?.includes("opportunity-missing"));
    expect(refusedAudit).toMatchObject({ action: "pr_fix_ci_park", success: false });
  });

  it("returns 500 (with a failed audit row) when the store throws", async () => {
    (harness.prisma.prFixQueueItem.findMany as any).mockRejectedValueOnce(new Error("db connection lost"));
    const res = await postRequest({ repo: "acme/widgets", generation: 3, agentName: "worker", head: HEAD1, idempotencyKey: "k" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to park PR fix queue item for CI");
    expect(harness.audits[0]).toMatchObject({ action: "pr_fix_ci_park", success: false, errorMessage: "db connection lost" });
  });
});
