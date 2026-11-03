/**
 * #1532: the rebase-only intake contract at the next-task route.
 *
 * Self-contained harness: the PR-fix queue is a stateful in-memory store so
 * a hand-out genuinely mutates the row (the deferred/duplicate/concurrent
 * cases depend on the row's live state, not on call counts).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock(mockToken));

const { mocks, matchRow, applyData } = vi.hoisted(() => {
  /** One OR arm of a composed Prisma pin, evaluated against a fake row. */
  const matchesOrArm = (row: any, cond: any): boolean => {
    if ("dispatchedGeneration" in cond) {
      return cond.dispatchedGeneration === null
        ? row.dispatchedGeneration == null
        : row.dispatchedGeneration != null && row.dispatchedGeneration !== cond.dispatchedGeneration.not;
    }
    if ("ciParkState" in cond) {
      return cond.ciParkState === null
        ? row.ciParkState == null
        : row.ciParkState != null && row.ciParkState !== cond.ciParkState.not;
    }
    // The issuance pin (#1327): the row must still anchor the lane being
    // issued — its mutable type, or the attempt stamp that names it.
    if ("type" in cond) return row.type === cond.type;
    if ("attemptType" in cond) return row.attemptType === cond.attemptType;
    return false;
  };

  const matchRow = (row: any, where: any): boolean => {
    if (!where) return true;
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.generation !== undefined && row.generation !== where.generation) return false;
    if (where.lane !== undefined && row.lane !== where.lane) return false;
    if (where.status !== undefined) {
      if (typeof where.status === "string") {
        if (row.status !== where.status) return false;
      } else if (Array.isArray(where.status?.in) && !where.status.in.includes(row.status)) {
        return false;
      }
    }
    if (Array.isArray(where.agentHandouts?.equals) && (row.agentHandouts ?? []).length !== where.agentHandouts.equals.length) {
      return false;
    }
    if (where.NOT?.agentHandouts?.has !== undefined && (row.agentHandouts ?? []).includes(where.NOT.agentHandouts.has)) {
      return false;
    }
    if (where.evidenceSequence?.gte !== undefined && !(row.evidenceSequence >= where.evidenceSequence.gte)) {
      return false;
    }
    if (where.attemptEvidenceWatermark === null && row.attemptEvidenceWatermark != null) return false;
    if (where.OR && !where.OR.some((cond: any) => matchesOrArm(row, cond))) return false;
    for (const group of where.AND ?? []) {
      if (group.OR && !group.OR.some((cond: any) => matchesOrArm(row, cond))) return false;
    }
    return true;
  };

  const applyData = (row: any, data: any): void => {
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
  };

  return {
    mocks: {
      prFixRows: [] as any[],
      issueFindMany: vi.fn(),
      issueFindFirst: vi.fn(),
      issueFindFirstLocked: vi.fn(),
      prFixFindMany: vi.fn(),
      prFixFindUnique: vi.fn(),
      prFixCreate: vi.fn(),
      prFixHistoryCreate: vi.fn(),
      prFixUpdateMany: vi.fn(),
      fetchPullRequestLabels: vi.fn(),
      fetchPullRequestHeadSha: vi.fn(),
      findLeasedIssueIds: vi.fn(),
      capacityHandoffFindMany: vi.fn(),
      capacityHandoffDeleteMany: vi.fn(),
      noPrConclusionFindMany: vi.fn(),
      noPrConclusionDeleteMany: vi.fn(),
      // Queue-client surfaces touched THROUGH a transaction (the REBASE
      // admission transaction and the #1503 issuance fence).
      prFixTxSurfaces: [] as string[],
    },
    matchRow,
    applyData,
  };
});

