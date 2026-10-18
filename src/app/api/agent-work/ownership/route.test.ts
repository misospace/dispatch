import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authedRequest,
  makeDispatchEnvMock,
  TEST_AGENT_TOKEN as mockToken,
} from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

// Maintainer (default token), a legacy unbound worker token, and two bound
// worker credentials (#1129 identity-scope matrix for the ownership route).
vi.mock("@/lib/dispatch-env", () =>
  makeDispatchEnvMock(
    mockToken,
    { "unbound-worker-token": "worker" },
    { "bound-alpha-token": "alpha", "bound-beta-token": "beta" },
  ),
);

const { mocks, db, applyData } = vi.hoisted(() => {
  // Mirrors Prisma's `{ increment: n }` update input on the in-memory lease.
  const applyData = (lease: any, data: Record<string, unknown>) => {
    const next = { ...lease };
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && typeof value === "object" && "increment" in value) {
        next[key] = (typeof next[key] === "number" ? next[key] : 0) + (value as { increment: number }).increment;
      } else {
        next[key] = value;
      }
    }
    return next;
  };
  return {
    applyData,
    mocks: {
      guardBusy: false,
      // One-shot write-failure injection: the named delegate throws the first
      // time it is reached after being armed, so the retry runs clean.
      failAt: null as null | "agentWork.update" | "lifecycle" | "audit",
    },
    db: {
      issue: null as any,
      lease: null as any,
      agentWork: null as any,
      agentWorkUpdates: [] as any[],
      agentWorkHistory: [] as any[],
      leaseUpdates: [] as any[],
      updateManyCount: undefined as number | undefined,
      audit: [] as any[],
      lifecycleEvents: [] as any[],
      txCount: 0,
    },
  };
});

// Pass-through guard (capacity-handoff convention); flip `mocks.guardBusy`
// to exercise the busy branch.
vi.mock("@/lib/issue-mutation-guard", () => ({
  withIssueMutationGuard: async (_request: unknown, callback: any) => {
    if (mocks.guardBusy) return { status: "busy", ownerToken: "other-owner", operation: "ownership" };
    const result = await callback(undefined, { resuming: false });
    return { status: result.complete ? "completed" : "retained", value: result.value };
  },
}));

