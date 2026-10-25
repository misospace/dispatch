import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock(mockToken, { "test-worker-token": "worker" }, { "bound-token": "alpha" }));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    issueFindMany: vi.fn(),
    prFixFindMany: vi.fn(),
    prFixCreate: vi.fn(),
    prFixHistoryCreate: vi.fn(),
    prFixFindUnique: vi.fn(),
    prFixFindUniqueByRepo: vi.fn(),
    prFixUpdateMany: vi.fn(),
    findLeasedIssueIds: vi.fn(),
    linkedRows: [] as any[],
    fetchPullRequestLabels: vi.fn().mockResolvedValue([]),
    fetchPullRequestHeadSha: vi.fn().mockResolvedValue(null),
    capacityHandoffFindMany: vi.fn().mockResolvedValue([]),
    capacityHandoffDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    // #1327 review: when set, the REBASE admission transaction fails
    // (the advisory lock cannot be taken). The route must then fail CLOSED.
    prFixTransactionError: null as Error | null,
    // Queue-client surfaces touched THROUGH the admission transaction.
    prFixTxSurfaces: [] as string[],
  },
}));

vi.mock("@/lib/prisma", () => {
  const prFixQueueItem = {
    findMany: mocks.prFixFindMany,
    findUnique: vi.fn(async ({ where }: any) => {
      const rows = [...mocks.linkedRows, ...((await mocks.prFixFindMany()) ?? [])];
      if (where?.id !== undefined) {
        const byId = await mocks.prFixFindUnique({ where });
        return byId ?? rows.find((row: any) => row.id === where.id) ?? null;
      }
      if (where?.repo_pr) return mocks.prFixFindUniqueByRepo({ where });
      if (where?.repo !== undefined && where?.pr !== undefined) {
        return rows.find((row: any) => row.repo === where.repo && row.pr === where.pr) ?? null;
      }
      return null;
    }),
    create: mocks.prFixCreate,
    updateMany: mocks.prFixUpdateMany,
  };
  // The admission transaction hands out its OWN queue-client surface, so a
  // route test can prove that the gate read, the dispatch stamp, and the
  // hand-out push happened INSIDE the admission transaction — the
  // serialization the concurrency-1 invariant depends on. The module client
  // and the transaction client share the same underlying mocks, so the
  // rows behave identically; only the recorded surface differs.
  const txPrFixQueueItem = {
    findMany: async (args: any) => {
      mocks.prFixTxSurfaces.push("findMany");
      return prFixQueueItem.findMany(args);
    },
    findUnique: async (args: any) => {
      mocks.prFixTxSurfaces.push("findUnique");
      return prFixQueueItem.findUnique(args);
    },
    create: async (args: any) => {
      mocks.prFixTxSurfaces.push("create");
      return prFixQueueItem.create(args);
    },
    updateMany: async (args: any) => {
      mocks.prFixTxSurfaces.push("updateMany");
      return prFixQueueItem.updateMany(args);
    },
  };
  return {
    prisma: {
      issue: { findMany: mocks.issueFindMany },
      prFixQueueItem,
      prFixHistory: { create: mocks.prFixHistoryCreate },
      capacityHandoff: {
        findMany: mocks.capacityHandoffFindMany,
        deleteMany: mocks.capacityHandoffDeleteMany,
      },
      // The #1327 REBASE admission transaction runs the concurrency gate,
      // the dispatch stamp, and the hand-out push on the TRANSACTION client;
      // it mirrors the top-level surface here. $executeRaw is a no-op
      // standing in for the advisory lock (its real serialization is proven
      // against PostgreSQL in pr-fix-rebase-type.integration.test.ts).
      $transaction: async (fn: any) => {
        // A failed admission (lock timeout, aborted transaction) must make
        // the route fail CLOSED, so the failure is injectable here.
        if (mocks.prFixTransactionError) throw mocks.prFixTransactionError;
        return fn({
          prFixQueueItem: txPrFixQueueItem,
          prFixHistory: { create: mocks.prFixHistoryCreate },
          $executeRaw: async () => 1,
        });
      },
    },
    asPrFixQueueClient: (client: any) => client,
  };
});

vi.mock("@/lib/github", () => ({
  fetchPullRequestLabels: mocks.fetchPullRequestLabels,
  fetchPullRequestHeadSha: mocks.fetchPullRequestHeadSha,
}));

vi.mock("@/lib/lease", () => ({
  findLeasedIssueIds: mocks.findLeasedIssueIds,
}));

// The production queue-mutation functions (enqueue/mark/requeue) surface
// outcomes to GitHub; no-op them so route-level lifecycle tests can drive the
// real state machine without network.
vi.mock("@/lib/pr-fix-surfacing", () => ({
  NEEDS_HUMAN_LABEL: "needs-human",
  surfacePrFixBlocked: vi.fn().mockResolvedValue({ labelApplied: false, commentPosted: false, errors: [] }),
  surfacePrFixRequeued: vi.fn().mockResolvedValue({ labelRemoved: false, commentUpdated: false, errors: [] }),
  surfacePrFixUnblocked: vi.fn().mockResolvedValue({ labelRemoved: false, commentUpdated: false, errors: [] }),
  extractUrlsFromText: vi.fn(() => []),
}));

import { GET } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { enqueuePrFixItem, markPrFixItem, requeuePrFixItem } from "@/lib/pr-fix-queue";

/**
 * Minimal in-memory PrFixQueueClient backing the production queue-mutation
 * functions: findUnique by (repo, pr), update by id (with Prisma `increment`
 * support), findMany by status/lane, and history append.
 */
function makeQueueStore() {
  const items: any[] = [];
  let seq = 0;
  const client: any = {
    items,
    $transaction: async (fn: any) => fn(client),
    prFixQueueItem: {
      findUnique: async ({ where }: any) =>
        items.find((i) =>
          where.id !== undefined
            ? i.id === where.id
            : i.repo === where.repo_pr.repo && i.pr === where.repo_pr.pr,
        ) ?? null,
      create: async ({ data }: any) => {
        const item = { id: `prfix-${++seq}`, generation: 1, queuedAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"), ...data };
        items.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const idx = items.findIndex((i) => i.id === where.id);
        const patch: Record<string, any> = { ...data };
        for (const key of Object.keys(patch)) {
          const value = patch[key];
          if (value && typeof value === "object" && typeof value.increment === "number") {
            patch[key] = (items[idx][key] ?? 0) + value.increment;
          }
        }
        items[idx] = { ...items[idx], ...patch, updatedAt: new Date("2026-01-02T00:00:00Z") };
        return items[idx];
      },
      updateMany: async ({ where, data }: any) => {
        const idx = items.findIndex((i) =>
          where.id !== undefined
            ? i.id === where.id && (where.generation === undefined || i.generation === where.generation)
            : i.repo === where.repo_pr.repo && i.pr === where.repo_pr.pr,
        );
        if (idx === -1) return { count: 0 };
        const patch: Record<string, any> = { ...data };
        for (const key of Object.keys(patch)) {
          const value = patch[key];
          if (value && typeof value === "object" && typeof value.increment === "number") {
            patch[key] = (items[idx][key] ?? 0) + value.increment;
          }
        }
        items[idx] = { ...items[idx], ...patch, updatedAt: new Date("2026-01-02T00:00:00Z") };
        return { count: 1 };
      },
      findMany: async ({ where }: any) => {
        let result = items.slice();
        if (where?.status) {
          result = Array.isArray(where.status.in)
            ? result.filter((i) => where.status.in.includes(i.status))
            : result.filter((i) => i.status === where.status);
        }
        if (where?.lane) result = result.filter((i) => i.lane === where.lane);
        return result;
      },
    },
    prFixHistory: {
      create: async ({ data }: any) => ({ ...data }),
    },
  };
  return client;
}

/**
 * Mirrors the route's first-hand-out-only stamp `where` against a stateful
 * fake row: match id + generation, and (dispatchedGeneration IS NULL OR
 * != the stamped generation). Lets updateMany genuinely no-op on re-hand-outs
 * of an already-stamped generation.
 */
/**
 * Evaluate the OR clause of a pr-fix queue updateMany against a fake row.
 * Two shapes exist: the dispatch stamp's first-hand-out arms
 * (`dispatchedGeneration`) and the hand-out append's issuance pin (#1327),
 * whose arms anchor the lane being issued (`type` / `attemptType`).
 */
function matchesOrConditions(row: any, or: any[]): boolean {
  return or.some((cond: any) => {
    if ("dispatchedGeneration" in cond) {
      if (cond.dispatchedGeneration === null) return row.dispatchedGeneration == null;
      return (
        row.dispatchedGeneration != null &&
        row.dispatchedGeneration !== cond.dispatchedGeneration.not
      );
    }
    // The issuance pin: the row still anchors the lane being issued — its
    // `type` matches, or the attempt stamp already names it (a re-hand-out
    // of a dispatched lane). Fixtures that do not model a lane (`type`
    // absent) cannot race a flip, so the pin is vacuously satisfied for them.
    if ("type" in cond) return row.type === undefined || row.type === cond.type;
    if ("attemptType" in cond) return row.attemptType === cond.attemptType;
    return false;
  });
}

function matchesFirstHandOut(row: any, where: any): boolean {
  if (row.id !== where.id || row.generation !== where.generation) return false;
  if (!where.OR) return true;
  return matchesOrConditions(row, where.OR);
}

/**
 * Apply a Prisma update patch to a fake row, resolving the array-mutation
 * shapes the route writes: `{ push: [...] }` for the per-agent hand-out
 * record (#1133) and `{ increment: n }` for counters. A plain value is
 * assigned as-is.
 */
function applyUpdate(row: any, data: any): void {
  const patch: Record<string, any> = { ...data };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === "object" && Array.isArray(value.push)) {
      patch[key] = [...(Array.isArray(row[key]) ? row[key] : []), ...value.push];
    } else if (value && typeof value === "object" && typeof value.increment === "number") {
      patch[key] = (row[key] ?? 0) + value.increment;
    }
  }
  Object.assign(row, patch);
}

/**
 * Mirrors the route's evidence-watermark stamp `where` against a stateful fake
 * row, so the stamp is genuinely applied or rejected: id + generation, an
 * unstamped row (`attemptEvidenceWatermark: null`), and a counter pin on the
 * delivered sequence. Both inequality forms are evaluated, so a predicate
 * rejected by an advanced counter (the pre-fix `lte`) misses while the `gte`
 * lower bound applies. The hand-out flow's other writes (the dispatch stamp,
 * the per-agent hand-out record) defer to `matchesFirstHandOut`.
 */
function matchesLiveRow(row: any, where: any): boolean {
  if (!("evidenceSequence" in where)) return matchesFirstHandOut(row, where);
  if (row.id !== where.id || row.generation !== where.generation) return false;
  if (where.attemptEvidenceWatermark === null && row.attemptEvidenceWatermark != null) return false;
  const bound = where.evidenceSequence ?? {};
  if (typeof bound.gte === "number" && !(row.evidenceSequence >= bound.gte)) return false;
  if (typeof bound.lte === "number" && !(row.evidenceSequence <= bound.lte)) return false;
  return true;
}

function request(url: string, agentName = "example-agent", includeAuth = true) {
  return authedRequest(`http://localhost${url}`, { includeAuth });
}

/** A plain issue with no linked PR: independent implement work. */
function independentIssue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `issue-${number}`,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/org/repo/issues/${number}`,
    labels: ["priority/p2", "status/ready"],
    currentLane: "local",
    decomposed: false,
    repository: { fullName: "org/repo" },
    linkedPrNumber: null,
    linkedPrUrl: null,
    linkedPrNeedsFollowup: false,
    linkedPrFollowupReasons: [],
    linkedPrReviewDecision: null,
    linkedPrMergeState: null,
    linkedPrHealthCheckedAt: null,
    ...overrides,
  };
}

function linkedIssue(number: number, pr: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `issue-${number}`,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/org/repo/issues/${number}`,
    labels: ["priority/p0", "status/ready"],
    currentLane: "local",
    decomposed: false,
    repository: { fullName: "org/repo" },
    linkedPrNumber: pr,
    linkedPrUrl: `https://github.com/org/repo/pull/${pr}`,
    linkedPrNeedsFollowup: true,
    linkedPrFollowupReasons: ["changes requested", "checks failing"],
    linkedPrReviewDecision: "CHANGES_REQUESTED",
    linkedPrMergeState: null,
    linkedPrHealthCheckedAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  };
}