vi.mock("@/lib/prisma", () => {
  const prFixQueueItem = {
    findMany: async ({ where }: any = {}) => {
      mocks.prFixFindMany({ where });
      return mocks.prFixRows.filter((row: any) => matchRow(row, where));
    },
    findUnique: async ({ where }: any) => {
      mocks.prFixFindUnique({ where });
      if (where?.id !== undefined) return mocks.prFixRows.find((row: any) => row.id === where.id) ?? null;
      return mocks.prFixRows.find((row: any) => row.repo === where?.repo_pr?.repo && row.pr === where?.repo_pr?.pr) ?? null;
    },
    create: async (args: any) => mocks.prFixCreate(args),
    updateMany: async (args: any) => mocks.prFixUpdateMany(args),
  };
  // The transaction client shares the module client's rows, so a hand-out
  // written inside the admission transaction is visible to the next poll —
  // only the recorded surface differs.
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
      issue: { findMany: mocks.issueFindMany, findFirst: mocks.issueFindFirst },
      noPrConclusion: {
        findMany: mocks.noPrConclusionFindMany,
        deleteMany: mocks.noPrConclusionDeleteMany,
      },
      prFixQueueItem,
      prFixHistory: { create: mocks.prFixHistoryCreate },
      capacityHandoff: {
        findMany: mocks.capacityHandoffFindMany,
        deleteMany: mocks.capacityHandoffDeleteMany,
      },
      $transaction: async (fn: any) =>
        fn({
          prFixQueueItem: txPrFixQueueItem,
          prFixHistory: { create: mocks.prFixHistoryCreate },
          issue: {
            findFirst: mocks.issueFindFirst,
            findFirstLocked: mocks.issueFindFirstLocked,
          },
          // The advisory lock of the REBASE admission (#1327); its real
          // serialization is proven against PostgreSQL elsewhere.
          $executeRaw: async () => {
            mocks.prFixTxSurfaces.push("executeRaw");
            return 1;
          },
        }),
    },
    asPrFixQueueClient: (client: unknown) => client,
  };
});

vi.mock("@/lib/github", () => ({
  fetchPullRequestLabels: mocks.fetchPullRequestLabels,
  fetchPullRequestHeadSha: mocks.fetchPullRequestHeadSha,
}));

vi.mock("@/lib/lease", () => ({ findLeasedIssueIds: mocks.findLeasedIssueIds }));

// The production queue-mutation functions surface outcomes to GitHub; no-op
// them so the route can be exercised without network.
vi.mock("@/lib/pr-fix-surfacing", () => ({
  NEEDS_HUMAN_LABEL: "needs-human",
  surfacePrFixBlocked: vi.fn().mockResolvedValue({ labelApplied: false, commentPosted: false, errors: [] }),
  surfacePrFixParked: vi.fn().mockResolvedValue({ labelApplied: false, commentPosted: false, errors: [] }),
  surfacePrFixRequeued: vi.fn().mockResolvedValue({ labelRemoved: false, commentUpdated: false, errors: [] }),
  surfacePrFixUnblocked: vi.fn().mockResolvedValue({ labelRemoved: false, commentUpdated: false, errors: [] }),
  extractUrlsFromText: vi.fn(() => []),
}));

import { GET } from "./route";
import { resetAuthCaches } from "@/lib/auth";

const AGENT = "example-agent";

function request(url: string) {
  return authedRequest(`http://localhost${url}`);
}

function poll(query: string, agentName = AGENT) {
  return GET(request(`/api/agents/${agentName}/next-task${query}`), {
    params: Promise.resolve({ agentName }),
  });
}

/** A queued PR-fix row in the mechanical rebase lane. */
function rebaseRow(pr = 41, over: Record<string, unknown> = {}) {
  return {
    id: `prfix-${pr}`,
    repo: "org/repo",
    pr,
    issue: null,
    branch: "work/41",
    url: `https://github.com/org/repo/pull/${pr}`,
    title: "Rebase me",
    lane: "NORMAL",
    status: "QUEUED",
    type: "REBASE",
    attemptType: null,
    reason: "Mechanical rebase: PR dirty against base (#1327)",
    feedback: ["MECHANICALLY ONLY"],
    evidenceKeys: ["review:1"],
    author: "bot",
    generation: 1,
    queuedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    dispatchedAt: null,
    dispatchedGeneration: null,
    postDispatchEvidenceKeys: [],
    agentHandouts: [],
    handoutAcks: [],
    handoutReceipts: [],
    ciParkState: null,
    ...over,
  };
}

/** An ordinary PR-fix row (not the mechanical rebase lane). */
function ordinaryRow(pr = 42, over: Record<string, unknown> = {}) {
  return {
    ...rebaseRow(pr, over),
    id: `prfix-${pr}`,
    type: "CI_FAILURE",
    reason: "checks failing",
    feedback: ["fix the build"],
  };
}

