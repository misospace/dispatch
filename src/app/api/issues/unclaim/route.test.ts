import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, authedRequest } from "@/test/route-helpers";

// #1129: bind the worker credential to `worker` (the body agentName used by
// the worker-tier cases below) so the identity-scope gate accepts its
// own-agent unclaim.
const { WORKER_TOKEN } = vi.hoisted(() => ({ WORKER_TOKEN: "worker-token" }));

const { guardState, mocks } = vi.hoisted(() => ({
  // #1367: the guard fake's state — `stillHolds` decides whether the fenced
  // remote write runs, `busy` simulates another writer holding the anchor,
  // `foreignKey` simulates the anchor's guard row failing its issue foreign
  // key, `request` records the anchor request the route made, and `events`
  // records the order in which the anchor, the issue read, the fenced write
  // and the release happened.
  guardState: {
    stillHolds: true,
    busy: false,
    foreignKey: false,
    request: null as unknown,
    events: [] as string[],
    // #1367: the transaction client the fenced write hands to its callback —
    // what `fencedClaimClient` must reshape into the release's `prisma` arg.
    fencedTx: { issue: { id: "tx-issue" }, issueLifecycleEvent: undefined },
  },
  mocks: {
    findIssue: vi.fn().mockResolvedValue(null),
    createAuditLog: vi.fn().mockResolvedValue({ id: "log-1" }),
    releaseLease: vi.fn().mockResolvedValue(0),
    releaseWork: vi.fn().mockResolvedValue(0),
    releaseIssueClaim: vi.fn(),
    supersedeIntent: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      findUnique: mocks.findIssue,
    },
    auditLog: {
      create: mocks.createAuditLog,
    },
  },
}));

vi.mock("@/lib/lease", () => ({
  releaseLeaseByAgentAndIssue: mocks.releaseLease,
  releaseAgentWorkByAgentAndIssue: mocks.releaseWork,
}));

vi.mock("@/lib/ownership-reconciliation", () => ({
  supersedeOwnershipReleaseIntent: mocks.supersedeIntent,
}));

// #1367: the thin client is the load-bearing piece — the release's local
// writes must join the fenced transaction instead of opening a nested
// interactive transaction inside the region. The mock keeps the REAL
// `fencedClaimClient` (a pure reshape) and stubs only the release itself.
vi.mock("@/lib/issue-claim", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/issue-claim")>();
  return { ...actual, releaseIssueClaim: mocks.releaseIssueClaim };
});

// #1367: the unclaim path serializes on the per-issue mutation anchor; the
// fake grants the lock unless the test simulates a lost guard or a busy
// anchor.
vi.mock("@/lib/issue-mutation-guard", () => ({
  fencedWriteTimeoutMs: () => 60_000,
  withIssueMutationGuard: async (
    req: unknown,
    cb: (
      tx: unknown,
      context: {
        resuming: boolean;
        stillHoldsGuard: () => Promise<boolean>;
        runFencedRemoteWrite: <T>(fn: (tx: unknown) => Promise<T>) => Promise<{ status: string; value?: T }>;
      },
    ) => Promise<{ complete: boolean; value: unknown }>,
  ) => {
    guardState.request = req;
    if (guardState.foreignKey) {
      // The anchor's guard row references the issue: an unknown issueId fails
      // the foreign key before the callback ever runs.
      throw { code: "P2003", meta: { field_name: "IssueMutationGuard_issueId_fkey" } };
    }
    if (guardState.busy) {
      return { status: "busy", ownerToken: "owner-token", operation: "unclaim" };
    }
    guardState.events.push("anchor-entered");
    return {
      status: "completed",
      value: (await cb(undefined, {
        resuming: false,
        stillHoldsGuard: async () => guardState.stillHolds,
        // #1367: the fenced remote write is ATOMIC with the guard check — a
        // stolen guard means the forge function is NEVER called.
        runFencedRemoteWrite: async <T,>(fn: (tx: unknown) => Promise<T>) => {
          if (!guardState.stillHolds) return { status: "guard-lost" };
          guardState.events.push("fenced-entered");
          return { status: "written", value: await fn(guardState.fencedTx) };
        },
      })).value,
    };
  },
}));

process.env.DISPATCH_AGENT_TOKEN = mockToken;
process.env.DISPATCH_WORKER_TOKENS = `worker:${WORKER_TOKEN}`;

import { resetRateLimits } from "@/lib/rate-limit";
import { POST } from "./route";

// Reset process-global per-actor rate-limit windows and the guard fake's
// state per test (see the claim/unassign suites).
beforeEach(() => {
  guardState.stillHolds = true;
  guardState.busy = false;
  guardState.foreignKey = false;
  guardState.request = null;
  guardState.events = [];
  resetRateLimits();
});