describe("GET /api/agents/[agentName]/next-task", () => {
  it("rejects malformed or unsupported exclusions before reading queues", async () => {
    const before = mocks.issueFindMany.mock.calls.length;
    for (const url of [
      "/api/agents/example-agent/next-task?exclude_pr_fix=org/repo%231%401",
      "/api/agents/example-agent/next-task?exclude_pr_fix_version=2&exclude_pr_fix=org/repo%231%401",
      "/api/agents/example-agent/next-task?exclude_pr_fix_version=1&exclude_pr_fix=bad",
    ]) {
      const response = await GET(request(url), { params: Promise.resolve({ agentName: "example-agent" }) });
      expect(response.status).toBe(400);
    }
    expect(mocks.issueFindMany).toHaveBeenCalledTimes(before);
    expect(mocks.prFixFindMany).not.toHaveBeenCalled();
  });

  function exclusionUrl(entries = ["org/repo#12@2"]): string {
    const params = new URLSearchParams({ lane: "local", exclude_pr_fix_version: "1" });
    for (const entry of entries) params.append("exclude_pr_fix", entry);
    return `/api/agents/example-agent/next-task?${params}`;
  }

  function prFixRow(pr = 12, generation = 2) {
    return {
      id: `prfix-${pr}`, repo: "org/repo", pr, issue: null,
      url: `https://github.com/org/repo/pull/${pr}`, lane: "NORMAL", status: "QUEUED",
      reason: "checks failing", feedback: [], evidenceKeys: [], author: "bot",
      generation, agentHandouts: [],
    };
  }

  it("skips active A and returns PR-fix B without touching A", async () => {
    const a = { ...prFixRow(), agentHandouts: ["other-agent:2"] };
    const b = prFixRow(13);
    mocks.prFixFindMany.mockResolvedValue([a, b]);
    mocks.prFixFindUnique.mockImplementation(async ({ where }: any) => where.id === b.id ? b : a);
    const body = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(body.pullRequest.number).toBe(13);
    expect(body.prFixItem.id).toBe(b.id);
    expect(mocks.prFixUpdateMany.mock.calls.every(([args]) => args.where.id === b.id)).toBe(true);
  });

  it("marks the dispatched PR-fix identity with the item's fixType (#1327)", async () => {
    mocks.prFixFindMany.mockResolvedValue([{ ...prFixRow(13), type: "REBASE", reason: "Mechanical rebase: PR dirty against base (#1327)" }]);
    const body = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(body.type).toBe("followup-pr");
    expect(body.prFixItem.fixType).toBe("REBASE");
    expect(body.reasons[0]).toContain("Mechanical rebase");
  });

  describe("rebase worker pool eligibility (DISPATCH_REBASE_AGENTS, #1327)", () => {
    const rebaseRow = () => ({ ...prFixRow(31), type: "REBASE", reason: "Mechanical rebase: PR dirty against base (#1327)" });

    function rowMocks(row: any) {
      mocks.prFixFindMany.mockImplementation(async ({ where }: any = {}) =>
        where?.OR ? [row] : [row]);
      mocks.prFixFindUnique.mockImplementation(async ({ where }: any) =>
        (where.id === row.id ? { ...row } : null));
    }

    afterEach(() => {
      delete process.env.DISPATCH_REBASE_AGENTS;
    });

    it("defers REBASE for an agent outside the configured local pool", async () => {
      // #1327's rebase worker is the local-only pool; the operator declares
      // it server-side via DISPATCH_REBASE_AGENTS. An agent outside the pool
      // must not receive the hand-out — the candidate is deferred (transient,
      // retried by the next eligible poll), and the deferral happens BEFORE
      // the lane admission, so the advisory lock is never contended.
      process.env.DISPATCH_REBASE_AGENTS = "local-coder, other-local";
      const row = rebaseRow();
      rowMocks(row);

      const body = await (await GET(request(exclusionUrl()), {
        params: Promise.resolve({ agentName: "example-agent" }),
      })).json();
      expect(body.shouldRun).toBe(false);
      expect(body.prFixItem).toBeUndefined();
      // Deferred before admission: no hand-out stamp, no transaction surface.
      expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
      expect(mocks.prFixTxSurfaces).toEqual([]);
      expect(row.agentHandouts).toEqual([]);
    });

    it("hands REBASE to an agent inside the configured local pool", async () => {
      process.env.DISPATCH_REBASE_AGENTS = "local-coder, Example-Agent";
      const row = rebaseRow();
      rowMocks(row);

      const body = await (await GET(request(exclusionUrl()), {
        params: Promise.resolve({ agentName: "example-agent" }),
      })).json();
      expect(body.type).toBe("followup-pr");
      expect(body.prFixItem.fixType).toBe("REBASE");
      expect(body.prFixItem.id).toBe(row.id);
      // The config gate precedes, not replaces, the serialized admission:
      // the hand-out still runs inside the advisory-lock transaction.
      expect(mocks.prFixTxSurfaces).toContain("findMany");
      expect(mocks.prFixTxSurfaces).toContain("updateMany");
    });

    it("still dispatches ordinary fix work for an agent outside the pool", async () => {
      // The pool gates the REBASE lane only: the same ineligible poll must
      // keep serving ordinary fix work and issue work.
      process.env.DISPATCH_REBASE_AGENTS = "local-coder";
      const rebase = rebaseRow();
      const fix = prFixRow(32);
      mocks.prFixFindMany.mockImplementation(async ({ where }: any = {}) =>
        where?.OR ? [rebase] : [rebase, fix]);
      mocks.prFixFindUnique.mockImplementation(async ({ where }: any) =>
        where.id === fix.id ? { ...fix } : where.id === rebase.id ? { ...rebase } : null);

      const body = await (await GET(request(exclusionUrl()), {
        params: Promise.resolve({ agentName: "example-agent" }),
      })).json();
      expect(body.type).toBe("followup-pr");
      expect(body.pullRequest.number).toBe(32);
    });

    it("empty pool value is fail-closed: no agent receives REBASE", async () => {
      process.env.DISPATCH_REBASE_AGENTS = "   ";
      const row = rebaseRow();
      rowMocks(row);

      const body = await (await GET(request(exclusionUrl()), {
        params: Promise.resolve({ agentName: "example-agent" }),
      })).json();
      expect(body.shouldRun).toBe(false);
      expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
      expect(row.agentHandouts).toEqual([]);
    });

    it("unset pool is fail-closed: REBASE defers while ordinary fix work still dispatches", async () => {
      // #1327's fail-closed default: with no operator-declared pool, NO
      // agent is eligible — an unset allowlist must not hand the local-only
      // lane to every polling agent. The ineligible poll still serves
      // ordinary fix work, and the REBASE item stays QUEUED (no hand-out
      // stamp; the next eligible poll retries it).
      delete process.env.DISPATCH_REBASE_AGENTS;
      const rebase = rebaseRow();
      const fix = prFixRow(32);
      mocks.prFixFindMany.mockImplementation(async ({ where }: any = {}) =>
        where?.OR ? [rebase] : [rebase, fix]);
      mocks.prFixFindUnique.mockImplementation(async ({ where }: any) =>
        where.id === fix.id ? { ...fix } : where.id === rebase.id ? { ...rebase } : null);

      const body = await (await GET(request(exclusionUrl()), {
        params: Promise.resolve({ agentName: "example-agent" }),
      })).json();
      expect(body.type).toBe("followup-pr");
      expect(body.pullRequest.number).toBe(32);
      // Only the ordinary fix row was stamped: the REBASE item keeps its
      // QUEUED state for the next eligible poll.
      expect(mocks.prFixUpdateMany).toHaveBeenCalled();
      expect(mocks.prFixUpdateMany.mock.calls.every(([args]) => args.where.id === fix.id)).toBe(true);
      expect(rebase.agentHandouts).toEqual([]);
    });

    it("a bare * value is the explicit unrestricted opt-in", async () => {
      // Debugging/backcompat hatch: `*` reopens the lane to every poller —
      // including an agent no named pool would admit — but only as the
      // entire value, and never by default.
      process.env.DISPATCH_REBASE_AGENTS = "*";
      const row = rebaseRow();
      rowMocks(row);

      const body = await (await GET(request(exclusionUrl()), {
        params: Promise.resolve({ agentName: "some-cloud-agent" }),
      })).json();
      expect(body.type).toBe("followup-pr");
      expect(body.prFixItem.fixType).toBe("REBASE");
      // The hand-out still runs inside the serialized admission transaction.
      expect(mocks.prFixTxSurfaces).toContain("updateMany");
    });

    it("a failed append leaves no lane stamp: the flipped row re-enters the REBASE gates (#1327)", async () => {
      // Regression: the dispatch stamp used to write `attemptType` BEFORE the
      // hand-out append, so a failed append left a stale same-generation lane
      // stamp. A row that then flipped to REBASE was trusted as its stale
      // lane, and the next poll bypassed the worker-pool and serialized
      // admission gates. The lane stamp now rides the append — atomic with
      // issuance, pinned to the row's type — so after a failed append the row
      // is laneless: the next poll re-derives REBASE from the row and
      // enforces the REBASE gates.
      const row: any = { ...prFixRow(33), type: "CI_FAILURE" };
      mocks.prFixFindMany.mockImplementation(async ({ where }: any = {}) =>
        where?.OR
          // The rebase concurrency gate read: only rows anchored to REBASE.
          ? [row].filter((r: any) => (r.attemptType ?? r.type) === "REBASE")
          : [row]);
      mocks.prFixFindUnique.mockImplementation(async ({ where }: any) =>
        (where.id === row.id ? { ...row } : null));

      // Poll 1 — ordinary lane: the dispatch stamp lands, the hand-out
      // append FAILS.
      let stampArgs: any;
      let appendArgs: any;
      mocks.prFixUpdateMany
        .mockImplementationOnce(async (args: any) => { stampArgs = args; return { count: 1 }; })
        .mockImplementationOnce(async (args: any) => { appendArgs = args; throw new Error("hand-out append failed"); });
      const first = await (await GET(request(exclusionUrl()), {
        params: Promise.resolve({ agentName: "example-agent" }),
      })).json();
      expect(first.prFixItem).toBeUndefined();
      // The stamp ran WITHOUT the lane: attemptType cannot become
      // authoritative before a hand-out exists.
      expect(stampArgs.data.attemptType).toBeUndefined();
      expect(stampArgs.data.dispatchedGeneration).toBe(row.generation);
      // The append carried the lane and the type pin, and failed.
      expect(appendArgs.data.attemptType).toBe("CI_FAILURE");
      expect(appendArgs.where.OR).toEqual([{ type: "CI_FAILURE" }, { attemptType: "CI_FAILURE" }]);

      // A concurrent same-generation re-observation flips the row to REBASE.
      row.type = "REBASE";

      // Poll 2a — an agent outside the pool is deferred BEFORE the admission
      // transaction: no gate read, no writes.
      process.env.DISPATCH_REBASE_AGENTS = "local-coder";
      mocks.prFixUpdateMany.mockClear();
      const deferred = await (await GET(request(exclusionUrl()), {
        params: Promise.resolve({ agentName: "example-agent" }),
      })).json();
      expect(deferred.prFixItem).toBeUndefined();
      expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
      expect(mocks.prFixTxSurfaces).toEqual([]);

      // Poll 2b — a pool-eligible poll re-derives the lane from the flipped
      // row and enforces the serialized admission: the gate read and the
      // hand-out write (carrying the lane stamp) run inside the advisory-lock
      // transaction, shipping REBASE.
      process.env.DISPATCH_REBASE_AGENTS = "example-agent";
      const surfacesBefore = mocks.prFixTxSurfaces.length;
      const second = await (await GET(request(exclusionUrl()), {
        params: Promise.resolve({ agentName: "example-agent" }),
      })).json();
      expect(second.type).toBe("followup-pr");
      expect(second.prFixItem.fixType).toBe("REBASE");
      const surfaces = mocks.prFixTxSurfaces.slice(surfacesBefore);
      expect(surfaces).toContain("findMany");
      expect(surfaces).toContain("updateMany");
      // The lane stamp rode the issuance, pinned to the flipped row's type.
      const issued: any = mocks.prFixUpdateMany.mock.calls
        .map(([args]: any) => args)
        .find((args: any) => Array.isArray(args.data?.agentHandouts?.push));
      expect(issued.data.attemptType).toBe("REBASE");
      expect(issued.where.OR).toEqual([{ type: "REBASE" }, { attemptType: "REBASE" }]);
    });
  });

  it("defers REBASE hand-outs while any rebase hand-out is live (concurrency 1, #1327)", async () => {
    // `live` is a REBASE already handed out (live hand-out record, still
    // QUEUED); `waiting` is the next DIRTY PR. Neither may be handed out:
    // `waiting` because the lane is busy, `live` because a second hand-out
    // would put two force-with-lease pushes on one branch.
    const live = { ...prFixRow(21, 2), type: "REBASE", agentHandouts: ["other-agent@2"], dispatchedAt: new Date() };
    const waiting = { ...prFixRow(22), type: "REBASE" };
    mocks.prFixFindMany.mockImplementation(async ({ where }: any = {}) =>
      where?.OR
        ? [live, waiting].filter((r: any) => r.type === "REBASE" || r.attemptType === "REBASE")
        : [live, waiting].filter((r) => r.status === "QUEUED"));
    mocks.prFixFindUnique.mockImplementation(async ({ where }: any) =>
      (where.id === waiting.id ? waiting : live));
    const body = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(body.shouldRun).toBe(false);
    // Deferred, not dispatched: no hand-out stamp on either item.
    expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
    expect(live.agentHandouts).toEqual(["other-agent@2"]);
    expect(waiting.agentHandouts).toEqual([]);
  });

  it("an acknowledged REBASE hand-out gates the lane however stale it is (#1327, #1211)", async () => {
    // #1211: an acknowledged hand-out is never reclaimed — the worker
    // durably owns its generation — so it gates the lane until it settles.
    // The old gate freed the lane once `dispatchedAt` passed the hand-out
    // timeout, letting a second hand-out (a second `--force-with-lease`
    // push on one branch) issue under a still-live first attempt.
    const live = {
      ...prFixRow(21, 2), type: "REBASE",
      agentHandouts: ["other-agent@2"], handoutAcks: ["other-agent@2"],
      dispatchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    };
    const waiting = { ...prFixRow(22), type: "REBASE" };
    mocks.prFixFindMany.mockImplementation(async ({ where }: any = {}) =>
      where?.OR
        ? [live, waiting].filter((r: any) => r.type === "REBASE" || r.attemptType === "REBASE")
        : [live, waiting].filter((r) => r.status === "QUEUED"));
    mocks.prFixFindUnique.mockImplementation(async ({ where }: any) =>
      (where.id === waiting.id ? waiting : live));

    const body = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(body.shouldRun).toBe(false);
    expect(body.prFixItem).toBeUndefined();
    // No second hand-out was stamped while the acknowledged attempt is live.
    expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
    expect(live.agentHandouts).toEqual(["other-agent@2"]);
  });

  it("a stale unacknowledged REBASE frees the lane only once the reclaim sweep clears it (#1327, #1211)", async () => {
    // The hand-out timeout bounds the reclaim sweep's staleness population,
    // not the gate: a stale unacknowledged hand-out keeps gating PAST the
    // timeout, and the lane re-opens only through the sweep's committed
    // reclaim — the generation bump that clears the hand-out state
    // (exercised for real against the lib in pr-fix-queue.test.ts).
    const stale: any = {
      ...prFixRow(23), type: "REBASE",
      agentHandouts: ["other-agent@2"],
      dispatchedGeneration: 2,
      dispatchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    };
    mocks.prFixFindMany.mockImplementation(async ({ where }: any = {}) =>
      where?.OR
        ? [stale].filter((r: any) => r.type === "REBASE" || r.attemptType === "REBASE")
        : [stale].filter((r) => r.status === "QUEUED"));
    mocks.prFixFindUnique.mockImplementation(async ({ where }: any) =>
      (where.id === stale.id ? { ...stale } : null));

    const blocked = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(blocked.prFixItem).toBeUndefined();
    // Still gated past the timeout: no hand-out was stamped.
    expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();

    // The reclaim sweep's committed effect: generation bump + cleared
    // hand-out state (agentHandouts/acks/receipts, dispatched stamps,
    // attemptType).
    stale.generation += 1;
    stale.agentHandouts = [];
    stale.dispatchedGeneration = null;
    stale.dispatchedAt = null;
    stale.attemptType = null;

    const surfacesBefore = mocks.prFixTxSurfaces.length;
    const body = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(body.type).toBe("followup-pr");
    expect(body.prFixItem.fixType).toBe("REBASE");
    // The re-issued hand-out ran inside the serialized admission transaction.
    const surfaces = mocks.prFixTxSurfaces.slice(surfacesBefore);
    expect(surfaces).toContain("findMany");
    expect(surfaces).toContain("updateMany");
  });

  it("defers a REBASE hand-out when the admission transaction fails (fail closed, #1327 review)", async () => {
    // The advisory lock could not be taken (lock_timeout, aborted
    // transaction). The lane is concurrency 1, so the hand-out must be
    // DEFERRED: the removed fallback ran an unlocked check-then-write, which
    // let two concurrent polls both see an idle lane and both issue a REBASE
    // task. Deferral costs one poll; the fan-out costs two
    // `--force-with-lease` pushes on one branch.
    const row = { ...prFixRow(24), type: "REBASE", reason: "Mechanical rebase: PR dirty against base (#1327)" };
    mocks.prFixFindMany.mockImplementation(async ({ where }: any = {}) =>
      where?.OR ? [row] : [row]);
    mocks.prFixFindUnique.mockImplementation(async ({ where }: any) =>
      (where.id === row.id ? { ...row } : null));
    mocks.prFixTransactionError = new Error("canceling statement due to lock timeout");

    const body = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(body.shouldRun).toBe(false);
    // Deferred, not dispatched: no hand-out stamp on the item.
    expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
  });

  it("defers a REBASE hand-out when the gate read fails inside the admission (fail closed, #1327 review)", async () => {
    // One level deeper than the transaction-failure case: the transaction
    // runs and the advisory lock is taken, but the gate read itself throws
    // inside the serialized window. The failure must propagate to the same
    // fail-closed deferral — never a dispatch without the gate (the removed
    // fallback's behavior) and no hand-out write of any kind.
    const row = { ...prFixRow(24), type: "REBASE", reason: "Mechanical rebase: PR dirty against base (#1327)" };
    mocks.prFixFindMany.mockImplementation(async ({ where }: any = {}) => {
      if (where?.OR) throw new Error("gate read unavailable");
      return [row];
    });
    mocks.prFixFindUnique.mockImplementation(async ({ where }: any) =>
      (where.id === row.id ? { ...row } : null));

    const response = await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    });
    // The poll stays healthy (no 500); the candidate is deferred.
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.shouldRun).toBe(false);
    expect(body.prFixItem).toBeUndefined();
    expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
    expect(row.agentHandouts).toEqual([]);
  });

  it("still dispatches ordinary fix work when the rebase admission fails (#1327 review)", async () => {
    // The fail-closed deferral is REBASE-only: ordinary fix work never takes
    // the lane lock, so a failing REBASE admission must not strand it.
    const rebase = { ...prFixRow(25), type: "REBASE" };
    const fix = { ...prFixRow(26) };
    mocks.prFixFindMany.mockImplementation(async ({ where }: any = {}) =>
      where?.OR ? [rebase] : [rebase, fix]);
    mocks.prFixFindUnique.mockImplementation(async ({ where }: any) =>
      where.id === fix.id ? { ...fix } : where.id === rebase.id ? { ...rebase } : null);
    mocks.prFixTransactionError = new Error("canceling statement due to lock timeout");

    const body = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(body.type).toBe("followup-pr");
    expect(body.pullRequest.number).toBe(26);
  });

  it("writes a REBASE hand-out inside the admission transaction (#1327 review)", async () => {
    // The concurrency-1 gate only holds if the gate read AND the hand-out
    // write commit together, inside the advisory-locked transaction. If the
    // hand-out escaped to the module client it would be an unlocked write
    // next to a locked read — the check-then-write the lane forbids.
    const row = { ...prFixRow(27), type: "REBASE", reason: "Mechanical rebase: PR dirty against base (#1327)" };
    mocks.prFixFindMany.mockImplementation(async ({ where }: any = {}) =>
      where?.OR ? [row] : [row]);
    mocks.prFixFindUnique.mockImplementation(async ({ where }: any) =>
      (where.id === row.id ? { ...row } : null));

    const body = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(body.type).toBe("followup-pr");
    // The dispatch stamp and the hand-out push both ran on the transaction
    // client.
    expect(mocks.prFixTxSurfaces.filter((s) => s === "updateMany").length).toBeGreaterThanOrEqual(2);
    expect(mocks.prFixTxSurfaces).toContain("findMany");
    expect(mocks.prFixTxSurfaces).toContain("findUnique");
  });

  it("keeps ordinary fix hand-outs off the admission transaction (#1327 review)", async () => {
    // Mirror of the case above: ordinary fix work never takes the lane lock,
    // so it must not run inside the rebase admission transaction.
    const fix = { ...prFixRow(28) };
    mocks.prFixFindMany.mockImplementation(async ({ where }: any = {}) =>
      where?.OR ? [] : [fix]);
    mocks.prFixFindUnique.mockImplementation(async ({ where }: any) =>
      (where.id === fix.id ? { ...fix } : null));

    const body = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(body.type).toBe("followup-pr");
    expect(mocks.prFixTxSurfaces).toEqual([]);
  });

  it("retries a deferred REBASE hand-out on the next poll (#1327 review)", async () => {
    // Fail-closed defers, it does not strand: a transient admission failure
    // must leave the item QUEUED and the next poll must hand it out.
    const row = { ...prFixRow(29), type: "REBASE", reason: "Mechanical rebase: PR dirty against base (#1327)" };
    mocks.prFixFindMany.mockImplementation(async ({ where }: any = {}) =>
      where?.OR ? [row] : [row]);
    mocks.prFixFindUnique.mockImplementation(async ({ where }: any) =>
      (where.id === row.id ? { ...row } : null));
    mocks.prFixTransactionError = new Error("canceling statement due to lock timeout");

    const deferred = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(deferred.shouldRun).toBe(false);

    // The lane recovers on the next poll: the lock is free again.
    mocks.prFixTransactionError = null;
    const retried = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(retried.type).toBe("followup-pr");
    expect(retried.prFixItem.fixType).toBe("REBASE");
  });

  it("dispatches ordinary fix work while a rebase hand-out is live (#1327)", async () => {
    // The concurrency-1 gate is REBASE-only: OTHER fix work is unaffected.
    const live = { ...prFixRow(21, 2), type: "REBASE", agentHandouts: ["other-agent@2"], dispatchedAt: new Date() };
    const fix = prFixRow(23);
    mocks.prFixFindMany.mockImplementation(async ({ where }: any = {}) =>
      where?.OR
        ? [live].filter((r: any) => r.type === "REBASE" || r.attemptType === "REBASE")
        : [live, fix].filter((r) => r.status === "QUEUED"));
    mocks.prFixFindUnique.mockImplementation(async ({ where }: any) =>
      (where.id === fix.id ? fix : live));
    const body = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(body.type).toBe("followup-pr");
    expect(body.pullRequest.number).toBe(23);
  });

  it("gates a REBASE-dispatched row whose type flipped to OTHER while its hand-out is live (#1327 review)", async () => {
    // Self-live case on the DISPATCHED lane: the row was handed out as
    // REBASE and a re-observation flipped the mutable `type` to OTHER. A
    // second hand-out would still put two `--force-with-lease` pushes on
    // one branch, so the concurrency gate must defer it.
    const row = { ...prFixRow(33), type: "OTHER", attemptType: "REBASE", agentHandouts: ["other-agent@1"], dispatchedAt: new Date() };
    mocks.prFixFindMany.mockImplementation(async ({ where }: any = {}) =>
      where?.OR
        ? [row].filter((r: any) => (r.attemptType ?? r.type) === "REBASE")
        : [row].filter((r: any) => r.status === "QUEUED"));
    mocks.prFixFindUnique.mockImplementation(async ({ where }: any) =>
      (where.id === row.id ? { ...row } : null));
    const body = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(body.shouldRun).toBe(false);
    expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
  });

  it("ships the persisted dispatched lane when the row type flipped to REBASE mid-attempt (#1327 review)", async () => {
    // The row was DISPATCHED as an ordinary fix (attemptType stamped at the
    // first hand-out); a re-observation flipped the mutable `type` to REBASE.
    // The task must carry the lane the server will settle against
    // (`attemptType ?? type`), not the mutable row type.
    const row = { ...prFixRow(31), type: "REBASE", attemptType: "CI_FAILURE" };
    mocks.prFixFindMany.mockImplementation(async ({ where }: any = {}) =>
      where?.OR
        // The concurrency gate keys on the dispatched lane: this row is not
        // a live REBASE, so it must not gate itself.
        ? [row].filter((r: any) => (r.attemptType ?? r.type) === "REBASE" && (r.agentHandouts ?? []).length > 0)
        : [row].filter((r: any) => r.status === "QUEUED"));
    mocks.prFixFindUnique.mockImplementation(async ({ where }: any) =>
      (where.id === row.id ? { ...row } : null));
    const body = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(body.type).toBe("followup-pr");
    expect(body.prFixItem.fixType).toBe("CI_FAILURE");
  });

  it("ships the persisted REBASE dispatched lane after a mid-attempt flip away from REBASE (#1327 review)", async () => {
    // Mirror direction: dispatched as REBASE, the row's mutable `type` has
    // since flipped to OTHER. The worker must still see REBASE — settlement
    // will bound this attempt on the rebase lane (terminal PARKED on
    // failure), and a payload claiming OTHER would promise the generic
    // retry ladder the rebase lane deliberately does not get.
    const row = { ...prFixRow(32), type: "OTHER", attemptType: "REBASE" };
    mocks.prFixFindMany.mockImplementation(async ({ where }: any = {}) =>
      where?.OR
        ? [row].filter((r: any) => (r.attemptType ?? r.type) === "REBASE" && (r.agentHandouts ?? []).length > 0)
        : [row].filter((r: any) => r.status === "QUEUED"));
    mocks.prFixFindUnique.mockImplementation(async ({ where }: any) =>
      (where.id === row.id ? { ...row } : null));
    const body = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(body.type).toBe("followup-pr");
    expect(body.prFixItem.fixType).toBe("REBASE");
  });

  it("skips linked generation 1 before materialization or GitHub reads", async () => {
    mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 12), independentIssue(99)]);
    const body = await (await GET(request(exclusionUrl(["org/repo#12@1"])), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(body.prFixExclusions.skipped[0].phase).toBe("linked");
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
    expect(mocks.prFixHistoryCreate).not.toHaveBeenCalled();
    expect(mocks.fetchPullRequestLabels).not.toHaveBeenCalled();
    expect(mocks.fetchPullRequestHeadSha).not.toHaveBeenCalled();
    expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
  });

  it.each(["BLOCKED", "FIXED", "QUEUED"])("preserves retained %s ownership and skips to independent work", async (status) => {
    const row = { ...prFixRow(), issue: 42, status };
    mocks.linkedRows = [row];
    mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 12), independentIssue(99)]);
    const body = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(body.prFixExclusions.skipped[0].phase).toBe(status);
    expect(row.status).toBe(status);
    expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
  });

  it("distinguishes exclusion idle from genuinely empty work", async () => {
    mocks.prFixFindMany.mockResolvedValue([prFixRow()]);
    const body = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(body.shouldRun).toBe(false);
    expect(body.reason).toContain("client exclusion");
    expect(body.prFixExclusions.skipped).toHaveLength(1);
    expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
  });

  it("does not stamp an excluded generation discovered during confirmation", async () => {
    const row = prFixRow(12, 1);
    mocks.prFixFindMany.mockResolvedValue([row]);
    mocks.prFixFindUnique.mockResolvedValue({ ...row, generation: 2 });
    const body = await (await GET(request(exclusionUrl()), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(body.shouldRun).toBe(false);
    expect(mocks.prFixUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.prFixUpdateMany.mock.calls[0][0].where.generation).toBe(1);
    expect(body.prFixExclusions.skipped[0].generation).toBe(2);
  });

  it("fences concurrent polls for the same agent and generation", async () => {
    const row = prFixRow();
    mocks.prFixFindMany.mockResolvedValue([row]);
    mocks.prFixFindUnique.mockResolvedValue(row);
    let claimed = false;
    mocks.prFixUpdateMany.mockImplementation(async ({ where }: any) => {
      if (!where.NOT) return { count: 1 };
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    });
    const poll = () => GET(request(exclusionUrl([])), {
      params: Promise.resolve({ agentName: "example-agent" }),
    }).then((response) => response.json());
    const bodies = await Promise.all([poll(), poll()]);
    expect(bodies.filter((body) => body.type === "followup-pr")).toHaveLength(1);
    expect(bodies.filter((body) => body.type === "idle")).toHaveLength(1);
  });

  it("keeps auth and lane validation with exclusions", async () => {
    const unauthorized = await GET(request(exclusionUrl(), "example-agent", false), {
      params: Promise.resolve({ agentName: "example-agent" }),
    });
    expect(unauthorized.status).toBe(401);
    const wrongAgent = await GET(authedRequest(`http://localhost${exclusionUrl()}`, { token: "bound-token" }), {
      params: Promise.resolve({ agentName: "example-agent" }),
    });
    expect(wrongAgent.status).toBe(403);
    expect(mocks.issueFindMany).not.toHaveBeenCalled();
    const invalidLane = await GET(request(exclusionUrl().replace("lane=local", "lane=not-configured")), {
      params: Promise.resolve({ agentName: "example-agent" }),
    });
    expect(invalidLane.status).toBe(400);
    expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
  });

  it("preserves old-client response shape", async () => {
    const body = await (await GET(request("/api/agents/example-agent/next-task"), {
      params: Promise.resolve({ agentName: "example-agent" }),
    })).json();
    expect(body.prFixExclusions).toBeUndefined();
  });

  it("rejects bounded-contract violations before reads or writes", async () => {
    const urls = [
      exclusionUrl(Array.from({ length: 33 }, (_, i) => `org/repo#${i + 1}@1`)),
      exclusionUrl(["a".repeat(301)]),
      exclusionUrl(["org/repo#9007199254740992@1"]),
      exclusionUrl(["org/re po#12@2"]),
      exclusionUrl() + "&exclude_pr_fix_version=1",
    ];
    for (const url of urls) {
      const response = await GET(request(url), { params: Promise.resolve({ agentName: "example-agent" }) });
      expect(response.status).toBe(400);
    }
    expect(mocks.issueFindMany).not.toHaveBeenCalled();
    expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
  });

  it("skips only the exactly excluded PR-fix generation and reports it", async () => {
    const excludedItem = {
      id: "prfix-1", repo: "Org/Repo", pr: 12, issue: null, branch: "fix/x",
      url: "https://github.com/Org/Repo/pull/12", title: "Excluded fix", lane: "NORMAL",
      status: "QUEUED", reason: "review requested changes", feedback: [],
      evidenceKeys: [], author: "bot", generation: 2,
    };
    mocks.prFixFindMany.mockResolvedValue([excludedItem]);
    mocks.issueFindMany.mockResolvedValue([independentIssue(99)]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local&exclude_pr_fix_version=1&exclude_pr_fix=org%2Frepo%2312%402"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(body.prFixExclusions).toEqual({
      version: 1,
      skipped: [{ repoFullName: "org/repo", pullRequestNumber: 12, generation: 2, phase: "QUEUED", reason: "client-excluded" }],
    });
    expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
  });

  it("does not exclude a different generation of the same PR", async () => {
    mocks.prFixFindMany.mockResolvedValue([{
      id: "prfix-1", repo: "org/repo", pr: 12, issue: null, branch: "fix/x",
      url: "https://github.com/org/repo/pull/12", title: "Fix", lane: "NORMAL",
      status: "QUEUED", reason: "review requested changes", feedback: [],
      evidenceKeys: [], author: "bot", generation: 3,
    }]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local&exclude_pr_fix_version=1&exclude_pr_fix=org%2Frepo%2312%402"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.prFixItem).toMatchObject({ id: "prfix-1", generation: 3 });
    expect(body.prFixExclusions).toEqual({ version: 1, skipped: [] });
  });

  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    // The REBASE lane mechanic tests dispatch to `example-agent`; the
    // operator pool itself is pinned per-test in the rebase-worker-pool
    // describe. Unset/empty admits nobody, so the mechanic tests declare a
    // pool containing their agent and afterEach clears it again.
    process.env.DISPATCH_REBASE_AGENTS = "example-agent";
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.prFixFindMany.mockResolvedValue([]);
    mocks.linkedRows = [];
    mocks.prFixTransactionError = null;
    mocks.prFixTxSurfaces = [];
    mocks.prFixFindUniqueByRepo.mockImplementation(async ({ where }: any) => {
      const rows = [...mocks.linkedRows, ...(await mocks.prFixFindMany())];
      return rows.find((row: any) => row.repo === where.repo_pr.repo && row.pr === where.repo_pr.pr) ?? null;
    });
    mocks.fetchPullRequestLabels.mockResolvedValue([]);
    mocks.fetchPullRequestHeadSha.mockResolvedValue(null);
    mocks.prFixCreate.mockImplementation(async ({ data }: any) => {
      const item = { id: "linked-prfix", generation: 1, status: "QUEUED", agentHandouts: [], ...data };
      mocks.linkedRows.push(item);
      return item;
    });
    mocks.prFixHistoryCreate.mockResolvedValue({});
    // Default re-read mirrors production: the row read back after the stamp
    // is the same live row listQueuedPrFixItems served. Stateful tests
    // override this with their own implementation.
    mocks.prFixFindUnique.mockImplementation(async () => {
      const items = await mocks.prFixFindMany();
      const first = items[0];
      return first
        ? { reason: first.reason, feedback: first.feedback, generation: first.generation, status: first.status, lane: first.lane, agentHandouts: first.agentHandouts, attemptType: first.attemptType, type: first.type }
        : null;
    });
    mocks.prFixUpdateMany.mockResolvedValue({ count: 1 });
    mocks.issueFindMany.mockResolvedValue([]);
    mocks.findLeasedIssueIds.mockResolvedValue([]);
  });

  afterEach(() => {
    delete process.env.DISPATCH_REBASE_AGENTS;
  });

  it("returns idle when the queue is empty", async () => {
    const res = await GET(
      request("/api/agents/example-agent/next-task"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("idle");
    expect(body.shouldRun).toBe(false);
    expect(body.reason).toBe("No work available");
  });

  it("returns idle when queue is empty (not an array)", async () => {
    const res = await GET(
      request("/api/agents/example-agent/next-task"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(Array.isArray(body)).toBe(false);
  });

  it("returns one implement task for a normal issue", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 42,
        title: "Fix login bug",
        url: "https://github.com/org/repo/issues/42",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.shouldRun).toBe(true);
    expect(body.agentName).toBe("example-agent");
    expect(body.issue.number).toBe(42);
    expect(body.issue.title).toBe("Fix login bug");
    expect(body.issue.repoFullName).toBe("org/repo");
    expect(body.issue.url).toBe("https://github.com/org/repo/issues/42");
  });

  it("returns exactly one task, not an array", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 42,
        title: "First issue",
        url: "https://github.com/org/repo/issues/42",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
      {
        id: "issue-2",
        number: 43,
        title: "Second issue",
        url: "https://github.com/org/repo/issues/43",
        labels: ["priority/p1", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(Array.isArray(body)).toBe(false);
    expect(body.type).toBe("implement");
  });

  it("returns followup-pr task when a PR-fix item is ahead of issue work", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 12,
        issue: 67,
        branch: "fix/issue-67",
        url: "https://github.com/org/repo/pull/12",
        title: "Fix issue 67",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "review changes requested",
        feedback: ["please update tests"],
        evidenceKeys: ["review:1"],
        author: "itsmiso-ai",
        generation: 1,
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 99,
        title: "Regular issue",
        url: "https://github.com/org/repo/issues/99",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.shouldRun).toBe(true);
    expect(body.agentName).toBe("example-agent");
    expect(body.pullRequest.repoFullName).toBe("org/repo");
    expect(body.pullRequest.number).toBe(12);
    expect(body.pullRequest.url).toBe("https://github.com/org/repo/pull/12");
    expect(body.prFixItem).toMatchObject({
      id: "prfix-1",
      generation: 1,
    });
    expect(Array.isArray(body.reasons)).toBe(true);
  });

  it("serves distinct (id, generation) identities across a requeue of the same PR", async () => {
    // The route is a read over the persisted queue row; a requeue bumps the
    // row's generation without changing its id. First attempt:
    const item = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 12,
      issue: null,
      branch: "fix/something",
      url: "https://github.com/org/repo/pull/12",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "review changes requested",
      feedback: ["please update tests"],
      evidenceKeys: ["review:1"],
      author: "bot",
      generation: 1,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    };
    mocks.prFixFindMany.mockResolvedValue([item]);

    const first = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const firstBody = await first.json();
    expect(firstBody.prFixItem).toMatchObject({ id: "prfix-1", generation: 1 });

    // Same queue row after an explicit requeue — same id, bumped generation.
    item.generation = 2;
    const second = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const secondBody = await second.json();
    expect(secondBody.type).toBe("followup-pr");
    expect(secondBody.prFixItem).toMatchObject({ id: "prfix-1", generation: 2 });
    expect(secondBody.prFixItem.id).toBe(firstBody.prFixItem.id);
  });

  it("withholds future external waits and lazily hands out due retries at a new generation (#1231)", async () => {
    const client = makeQueueStore();
    mocks.prFixFindMany.mockImplementation(async ({ where }: any = {}) =>
      client.prFixQueueItem.findMany({ where }),
    );
    mocks.prFixFindUnique.mockImplementation(async ({ where }: any) =>
      client.items.find((row: any) => row.id === where.id) ?? null,
    );
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      const row = client.items.find((candidate: any) =>
        candidate.id === where.id && candidate.generation === where.generation &&
        (where.status === undefined || candidate.status === where.status) &&
        (where.retryAt === undefined || candidate.retryAt?.getTime() === where.retryAt.getTime()) &&
        (!where.OR || matchesOrConditions(candidate, where.OR)),
      );
      if (!row) return { count: 0 };
      const patch: Record<string, any> = { ...data };
      for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === "object" && Array.isArray((value as any).push)) {
          patch[key] = [...(row[key] ?? []), ...(value as any).push];
        } else if (value && typeof value === "object" && typeof (value as any).increment === "number") {
          patch[key] = (row[key] ?? 0) + (value as any).increment;
        }
      }
      Object.assign(row, patch);
      return { count: 1 };
    });
    const item = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 123, lane: "NORMAL", reason: "review changes requested",
      feedback: "please update tests", evidenceKey: "review:123",
    });
    await markPrFixItem(client, {
      repo: "org/repo", pr: 123, status: "WAITING_EXTERNAL",
      expectedGeneration: item.generation, note: "waiting on prerequisite",
      externalWait: { kind: "upstream_pr", ref: "org/deps#7", evidence: "upstream PR open", trigger: { kind: "merged" } },
    });
    const waiting = client.items[0];
    const issuedGeneration = waiting.generation;
    expect(waiting.retryAt.getTime()).toBeGreaterThan(Date.now());

    const poll = async () => GET(
      request("/api/agents/example-agent/next-task"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const early = await poll();
    expect((await early.json()).type).toBe("idle");
    expect(waiting.status).toBe("WAITING_EXTERNAL");

    waiting.retryAt = new Date(Date.now() - 1_000);
    const due = await poll();
    const body = await due.json();
    expect(body.type).toBe("followup-pr");
    expect(body.prFixItem).toMatchObject({ id: waiting.id, generation: issuedGeneration + 1 });
    expect(waiting.status).toBe("QUEUED");
    expect(waiting.generation).toBeGreaterThan(issuedGeneration);
    expect(waiting.fixAttempts).toBeUndefined();
    expect(waiting.dispatchedGeneration).toBe(waiting.generation);

    const repeat = await poll();
    expect((await repeat.json()).type).toBe("idle");
  });

  it("serves the bumped generation through the production requeue path", async () => {
    // Drive the real queue state machine (enqueue → BLOCKED → requeue) against
    // an in-memory store, and verify next-task surfaces the persisted identity.
    const client = makeQueueStore();
    mocks.prFixFindMany.mockImplementation(async ({ where }: any) =>
      client.prFixQueueItem.findMany({ where }),
    );

    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 12,
      lane: "NORMAL",
      reason: "review changes requested",
      feedback: "please update tests",
      evidenceKey: "review:1",
    });

    const first = await GET(
      request("/api/agents/example-agent/next-task"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const firstBody = await first.json();
    expect(firstBody.type).toBe("followup-pr");
    expect(firstBody.prFixItem.generation).toBe(1);
    const itemId = firstBody.prFixItem.id;

    await markPrFixItem(client, { repo: "org/repo", pr: 12, status: "BLOCKED", note: "stuck" });
    const requeued = await requeuePrFixItem(client, { repo: "org/repo", pr: 12, note: "try again" });
    expect(requeued?.status).toBe("QUEUED");
    expect(requeued?.generation).toBe(2);

    const second = await GET(
      request("/api/agents/example-agent/next-task"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const secondBody = await second.json();
    expect(secondBody.type).toBe("followup-pr");
    expect(secondBody.prFixItem).toMatchObject({ id: itemId, generation: 2 });
  });

  it("stamps the hand-out with a generation-conditional update (#1119)", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 12,
        issue: null,
        branch: "fix/something",
        url: "https://github.com/org/repo/pull/12",
        title: "Fix something",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "CI failure on main",
        feedback: ["update tests"],
        evidenceKeys: ["ci:1"],
        author: "bot",
        generation: 2,
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(mocks.prFixUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "prfix-1",
        generation: 2,
        status: "QUEUED",
        OR: [
          { dispatchedGeneration: null },
          { dispatchedGeneration: { not: 2 } },
        ],
      },
      data: expect.objectContaining({
        dispatchedAt: expect.any(Date),
        dispatchedGeneration: 2,
        postDispatchEvidenceKeys: [],
      }),
    });
  });

  it("another agent's hand-out of a stamped generation preserves post-dispatch evidence (#1119, #1133)", async () => {
    // Stateful fake row: the updateMany mock honors the first-hand-out-only
    // where clause, so a hand-out of an already-stamped generation genuinely
    // no-ops instead of re-stamping and clearing the post-dispatch keys.
    const row: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 7,
      issue: null,
      branch: "fix/x",
      url: "https://github.com/org/repo/pull/7",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["ci:1"],
      author: "bot",
      generation: 2,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: null,
      dispatchedGeneration: null,
      postDispatchEvidenceKeys: [],
      agentHandouts: [],
    };
    mocks.prFixFindMany.mockResolvedValue([row]);
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      if (!matchesFirstHandOut(row, where)) return { count: 0 };
      applyUpdate(row, data);
      return { count: 1 };
    });
    mocks.prFixFindUnique.mockImplementation(async () => ({
      id: row.id,
      reason: row.reason,
      feedback: row.feedback,
      generation: row.generation,
    }));

    // (a) First hand-out of generation 2, by agent A: stamps and clears the keys.
    const first = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    expect((await first.json()).type).toBe("followup-pr");
    expect(row.dispatchedGeneration).toBe(2);
    expect(row.dispatchedAt).toBeInstanceOf(Date);
    expect(row.postDispatchEvidenceKeys).toEqual([]);
    expect(row.agentHandouts).toEqual(["example-agent@2"]);
    // #1256 review: the hand-out pushed a per-hand-out receipt alongside the
    // record, and the task carries its token back to the worker.
    const firstIssued = /^(hnd_[0-9a-f]+)@example-agent@2$/.exec(row.handoutReceipts[0] ?? "");
    expect(firstIssued).not.toBeNull();
    const stampedAt = row.dispatchedAt;

    // (b) New evidence enqueues mid-run, after the dispatch.
    row.postDispatchEvidenceKeys = ["review:o/r#7:r2@H1"];

    // (c) Agent B's FIRST hand-out of the same still-QUEUED generation: the
    // stamp no-ops (dispatchedGeneration already == 2), so the post-dispatch
    // keys survive, and B receives the item (per-agent records, #1133).
    const second = await GET(
      request("/api/agents/other-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "other-agent" }) },
    );
    const secondBody = await second.json();
    expect(secondBody.type).toBe("followup-pr");
    expect(secondBody.prFixItem).toMatchObject({ id: "prfix-1", generation: 2 });
    expect(typeof secondBody.prFixItem.handoutToken).toBe("string");
    // The token rotates per hand-out: B's receipt is a distinct entry from A's.
    expect(row.handoutReceipts).toHaveLength(2);
    expect(row.handoutReceipts[1]).toBe(`${secondBody.prFixItem.handoutToken}@other-agent@2`);
    expect(row.handoutReceipts[0]).not.toBe(row.handoutReceipts[1]);
    expect(row.postDispatchEvidenceKeys).toEqual(["review:o/r#7:r2@H1"]);
    expect(row.dispatchedGeneration).toBe(2);
    expect(row.dispatchedAt).toBe(stampedAt);
    expect(row.agentHandouts).toEqual(["example-agent@2", "other-agent@2"]);

    // (d) Agent A re-polling at the same generation is SKIPPED (#1133): it
    // already has a run for this work identity, so re-handing would only
    // starve the lane. The request falls through to issue work.
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 99,
        title: "Regular issue",
        url: "https://github.com/org/repo/issues/99",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);
    const third = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const thirdBody = await third.json();
    expect(thirdBody.type).toBe("implement");
    expect(thirdBody.prFixItem).toBeUndefined();
    // The skip left the row untouched: the stamp and the recorded keys are
    // exactly as the in-flight worker needs them.
    expect(row.postDispatchEvidenceKeys).toEqual(["review:o/r#7:r2@H1"]);
    expect(row.dispatchedGeneration).toBe(2);
    expect(row.agentHandouts).toEqual(["example-agent@2", "other-agent@2"]);
  });

  it("serves the next pr-fix item when the first was already handed to this agent (#1133)", async () => {
    const handed: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 7,
      issue: null,
      branch: "fix/x",
      url: "https://github.com/org/repo/pull/7",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["ci:1"],
      author: "bot",
      generation: 2,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: new Date("2026-01-01T00:05:00Z"),
      dispatchedGeneration: 2,
      postDispatchEvidenceKeys: [],
      agentHandouts: ["example-agent@2"],
    };
    const fresh: any = {
      id: "prfix-2",
      repo: "org/other",
      pr: 9,
      issue: null,
      branch: "fix/y",
      url: "https://github.com/org/other/pull/9",
      title: "Fix something else",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "review changes requested",
      feedback: ["address comments"],
      evidenceKeys: ["review:2"],
      author: "bot",
      generation: 1,
      queuedAt: new Date("2026-01-01T00:06:00Z"),
      updatedAt: new Date("2026-01-01T00:06:00Z"),
      dispatchedAt: null,
      dispatchedGeneration: null,
      postDispatchEvidenceKeys: [],
      agentHandouts: [],
    };
    mocks.prFixFindMany.mockResolvedValue([handed, fresh]);
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      const target = handed.id === where.id ? handed : fresh.id === where.id ? fresh : null;
      if (!target || !matchesFirstHandOut(target, where)) return { count: 0 };
      applyUpdate(target, data);
      return { count: 1 };
    });
    mocks.prFixFindUnique.mockImplementation(async ({ where }: any) => {
      const target = handed.id === where.id ? handed : fresh;
      return { id: target.id, reason: target.reason, feedback: target.feedback, generation: target.generation };
    });

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    // The already-handed item is skipped; the NEXT pr-fix item ships.
    expect(body.type).toBe("followup-pr");
    expect(body.prFixItem).toMatchObject({ id: "prfix-2", generation: 1 });
    expect(handed.agentHandouts).toEqual(["example-agent@2"]);
    expect(fresh.agentHandouts).toEqual(["example-agent@1"]);
  });

  it("suppresses the issue of an already-handed pr-fix item from the implement fallback (#1145)", async () => {
    // The item's issue is ready for implement pickup and carries no linked-PR
    // health flag, so only the pr-fix skip marks it queue-owned.
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 7,
        issue: 42,
        branch: "fix/issue-42",
        url: "https://github.com/org/repo/pull/7",
        title: "Fix 42",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "review changes requested",
        feedback: ["address comments"],
        evidenceKeys: ["review:1"],
        author: "bot",
        generation: 2,
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        dispatchedAt: new Date("2026-01-01T00:05:00Z"),
        dispatchedGeneration: 2,
        postDispatchEvidenceKeys: [],
        agentHandouts: ["example-agent@2"],
      },
    ]);
    mocks.issueFindMany.mockResolvedValue([independentIssue(42), independentIssue(99)]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
  });

  it("suppresses the issue when the queue row's repo casing differs from the issue's (#1145)", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "Org/Repo",
        pr: 7,
        issue: 42,
        branch: "fix/issue-42",
        url: "https://github.com/Org/Repo/pull/7",
        title: "Fix 42",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "review changes requested",
        feedback: ["address comments"],
        evidenceKeys: ["review:1"],
        author: "bot",
        generation: 2,
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        postDispatchEvidenceKeys: [],
        agentHandouts: ["example-agent@2"],
      },
    ]);
    mocks.issueFindMany.mockResolvedValue([independentIssue(42), independentIssue(99)]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
  });

  it("idles when the only ready issue belongs to an already-handed pr-fix item (#1145)", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 7,
        issue: 42,
        branch: "fix/issue-42",
        url: "https://github.com/org/repo/pull/7",
        title: "Fix 42",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "review changes requested",
        feedback: ["address comments"],
        evidenceKeys: ["review:1"],
        author: "bot",
        generation: 2,
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        postDispatchEvidenceKeys: [],
        agentHandouts: ["example-agent@2"],
      },
    ]);
    mocks.issueFindMany.mockResolvedValue([independentIssue(42)]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("idle");
    expect(body.shouldRun).toBe(false);
    expect(body.reason).toContain("deferred");
  });

  it("hands the item to the same agent again after its generation moves (#1133)", async () => {
    const row: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 7,
      issue: null,
      branch: "fix/x",
      url: "https://github.com/org/repo/pull/7",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["ci:1"],
      author: "bot",
      generation: 2,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: null,
      dispatchedGeneration: null,
      postDispatchEvidenceKeys: [],
      agentHandouts: [],
    };
    mocks.prFixFindMany.mockResolvedValue([row]);
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      if (!matchesFirstHandOut(row, where)) return { count: 0 };
      applyUpdate(row, data);
      return { count: 1 };
    });
    mocks.prFixFindUnique.mockImplementation(async () => ({
      id: row.id,
      reason: row.reason,
      feedback: row.feedback,
      generation: row.generation,
    }));
    mocks.issueFindMany.mockResolvedValue([]);

    const first = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    expect((await first.json()).prFixItem).toMatchObject({ id: "prfix-1", generation: 2 });
    expect(row.agentHandouts).toEqual(["example-agent@2"]);

    // The item is re-issued as a fresh attempt (requeue/reopen): generation
    // bumps, and the fresh attempt cleared the hand-out records.
    row.generation = 3;
    row.dispatchedGeneration = null;
    row.agentHandouts = [];

    const second = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const secondBody = await second.json();
    expect(secondBody.type).toBe("followup-pr");
    expect(secondBody.prFixItem).toMatchObject({ id: "prfix-1", generation: 3 });
    expect(row.agentHandouts).toEqual(["example-agent@3"]);
  });

  it("still hands out a pr-fix item to an agent with no recorded hand-out (#1133)", async () => {
    // An item handed to another agent is still dispatchable to this one:
    // the records are per-agent, keyed by the receiving agent's name.
    const row: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 7,
      issue: null,
      branch: "fix/x",
      url: "https://github.com/org/repo/pull/7",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["ci:1"],
      author: "bot",
      generation: 2,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: new Date("2026-01-01T00:05:00Z"),
      dispatchedGeneration: 2,
      postDispatchEvidenceKeys: [],
      agentHandouts: ["some-other-agent@2"],
    };
    mocks.prFixFindMany.mockResolvedValue([row]);
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      if (!matchesFirstHandOut(row, where)) return { count: 0 };
      applyUpdate(row, data);
      return { count: 1 };
    });
    mocks.prFixFindUnique.mockImplementation(async () => ({
      id: row.id,
      reason: row.reason,
      feedback: row.feedback,
      generation: row.generation,
    }));

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.prFixItem).toMatchObject({ id: "prfix-1", generation: 2 });
    expect(row.agentHandouts).toEqual(["some-other-agent@2", "example-agent@2"]);
  });

  it("first hand-out of a new generation re-stamps and clears stale evidence keys", async () => {
    // Same PR requeued: generation bumped to 3, but the row still carries
    // the generation-2 stamp and its stale post-dispatch keys.
    const row: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 7,
      issue: null,
      branch: "fix/x",
      url: "https://github.com/org/repo/pull/7",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["ci:2"],
      author: "bot",
      generation: 3,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
      dispatchedAt: new Date("2026-01-02T00:00:00Z"),
      dispatchedGeneration: 2,
      postDispatchEvidenceKeys: ["review:o/r#7:r1@H1"],
    };
    mocks.prFixFindMany.mockResolvedValue([row]);
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      if (!matchesFirstHandOut(row, where)) return { count: 0 };
      applyUpdate(row, data);
      return { count: 1 };
    });
    mocks.prFixFindUnique.mockImplementation(async () => ({
      id: row.id,
      reason: row.reason,
      feedback: row.feedback,
      generation: row.generation,
    }));

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    // A new generation is a first hand-out: it re-stamps and clears the
    // stale post-dispatch keys from the prior generation.
    expect(row.dispatchedGeneration).toBe(3);
    expect(row.postDispatchEvidenceKeys).toEqual([]);
    expect(row.dispatchedAt).not.toEqual(new Date("2026-01-02T00:00:00Z"));
  });

  it("hands out a token for the NEW generation when the re-read shows generation moved (#1119)", async () => {
    const row: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 7,
      issue: null,
      branch: "fix/x",
      url: "https://github.com/org/repo/pull/7",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["ci:1"],
      author: "bot",
      generation: 2,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: null,
      dispatchedGeneration: null,
      postDispatchEvidenceKeys: [],
    };
    mocks.prFixFindMany.mockResolvedValue([row]);
    let stampCount = 0;
    const stamps: any[] = [];
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      // Stamps carry the first-hand-out OR arms; the per-agent hand-out
      // record push (#1133) carries the issuance pin (#1327) or no OR.
      const isStamp = Array.isArray(where.OR) &&
        where.OR.some((cond: any) => "dispatchedGeneration" in cond);
      if (!isStamp) {
        const recorded = matchesFirstHandOut(row, where);
        if (recorded) applyUpdate(row, data);
        return { count: recorded ? 1 : 0 };
      }
      stampCount += 1;
      stamps.push(where);
      if (!matchesFirstHandOut(row, where)) return { count: 0 };
      applyUpdate(row, data);
      if (stampCount === 1) {
        // A concurrent re-issue moves the row in the read→stamp gap.
        row.generation = 3;
        row.reason = "CI failure on main (re-issued)";
        row.feedback = ["update tests", "fix lint"];
      }
      return { count: 1 };
    });
    mocks.prFixFindUnique.mockImplementation(async () => ({
      id: row.id,
      reason: row.reason,
      feedback: row.feedback,
      generation: row.generation,
    }));

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    // The first stamp targeted 2; the retry targeted the NEW generation.
    expect(stampCount).toBe(2);
    expect(stamps[0].generation).toBe(2);
    expect(stamps[1].generation).toBe(3);
    // The handed-out token is the NEW generation, so the worker's settle
    // report matches the live row instead of being rejected as a mismatch.
    expect(body.prFixItem).toMatchObject({ id: "prfix-1", generation: 3 });
    // The payload reasons come from the latest read, not the queue snapshot.
    expect(body.reasons).toContain("CI failure on main (re-issued)");
    expect(body.reasons).toContain("fix lint");
    // The row is stamped at the generation the token names.
    expect(row.dispatchedGeneration).toBe(3);
  });

  it("does not hand out an unconfirmed token when the generation moves on both retry passes (#1119)", async () => {
    // A concurrent re-issue keeps winning the race: every successful stamp
    // is immediately followed by another generation bump, so neither pass
    // can confirm the generation it stamped. The route must not ship a
    // token for a generation it never confirmed — mid-run evidence would be
    // classified as pre-dispatch and absorbed, the exact #1119 loss.
    const row: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 7,
      issue: null,
      branch: "fix/x",
      url: "https://github.com/org/repo/pull/7",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["ci:1"],
      author: "bot",
      generation: 2,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: null,
      dispatchedGeneration: null,
      postDispatchEvidenceKeys: [],
    };
    mocks.prFixFindMany.mockResolvedValue([row]);
    let stampCount = 0;
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      stampCount += 1;
      if (!matchesFirstHandOut(row, where)) return { count: 0 };
      applyUpdate(row, data);
      row.generation = (where.generation as number) + 1;
      row.reason = `re-issued at generation ${row.generation}`;
      return { count: 1 };
    });
    mocks.prFixFindUnique.mockImplementation(async () => ({
      id: row.id,
      reason: row.reason,
      feedback: row.feedback,
      generation: row.generation,
    }));
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 99,
        title: "Regular issue",
        url: "https://github.com/org/repo/issues/99",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // The bounded retry ran both passes, then gave up.
    expect(stampCount).toBe(2);
    // No pr-fix token ships: the last observed generation (4) was never
    // stamped or confirmed. The request falls through to issue work.
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(body.prFixItem).toBeUndefined();
    // The last confirmed stamp (generation 3) stays on the row, so a later
    // poll confirms and hands it out against the then-live row.
    expect(row.dispatchedGeneration).toBe(3);
  });

  it("does not hand out a stale token when the second pass throws after a move was observed (#1119)", async () => {
    // Pass 1 observes the generation move; pass 2 then fails. Falling back
    // to first.generation would hand out a stale token whose settle report
    // is rejected as a generation mismatch — the move was already observed,
    // so no unconfirmed token may ship.
    const row: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 7,
      issue: null,
      branch: "fix/x",
      url: "https://github.com/org/repo/pull/7",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["ci:1"],
      author: "bot",
      generation: 2,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: null,
      dispatchedGeneration: null,
      postDispatchEvidenceKeys: [],
    };
    mocks.prFixFindMany.mockResolvedValue([row]);
    let stampCount = 0;
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      stampCount += 1;
      if (stampCount === 2) throw new Error("db down");
      if (!matchesFirstHandOut(row, where)) return { count: 0 };
      applyUpdate(row, data);
      // A concurrent re-issue moves the row in the read→stamp gap.
      row.generation = 3;
      return { count: 1 };
    });
    mocks.prFixFindUnique.mockImplementation(async () => ({
      id: row.id,
      reason: row.reason,
      feedback: row.feedback,
      generation: row.generation,
    }));
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 99,
        title: "Regular issue",
        url: "https://github.com/org/repo/issues/99",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(stampCount).toBe(2);
    // Neither the stale generation 2 nor the un-stamped generation 3 ships;
    // the request falls through to issue work instead.
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(body.prFixItem).toBeUndefined();
  });

  it("still serves the pre-stamp token when the dispatch tracking stamp throws (#1119)", async () => {
    const item: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 7,
      issue: null,
      branch: "fix/x",
      url: "https://github.com/org/repo/pull/7",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["ci:1"],
      author: "bot",
      generation: 2,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: null,
      dispatchedGeneration: null,
      postDispatchEvidenceKeys: [],
    };
    mocks.prFixFindMany.mockResolvedValue([item]);
    mocks.prFixUpdateMany.mockRejectedValueOnce(new Error("db down"));

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    // Best-effort: the task is served with the pre-stamp snapshot's
    // generation and reasons.
    expect(body.prFixItem).toMatchObject({ id: "prfix-1", generation: 2 });
    expect(body.reasons).toContain("CI failure on main");
    expect(body.reasons).toContain("update tests");
  });

  it("feeds the re-read row's fresh feedback into the task payload (#1119)", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 12,
        issue: null,
        branch: "fix/something",
        url: "https://github.com/org/repo/pull/12",
        title: "Fix something",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "CI failure on main",
        feedback: ["update tests"],
        evidenceKeys: ["ci:1"],
        author: "bot",
        generation: 2,
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    mocks.prFixUpdateMany.mockResolvedValue({ count: 1 });
    mocks.prFixFindUnique.mockResolvedValue({
      reason: "CI failure on main",
      feedback: ["update tests", "fix lint (enqueued after the hand-out read)"],
    });

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.prFixItem).toMatchObject({ id: "prfix-1", generation: 2 });
    expect(body.reasons).toContain("CI failure on main");
    expect(body.reasons).toContain("update tests");
    // Only present in the re-read row — proves the payload reasons come from
    // the fresh row, not the stale queue snapshot.
    expect(body.reasons).toContain("fix lint (enqueued after the hand-out read)");
  });

  it("stamps the evidence watermark from the same snapshot it ships (#1276)", async () => {
    // The ledger counter moves BETWEEN the queue snapshot and the confirming
    // re-read (a sync recorded a transition). The boundary must follow the
    // re-read that assembled this hand-out's payload — never a later read,
    // which would sit ABOVE the delivered evidence and make settlement absorb a
    // transition this worker never received.
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 12,
        issue: null,
        branch: "fix/something",
        url: "https://github.com/org/repo/pull/12",
        title: "Fix something",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "CI failure on main",
        feedback: ["update tests"],
        evidenceKeys: ["check:1"],
        author: "itsmiso-ai",
        generation: 2,
        evidenceSequence: 5,
        agentHandouts: [],
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    mocks.prFixFindUnique.mockImplementation(async (args: any) => {
      // A counter-only read — the pre-fix shape — would answer 99 here, which
      // is exactly the "watermark above delivered evidence" bug this pins.
      if (args?.select && Object.keys(args.select).length === 1 && "evidenceSequence" in args.select) {
        return { evidenceSequence: 99 };
      }
      return {
        reason: "CI failure on main",
        feedback: ["update tests", "and lint"],
        generation: 2,
        status: "QUEUED",
        lane: "NORMAL",
        agentHandouts: [],
        evidenceSequence: 7,
      };
    });
    const updateManyCalls: any[] = [];
    mocks.prFixUpdateMany.mockImplementation(async (args: any) => {
      updateManyCalls.push(args);
      return { count: 1 };
    });

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const stamps = updateManyCalls.filter((call) => call.data && "attemptEvidenceWatermark" in call.data);
    expect(stamps).toHaveLength(1);
    // The boundary is the delivered payload's own position (7), not the
    // counter's later value (99), and the pin admits the counter having moved
    // on — transitions recorded after the payload are what must stay fresh.
    expect(stamps[0].where.evidenceSequence).toEqual({ gte: 7 });
    expect(stamps[0].where.attemptEvidenceWatermark).toBeNull();
    expect(stamps[0].data.attemptEvidenceWatermark).toBe(7);
  });

  it("stamps the watermark when a transition moves the counter past the delivered sequence (#1276)", async () => {
    // A concurrent sync commits a transition in the re-read→stamp gap: the row
    // counter is N+1 while the payload shipped N. That evidence is exactly what
    // this worker never received, so the stamp must still apply at the delivered
    // position — the pre-fix `lte` pin rejected it (count 0) and left the attempt
    // with no durable boundary once the bounded cache was evicted.
    const row: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 12,
      issue: null,
      branch: "fix/something",
      url: "https://github.com/org/repo/pull/12",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["check:1"],
      author: "itsmiso-ai",
      generation: 2,
      evidenceSequence: 6,
      attemptEvidenceWatermark: null,
      agentHandouts: [],
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: null,
      dispatchedGeneration: null,
      postDispatchEvidenceKeys: [],
    };
    mocks.prFixFindMany.mockResolvedValue([row]);
    let raced = false;
    mocks.prFixFindUnique.mockImplementation(async ({ where }: any) => {
      const snapshot = {
        reason: row.reason,
        feedback: row.feedback,
        generation: row.generation,
        status: row.status,
        lane: row.lane,
        agentHandouts: row.agentHandouts,
        evidenceSequence: row.evidenceSequence,
      };
      if (where?.id === row.id && !raced) {
        raced = true;
        row.evidenceSequence += 1;
      }
      return snapshot;
    });
    const updateManyCalls: any[] = [];
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      updateManyCalls.push({ where, data });
      if (!matchesLiveRow(row, where)) return { count: 0 };
      applyUpdate(row, data);
      return { count: 1 };
    });

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.prFixItem).toMatchObject({ id: "prfix-1", generation: 2 });
    const stamps = updateManyCalls.filter((call) => call.data && "attemptEvidenceWatermark" in call.data);
    expect(stamps).toHaveLength(1);
    expect(stamps[0].where.evidenceSequence).toEqual({ gte: 6 });
    expect(stamps[0].where.attemptEvidenceWatermark).toBeNull();
    // The delivered position, never the counter this worker raced ahead of.
    expect(stamps[0].data.attemptEvidenceWatermark).toBe(6);
    expect(row.attemptEvidenceWatermark).toBe(6);
    expect(row.evidenceSequence).toBe(7);
  });

  it("never overwrites a watermark another reader stamped, and still hands out the task (#1276)", async () => {
    // The `attemptEvidenceWatermark: null` fence is the idempotence guard: an
    // existing boundary for this generation must survive the stamp attempt, and
    // a miss is best-effort — it must never cost the worker its hand-out.
    const row: any = {
      id: "prfix-1",
      repo: "org/repo",
      pr: 12,
      issue: null,
      branch: "fix/something",
      url: "https://github.com/org/repo/pull/12",
      title: "Fix something",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "CI failure on main",
      feedback: ["update tests"],
      evidenceKeys: ["check:1"],
      author: "itsmiso-ai",
      generation: 2,
      evidenceSequence: 6,
      attemptEvidenceWatermark: 4,
      agentHandouts: [],
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: null,
      dispatchedGeneration: null,
      postDispatchEvidenceKeys: [],
    };
    mocks.prFixFindMany.mockResolvedValue([row]);
    mocks.prFixFindUnique.mockImplementation(async () => ({
      reason: row.reason,
      feedback: row.feedback,
      generation: row.generation,
      status: row.status,
      lane: row.lane,
      agentHandouts: row.agentHandouts,
      evidenceSequence: row.evidenceSequence,
    }));
    const stampCounts: number[] = [];
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      const matched = matchesLiveRow(row, where);
      if (matched) applyUpdate(row, data);
      else if (data && "attemptEvidenceWatermark" in data) stampCounts.push(0);
      return { count: matched ? 1 : 0 };
    });

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.prFixItem).toMatchObject({ id: "prfix-1", generation: 2 });
    expect(stampCounts).toEqual([0]);
    expect(row.attemptEvidenceWatermark).toBe(4);
    // The dispatch stamp itself did apply — the fence is specific to the
    // watermark, not a blanket refusal on this hand-out.
    expect(row.dispatchedGeneration).toBe(2);
    expect(row.agentHandouts).toEqual(["example-agent@2"]);
  });

  it("includes linked issue context when PR-fix has an issue number", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 12,
        issue: 67,
        branch: "fix/issue-67",
        url: "https://github.com/org/repo/pull/12",
        title: "Fix issue 67",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "review changes requested",
        feedback: ["please update tests"],
        evidenceKeys: ["review:1"],
        author: "itsmiso-ai",
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.issue.repoFullName).toBe("org/repo");
    expect(body.issue.number).toBe(67);
  });

  it("includes both reason and feedback in reasons", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 12,
        issue: null,
        branch: "fix/something",
        url: "https://github.com/org/repo/pull/12",
        title: "Fix something",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "CI failure on main",
        feedback: ["update tests", "fix lint"],
        evidenceKeys: ["ci:1"],
        author: "bot",
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.reasons).toContain("CI failure on main");
    expect(body.reasons).toContain("update tests");
    expect(body.reasons).toContain("fix lint");
  });

  it("preserves lane filtering", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-normal",
        number: 10,
        title: "Normal issue",
        url: "https://github.com/org/repo/issues/10",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
      {
        id: "issue-escalated",
        number: 20,
        title: "Escalated issue",
        url: "https://github.com/org/repo/issues/20",
        labels: ["priority/p0", "status/ready"],
        currentLane: "frontier",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(10);
  });

  it("passes through includeClaimed behavior", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-claimed-other",
        number: 30,
        title: "Claimed by other agent",
        url: "https://github.com/org/repo/issues/30",
        labels: ["agent/other-agent", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("idle");
  });

  it("includes claimed issues when includeClaimed=true", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-claimed-other",
        number: 30,
        title: "Claimed by other agent",
        url: "https://github.com/org/repo/issues/30",
        labels: ["agent/other-agent", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local&includeClaimed=true"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(30);
  });

  it("does not require harness-specific fields", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 42,
        title: "Test issue",
        url: "https://github.com/org/repo/issues/42",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect("harness" in body).toBe(false);
    expect("workflowRepo" in body).toBe(false);
  });

  it("followup-pr task uses reason when feedback is empty", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 12,
        issue: null,
        branch: "fix/something",
        url: "https://github.com/org/repo/pull/12",
        title: "Fix something",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "CI failure on main",
        feedback: [],
        evidenceKeys: ["ci:1"],
        author: "bot",
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.reasons).toEqual(["CI failure on main"]);
  });

  it("does not mutate issue or claim state", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 42,
        title: "Test issue",
        url: "https://github.com/org/repo/issues/42",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
      },
    ]);

    await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(mocks.issueFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ state: "open" }),
      }),
    );
  });

  // Linked PR follow-up tests

  it("returns followup-pr when issue has linked PR needing follow-up", async () => {
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, {
        title: "Fix login bug",
        linkedPrFollowupReasons: ["tests failing", "lint errors"],
        linkedPrReviewDecision: null,
      }),
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.shouldRun).toBe(true);
    expect(body.prFixItem).toMatchObject({ id: "linked-prfix", generation: 1 });
    expect(mocks.prFixCreate).toHaveBeenCalledTimes(1);
    expect(mocks.prFixHistoryCreate).toHaveBeenCalledTimes(1);
  });

  it("the PR-fix queue owns a linked PR that also qualifies as a queued issue", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "existing-prfix",
        repo: "org/repo",
        pr: 15,
        issue: 42,
        branch: null,
        url: "https://github.com/org/repo/pull/15",
        title: "Existing queued work",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "review changes requested",
        feedback: ["update tests"],
        evidenceKeys: ["review:1"],
        agentHandouts: [],
        generation: 3,
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 15)]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.prFixItem).toMatchObject({ id: "existing-prfix", generation: 3 });
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
    expect(mocks.fetchPullRequestLabels).not.toHaveBeenCalled();
  });

  it("linked-only work is materialized once and handout identity is not repeated", async () => {
    mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 15)]);

    const first = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const firstBody = await first.json();
    expect(firstBody.type).toBe("followup-pr");
    expect(firstBody.prFixItem).toMatchObject({ id: "linked-prfix", generation: 1 });
    expect(mocks.prFixHistoryCreate).toHaveBeenCalledTimes(1);

    const second = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    // The queue owns the PR now, so the issue is not re-served as implement work.
    expect((await second.json()).type).toBe("idle");
    expect(mocks.fetchPullRequestLabels).toHaveBeenCalledTimes(1);
    expect(mocks.prFixCreate).toHaveBeenCalledTimes(1);
    expect(mocks.prFixHistoryCreate).toHaveBeenCalledTimes(1);
    expect(mocks.prFixUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "linked-prfix", generation: 1, status: "QUEUED",
        NOT: { agentHandouts: { has: "example-agent@1" } },
      }),
      // #1256 review: the hand-out record and its per-hand-out receipt are
      // pushed in the same conditional write (token rotates per issuance).
      data: expect.objectContaining({
        agentHandouts: { push: ["example-agent@1"] },
        handoutReceipts: { push: [expect.stringMatching(/^hnd_[0-9a-f]+@example-agent@1$/)] },
      }),
    }));
  });

  it.each(
    ["QUEUED", "BLOCKED", "FIXED", "IGNORED", "STALE"].flatMap((status) =>
      ["NORMAL", "ESCALATED", "NEEDS_HUMAN"].map((lane) => [status, lane]),
    ),
  )("linked path defers to existing %s/%s queue row and does not hand the issue out as implement work", async (status, lane) => {
    mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 15), independentIssue(99)]);
    mocks.linkedRows.push({ repo: "org/repo", pr: 15, status, lane });

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const body = await res.json();
    // The next independent issue, never the deferred linked one (#1145).
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
    expect(mocks.fetchPullRequestLabels).not.toHaveBeenCalled();
  });

  it.each(["QUEUED", "BLOCKED", "FIXED", "IGNORED", "STALE"])(
    "idles rather than re-serving a deferred linked issue (%s row) as implement work",
    async (status) => {
      mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 15)]);
      mocks.linkedRows.push({ repo: "org/repo", pr: 15, status, lane: "NEEDS_HUMAN" });

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );
      const body = await res.json();
      expect(body.type).toBe("idle");
      expect(body.shouldRun).toBe(false);
      expect(body.reason).toContain("deferred");
    },
  );

  it("does not dispatch or mutate a concurrent queue winner during linked materialization", async () => {
    const winner = {
      id: "concurrent-prfix",
      repo: "org/repo",
      pr: 15,
      issue: 7,
      lane: "ESCALATED",
      status: "BLOCKED",
      generation: 4,
      reason: "operator blocked",
      feedback: ["wait for approval"],
      agentHandouts: [],
    };
    mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 15), independentIssue(99)]);
    mocks.prFixCreate.mockRejectedValue(Object.assign(new Error("unique constraint"), { code: "P2002" }));
    mocks.prFixFindUniqueByRepo.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    mocks.linkedRows.push(winner);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const raceBody = await res.json();
    expect(raceBody.type).toBe("implement");
    expect(raceBody.issue.number).toBe(99);
    expect(mocks.prFixCreate).toHaveBeenCalledTimes(1);
    expect(mocks.prFixHistoryCreate).not.toHaveBeenCalled();
    expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
    expect(winner).toMatchObject({ status: "BLOCKED", generation: 4, lane: "ESCALATED", agentHandouts: [] });
  });

  it("does not create linked follow-up for a PR with the needs-human label, and serves the next issue", async () => {
    mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 15), independentIssue(99)]);
    mocks.fetchPullRequestLabels.mockResolvedValue(["needs-human"]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
  });

  it("defers the issue when the needs-human label read is unavailable, and serves the next issue", async () => {
    // A transient GitHub failure must not fail the verdict open: the PR may be
    // human-blocked, so the issue is not eligible for implement pickup either.
    mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 15), independentIssue(99)]);
    mocks.fetchPullRequestLabels.mockResolvedValue(null);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
  });

  it("idles when the label read is unavailable and the linked issue is the only ready work", async () => {
    mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 15)]);
    mocks.fetchPullRequestLabels.mockResolvedValue(null);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("idle");
    expect(body.reason).toContain("deferred");
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
  });

  it("continues to the next linked PR when the first cannot be materialized", async () => {
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15),
      linkedIssue(43, 16, { id: "issue-43", number: 43, title: "Second issue", url: "https://github.com/org/repo/issues/43" }),
    ]);
    mocks.linkedRows.push({ repo: "org/repo", pr: 15, status: "BLOCKED", lane: "NEEDS_HUMAN" });
    mocks.prFixCreate.mockImplementation(async ({ data }: any) => {
      const item = { id: "linked-prfix-2", generation: 1, status: "QUEUED", agentHandouts: [], ...data };
      mocks.linkedRows.push(item);
      return item;
    });

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.pullRequest.number).toBe(16);
    expect(body.prFixItem).toMatchObject({ id: "linked-prfix-2", generation: 1 });
  });

  it("materializes linked-only work for a lane without a PR-fix equivalent, without handing it to that lane", async () => {
    // "cloud" is claimable but carries no role, so prFixLaneForRequest returns
    // null: discovered work must still converge onto the queue (NORMAL) so a
    // capable lane picks it up, rather than being silently dropped. The cloud
    // caller itself must not consume PR-fix work (#1046).
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, { currentLane: "cloud" }),
      independentIssue(99, { currentLane: "cloud" }),
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=cloud"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    // The linked issue is queue-owned; the caller drains to its next issue.
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(mocks.prFixCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lane: "NORMAL", status: "QUEUED" }),
    }));
    expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
  });

  it("records the discovered head as the attempt baseline when materializing linked work", async () => {
    mocks.issueFindMany.mockResolvedValue([linkedIssue(42, 15)]);
    mocks.fetchPullRequestHeadSha.mockResolvedValue("b".repeat(40));

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect((await res.json()).type).toBe("followup-pr");
    expect(mocks.prFixCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ headSha: "b".repeat(40), attemptHeadSha: "b".repeat(40) }),
    }));
  });

  it("does not fail the poll when linked materialization errors, and still serves the next candidate", async () => {
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15),
      linkedIssue(43, 16, { id: "issue-43", number: 43, title: "Second issue", url: "https://github.com/org/repo/issues/43" }),
      independentIssue(99),
    ]);
    mocks.prFixCreate
      .mockRejectedValueOnce(Object.assign(new Error("db down"), { code: "P2024" }))
      .mockImplementation(async ({ data }: any) => {
        const item = { id: "linked-prfix-2", generation: 1, status: "QUEUED", agentHandouts: [], ...data };
        mocks.linkedRows.push(item);
        return item;
      });

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.pullRequest.number).toBe(16);
  });

  it("defers a linked issue whose PR has a queue row even when cached health says no follow-up", async () => {
    // The cached health column is refreshed on a reconcile cadence and can lag
    // the queue row's creation. A false value must not let the issue through to
    // implement pickup on a PR the queue is holding back (BLOCKED rows are not
    // in the pr-fix list, so nothing else would stop it).
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, { linkedPrNeedsFollowup: false, linkedPrFollowupReasons: [] }),
      independentIssue(99),
    ]);
    mocks.linkedRows.push({ repo: "org/repo", pr: 15, status: "BLOCKED", lane: "NEEDS_HUMAN" });

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
  });

  it("still serves implement work for a linked PR that needs no follow-up and has no queue row", async () => {
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, { linkedPrNeedsFollowup: false, linkedPrFollowupReasons: [] }),
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(42);
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
    expect(mocks.fetchPullRequestLabels).not.toHaveBeenCalled();
  });

  it("finds an existing queue row when the issue cache's repo casing differs from the queue key", async () => {
    // Queue rows are stored under a case-folded repo; the issue cache is not
    // normalized against them, so the identity lookup must fold too (#1145).
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, { repository: { fullName: "Org/Repo" } }),
      independentIssue(99, { repository: { fullName: "Org/Repo" } }),
    ]);
    mocks.linkedRows.push({ repo: "org/repo", pr: 15, status: "BLOCKED", lane: "NEEDS_HUMAN" });

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(99);
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
  });

  it("linked PR follow-up beats normal implement work", async () => {
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, { title: "Issue with PR needing follow-up", linkedPrFollowupReasons: ["needs changes"] }),
      {
        id: "issue-normal",
        number: 99,
        title: "Normal issue",
        url: "https://github.com/org/repo/issues/99",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
        linkedPrNumber: null,
        linkedPrUrl: null,
        linkedPrNeedsFollowup: false,
        linkedPrFollowupReasons: [],
        linkedPrReviewDecision: null,
        linkedPrMergeState: null,
        linkedPrHealthCheckedAt: null,
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.pullRequest.number).toBe(15);
  });

  it("PR-fix queue item still beats linked PR follow-up", async () => {
    mocks.prFixFindMany.mockResolvedValue([
      {
        id: "prfix-1",
        repo: "org/repo",
        pr: 12,
        issue: null,
        branch: "fix/something",
        url: "https://github.com/org/repo/pull/12",
        title: "Fix something",
        lane: "NORMAL",
        status: "QUEUED",
        reason: "review changes requested",
        feedback: ["update tests"],
        evidenceKeys: ["review:1"],
        author: "bot",
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-followup",
        number: 42,
        title: "Issue with PR needing follow-up",
        url: "https://github.com/org/repo/issues/42",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
        linkedPrNumber: 15,
        linkedPrUrl: "https://github.com/org/repo/pull/15",
        linkedPrNeedsFollowup: true,
        linkedPrFollowupReasons: ["needs changes"],
        linkedPrReviewDecision: null,
        linkedPrMergeState: null,
        linkedPrHealthCheckedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.pullRequest.number).toBe(12);
  });

  it("linked PR follow-up includes issue context", async () => {
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, { title: "Fix login bug", linkedPrFollowupReasons: ["needs changes"] }),
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.issue.repoFullName).toBe("org/repo");
    expect(body.issue.number).toBe(42);
    expect(body.issue.title).toBe("Fix login bug");
    expect(body.issue.url).toBe("https://github.com/org/repo/issues/42");
  });

  it("linked PR follow-up includes pull request context", async () => {
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, { title: "Fix login bug", linkedPrFollowupReasons: ["needs changes"] }),
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.pullRequest.repoFullName).toBe("org/repo");
    expect(body.pullRequest.number).toBe(15);
    expect(body.pullRequest.url).toBe("https://github.com/org/repo/pull/15");
  });

  it("linked PR follow-up uses followup reasons", async () => {
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, { linkedPrFollowupReasons: ["tests failing", "lint errors", "missing docs"] }),
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.reasons).toContain("tests failing");
    expect(body.reasons).toContain("lint errors");
    expect(body.reasons).toContain("missing docs");
  });

  it("missing followup reasons uses fallback reason", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 42,
        title: "Fix login bug",
        url: "https://github.com/org/repo/issues/42",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
        linkedPrNumber: 15,
        linkedPrUrl: "https://github.com/org/repo/pull/15",
        linkedPrNeedsFollowup: true,
        linkedPrFollowupReasons: [],
        linkedPrReviewDecision: null,
        linkedPrMergeState: null,
        linkedPrHealthCheckedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.reasons).toEqual(["Linked PR needs follow-up"]);
  });

  it("dispatches a conflicted linked PR through the mechanical rebase lane (#1327)", async () => {
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, {
        linkedPrMergeState: "dirty",
        linkedPrFollowupReasons: ["merge_conflict"],
      }),
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.pullRequest.number).toBe(15);
    // The dispatch identity names the rebase lane, not the ordinary fix lane.
    expect(body.prFixItem.fixType).toBe("REBASE");
    // The materialized row is a REBASE item carrying the contract as its
    // single feedback entry (the same shape the ingestion path writes).
    expect(mocks.prFixCreate).toHaveBeenCalledTimes(1);
    const materialized = mocks.prFixCreate.mock.calls[0][0].data;
    expect(materialized.type).toBe("REBASE");
    expect(materialized.feedback).toHaveLength(1);
    expect(materialized.reason).toContain("Mechanical rebase");
    // The contract IS the instruction wall: it must reach the worker.
    const contract = body.reasons.join("\n");
    expect(contract).toContain("MECHANICALLY ONLY");
    expect(contract).toContain("--force-with-lease");
    expect(contract).toContain("human_decision");
  });

  it("defers a materialized conflicted linked PR for an agent outside the rebase pool (#1327)", async () => {
    // The linked-PR materialization loop is a second dispatchPrFixCandidate
    // caller: the pool gate must hold there too — the row is still
    // materialized (an eligible poller consumes it next poll), but this
    // ineligible agent receives no hand-out and never enters the lane
    // admission.
    process.env.DISPATCH_REBASE_AGENTS = "local-coder";
    try {
      mocks.issueFindMany.mockResolvedValue([
        linkedIssue(42, 15, {
          linkedPrMergeState: "dirty",
          linkedPrFollowupReasons: ["merge_conflict"],
        }),
      ]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      const body = await res.json();
      expect(body.shouldRun).toBe(false);
      expect(body.prFixItem).toBeUndefined();
      // The row is materialized QUEUED (not dropped), but no hand-out was
      // stamped and the admission transaction was never entered.
      expect(mocks.prFixCreate).toHaveBeenCalledTimes(1);
      expect(mocks.prFixCreate.mock.calls[0][0].data.type).toBe("REBASE");
      expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
      // The only transaction surface is the materialization create itself
      // (createLinkedPrFixItem writes in its own $transaction); the rebase
      // lane admission — gate read + hand-out stamp — was never entered.
      expect(mocks.prFixTxSurfaces).toEqual(["create"]);
    } finally {
      delete process.env.DISPATCH_REBASE_AGENTS;
    }
  });

  it("materializes a linked PR without a merge conflict as an ordinary fix item (#1327)", async () => {
    mocks.issueFindMany.mockResolvedValue([
      linkedIssue(42, 15, {
        linkedPrMergeState: "behind",
        linkedPrFollowupReasons: ["merge_state_behind"],
      }),
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("followup-pr");
    expect(body.prFixItem.fixType).toBe("OTHER");
    expect(mocks.prFixCreate).toHaveBeenCalledTimes(1);
    const materialized = mocks.prFixCreate.mock.calls[0][0].data;
    expect(materialized.type).toBe("OTHER");
    expect(materialized.feedback).toEqual(["merge_state_behind"]);
    // No conflict, no contract: the health reasons stand unchanged.
    expect(body.reasons).toEqual(["merge_state_behind"]);
  });

  it("normal issue still returns implement when no follow-up exists", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-1",
        number: 42,
        title: "Fix login bug",
        url: "https://github.com/org/repo/issues/42",
        labels: ["priority/p0", "status/ready"],
        currentLane: "local",
        decomposed: false,
        repository: { fullName: "org/repo" },
        linkedPrNumber: null,
        linkedPrUrl: null,
        linkedPrNeedsFollowup: false,
        linkedPrFollowupReasons: [],
        linkedPrReviewDecision: null,
        linkedPrMergeState: null,
        linkedPrHealthCheckedAt: null,
      },
    ]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(42);
  });

  it("idle still works when queue is empty", async () => {
    mocks.issueFindMany.mockResolvedValue([]);

    const res = await GET(
      request("/api/agents/example-agent/next-task"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );

    const body = await res.json();
    expect(body.type).toBe("idle");
    expect(body.shouldRun).toBe(false);
  });

  // ─── Worker idle read-only tests ─────────────────────────────────────

  describe("worker idle is read-only", () => {
    it("empty issue queue returns idle with shouldRun false", async () => {
      mocks.issueFindMany.mockResolvedValue([]);
      mocks.prFixFindMany.mockResolvedValue([]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("idle");
      expect(body.shouldRun).toBe(false);
    });

    it("empty PR-fix queue returns idle with shouldRun false", async () => {
      mocks.issueFindMany.mockResolvedValue([]);
      mocks.prFixFindMany.mockResolvedValue([]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("idle");
      expect(body.shouldRun).toBe(false);
    });

    it("idle reason is a short non-empty string", async () => {
      mocks.issueFindMany.mockResolvedValue([]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      const body = await res.json();
      expect(typeof body.reason).toBe("string");
      expect(body.reason.length).toBeGreaterThan(0);
      expect(body.reason.length).toBeLessThan(200);
    });

    it("idle check does not mutate issues", async () => {
      mocks.issueFindMany.mockResolvedValue([]);

      await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      expect(mocks.issueFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ state: "open" }),
        }),
      );
    });

    it("idle check does not mutate PR-fix queue", async () => {
      mocks.issueFindMany.mockResolvedValue([]);
      mocks.prFixFindMany.mockResolvedValue([]);

      await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      // listQueuedPrFixItems reads via prisma.prFixQueueItem.findMany
      // An idle check must not create, update, or delete any PR-fix queue items
      expect(mocks.prFixFindMany).toHaveBeenCalled();
    });

    it("idle check does not mutate leases", async () => {
      mocks.issueFindMany.mockResolvedValue([]);

      await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      // findLeasedIssueIds is a read-only query; no lease mutations should occur
      expect(mocks.findLeasedIssueIds).toHaveBeenCalledWith("example-agent");
    });
  });

  // ─── Retired external grooming mode ────────────────────────────────
  describe("retired mode=groom", () => {
    it("returns 410 for maintainer tokens without queue, issue, or lease reads", async () => {
      const res = await GET(request("/api/agents/groomer/next-task?mode=groom"),
        { params: Promise.resolve({ agentName: "groomer" }) });
      expect(res.status).toBe(410);
      expect((await res.json()).error).toContain("retired");
      expect(mocks.issueFindMany).not.toHaveBeenCalled();
      expect(mocks.prFixFindMany).not.toHaveBeenCalled();
      expect(mocks.findLeasedIssueIds).not.toHaveBeenCalled();
    });

    it("returns 410 for worker-tier bearer tokens", async () => {
      const res = await GET(authedRequest("http://localhost/api/agents/worker/next-task?mode=groom", { token: "test-worker-token" }),
        { params: Promise.resolve({ agentName: "worker" }) });
      expect(res.status).toBe(410);
      expect(mocks.issueFindMany).not.toHaveBeenCalled();
      expect(mocks.prFixFindMany).not.toHaveBeenCalled();
    });
  });

  // ─── PR-fix lane filter tests ──────────────────────────────────────────

  describe("PR-fix lane filter (#1046)", () => {
    function prFixStore(items: any[]) {
      mocks.prFixFindMany.mockImplementation(async ({ where }: any) => {
        let result = items.slice();
        if (where?.status) {
          result = Array.isArray(where.status.in)
            ? result.filter((i) => where.status.in.includes(i.status))
            : result.filter((i) => i.status === where.status);
        }
        if (where?.lane) result = result.filter((i) => i.lane === where.lane);
        return result;
      });
    }
    function prFixItem(id: string, lane: string, extra: Record<string, unknown> = {}) {
      return {
        id, repo: "org/repo", pr: 12, issue: null, branch: "fix/x",
        url: "https://github.com/org/repo/pull/12", title: "Fix", lane,
        status: "QUEUED", reason: "review changes requested", feedback: [],
        evidenceKeys: ["review:1"], author: "bot", generation: 1,
        queuedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        ...extra,
      };
    }

    it("serves NORMAL PR-fix work for a normal configured lane", async () => {
      prFixStore([prFixItem("prfix-1", "NORMAL")]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.type).toBe("followup-pr");
      expect(body.pullRequest.number).toBe(12);
      expect(mocks.prFixFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ lane: "NORMAL" }),
        }),
      );
    });

    it("does not coerce a normal lane to NEEDS_HUMAN", async () => {
      prFixStore([prFixItem("prfix-nh", "NEEDS_HUMAN")]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      const body = await res.json();
      expect(body.type).toBe("idle");
      expect(mocks.prFixFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ lane: "NORMAL" }),
        }),
      );
    });

    it("resolves an alias lane to NORMAL PR-fix work", async () => {
      prFixStore([prFixItem("prfix-1", "NORMAL")]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=normal"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.type).toBe("followup-pr");
    });

    it("routes escalation lane to ESCALATED PR-fix work", async () => {
      prFixStore([prFixItem("prfix-e", "ESCALATED")]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=frontier"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.type).toBe("followup-pr");
    });

    it("backlog and custom no-role lanes do not pick up PR-fix work", async () => {
      for (const lane of ["backlog", "cloud"]) {
        vi.clearAllMocks();
        prFixStore([prFixItem("prfix-n", "NORMAL"), prFixItem("prfix-e", "ESCALATED")]);
        mocks.issueFindMany.mockResolvedValue([]);
        mocks.findLeasedIssueIds.mockResolvedValue([]);

        const res = await GET(
          request(`/api/agents/example-agent/next-task?lane=${lane}`),
          { params: Promise.resolve({ agentName: "example-agent" }) },
        );

        expect(res.status).toBe(200);
        expect((await res.json()).type).toBe("idle");
        expect(mocks.prFixFindMany).not.toHaveBeenCalled();
      }
    });

    it("escalation lane does not pick up NORMAL PR-fix work", async () => {
      prFixStore([prFixItem("prfix-1", "NORMAL")]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=frontier"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.type).toBe("idle");
      expect(mocks.prFixFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ lane: "ESCALATED" }),
        }),
      );
    });

    it("returns 400 for an unknown lane", async () => {
      prFixStore([prFixItem("prfix-1", "NORMAL")]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=definitely-not-a-lane"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid lane");
      expect(mocks.prFixFindMany).not.toHaveBeenCalled();
    });
  });

  // ─── Auth tests ──────────────────────────────────────────────────

  describe("auth", () => {
    it("returns 401 when no authorization header is provided", async () => {
      const res = await GET(
        request("/api/agents/example-agent/next-task", "example-agent", false),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 when bearer token is wrong", async () => {
      const res = await GET(
        new Request("http://localhost/api/agents/example-agent/next-task", {
          headers: { Authorization: "Bearer wrong-token" },
        }),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );
      expect(res.status).toBe(401);
    });

    it("allows normal worker next-task with valid bearer token", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          id: "issue-1",
          number: 42,
          title: "Fix login bug",
          url: "https://github.com/org/repo/issues/42",
          labels: ["priority/p0", "status/ready"],
          currentLane: "local",
          decomposed: false,
          repository: { fullName: "org/repo" },
        },
      ]);

      const res = await GET(
        request("/api/agents/example-agent/next-task?lane=local"),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.type).toBe("implement");
      expect(body.issue.number).toBe(42);
    });

    it("unauthorized normal request does not call pr-fix, issues, or leases", async () => {
      const res = await GET(
        request("/api/agents/example-agent/next-task", "example-agent", false),
        { params: Promise.resolve({ agentName: "example-agent" }) },
      );

      expect(res.status).toBe(401);
      expect(mocks.issueFindMany).not.toHaveBeenCalled();
      expect(mocks.prFixFindMany).not.toHaveBeenCalled();
      expect(mocks.findLeasedIssueIds).not.toHaveBeenCalled();
    });

    it("unauthorized groom request does not call issues, pr-fix, or leases", async () => {
      const res = await GET(
        request("/api/agents/groomer/next-task?mode=groom", "groomer", false),
        { params: Promise.resolve({ agentName: "groomer" }) },
      );

      expect(res.status).toBe(401);
      expect(mocks.issueFindMany).not.toHaveBeenCalled();
      expect(mocks.prFixFindMany).not.toHaveBeenCalled();
      expect(mocks.findLeasedIssueIds).not.toHaveBeenCalled();
    });
  });
});