/** A ready issue — ordinary implementation work. */
function readyIssue(number = 7) {
  return {
    id: `issue-${number}`,
    number,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    title: `Issue ${number}`,
    body: "body",
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
  };
}

const REBASE_ONLY = "?work_scope=rebase-only&work_scope_version=1&capabilities=rebase-executor:1";
const CAPABLE = "?capabilities=rebase-executor:1";

beforeEach(() => {
  delete process.env.DISPATCH_AUTH_MODE;
  resetAuthCaches();
  vi.clearAllMocks();
  mocks.prFixRows = [];
  mocks.prFixTxSurfaces = [];
  // The rebase worker pool is operator-declared (#1327); the tests that care
  // about the pool pin it themselves.
  process.env.DISPATCH_REBASE_AGENTS = AGENT;
  mocks.issueFindMany.mockResolvedValue([]);
  mocks.issueFindFirst.mockResolvedValue(null);
  mocks.issueFindFirstLocked.mockResolvedValue(null);
  mocks.findLeasedIssueIds.mockResolvedValue([]);
  mocks.capacityHandoffFindMany.mockResolvedValue([]);
  mocks.capacityHandoffDeleteMany.mockResolvedValue({ count: 0 });
  mocks.noPrConclusionFindMany.mockResolvedValue([]);
  mocks.noPrConclusionDeleteMany.mockResolvedValue({ count: 0 });
  mocks.fetchPullRequestLabels.mockResolvedValue([]);
  mocks.fetchPullRequestHeadSha.mockResolvedValue(null);
  mocks.prFixCreate.mockImplementation(async ({ data }: any) => {
    const item = { id: "materialized-prfix", generation: 1, status: "QUEUED", agentHandouts: [], ...data };
    mocks.prFixRows.push(item);
    return item;
  });
  mocks.prFixHistoryCreate.mockResolvedValue({});
  mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
    const row = mocks.prFixRows.find((candidate: any) => matchRow(candidate, where));
    if (!row) return { count: 0 };
    applyData(row, data);
    return { count: 1 };
  });
});

afterEach(() => {
  delete process.env.DISPATCH_REBASE_AGENTS;
});

describe("rebase-only intake — eligible work only (#1532)", () => {
  it("hands out a queued REBASE item and acknowledges the scope", async () => {
    const row = rebaseRow();
    mocks.prFixRows.push(row);

    const response = await poll(REBASE_ONLY);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.type).toBe("followup-pr");
    expect(body.shouldRun).toBe(true);
    expect(body.prFixItem.fixType).toBe("REBASE");
    expect(body.prFixItem.id).toBe(row.id);
    expect(body.intake).toEqual({
      version: 1,
      scope: "rebase-only",
      scopeEnforced: true,
      capabilities: [{ name: "rebase-executor", requested: 1, granted: true }],
    });
  });

  it("never serves an ordinary PR-fix item, and leaves it untouched", async () => {
    const ordinary = ordinaryRow();
    mocks.prFixRows.push(ordinary);

    const body = await (await poll(REBASE_ONLY)).json();

    expect(body.type).toBe("idle");
    expect(body.shouldRun).toBe(false);
    expect(body.prFixItem).toBeUndefined();
    // The ordinary item is untouched: no hand-out, no dispatch stamp.
    expect(ordinary.agentHandouts).toEqual([]);
    expect(ordinary.dispatchedGeneration).toBeNull();
  });

  it("never serves implementation work", async () => {
    mocks.issueFindMany.mockResolvedValue([readyIssue()]);
    mocks.prFixRows.push(rebaseRow());

    const body = await (await poll(REBASE_ONLY)).json();

    // The REBASE item is handed out; the ready issue is never offered.
    expect(body.type).toBe("followup-pr");
    expect(body.issue).toBeUndefined();
  });

  it("idles on a ready issue alone and never reads the issue queue", async () => {
    mocks.issueFindMany.mockResolvedValue([readyIssue()]);

    const body = await (await poll(REBASE_ONLY)).json();

    expect(body.type).toBe("idle");
    expect(body.shouldRun).toBe(false);
    expect(body.issue).toBeUndefined();
    // The rebase-only fetch reads NO issue queue at all.
    expect(mocks.issueFindMany).not.toHaveBeenCalled();
  });

  it("never materializes linked-PR work", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        ...readyIssue(11),
        linkedPrNumber: 55,
        linkedPrUrl: "https://github.com/org/repo/pull/55",
        linkedPrNeedsFollowup: true,
        linkedPrFollowupReasons: ["merge_conflict"],
        linkedPrMergeState: "dirty",
      },
    ]);

    const body = await (await poll(REBASE_ONLY)).json();

    expect(body.type).toBe("idle");
    // No queue row was created, and no GitHub state was read.
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
    expect(mocks.prFixHistoryCreate).not.toHaveBeenCalled();
    expect(mocks.fetchPullRequestLabels).not.toHaveBeenCalled();
    expect(mocks.fetchPullRequestHeadSha).not.toHaveBeenCalled();
  });
});