function makePayload(overrides = {}) {
  return {
    issueId: "issue-1",
    repoFullName: "org/repo",
    issueNumber: 42,
    agentName: "worker" as const,
    ...overrides,
  };
}

function makeIssue(overrides = {}) {
  return {
    id: "issue-1",
    state: "open",
    number: 42,
    repository: { fullName: "org/repo" },
    labels: ["status/in-progress", "agent/worker"],
    ...overrides,
  };
}

function installReleaseLabels(labels: string[], extras = {}) {
  mocks.findIssue.mockImplementation(async () => {
    guardState.events.push("issue-read");
    return { ...makeIssue(), labels, ...extras };
  });
  mocks.releaseIssueClaim.mockImplementation(async (args: any) => {
    guardState.events.push("release-ran");
    return { released: true, labels: args.issue.labels.filter((l: string) => !l.startsWith("agent/")), status: args.issue.labels.find((l: string) => l.startsWith("status/")) ?? null, statusNote: null };
  });
}

function postRequest(payload = makePayload(), includeAuth = true) {
  return POST(authedRequest("http://localhost/api/issues/unclaim", { method: "POST", body: payload, includeAuth }));
}

describe("POST /api/issues/unclaim — auth", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 401 when no authorization header is provided", async () => {
    const res = await postRequest(makePayload(), false);
    expect(res.status).toBe(401);

    // No anchor engagement for an unauthorized caller.
    expect(guardState.request).toBeNull();
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(
      authedRequest("http://localhost/api/issues/unclaim", {
        method: "POST",
        body: makePayload(),
        headers: { Authorization: "Bearer wrong-token" },
      }),
    );
    expect(res.status).toBe(401);
    expect(guardState.request).toBeNull();
  });
});