describe("GET /api/agents/[agentName]/next-task — bound worker scope (#1129)", () => {
  it("denies a bound worker requesting another agent's task", async () => {
    const res = await GET(
      authedRequest("http://localhost/api/agents/bravo/next-task", { token: "bound-token" }),
      { params: Promise.resolve({ agentName: "bravo" }) },
    );
    expect(res.status).toBe(403);
  });

  it("denies an unbound legacy worker token", async () => {
    const res = await GET(
      authedRequest("http://localhost/api/agents/alpha/next-task", { token: "test-worker-token" }),
      { params: Promise.resolve({ agentName: "alpha" }) },
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /api/agents/[agentName]/next-task — capacity-scoped handoff cooldowns (#1256)", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.prFixFindMany.mockResolvedValue([]);
    mocks.issueFindMany.mockResolvedValue([]);
    mocks.findLeasedIssueIds.mockResolvedValue([]);
    mocks.prFixUpdateMany.mockResolvedValue({ count: 1 });
    mocks.prFixFindUnique.mockResolvedValue(null);
    mocks.prFixFindUniqueByRepo.mockResolvedValue(null);
    mocks.capacityHandoffFindMany.mockResolvedValue([]);
    mocks.capacityHandoffDeleteMany.mockResolvedValue({ count: 0 });
  });

  function cooledPrRow(): any {
    return {
      id: "prfix-cooled",
      repo: "org/repo",
      pr: 70,
      issue: null,
      branch: "work/70",
      url: "https://github.com/org/repo/pull/70",
      lane: "NORMAL",
      status: "QUEUED",
      reason: "review changes requested",
      feedback: [],
      generation: 1,
      queuedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      dispatchedAt: null,
      dispatchedGeneration: null,
      postDispatchEvidenceKeys: [],
      agentHandouts: [],
    };
  }

  it("rejects a malformed capacity query", async () => {
    const res = await GET(
      request(`/api/agents/example-agent/next-task?capacity=${"x".repeat(250)}`),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    expect(res.status).toBe(400);
  });

  it("does not re-hand a cooled PR-fix attempt to the exhausted capacity, but hands it to an unrelated capacity", async () => {
    const row = cooledPrRow();
    mocks.prFixFindMany.mockResolvedValue([row]);
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      if (row.id !== where.id) return { count: 0 };
      if (where.generation !== undefined && row.generation !== where.generation) return { count: 0 };
      applyUpdate(row, data);
      return { count: 1 };
    });
    mocks.prFixFindUnique.mockImplementation(async () => ({
      reason: row.reason, feedback: row.feedback, generation: row.generation,
      status: row.status, lane: row.lane, agentHandouts: row.agentHandouts,
    }));
    mocks.capacityHandoffFindMany.mockResolvedValue([
      { kind: "pr_fix", capacity: "model-a", repoFullName: "org/repo", issueNumber: null, prNumber: 70 },
    ]);

    // The exhausted capacity is suppressed; with no other work it goes idle.
    const cooled = await GET(
      request("/api/agents/example-agent/next-task?lane=local&capacity=model-a"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    expect((await cooled.json()).type).toBe("idle");

    // An unrelated capacity still gets the work — the cooldown is scoped.
    const unrelated = await GET(
      request("/api/agents/example-agent/next-task?lane=local&capacity=model-b"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const body = await unrelated.json();
    expect(body.type).toBe("followup-pr");
    expect(body.pullRequest.number).toBe(70);
    expect(body.prFixItem).toMatchObject({ id: row.id, generation: 1 });
  });

  it("suppresses a cooled issue only for the exhausted capacity; undeclared workers skip conservatively", async () => {
    mocks.issueFindMany.mockResolvedValue([independentIssue(101)]);
    mocks.capacityHandoffFindMany.mockResolvedValue([
      { kind: "issue", capacity: "model-a", repoFullName: "org/repo", issueNumber: 101, prNumber: null },
    ]);

    const exhausted = await GET(
      request("/api/agents/example-agent/next-task?lane=local&capacity=model-a"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    expect((await exhausted.json()).type).toBe("idle");

    // Fail-closed for workers that declare no capacity: Dispatch cannot prove
    // they are not the exhausted capacity.
    const undeclared = await GET(
      request("/api/agents/example-agent/next-task?lane=local"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    expect((await undeclared.json()).type).toBe("idle");

    const unrelated = await GET(
      request("/api/agents/example-agent/next-task?lane=local&capacity=model-b"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const body = await unrelated.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(101);
  });

  it("resumes normal dispatch once no active cooldown exists (expiry is lazy)", async () => {
    mocks.issueFindMany.mockResolvedValue([independentIssue(101)]);
    // The route filters by `cooldownUntil > now`; expiry simply means the row
    // no longer comes back from the active read.
    mocks.capacityHandoffFindMany.mockResolvedValue([]);

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local&capacity=model-a"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(101);
  });

  it("dispatches without capacity suppression when the cooldown read fails (availability over strictness)", async () => {
    mocks.issueFindMany.mockResolvedValue([independentIssue(101)]);
    mocks.capacityHandoffFindMany.mockRejectedValue(new Error("db down"));

    const res = await GET(
      request("/api/agents/example-agent/next-task?lane=local&capacity=model-a"),
      { params: Promise.resolve({ agentName: "example-agent" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(101);
  });
});