describe("rebase-only intake — the rebase-executor capability is required (#1532)", () => {
  it("defers a REBASE item for an allowlisted agent that did not declare the capability", async () => {
    // The "new Dispatch + old Courier" case: the agent name is allowlisted,
    // but the client never declared the rebase-executor contract, so the
    // mechanical lane must not be handed to it.
    const row = rebaseRow();
    mocks.prFixRows.push(row);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    const body = await (await poll("")).json();

    expect(body.shouldRun).toBe(false);
    expect(body.prFixItem).toBeUndefined();
    expect(row.agentHandouts).toEqual([]);
    expect(row.dispatchedGeneration).toBeNull();
    expect(row.dispatchedAt).toBeNull();
    expect(info.mock.calls.flat().join(" ")).toContain("rebase-executor:1");
    info.mockRestore();
  });

  it("tells the operator why the rebase lane did not dispatch", async () => {
    // A deployment whose client never learned the contract must see the
    // reason in the poll response, not only in the server log.
    const row = rebaseRow();
    mocks.prFixRows.push(row);

    const body = await (await poll("")).json();

    expect(body.type).toBe("idle");
    expect(body.reason).toContain("1 rebase candidate deferred");
    expect(body.reason).toContain("rebase-executor:1");
  });

  it("hands the same item to a later capable poll", async () => {
    const row = rebaseRow();
    mocks.prFixRows.push(row);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await (await poll("")).json();
    const capable = await (await poll(CAPABLE)).json();

    expect(capable.type).toBe("followup-pr");
    expect(capable.prFixItem.fixType).toBe("REBASE");
    expect(row.agentHandouts).toEqual([`${AGENT}@1`]);
    info.mockRestore();
  });

  it("does not grant an unknown capability version, and still serves ordinary work", async () => {
    const rebase = rebaseRow();
    const ordinary = ordinaryRow();
    mocks.prFixRows.push(rebase, ordinary);

    const body = await (await poll("?capabilities=rebase-executor:2")).json();

    expect(body.type).toBe("followup-pr");
    expect(body.pullRequest.number).toBe(ordinary.pr);
    expect(rebase.agentHandouts).toEqual([]);
    expect(body.intake.capabilities).toEqual([
      { name: "rebase-executor", requested: 2, granted: false, reason: "unsupported-version" },
    ]);
  });

  it("rejects an unsupported scope version and a malformed capability", async () => {
    const badVersion = await poll("?work_scope=rebase-only&work_scope_version=2&capabilities=rebase-executor:1");
    expect(badVersion.status).toBe(400);
    expect((await badVersion.json()).error).toContain("Unsupported work_scope_version");

    const malformed = await poll("?capabilities=rebase-executor");
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toContain("Malformed capabilities entry");

    const noCapability = await poll("?work_scope=rebase-only&work_scope_version=1");
    expect(noCapability.status).toBe(400);
    expect((await noCapability.json()).error).toContain("rebase-executor:1 capability declaration");

    // A rejected declaration never reaches the queue: no read, and no write.
    expect(mocks.prFixFindMany).not.toHaveBeenCalled();
    expect(mocks.issueFindMany).not.toHaveBeenCalled();
    expect(mocks.prFixUpdateMany).not.toHaveBeenCalled();
    expect(mocks.prFixCreate).not.toHaveBeenCalled();
    expect(mocks.prFixHistoryCreate).not.toHaveBeenCalled();
  });

  it("leaves an ordinary poll untouched: no acknowledgment, today's behavior", async () => {
    mocks.issueFindMany.mockResolvedValue([readyIssue()]);

    const body = await (await poll("")).json();

    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(7);
    expect(body.intake).toBeUndefined();
    expect("intake" in body).toBe(false);
  });
});