describe("POST /api/issues/unclaim — validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when agentName is missing", async () => {
    const res = await postRequest(makePayload({ agentName: undefined as unknown as string }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required fields: issueId, repoFullName, issueNumber, agentName");
  });

  it("returns 400 when agentName is not a string", async () => {
    const res = await postRequest(makePayload({ agentName: 123 as unknown as string }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required fields: issueId, repoFullName, issueNumber, agentName");
  });

  it("returns 400 when issueId is missing", async () => {
    const res = await postRequest(makePayload({ issueId: undefined as unknown as string }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required fields: issueId, repoFullName, issueNumber, agentName");
  });

  it("returns 400 when repoFullName is missing", async () => {
    const res = await postRequest(makePayload({ repoFullName: undefined as unknown as string }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required fields: issueId, repoFullName, issueNumber, agentName");
  });

  it("returns 400 when issueNumber is missing", async () => {
    const res = await postRequest(makePayload({ issueNumber: undefined as unknown as number }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required fields: issueId, repoFullName, issueNumber, agentName");
  });

  it("returns 400 on malformed JSON", async () => {
    const res = await POST(
      authedRequest("http://localhost/api/issues/unclaim", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
        body: "not-json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on non-object JSON", async () => {
    const res = await POST(
      authedRequest("http://localhost/api/issues/unclaim", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
        body: JSON.stringify([1, 2, 3]),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/issues/unclaim — happy path (#1367)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installReleaseLabels(["status/in-progress", "agent/worker"]);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
    mocks.supersedeIntent.mockResolvedValue(false);
  });

  it("runs the entire mutation under the anchor and the release inside the fenced write", async () => {
    const res = await postRequest();
    expect(res.status).toBe(200);

    // The anchor was engaged for this issue, as an unclaim by this agent.
    expect(guardState.request).toEqual({ issueId: "issue-1", operation: "unclaim", agentName: "worker" });

    // The issue was read and the release ran INSIDE the anchor.
    expect(guardState.events).toEqual(["anchor-entered", "issue-read", "fenced-entered", "release-ran"]);

    // §8.7: the pending reconciler release intent was superseded first.
    expect(mocks.supersedeIntent).toHaveBeenCalledWith({
      issueId: "issue-1",
      actor: "worker",
      reason: "explicit unclaim by worker",
    });
  });

  it("hands the release a thin client with no $transaction so its local writes join the fenced transaction", async () => {
    const res = await postRequest();
    expect(res.status).toBe(200);

    expect(mocks.releaseIssueClaim).toHaveBeenCalledTimes(1);
    const args = mocks.releaseIssueClaim.mock.calls[0][0];
    expect(args.repoFullName).toBe("org/repo");
    expect(args.issueNumber).toBe(42);
    expect(args.agentName).toBe("worker");
    expect(args.options).toEqual({ actor: "worker" });
    // The thin client carries the fenced transaction's surfaces and NO
    // `$transaction` — the release's cache mirror and its `claim_released`
    // evidence row join the fenced transaction instead of nesting an
    // interactive transaction (a savepoint) with Prisma's 5s timeout inside
    // the region.
    expect("$transaction" in args.prisma).toBe(false);
    expect(args.prisma.issue).toBe((guardState as any).fencedTx.issue);
    expect(args.prisma.issueLifecycleEvent).toBeUndefined();
  });

  it("releases the lease, answers with the release result and keeps today's success audit", async () => {
    const res = await postRequest();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, labels: ["status/in-progress"], status: "status/in-progress", statusNote: null });
    expect(body.labels).not.toContain("agent/worker");

    expect(mocks.releaseLease).toHaveBeenCalledWith("worker", "issue-1");

    // Agent self-unclaim (bearer actor == agentName): no AgentWork release.
    expect(mocks.releaseWork).not.toHaveBeenCalled();

    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actor: "worker",
        action: "unclaim_issue",
        repoFullName: "org/repo",
        issueNumber: 42,
        issueId: "issue-1",
        beforeLabels: ["status/in-progress", "agent/worker"],
        afterLabels: ["status/in-progress"],
        notes: null,
        success: true,
      }),
    });
  });
});

describe("POST /api/issues/unclaim — #1367 mutation anchor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installReleaseLabels(["status/in-progress", "agent/worker"]);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  it("answers 404 when the anchor's guard row cannot reference the issue", async () => {
    // The anchor's guard row has a foreign key on the issue: an unknown
    // issueId fails the foreign key before the route's own lookup runs. The
    // route's documented answer for a missing issue is 404, not a 500.
    guardState.foreignKey = true;

    const res = await postRequest();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Issue not found in local cache");

    expect(mocks.findIssue).not.toHaveBeenCalled();
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(mocks.releaseLease).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("answers 409 without any write when another writer holds the anchor", async () => {
    guardState.busy = true;

    const res = await postRequest();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("Issue mutation is in progress; retry shortly");

    // The unclaim did not run at all — no writes whatsoever.
    expect(mocks.findIssue).not.toHaveBeenCalled();
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(mocks.releaseLease).not.toHaveBeenCalled();
    expect(mocks.releaseWork).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("does not release remotely and answers 409 when the guard was lost before the fenced write", async () => {
    guardState.stillHolds = false;

    const res = await postRequest();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe(
      "Unclaim was superseded by an operator override before the remote claim release; retry shortly",
    );

    // The forge function is NEVER called when the guard is gone.
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();

    // No lease or AgentWork release: no remote effect may be implied.
    expect(mocks.releaseLease).not.toHaveBeenCalled();
    expect(mocks.releaseWork).not.toHaveBeenCalled();

    // The guard loss is audited — the skipped unclaim must be visible.
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "unclaim_issue",
        repoFullName: "org/repo",
        issueNumber: 42,
        issueId: "issue-1",
        beforeLabels: ["status/in-progress", "agent/worker"],
        afterLabels: [],
        success: false,
        errorMessage: "Unclaim was superseded by an operator override before the remote claim release",
      }),
    });
    // ...and ONLY the failure audit.
    expect(mocks.createAuditLog).toHaveBeenCalledTimes(1);
  });

  it("returns the error's message with a failure audit when the release rejects under the guard", async () => {
    mocks.releaseIssueClaim.mockRejectedValue(new Error("github 500"));

    const res = await postRequest();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("github 500");

    // The failure audit names the release error...
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "unclaim_issue",
        repoFullName: "org/repo",
        issueNumber: 42,
        issueId: "issue-1",
        beforeLabels: ["status/in-progress", "agent/worker"],
        afterLabels: [],
        success: false,
        errorMessage: "github 500",
      }),
    });

    // ...and no lease release: the remote release did not succeed.
    expect(mocks.releaseLease).not.toHaveBeenCalled();

    // The release was attempted exactly once (inner catch keeps the path
    // linear; no retry inside the same request).
    expect(mocks.releaseIssueClaim).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for a closed issue without any release", async () => {
    installReleaseLabels(["agent/worker"], { state: "closed" });

    const res = await postRequest();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Cannot unclaim a closed issue");

    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(mocks.releaseLease).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 for a done issue without any release", async () => {
    installReleaseLabels(["status/done", "agent/worker"]);

    const res = await postRequest();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Cannot unclaim a done issue");

    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(mocks.releaseLease).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 for an issue assigned to another agent without any release", async () => {
    installReleaseLabels(["status/in-progress", "agent/other"]);

    const res = await postRequest();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Issue is not assigned to worker");

    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(mocks.releaseLease).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 with the exact message when the body repoFullName does not match the anchored issue", async () => {
    const res = await postRequest(makePayload({ repoFullName: "other/repo" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("issueId does not match repoFullName/issueNumber; expected org/repo#42");

    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(mocks.releaseLease).not.toHaveBeenCalled();
    expect(mocks.releaseWork).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 with the exact message when the body issueNumber does not match the anchored issue", async () => {
    const res = await postRequest(makePayload({ issueNumber: 99 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("issueId does not match repoFullName/issueNumber; expected org/repo#42");

    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(mocks.releaseLease).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });
});

describe("POST /api/issues/unclaim — worker tier (#1129)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installReleaseLabels(["status/in-progress", "agent/worker"]);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  function workerPost(payload = makePayload()) {
    return POST(
      authedRequest("http://localhost/api/issues/unclaim", {
        method: "POST",
        body: payload,
        token: WORKER_TOKEN,
      }),
    );
  }

  it("allows a bound worker to release its own claim without an x-agent-name header", async () => {
    const res = await workerPost();
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mocks.releaseLease).toHaveBeenCalledWith("worker", "issue-1");
  });

  it("returns 403 when a bound worker names another agent in the body", async () => {
    const res = await workerPost(makePayload({ agentName: "other-agent" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("may not act for");
    // The refusal happens before the anchor: no release attempts at all.
    expect(guardState.request).toBeNull();
    expect(mocks.releaseLease).not.toHaveBeenCalled();
  });

  it("returns 400 when the bound worker's own agent is not assigned to the issue", async () => {
    // The bound worker acts for its own agent (passes the identity-scope
    // gate), but the issue's labels carry no matching `agent/*` label.
    installReleaseLabels(["status/in-progress", "agent/other"]);

    const res = await workerPost();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Issue is not assigned to worker");

    // No fenced release, no lease/AgentWork release, no audit row.
    expect(mocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(mocks.releaseLease).not.toHaveBeenCalled();
    expect(mocks.releaseWork).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });
});

// The route-helpers harness can traverse the real auth module (no @/lib/auth
// mock), so basic-operator credentials are forged with env vars — the same
// pattern the pre-#1367 unclaim suite used.
describe("POST /api/issues/unclaim — operator path (basic auth)", () => {
  function basicPost() {
    const credentials = Buffer.from("alice:hunter2").toString("base64");
    return POST(
      authedRequest("http://localhost/api/issues/unclaim", {
        method: "POST",
        body: makePayload(),
        includeAuth: false,
        headers: { Authorization: `Basic ${credentials}` },
      }),
    );
  }

  async function withBasicAuth<T>(fn: () => Promise<T>): Promise<T> {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "alice";
    process.env.DISPATCH_AUTH_PASSWORD = "hunter2";
    const { resetAuthCaches } = await import("@/lib/auth");
    resetAuthCaches();
    try {
      return await fn();
    } finally {
      delete process.env.DISPATCH_AUTH_MODE;
      delete process.env.DISPATCH_AUTH_USERNAME;
      delete process.env.DISPATCH_AUTH_PASSWORD;
      resetAuthCaches();
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    installReleaseLabels(["status/in-progress", "agent/worker"]);
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  it("uses the operator audit action and releases AgentWork in addition to the lease", async () => {
    await withBasicAuth(async () => {
      const res = await basicPost();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.labels).not.toContain("agent/worker");

      expect(mocks.releaseIssueClaim).toHaveBeenCalledTimes(1);
      expect((mocks.releaseIssueClaim as any).mock.calls[0][0].options).toEqual({ actor: "alice" });

      expect(mocks.releaseLease).toHaveBeenCalledWith("worker", "issue-1");
      expect(mocks.releaseWork).toHaveBeenCalledWith("worker", "issue-1");

      expect(mocks.createAuditLog).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actor: "alice",
          action: "unclaim_issue_by_operator",
          repoFullName: "org/repo",
          issueNumber: 42,
          issueId: "issue-1",
          beforeLabels: ["status/in-progress", "agent/worker"],
          afterLabels: ["status/in-progress"],
          notes: "Released agent worker as alice",
          success: true,
        }),
      });
    });
  });

  it("audits a release failure under the anchor with the operator identity", async () => {
    mocks.releaseIssueClaim.mockRejectedValue(new Error("github 500"));

    await withBasicAuth(async () => {
      const res = await basicPost();
      expect(res.status).toBe(500);
      expect(mocks.createAuditLog).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actor: "alice",
          action: "unclaim_issue_by_operator",
          success: false,
          errorMessage: "github 500",
        }),
      });
      expect(mocks.releaseLease).not.toHaveBeenCalled();
      expect(mocks.releaseWork).not.toHaveBeenCalled();
    });
  });
});