vi.mock("@/lib/prisma", () => {
  const maybeFail = (point: string) => {
    if (mocks.failAt !== point) return;
    mocks.failAt = null;
    throw new Error(`injected failure at ${point}`);
  };

  const client: any = {
    issue: {
      findUnique: async ({ where }: any) =>
        db.issue && db.issue.id === where.id ? db.issue : null,
    },
    lease: {
      findUnique: async ({ where }: any) => {
        if (where.agentName_issueId) {
          const { agentName, issueId } = where.agentName_issueId;
          return db.lease && db.lease.agentName === agentName && db.lease.issueId === issueId
            ? db.lease
            : null;
        }
        return db.lease && db.lease.id === where.id ? db.lease : null;
      },
      update: async ({ where, data }: any) => {
        if (db.lease && db.lease.id === where.id) {
          db.leaseUpdates.push({ where, data });
          db.lease = applyData(db.lease, data);
        }
        return db.lease;
      },
      // Honors the fenced compare-and-set (id + claimToken + null disposition).
      updateMany: async ({ where, data }: any) => {
        if (db.updateManyCount !== undefined) return { count: db.updateManyCount };
        if (!db.lease || db.lease.id !== where.id) return { count: 0 };
        if (where.claimToken !== undefined && db.lease.claimToken !== where.claimToken) return { count: 0 };
        if (where.disposition !== undefined && db.lease.disposition !== where.disposition) return { count: 0 };
        db.lease = applyData(db.lease, data);
        return { count: 1 };
      },
    },
    agentWork: {
      findFirst: async ({ where }: any) => {
        if (!db.agentWork) return null;
        if (db.agentWork.agentName !== where.agentName) return null;
        if (db.agentWork.issueId !== where.issueId) return null;
        if (where.state?.in && !where.state.in.includes(db.agentWork.state)) return null;
        return db.agentWork;
      },
      update: async ({ where, data }: any) => {
        maybeFail("agentWork.update");
        if (db.agentWork && db.agentWork.id === where.id) {
          db.agentWorkUpdates.push({ where, data });
          db.agentWork = { ...db.agentWork, ...data };
        }
        return db.agentWork;
      },
    },
    agentWorkHistory: {
      create: async ({ data }: any) => {
        db.agentWorkHistory.push(data);
        return data;
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        maybeFail("audit");
        db.audit.push(data);
        return data;
      },
    },
    issueLifecycleEvent: {
      create: async ({ data }: any) => {
        maybeFail("lifecycle");
        db.lifecycleEvents.push(data);
        return data;
      },
      upsert: async ({ where, create }: any) => {
        maybeFail("lifecycle");
        const existing = db.lifecycleEvents.find((e) => e.dedupeKey === where.dedupeKey);
        if (existing) return existing;
        db.lifecycleEvents.push(create);
        return create;
      },
    },
  };

  // Interactive transaction over the same delegates, rolling the in-memory
  // store back when the callback throws — so a test can prove that a failed
  // disposition leaves no committed lease CAS behind (#1251 review MAJOR).
  client.$transaction = async (fn: (tx: any) => Promise<any>) => {
    db.txCount += 1;
    const snapshot = {
      lease: db.lease,
      agentWork: db.agentWork,
      leaseUpdates: db.leaseUpdates.length,
      agentWorkUpdates: db.agentWorkUpdates.length,
      history: db.agentWorkHistory.length,
      audit: db.audit.length,
      lifecycle: db.lifecycleEvents.length,
    };
    try {
      return await fn(client);
    } catch (error) {
      db.lease = snapshot.lease;
      db.agentWork = snapshot.agentWork;
      db.leaseUpdates.length = snapshot.leaseUpdates;
      db.agentWorkUpdates.length = snapshot.agentWorkUpdates;
      db.agentWorkHistory.length = snapshot.history;
      db.audit.length = snapshot.audit;
      db.lifecycleEvents.length = snapshot.lifecycle;
      throw error;
    }
  };

  return { prisma: client };
});

import { POST } from "./route";
import { upsertLease } from "@/lib/lease";
import { getAuthorizedActor, authorizeRequest, resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";
import { lifecycleDedupeKey } from "@/lib/issue-lifecycle";

const URL = "http://localhost/api/agent-work/ownership";
const AGENT = "alpha";
const CLAIM_TOKEN = "SECRET-CLAIM-TOKEN-123";
const inMin = (n: number) => new Date(Date.now() + n * 60_000);

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "iss1",
    number: 7,
    state: "open",
    labels: ["agent/alpha"],
    blockedReason: null,
    linkedPrNumber: null,
    linkedPrMergeState: null,
    repository: { fullName: "acme/widgets" },
    ...overrides,
  };
}

function makeLease(overrides: Record<string, unknown> = {}) {
  return {
    id: "lease-1",
    agentName: AGENT,
    issueId: "iss1",
    claimToken: CLAIM_TOKEN,
    expiredAt: inMin(30),
    renewedAt: null,
    registeredAt: null,
    registrationOccurredAt: null,
    renewCount: 0,
    lastRenewalObservedAt: null,
    lastRenewalOccurredAt: null,
    retryAfter: null,
    waitReason: null,
    disposition: null,
    dispositionNote: null,
    successorRef: null,
    dispositionOccurredAt: null,
    dispositionObservedAt: null,
    runRef: null,
    createdAt: inMin(-1),
    ...overrides,
  };
}

function makeAgentWork(overrides: Record<string, unknown> = {}) {
  return {
    id: "work-1",
    agentName: AGENT,
    issueId: "iss1",
    state: "IN_PROGRESS",
    lastHeartbeatAt: inMin(-2),
    blockerReason: null,
    ...overrides,
  };
}