describe("rebase-only intake — hand-out races (#1532)", () => {
  it("does not land a hand-out when the lane flips between the read and the write", async () => {
    const row = rebaseRow();
    mocks.prFixRows.push(row);
    // A concurrent re-observation flips the row's lane after the queue read
    // (the dispatch stamp lands) and before the hand-out append: the
    // issuance pin must refuse the append.
    mocks.prFixUpdateMany.mockImplementation(async ({ where, data }: any) => {
      const target = mocks.prFixRows.find((candidate: any) => matchRow(candidate, where));
      if (!target) return { count: 0 };
      if (data?.dispatchedGeneration !== undefined) target.type = "CI_FAILURE";
      applyData(target, data);
      return { count: 1 };
    });

    const body = await (await poll(REBASE_ONLY)).json();

    expect(body.type).toBe("idle");
    expect(body.prFixItem).toBeUndefined();
    expect(row.agentHandouts).toEqual([]);
  });

  it("does not hand the same item out twice to the same agent", async () => {
    const row = rebaseRow();
    mocks.prFixRows.push(row);

    const first = await (await poll(REBASE_ONLY)).json();
    expect(first.type).toBe("followup-pr");
    expect(row.agentHandouts).toEqual([`${AGENT}@1`]);
    expect(row.handoutReceipts).toHaveLength(1);

    const second = await (await poll(REBASE_ONLY)).json();
    expect(second.shouldRun).toBe(false);
    expect(second.prFixItem).toBeUndefined();
    // The second poll minted no new hand-out.
    expect(row.agentHandouts).toEqual([`${AGENT}@1`]);
    expect(row.handoutReceipts).toHaveLength(1);
  });

  it("gives the second concurrent poll the first hand-out and hands out nothing twice", async () => {
    // The advisory lock that serializes the lane is proven against a real
    // PostgreSQL elsewhere. What this harness proves is the state read inside
    // the admission: the second poll observes the first hand-out and defers.
    const row = rebaseRow();
    mocks.prFixRows.push(row);

    const bodies = await Promise.all([poll(REBASE_ONLY), poll(REBASE_ONLY)].map((p) => p.then((r) => r.json())));

    expect(bodies.filter((body) => body.type === "followup-pr")).toHaveLength(1);
    expect(bodies.filter((body) => body.type === "idle")).toHaveLength(1);
    expect(row.agentHandouts).toEqual([`${AGENT}@1`]);
    // The hand-out ran inside the REBASE admission transaction.
    expect(mocks.prFixTxSurfaces).toContain("executeRaw");
    expect(mocks.prFixTxSurfaces).toContain("updateMany");
  });

  it("reports the deferred rebase candidates in the idle reason", async () => {
    // A candidate this agent already holds is not handed out again. The poll
    // must say that it deferred a candidate, not that the lane has no work.
    const row = rebaseRow();
    mocks.prFixRows.push(row);

    const first = await (await poll(REBASE_ONLY)).json();
    expect(first.type).toBe("followup-pr");

    const second = await (await poll(REBASE_ONLY)).json();
    expect(second.type).toBe("idle");
    expect(second.reason).toContain("1 rebase candidate deferred");
  });

  it("refuses a rebase-only poll from an agent outside the rebase worker pool", async () => {
    process.env.DISPATCH_REBASE_AGENTS = "some-other-agent";
    const row = rebaseRow();
    mocks.prFixRows.push(row);

    const body = await (await poll(REBASE_ONLY)).json();

    expect(body.type).toBe("idle");
    expect(body.shouldRun).toBe(false);
    expect(body.reason).toContain("rebase worker pool");
    expect(row.agentHandouts).toEqual([]);
  });
});