function post(
  body: Record<string, unknown>,
  opts: { token?: string; includeAuth?: boolean } = {},
) {
  return POST(
    authedRequest(URL, {
      method: "POST",
      token: opts.token,
      includeAuth: opts.includeAuth,
      body,
    }),
  );
}

function baseBody(overrides: Record<string, unknown> = {}) {
  return { agentName: AGENT, issueId: "iss1", claimToken: CLAIM_TOKEN, ...overrides };
}

function seedDb() {
  db.issue = makeIssue();
  db.lease = makeLease();
  db.agentWork = null;
  db.agentWorkUpdates = [];
  db.agentWorkHistory = [];
  db.leaseUpdates = [];
  db.updateManyCount = undefined;
  db.audit = [];
  db.lifecycleEvents = [];
  db.txCount = 0;
  mocks.failAt = null;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAuthCaches();
  resetRateLimits();
  delete process.env.DISPATCH_AUTH_MODE;
  mocks.guardBusy = false;
  seedDb();
});

describe("POST /api/agent-work/ownership — auth", () => {
  it("returns 401 when no authorization header is provided", async () => {
    const res = await post(baseBody({ operation: "register" }), { includeAuth: false });
    expect(res.status).toBe(401);
  });

  it("refuses a bound worker acting for another agent with 403 and no writes", async () => {
    const res = await post(baseBody({ operation: "register" }), { token: "bound-beta-token" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('bound to agent "beta"');
    expect(body.error).toContain('"alpha"');
    expect(db.lease.registeredAt).toBeNull();
    expect(db.lease.disposition).toBeNull();
    expect(db.leaseUpdates).toHaveLength(0);
    expect(db.lifecycleEvents).toHaveLength(0);
    expect(db.audit.filter((a) => a.action.startsWith("ownership_"))).toHaveLength(0);
    // The only side effect is the best-effort scope-denial audit row.
    expect(db.audit.some((a) => a.action === "worker_scope_denied")).toBe(true);
  });

  it("refuses the legacy unbound worker token with 403", async () => {
    const res = await post(baseBody({ operation: "register" }), { token: "unbound-worker-token" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/not bound to an agent/i);
    expect(db.lease.registeredAt).toBeNull();
    expect(db.audit.some((a) => a.action === "worker_scope_denied")).toBe(true);
  });

  it("lets a bound worker operate for its own agent", async () => {
    const res = await post(baseBody({ operation: "register" }), { token: "bound-alpha-token" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.operation).toBe("register");
  });

  it("lets a maintainer record for a named agent, auditing as the resolved actor", async () => {
    const req = authedRequest(URL, { method: "POST", body: baseBody({ operation: "register" }) });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const auth = await authorizeRequest(req);
    expect(auth.authorized).toBe(true);
    const expectedActor = getAuthorizedActor(auth, req, AGENT);
    // A maintainer bearer has no bound identity: the named agent is the
    // fallback actor, per getAuthorizedActor in src/lib/auth.ts.
    expect(expectedActor).toBe(AGENT);
    const row = db.audit.find((a) => a.action === "ownership_register");
    expect(row).toBeDefined();
    expect(row.actor).toBe(expectedActor);
  });
});

describe("POST /api/agent-work/ownership — register", () => {
  it("records registration on the lease, one lifecycle event, and an audit row", async () => {
    const before = Date.now();
    const res = await post(baseBody({ operation: "register", runRef: "run-77" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.replayed).toBe(false);
    expect(body.leaseId).toBe("lease-1");
    expect(body.expiresAt).toBe(db.lease.expiredAt.toISOString());
    expect(body.registeredAt).toBe(db.lease.registeredAt.toISOString());
    expect(body.registrationOccurredAt).toBe(db.lease.registrationOccurredAt.toISOString());
    const elapsed = new Date(body.registeredAt).getTime() - before;
    expect(elapsed).toBeGreaterThanOrEqual(-1000);
    expect(elapsed).toBeLessThanOrEqual(15_000);

    expect(db.lease.registeredAt).toBeInstanceOf(Date);
    expect(db.lease.registrationOccurredAt).toBeInstanceOf(Date);
    expect(db.lease.runRef).toBe("run-77");

    expect(db.lifecycleEvents).toHaveLength(1);
    const [event] = db.lifecycleEvents;
    expect(event.kind).toBe("ownership_registered");
    expect(event.source).toBe("api:ownership");
    expect(event.actor).toBe(AGENT);
    expect(event.agentName).toBe(AGENT);
    expect(event.repoFullName).toBe("acme/widgets");
    expect(event.issueNumber).toBe(7);
    const expectedDedupeKey = lifecycleDedupeKey("ownership_registered", "iss1", AGENT, CLAIM_TOKEN);
    expect(event.dedupeKey).toBe(expectedDedupeKey);
    expect(event.dedupeKey).toContain("iss1");
    expect(event.dedupeKey).toContain(AGENT);
    expect(event.dedupeKey).toContain(CLAIM_TOKEN);
    expect(event.metadata.runRef).toBe("run-77");

    const audit = db.audit.find((a) => a.action === "ownership_register");
    expect(audit).toBeDefined();
    expect(audit.actor).toBe(AGENT);
    expect(audit.repoFullName).toBe("acme/widgets");
    expect(audit.issueNumber).toBe(7);
    expect(audit.success).toBe(true);
    expect(audit.notes).toBe("runRef=run-77");
  });

  it("returns 409 no_active_claim when the issue has no lease", async () => {
    db.lease = null;
    const res = await post(baseBody({ operation: "register" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("no_active_claim");
    expect(body.error).toBeTruthy();
    expect(db.audit).toHaveLength(0);
  });

  it("returns 409 stale_claim_token for a mismatched token and leaves the lease untouched", async () => {
    const res = await post(baseBody({ operation: "register", claimToken: "SOME-OTHER-TOKEN" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("stale_claim_token");
    expect(body.error).toBeTruthy();
    expect(db.lease.registeredAt).toBeNull();
    expect(db.lease.disposition).toBeNull();
    expect(db.leaseUpdates).toHaveLength(0);
    expect(db.lifecycleEvents).toHaveLength(0);
    expect(db.audit).toHaveLength(0);
  });

  it("returns 409 stale_claim_token for a lease with no claim token (pre-#1256 claim)", async () => {
    db.lease = makeLease({ claimToken: null });
    const res = await post(baseBody({ operation: "register" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("stale_claim_token");
    expect(db.leaseUpdates).toHaveLength(0);
    expect(db.lifecycleEvents).toHaveLength(0);
  });

  it("returns 409 disposed when the lease already carries a terminal disposition", async () => {
    db.lease = makeLease({ disposition: "completed" });
    const res = await post(baseBody({ operation: "register" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("disposed");
  });

  it("dedupes a replayed register on the claim token (one lifecycle event)", async () => {
    const first = await post(baseBody({ operation: "register", runRef: "run-1" }));
    const replay = await post(baseBody({ operation: "register", runRef: "run-1" }));
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect((await replay.json()).ok).toBe(true);
    expect(db.lifecycleEvents).toHaveLength(1);
  });

  it("returns the persisted registration on a replay and writes nothing (#1251 review)", async () => {
    const first = await post(baseBody({ operation: "register", runRef: "run-1" }));
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const registeredAt = db.lease.registeredAt;
    const occurredAt = db.lease.registrationOccurredAt;
    expect(db.audit.filter((a) => a.action === "ownership_register")).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const replay = await post(baseBody({ operation: "register", runRef: "run-2" }));
    expect(replay.status).toBe(200);
    const replayBody = await replay.json();
    // Truthful replay: the same response shape as the first call, flagged as a
    // replay, carrying the FIRST registration's persisted values.
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.leaseId).toBe("lease-1");
    expect(replayBody.registeredAt).toBe(registeredAt.toISOString());
    expect(replayBody.registrationOccurredAt).toBe(occurredAt.toISOString());
    expect(replayBody.expiresAt).toBe(firstBody.expiresAt);
    // Not one write: no timestamp refresh, no run-reference overwrite, no
    // second lifecycle event, no second audit row.
    expect(db.lease.registeredAt).toEqual(registeredAt);
    expect(db.lease.registrationOccurredAt).toEqual(occurredAt);
    expect(db.lease.runRef).toBe("run-1");
    expect(db.leaseUpdates).toHaveLength(1);
    expect(db.lifecycleEvents).toHaveLength(1);
    expect(db.audit.filter((a) => a.action === "ownership_register")).toHaveLength(1);
  });

  it("rejects an over-long runRef with 400", async () => {
    const res = await post(baseBody({ operation: "register", runRef: "x".repeat(501) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/runRef/);
  });

  it("rejects an unknown operation with 400", async () => {
    const res = await post(
      { operation: "explosify", agentName: AGENT, issueId: "iss1", claimToken: CLAIM_TOKEN },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid operation/);
  });
});

describe("POST /api/agent-work/ownership — renew", () => {
  it("extends the lease TTL, increments renewCount, and records renewal times", async () => {
    const before = Date.now();
    const res = await post(baseBody({ operation: "renew" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.leaseId).toBe("lease-1");
    expect(body.renewCount).toBe(1);
    expect(body.agentWorkHeartbeated).toBe(false);
    const delta = new Date(body.expiresAt).getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(30 * 60_000 - 10_000);
    expect(delta).toBeLessThanOrEqual(30 * 60_000 + 10_000);
    expect(body.lastRenewalObservedAt).toBeTruthy();
    expect(body.lastRenewalOccurredAt).toBeTruthy();
    expect(db.lease.renewCount).toBe(1);
    expect(db.lease.renewedAt).toBeInstanceOf(Date);
    expect(db.lease.lastRenewalObservedAt).toBeInstanceOf(Date);
    expect(db.lease.lastRenewalOccurredAt).toBeInstanceOf(Date);
  });

  it("accepts a renewal for a lapsed-but-present lease (late renewal)", async () => {
    db.lease = makeLease({ expiredAt: new Date(Date.now() - 5 * 60_000) });
    const res = await post(baseBody({ operation: "renew" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(db.lease.renewCount).toBe(1);
  });

  it("returns 409 stale_claim_token after the claim was re-issued a new token", async () => {
    const seeded = inMin(30);
    db.lease = makeLease({ claimToken: "FRESH-TOKEN-2", expiredAt: seeded });
    const res = await post(baseBody({ operation: "renew" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("stale_claim_token");
    // The fenced renewal must not have touched the live claim.
    expect(db.lease.expiredAt.getTime()).toBe(seeded.getTime());
    expect(db.lease.renewCount).toBe(0);
  });

  it("returns 409 disposed once the lease carries a terminal disposition", async () => {
    db.lease = makeLease({ disposition: "released" });
    const res = await post(baseBody({ operation: "renew" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("disposed");
  });

  it("returns 409 stale_claim_token when the compare-and-set matches nothing", async () => {
    db.updateManyCount = 0;
    const res = await post(baseBody({ operation: "renew" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("stale_claim_token");
    expect(body.error).toMatch(/concurrently/i);
  });

  it("heartbeats a matching active AgentWork row and writes history", async () => {
    db.agentWork = makeAgentWork();
    const res = await post(baseBody({ operation: "renew" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentWorkHeartbeated).toBe(true);
    expect(db.agentWorkUpdates).toHaveLength(1);
    expect(db.agentWorkUpdates[0].data.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(db.agentWorkHistory).toHaveLength(1);
    const [history] = db.agentWorkHistory;
    expect(history.workId).toBe("work-1");
    expect(history.action).toBe("ownership_renewed");
  });

  it("sets an external wait marker on the lease", async () => {
    const retryAfter = new Date(Date.now() + 3600_000);
    const res = await post(
      baseBody({ operation: "renew", externalWait: { reason: "waiting on infra", retryAfter: retryAfter.toISOString() } }),
    );
    expect(res.status).toBe(200);
    expect(db.lease.retryAfter).toEqual(retryAfter);
    expect(db.lease.waitReason).toBe("waiting on infra");
  });

  it("clears a previously set external wait when passed null", async () => {
    db.lease = makeLease({ retryAfter: inMin(60), waitReason: "waiting on infra" });
    const res = await post(baseBody({ operation: "renew", externalWait: null }));
    expect(res.status).toBe(200);
    expect(db.lease.retryAfter).toBeNull();
    expect(db.lease.waitReason).toBeNull();
  });

  it("preserves a valid past occurredAt in lastRenewalOccurredAt", async () => {
    const occurred = new Date(Date.now() - 5 * 60_000);
    const res = await post(baseBody({ operation: "renew", occurredAt: occurred.toISOString() }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lastRenewalOccurredAt).toBe(occurred.toISOString());
    expect(db.lease.lastRenewalOccurredAt).toEqual(occurred);
  });

  it("falls back to the server clock for a future occurredAt without rejecting", async () => {
    const future = new Date(Date.now() + 2 * 3600_000).toISOString();
    const before = Date.now();
    const res = await post(baseBody({ operation: "renew", occurredAt: future }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const got = new Date(body.lastRenewalOccurredAt).getTime();
    expect(got).toBeGreaterThan(before - 5000);
    expect(got).toBeLessThanOrEqual(before + 5000);
  });
});

describe("POST /api/agent-work/ownership — disposition", () => {
  it("settles completed: terminal lease, DONE AgentWork, history, lifecycle, audit; lease retained", async () => {
    db.agentWork = makeAgentWork();
    const res = await post(
      baseBody({ operation: "disposition", disposition: "completed", note: "shipped and merged" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.replayed).toBe(false);
    expect(body.leaseId).toBe("lease-1");
    expect(body.disposition).toBe("completed");

    // The lease row is durable evidence — never deleted by a disposition.
    expect(db.lease).not.toBeNull();
    expect(db.lease.disposition).toBe("completed");
    expect(db.lease.dispositionNote).toBe("shipped and merged");
    expect(db.lease.dispositionOccurredAt).toBeInstanceOf(Date);
    expect(db.lease.dispositionObservedAt).toBeInstanceOf(Date);

    expect(db.agentWork.state).toBe("DONE");
    expect(db.agentWorkHistory).toHaveLength(1);
    const [history] = db.agentWorkHistory;
    expect(history.workId).toBe("work-1");
    expect(history.action).toBe("ownership_dispositioned");
    expect(history.state).toBe("DONE");

    expect(db.lifecycleEvents).toHaveLength(1);
    const [event] = db.lifecycleEvents;
    expect(event.kind).toBe("ownership_dispositioned");
    expect(event.dedupeKey).toBe(
      lifecycleDedupeKey("ownership_dispositioned", "iss1", AGENT, CLAIM_TOKEN, "completed"),
    );
    expect(event.metadata.disposition).toBe("completed");

    const audit = db.audit.find((a) => a.action === "ownership_disposition");
    expect(audit).toBeDefined();
    expect(audit.success).toBe(true);
  });

  it("replays the same disposition idempotently", async () => {
    const first = await post(baseBody({ operation: "disposition", disposition: "completed" }));
    expect(first.status).toBe(200);
    const replay = await post(baseBody({ operation: "disposition", disposition: "completed" }));
    expect(replay.status).toBe(200);
    const body = await replay.json();
    expect(body.replayed).toBe(true);
    expect(body.disposition).toBe("completed");
    expect(db.lifecycleEvents).toHaveLength(1);
    expect(db.audit.filter((a) => a.action === "ownership_disposition")).toHaveLength(1);
  });

  it("rejects a different disposition after a terminal one", async () => {
    db.lease = makeLease({ disposition: "completed" });
    const res = await post(baseBody({ operation: "disposition", disposition: "blocked" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("disposition_conflict");
  });

  it("parks a blocked disposition with a future retryAfter", async () => {
    const retryAfter = new Date(Date.now() + 2 * 3600_000);
    const res = await post(
      baseBody({
        operation: "disposition",
        disposition: "blocked",
        note: "waiting on infra",
        retryAfter: retryAfter.toISOString(),
        waitReason: "infra cooldown",
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).disposition).toBe("blocked");
    expect(db.lease.disposition).toBe("blocked");
    expect(db.lease.retryAfter).toEqual(retryAfter);
    expect(db.lease.waitReason).toBe("infra cooldown");
  });

  it("clears a stale external wait when the disposition is not blocked (#1251 review)", async () => {
    // An earlier renew parked an external wait; a terminal completed
    // disposition must drop it so the gone owner is not EXTERNAL_WAIT.
    db.lease = { ...db.lease, retryAfter: new Date(Date.now() + 3600_000), waitReason: "dep" };
    const res = await post(baseBody({ operation: "disposition", disposition: "completed" }));
    expect(res.status).toBe(200);
    expect(db.lease.disposition).toBe("completed");
    expect(db.lease.retryAfter).toBeNull();
    expect(db.lease.waitReason).toBeNull();
  });

  it("rejects a past retryAfter with 400", async () => {
    const res = await post(
      baseBody({
        operation: "disposition",
        disposition: "blocked",
        retryAfter: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/future/);
  });

  it("rejects retryAfter on a non-blocked disposition with 400 (#1251 review)", async () => {
    const res = await post(
      baseBody({
        operation: "disposition",
        disposition: "completed",
        retryAfter: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/blocked/);
    // Nothing was written: the terminal record must not park as EXTERNAL_WAIT.
    expect(db.lease.disposition).toBeNull();
    expect(db.lease.retryAfter ?? null).toBeNull();
  });

  it("rejects an unknown disposition value with 400", async () => {
    const res = await post(baseBody({ operation: "disposition", disposition: "yanked" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid disposition/);
  });
});

describe("POST /api/agent-work/ownership — disposition atomicity (#1251 review)", () => {
  // The `ownership` guard has no resume branch: a throw deletes it and the
  // route 500s. So the terminal lease CAS and every local effect it implies
  // must commit together — otherwise the retry hits the `lease.disposition`
  // replay branch and returns `replayed: true` for a disposition whose
  // AgentWork settlement, history and `ownership_dispositioned` event never
  // landed (#1251 review MAJOR).
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  const assertNothingCommitted = () => {
    expect(db.lease.disposition).toBeNull();
    expect(db.lease.dispositionObservedAt).toBeNull();
    expect(db.agentWork.state).toBe("IN_PROGRESS");
    expect(db.agentWorkUpdates).toHaveLength(0);
    expect(db.agentWorkHistory).toHaveLength(0);
    expect(db.lifecycleEvents).toHaveLength(0);
    expect(db.audit.filter((a) => a.action === "ownership_disposition")).toHaveLength(0);
  };

  it("surfaces a 500 and commits nothing when the AgentWork settlement fails right after the lease CAS", async () => {
    db.agentWork = makeAgentWork();
    mocks.failAt = "agentWork.update";

    const res = await post(baseBody({ operation: "disposition", disposition: "completed" }));

    expect(res.status).toBe(500);
    expect(db.txCount).toBe(1);
    // The CAS rolled back with the effect it implies: a retry is not
    // short-circuited into a replay of a disposition that never settled.
    assertNothingCommitted();
  });

  it("surfaces a 500 and commits nothing when the lifecycle write fails after the AgentWork settlement", async () => {
    db.agentWork = makeAgentWork();
    mocks.failAt = "lifecycle";

    const res = await post(baseBody({ operation: "disposition", disposition: "completed" }));

    expect(res.status).toBe(500);
    expect(db.txCount).toBe(1);
    // AgentWork + history had been written inside the transaction; the
    // missing lifecycle event rolls them back with the lease CAS.
    assertNothingCommitted();
  });

  it("converges on retry of the same disposition after either injected post-CAS failure", async () => {
    for (const point of ["agentWork.update", "lifecycle"] as const) {
      seedDb();
      db.agentWork = makeAgentWork();
      mocks.failAt = point;

      const failed = await post(baseBody({ operation: "disposition", disposition: "completed", note: "shipped" }));
      expect(failed.status).toBe(500);
      assertNothingCommitted();

      // Same disposition, retry: the guard is gone and nothing was committed,
      // so the full path re-runs and reports a real (non-replayed) success.
      const retry = await post(baseBody({ operation: "disposition", disposition: "completed", note: "shipped" }));
      expect(retry.status).toBe(200);
      const body = await retry.json();
      expect(body.ok).toBe(true);
      expect(body.replayed).toBe(false);
      expect(body.disposition).toBe("completed");

      expect(db.lease.disposition).toBe("completed");
      expect(db.agentWork.state).toBe("DONE");
      expect(db.agentWorkHistory).toHaveLength(1);
      expect(db.agentWorkHistory[0].action).toBe("ownership_dispositioned");
      expect(db.lifecycleEvents).toHaveLength(1);
      expect(db.lifecycleEvents[0].kind).toBe("ownership_dispositioned");
      expect(db.audit.filter((a) => a.action === "ownership_disposition")).toHaveLength(1);
    }
  });

  it("fences the retired claim token after the claim path reactivates a disposed lease (#1251/#1256)", async () => {
    const disposed = await post(baseBody({ operation: "disposition", disposition: "completed" }));
    expect(disposed.status).toBe(200);
    expect(db.lease.disposition).toBe("completed");

    // The claim path reuses the live row: it clears the terminal marker and
    // rotates the fencing token, so the row now describes a NEW attempt
    // (lease.ts). Registration evidence is reset with it.
    const reclaimed = await upsertLease({ agentName: AGENT, issueId: "iss1" });
    expect(reclaimed.created).toBe(false);
    const freshToken = db.lease.claimToken as string;
    expect(freshToken).toMatch(/^claim_/);
    expect(freshToken).not.toBe(CLAIM_TOKEN);
    expect(db.lease.disposition).toBeNull();
    expect(db.lease.registeredAt).toBeNull();

    // The retired incarnation's receipt is inert against the new attempt…
    const retired = await post(baseBody({ operation: "disposition", disposition: "completed" }));
    expect(retired.status).toBe(409);
    expect((await retired.json()).code).toBe("stale_claim_token");
    expect(db.lease.disposition).toBeNull();

    // …while the new one registers and disposes normally. Registration is not
    // a replay of the retired attempt's, because reactivation reset it.
    const registered = await post(baseBody({ operation: "register", claimToken: freshToken, runRef: "run-new" }));
    expect(registered.status).toBe(200);
    expect((await registered.json()).replayed).toBe(false);
    const settled = await post(baseBody({ operation: "disposition", disposition: "released", claimToken: freshToken }));
    expect(settled.status).toBe(200);
    expect((await settled.json()).disposition).toBe("released");
    expect(db.lease.disposition).toBe("released");
  });
});

describe("POST /api/agent-work/ownership — mutation guard", () => {
  it("returns 409 mutation_busy while another mutation holds the guard", async () => {
    mocks.guardBusy = true;
    const res = await post(baseBody({ operation: "register" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("mutation_busy");
    expect(db.leaseUpdates).toHaveLength(0);
    expect(db.lease.renewCount).toBe(0);
  });
});
