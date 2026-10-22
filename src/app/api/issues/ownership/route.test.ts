import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authedRequest,
  makeDispatchEnvMock,
  TEST_AGENT_TOKEN as mockToken,
} from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

// maintainer (default token) + a legacy tierMap worker token + a bound worker
// credential, so the central-tiering 403 path is exercised both ways.
vi.mock(
  "@/lib/dispatch-env",
  () =>
    makeDispatchEnvMock(
      mockToken,
      { "worker-ownership-token": "worker" },
      { "worker-bound": "alpha" },
    ),
);

// One in-memory db shared by the list-route candidate queries and the
// per-candidate inspectIssueOwnership re-reads (issue.findUnique,
// lease.findMany({issueId}), agentWork.findFirst, prFixQueueItem.findFirst).
const { db, applyListArgs } = vi.hoisted(() => {
  // The mock prisma applies the route's `orderBy` + `take` so the bounded scan
  // (and its probe-row overflow signal) is exercised for real instead of
  // returning every row in insertion order.
  function applyListArgs<T extends Record<string, any>>(rows: T[], args?: any): T[] {
    const orderBy = args?.orderBy;
    let out = rows;
    if (orderBy) {
      const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
      // Compare by VALUE: two rows holding the same instant are two distinct
      // Date objects, and a reference comparison would never treat them as
      // equal — so the next `orderBy` clause (the id tie-break) would be
      // skipped.
      const value = (v: any) => (v instanceof Date ? v.getTime() : v);
      out = [...rows].sort((a, b) => {
        for (const clause of clauses) {
          const field = Object.keys(clause)[0];
          const spec = clause[field];
          const dir = typeof spec === "string" ? spec : (spec?.sort ?? "asc");
          // Postgres: ASC puts NULLs last, DESC puts them first, unless the
          // query overrides it with `nulls`.
          const nulls =
            typeof spec === "object" && spec?.nulls
              ? spec.nulls
              : dir === "asc"
                ? "last"
                : "first";
          const av = a[field] ?? null;
          const bv = b[field] ?? null;
          if (av === null && bv === null) continue;
          if (av === null) return nulls === "first" ? -1 : 1;
          if (bv === null) return nulls === "first" ? 1 : -1;
          const c = value(av);
          const d = value(bv);
          if (c === d) continue;
          // asc: the SMALLER value first; desc: the LARGER value first.
          if (dir === "asc") return c > d ? 1 : -1;
          return c > d ? -1 : 1;
        }
        return 0;
      });
    }
    const take = args?.take;
    return typeof take === "number" ? out.slice(0, take) : out;
  }

  return {
    db: {
    issues: [] as any[],
    leases: [] as any[],
    agentWorks: [] as any[],
    prFixes: [] as any[],
    guards: [] as any[],
  },
    applyListArgs,
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // #1254: the operator read surface lists pending release intents and
    // ladder candidates.
    ownershipReleaseIntent: { findMany: async () => [] },
    ownershipReconcileCandidate: { findMany: async () => [] },
    issueMutationGuard: { findMany: async () => db.guards.filter((g) => g.executing) },
    issue: {
      // list route: { where: { repository: { enabled }, state }, orderBy, take }
      findMany: async (args?: any) =>
        applyListArgs(
          db.issues.filter(
            (i) =>
              i.state === args?.where?.state &&
              (!args?.where?.repository ||
                i.repository?.enabled === args.where.repository.enabled),
          ),
          args,
        ),
      // inspectIssueOwnership: { where: { id }, include: { repository } }
      findUnique: async ({ where }: any) =>
        db.issues.find((i) => i.id === where.id) ?? null,
    },
    lease: {
      // list route: { where: { expiredAt: { gt }, renewedAt }, orderBy, take }
      // inspect:     { where: { issueId } }
      findMany: async (args?: any) => {
        const w = args?.where;
        let rows = db.leases;
        if (w?.issueId) {
          rows = rows.filter((l) => l.issueId === w.issueId);
        } else {
          if (w?.expiredAt?.gt) {
            const cutoff = new Date(w.expiredAt.gt).getTime();
            rows = rows.filter((l) => l.expiredAt.getTime() > cutoff);
          }
          // The scan reads the source as two runs: renewed leases
          // (`renewedAt: { not: null }`) and never-renewed ones
          // (`renewedAt: null`).
          if (w && "renewedAt" in w) {
            const renewed = w.renewedAt;
            if (renewed === null) {
              rows = rows.filter((l) => l.renewedAt === null);
            } else if (renewed && typeof renewed === "object" && renewed.not === null) {
              rows = rows.filter((l) => l.renewedAt !== null);
            }
          }
        }
        return applyListArgs(rows, args);
      },
    },
    agentWork: {
      // list route: { where: { issueId: { not: null }, state: { in } }, orderBy, take }
      findMany: async (args: any) =>
        applyListArgs(
          db.agentWorks.filter(
            (w) =>
              w.issueId !== null &&
              (args?.where?.state?.in ?? []).includes(w.state),
          ),
          args,
        ),
      // inspect: { where: { issueId, state: { in } }, orderBy heartbeat desc }
      findFirst: async ({ where }: any) => {
        const matches = db.agentWorks
          .filter(
            (w) =>
              w.issueId === where.issueId &&
              (where.state?.in ?? []).includes(w.state),
          )
          .sort(
            (a, b) =>
              (b.lastHeartbeatAt?.getTime() ?? 0) -
              (a.lastHeartbeatAt?.getTime() ?? 0),
          );
        return matches[0] ?? null;
      },
    },
    prFixQueueItem: {
      // inspect: { where: { repo, status: { in }, OR: [{ issue }, { pr }] } }
      findFirst: async ({ where }: any) => {
        const match = db.prFixes.find((r: any) => {
          if (r.repo !== where.repo) return false;
          if (where.status?.in && !where.status.in.includes(r.status)) {
            return false;
          }
          return where.OR?.some(
            (c: any) =>
              (c.issue !== undefined && r.issue === c.issue) ||
              (c.pr !== undefined && r.pr === c.pr),
          );
        });
        return match ?? null;
      },
    },
  },
}));

// The list route inspects with live: false and must never hit the forge;
// this safety net fails loudly if an unexpected live label read is attempted.
vi.mock("@/lib/claim-gate", () => ({
  getLiveIssueLabels: vi.fn(async () => {
    throw new Error("getLiveIssueLabels must not be called (list route uses live:false)");
  }),
}));

import { GET } from "./route";
import { resetAuthCaches } from "@/lib/auth";

const NOW = new Date();
const inMin = (n: number) => new Date(NOW.getTime() + n * 60_000);

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    number: 42,
    state: "open",
    labels: [] as string[],
    blockedReason: null,
    linkedPrNumber: null,
    linkedPrMergeState: null,
    updatedAt: inMin(-3),
    repository: { fullName: "org/repo", enabled: true },
    ...overrides,
  };
}

function makeLease(overrides: Record<string, unknown> = {}) {
  return {
    id: "lease-1",
    agentName: "alpha",
    issueId: "issue-1",
    expiredAt: inMin(30),
    renewedAt: inMin(-1),
    claimToken: "secret-token-xyz",
    registeredAt: null,
    registrationOccurredAt: null,
    renewCount: 1,
    lastRenewalObservedAt: inMin(-1),
    lastRenewalOccurredAt: inMin(-1),
    retryAfter: null,
    disposition: null,
    runRef: null,
    createdAt: inMin(-2),
    ...overrides,
  };
}

function makeAgentWork(overrides: Record<string, unknown> = {}) {
  return {
    id: "aw-1",
    agentName: "alpha",
    issueId: "issue-1",
    state: "CLAIMED",
    lastHeartbeatAt: inMin(-1),
    updatedAt: inMin(-1),
    blockerReason: null,
    ...overrides,
  };
}

function get(
  url = "http://localhost/api/issues/ownership",
  opts: { token?: string; includeAuth?: boolean } = {},
) {
  return GET(
    authedRequest(url, { token: opts.token, includeAuth: opts.includeAuth }),
  );
}

function reset() {
  vi.clearAllMocks();
  resetAuthCaches();
  delete process.env.DISPATCH_AUTH_MODE;
  delete process.env.DISPATCH_OWNERSHIP_ACTIVE_WINDOW_MS;
  delete process.env.DISPATCH_OWNERSHIP_LONG_RUN_GRACE_MS;
  db.issues = [];
  db.leases = [];
  db.agentWorks = [];
  db.prFixes = [];
  db.guards = [];
}

describe("GET /api/issues/ownership — auth", () => {
  beforeEach(() => {
    reset();
  });

  it("returns 401 when no authorization header is provided", async () => {
    const res = await get(undefined, { includeAuth: false });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an unknown token", async () => {
    const res = await get(undefined, { token: "wrong-token" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a bound worker-tier token (route not on the worker allowlist)", async () => {
    const res = await get(undefined, { token: "worker-bound" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("maintainer");
  });

  it("returns 403 for a legacy unbound worker-tier token via the central tiering", async () => {
    const res = await get(undefined, { token: "worker-ownership-token" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("maintainer");
  });
});

describe("GET /api/issues/ownership — executing-guard surface (#1254 round 4)", () => {
  beforeEach(() => {
    reset();
  });

  it("surfaces guard updatedAt (the heartbeat silence signal), never the owner token", async () => {
    const createdAt = new Date(Date.now() - 20 * 60_000);
    // Created 20 min ago but stamped 30 s ago: the operator reads SILENCE,
    // not elapsed age — this guard belongs to a live (slow) holder and is NOT
    // override-eligible. The payload must carry both timestamps to show that.
    const updatedAt = new Date(Date.now() - 30_000);
    db.guards = [
      {
        issueId: "issue-1",
        operation: "reconcile-release",
        agentName: "alpha",
        ownerToken: "secret-owner-token",
        executing: true,
        createdAt,
        updatedAt,
      },
    ];

    const res = await get("http://localhost/api/issues/ownership?state=");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reconciliation.executingGuards).toEqual([
      {
        issueId: "issue-1",
        operation: "reconcile-release",
        agentName: "alpha",
        ownerTokenPresent: true,
        createdAt: createdAt.toISOString(),
        updatedAt: updatedAt.toISOString(),
      },
    ]);
  });
});

describe("GET /api/issues/ownership — candidate gathering + derivation", () => {
  beforeEach(() => {
    reset();
  });

  // NOTE: the plain (paramless) list is currently broken — see the
  // "known bug" block at the bottom. `?state=` (present-but-empty) is the
  // only input that reaches the route's no-filter branch, so it is used to
  // exercise the happy path here.
  it("200 happy path: open issue with agent/alpha label + lease renewed 1 min ago → CLAIMED_ACTIVE (cache), counts, examined, limit, windows", async () => {
    db.issues = [makeIssue({ labels: ["agent/alpha"] })];
    db.leases = [makeLease()];

    const res = await get("http://localhost/api/issues/ownership?state=");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("issue-1");
    expect(body.items[0].repoFullName).toBe("org/repo");
    expect(body.items[0].assessment.state).toBe("CLAIMED_ACTIVE");
    expect(body.items[0].assessment.reasonCodes).toContain("evidence_recent");
    expect(body.items[0].assessment.verified).toBe(false);
    expect(body.items[0].assessment.ownerAgent).toBe("alpha");
    expect(body.items[0].evidence.labelSource).toBe("cache");
    expect(body.items[0].evidence.lease.claimTokenPresent).toBe(true);

    expect(body.counts.CLAIMED_ACTIVE).toBe(1);
    expect(body.counts.HELD).toBe(0);
    expect(body.examined).toBe(1);
    expect(body.truncated).toBe(false);
    expect(body.limit).toBe(50);
    expect(typeof body.windows.activeMs).toBe("number");
    expect(typeof body.windows.longRunGraceMs).toBe("number");
  });

  it("gathers a lease-only candidate (no agent label): claim passes via the active lease → ladder", async () => {
    db.issues = [makeIssue({ labels: ["status/in-progress"] })];
    db.leases = [makeLease()];

    const res = await get("http://localhost/api/issues/ownership?state=");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items).toHaveLength(1);
    expect(body.items[0].assessment.state).toBe("CLAIMED_ACTIVE");
    expect(body.items[0].assessment.ownerAgent).toBe("alpha");
    expect(body.items[0].evidence.lease).not.toBeNull();
    expect(body.items[0].evidence.agentWork).toBeNull();
    expect(body.examined).toBe(1);
  });

  it("gathers an active AgentWork-only candidate (no label, no lease)", async () => {
    db.issues = [makeIssue()];
    db.agentWorks = [makeAgentWork()];

    const res = await get("http://localhost/api/issues/ownership?state=");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items).toHaveLength(1);
    expect(body.items[0].assessment.state).toBe("CLAIMED_ACTIVE");
    expect(body.items[0].assessment.ownerAgent).toBe("alpha");
    expect(body.items[0].evidence.agentWork).not.toBeNull();
    expect(body.items[0].evidence.lease).toBeNull();
    expect(body.examined).toBe(1);
  });

  it("drops a closed issue (even with an agent label and an active lease) and never gathers an open no-signal issue: examined 0", async () => {
    // closed issue carries the label AND an active lease, so it would enter
    // the candidate set via the lease signal if the open filter did not drop it
    db.issues = [
      makeIssue({ id: "issue-closed", state: "closed", labels: ["agent/alpha"] }),
      makeIssue({ id: "issue-plain", labels: ["status/ready"] }),
    ];
    db.leases = [makeLease({ issueId: "issue-closed" })];

    const res = await get("http://localhost/api/issues/ownership?state=");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items).toHaveLength(0);
    expect(body.examined).toBe(0);
    expect(body.counts.UNOWNED).toBe(0);
    expect(body.counts.CLAIMED_ACTIVE).toBe(0);
  });
});

describe("GET /api/issues/ownership — state filter", () => {
  beforeEach(() => {
    reset();
    db.issues = [
      makeIssue({
        id: "issue-blocked",
        labels: ["agent/alpha", "status/blocked"],
        blockedReason: "awaiting upstream decision",
      }),
      makeIssue({ id: "issue-claimed", labels: ["agent/alpha"] }),
    ];
    db.leases = [makeLease({ issueId: "issue-claimed" })];
  });

  it("?state=HELD returns only the blocked-with-reason issue; counts/examined reflect the full population", async () => {
    const res = await get("http://localhost/api/issues/ownership?state=HELD");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("issue-blocked");
    expect(body.items[0].assessment.state).toBe("HELD");
    expect(body.items[0].assessment.reasonCodes).toContain("human_hold");
    expect(body.items[0].evidence.blockedReason).toBe(
      "awaiting upstream decision",
    );
    expect(body.counts.HELD).toBe(1);
    expect(body.counts.CLAIMED_ACTIVE).toBe(1);
    expect(body.examined).toBe(2);
  });

  it("a valid state with no matches returns 200 with empty items and full counts/examined", async () => {
    const res = await get("http://localhost/api/issues/ownership?state=UNKNOWN");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items).toHaveLength(0);
    expect(body.examined).toBe(2);
    expect(body.counts.CLAIMED_ACTIVE).toBe(1);
  });

  it("returns 400 with an allowed-states message for an invalid state value", async () => {
    const res = await get("http://localhost/api/issues/ownership?state=BOGUS");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid state: BOGUS");
    expect(body.error).toContain("Allowed:");
    expect(body.error).toContain("CLAIMED_ACTIVE");
  });

  it("trims whitespace around a valid state value", async () => {
    const res = await get(
      "http://localhost/api/issues/ownership?state=%20HELD%20",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("issue-blocked");
  });
});

describe("GET /api/issues/ownership — limit", () => {
  beforeEach(() => {
    reset();
    db.issues = [
      makeIssue({ id: "issue-1", labels: ["agent/alpha"] }),
      makeIssue({ id: "issue-2", labels: ["agent/alpha"] }),
      makeIssue({ id: "issue-3", labels: ["agent/alpha"] }),
    ];
    db.leases = [
      makeLease({ issueId: "issue-1" }),
      makeLease({ issueId: "issue-2" }),
      makeLease({ issueId: "issue-3" }),
    ];
  });

  it("?limit=1 slices items but counts/examined reflect the full population", async () => {
    const res = await get("http://localhost/api/issues/ownership?state=&limit=1");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items).toHaveLength(1);
    expect(body.examined).toBe(3);
    expect(body.counts.CLAIMED_ACTIVE).toBe(3);
    expect(body.limit).toBe(1);
  });

  it("?limit=9999 clamps to the MAX_LIMIT (200)", async () => {
    const res = await get("http://localhost/api/issues/ownership?state=&limit=9999");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.limit).toBe(200);
    expect(body.items).toHaveLength(3);
  });

  it("ignores a non-numeric limit and falls back to the default 50", async () => {
    const res = await get("http://localhost/api/issues/ownership?state=&limit=abc");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.limit).toBe(50);
    expect(body.items).toHaveLength(3);
  });

  it("clamps a negative limit to 1", async () => {
    const res = await get("http://localhost/api/issues/ownership?state=&limit=-7");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.limit).toBe(1);
    expect(body.items).toHaveLength(1);
  });
});

describe("GET /api/issues/ownership — token hygiene + windows", () => {
  beforeEach(() => {
    reset();
    db.issues = [makeIssue({ labels: ["agent/alpha"] })];
    db.leases = [makeLease({ claimToken: "secret-token-xyz" })];
  });

  it("never surfaces the raw claim token in the body; reports claimTokenPresent instead", async () => {
    const res = await get("http://localhost/api/issues/ownership?state=");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items[0].evidence.lease.claimTokenPresent).toBe(true);
    expect(JSON.stringify(body)).not.toContain("secret-token-xyz");
  });

  it("echoes the deployment's ownership windows (defaults: 15m active / 45m long-run grace)", async () => {
    const res = await get("http://localhost/api/issues/ownership?state=");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(typeof body.windows.activeMs).toBe("number");
    expect(typeof body.windows.longRunGraceMs).toBe("number");
    expect(body.windows.activeMs).toBe(15 * 60 * 1000);
    expect(body.windows.longRunGraceMs).toBe(45 * 60 * 1000);
  });
});

describe("GET /api/issues/ownership — bounded source scan", () => {
  // The route caps every candidate source at MAX_CANDIDATE_SCAN (1000) rows and
  // reads one probe row past it, so `sourcesTruncated` says exactly which
  // source overflowed. `truncated` keeps its own meaning: candidates dropped
  // before derivation.
  const CAP = 1000;
  const overflow = () => Array.from({ length: CAP + 1 }, (_, i) => i);

  beforeEach(() => {
    reset();
  });

  it("reports only `labeled` when the open-issue label sweep overflows its cap", async () => {
    db.issues = overflow().map((i) =>
      makeIssue({ id: `issue-${i}`, labels: ["agent/alpha"] }),
    );

    const res = await get("http://localhost/api/issues/ownership?state=");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.sourcesTruncated).toEqual({
      labeled: true,
      leased: false,
      working: false,
    });
    // the label cap drops candidates before derivation (MAX_INSPECTED = 500),
    // which is `truncated`'s job — unchanged by the per-source signal.
    expect(body.truncated).toBe(true);
    expect(body.examined).toBe(500);
  });

  it("reports only `leased` when active leases overflow their cap", async () => {
    db.issues = [makeIssue()];
    // Lease is unique on (agentName, issueId): one agent per issue, so the
    // overflow is many distinct claims on the one issue.
    db.leases = overflow().map((i) =>
      makeLease({ id: `lease-${i}`, agentName: `alpha-${i}`, issueId: "issue-1" }),
    );

    const res = await get("http://localhost/api/issues/ownership?state=");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.sourcesTruncated).toEqual({
      labeled: false,
      leased: true,
      working: false,
    });
    expect(body.examined).toBe(1);
  });

  it("reports only `working` when active AgentWork rows overflow their cap", async () => {
    db.issues = [makeIssue()];
    db.agentWorks = overflow().map((i) =>
      makeAgentWork({ id: `aw-${i}`, agentName: `alpha-${i}`, issueId: "issue-1" }),
    );

    const res = await get("http://localhost/api/issues/ownership?state=");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.sourcesTruncated).toEqual({
      labeled: false,
      leased: false,
      working: true,
    });
    expect(body.examined).toBe(1);
  });

  it("does not over-report: a source with exactly the cap's worth of rows is not truncated", async () => {
    db.issues = Array.from({ length: CAP }, (_, i) => makeIssue({ id: `issue-${i}` }));
    db.leases = Array.from({ length: CAP }, (_, i) =>
      makeLease({ id: `lease-${i}`, agentName: `alpha-${i}`, issueId: "issue-0" }),
    );
    db.agentWorks = Array.from({ length: CAP }, (_, i) =>
      makeAgentWork({ id: `aw-${i}`, agentName: `alpha-${i}`, issueId: "issue-0" }),
    );

    const res = await get("http://localhost/api/issues/ownership?state=");
    expect(res.status).toBe(200);
    const body = await res.json();

    // toEqual, not property-by-property: a missing flag fails this assertion.
    expect(body.sourcesTruncated).toEqual({
      labeled: false,
      leased: false,
      working: false,
    });
  });
});

describe("GET /api/issues/ownership — lease scan activity order (#1251 review)", () => {
  const CAP = 1000;

  beforeEach(() => {
    reset();
  });

  // Freshness is the lease's most recent ACTIVITY, not its creation time: a
  // long-lived claim that its owner is still renewing is live ownership
  // evidence, and a claim that was never renewed falls back to its creation
  // time. Ordering on `createdAt` alone ranked a freshly claimed,
  // never-renewed lease above an old lease that is still heartbeating — and
  // past the cap, dropped the live one while keeping the stale one.
  it("orders an old lease renewed moments ago ahead of a newer-created lease that was never renewed", async () => {
    db.issues = [
      makeIssue({ id: "issue-old", number: 1 }),
      makeIssue({ id: "issue-new", number: 2 }),
    ];
    db.leases = [
      // Claimed a week ago, renewed a minute ago: activity is the renewal.
      makeLease({
        id: "lease-old",
        issueId: "issue-old",
        createdAt: inMin(-60 * 24 * 7),
        renewedAt: inMin(-1),
      }),
      // Claimed ten minutes ago and never renewed: activity is the claim.
      makeLease({
        id: "lease-new",
        issueId: "issue-new",
        createdAt: inMin(-10),
        renewedAt: null,
      }),
    ];

    const res = await get("http://localhost/api/issues/ownership?state=");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.sourcesTruncated).toEqual({
      labeled: false,
      leased: false,
      working: false,
    });
    // Candidates are seeded from the lease scan in scan order, so `items`
    // mirrors it: the most recently touched lease first.
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([
      "issue-old",
      "issue-new",
    ]);
  });

  it("keeps the recently renewed lease and drops the stale never-renewed one when the lease source overflows its cap", async () => {
    db.issues = [
      makeIssue({ id: "issue-old", number: 1 }),
      makeIssue({ id: "issue-new", number: 2 }),
    ];
    // 1000 long-lived claims, all renewed a minute ago, plus one claim that
    // was never renewed and is therefore the stalest row in the source.
    db.leases = [
      ...Array.from({ length: CAP }, (_, i) =>
        makeLease({
          id: `lease-old-${String(i).padStart(4, "0")}`,
          agentName: `alpha-${i}`,
          issueId: "issue-old",
          createdAt: inMin(-60 * 24 * 7),
          renewedAt: inMin(-1),
        }),
      ),
      makeLease({
        id: "lease-new",
        agentName: "alpha-new",
        issueId: "issue-new",
        createdAt: inMin(-10),
        renewedAt: null,
      }),
    ];

    const res = await get("http://localhost/api/issues/ownership?state=");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.sourcesTruncated).toEqual({
      labeled: false,
      leased: true,
      working: false,
    });
    // The cap drops the stalest row — the never-renewed claim — and keeps the
    // live one. Under a `createdAt`-first order the live, long-lived claim was
    // the row that fell off the end of the scan.
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([
      "issue-old",
    ]);
    expect(body.examined).toBe(1);
  });

  it("orders the renewed run by renewal time, not by claim time", async () => {
    db.issues = [
      makeIssue({ id: "issue-x", number: 1 }),
      makeIssue({ id: "issue-y", number: 2 }),
    ];
    // Both leases were renewed, so their activity is the renewal — and the
    // claim times sort the other way round, so only a renewal-time order puts
    // `issue-x` first.
    db.leases = [
      makeLease({
        id: "lease-x",
        issueId: "issue-x",
        createdAt: inMin(-10),
        renewedAt: inMin(-1),
      }),
      makeLease({
        id: "lease-y",
        issueId: "issue-y",
        createdAt: inMin(-1),
        renewedAt: inMin(-10),
      }),
    ];

    const res = await get("http://localhost/api/issues/ownership?state=");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items.map((item: { id: string }) => item.id)).toEqual([
      "issue-x",
      "issue-y",
    ]);
  });

  it("orders the never-renewed run by claim time, not by lease id", async () => {
    db.issues = [
      makeIssue({ id: "issue-a", number: 1 }),
      makeIssue({ id: "issue-z", number: 2 }),
    ];
    // Both claims were never renewed, so their activity is the claim time —
    // and the ids sort the OTHER way round, so only a claim-time order puts
    // `issue-z` first.
    db.leases = [
      makeLease({
        id: "lease-a",
        issueId: "issue-a",
        createdAt: inMin(-10),
        renewedAt: null,
      }),
      makeLease({
        id: "lease-z",
        issueId: "issue-z",
        createdAt: inMin(-1),
        renewedAt: null,
      }),
    ];

    const res = await get("http://localhost/api/issues/ownership?state=");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items.map((item: { id: string }) => item.id)).toEqual([
      "issue-z",
      "issue-a",
    ]);
  });

  it("breaks equal-activity ties by ascending lease id in the never-renewed run too", async () => {
    db.issues = [
      makeIssue({ id: "issue-z", number: 2 }),
      makeIssue({ id: "issue-a", number: 1 }),
    ];
    // Same claim instant, and the ids sort the opposite way to the insertion
    // order — so only the query's `id: "asc"` tie-break puts `issue-a` first.
    db.leases = [
      makeLease({
        id: "lease-z",
        issueId: "issue-z",
        createdAt: inMin(-1),
        renewedAt: null,
      }),
      makeLease({
        id: "lease-a",
        issueId: "issue-a",
        createdAt: inMin(-1),
        renewedAt: null,
      }),
    ];

    const res = await get("http://localhost/api/issues/ownership?state=");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items.map((item: { id: string }) => item.id)).toEqual([
      "issue-a",
      "issue-z",
    ]);
  });

  it("breaks equal-activity ties by ascending lease id", async () => {
    db.issues = [
      makeIssue({ id: "issue-b", number: 2 }),
      makeIssue({ id: "issue-a", number: 1 }),
    ];
    // Same renewal instant: only the id tie-break separates the two, so this
    // fails if the test double does not honour the query's `id: "asc"`.
    db.leases = [
      makeLease({
        id: "lease-b",
        issueId: "issue-b",
        createdAt: inMin(-5),
        renewedAt: inMin(-1),
      }),
      makeLease({
        id: "lease-a",
        issueId: "issue-a",
        createdAt: inMin(-5),
        renewedAt: inMin(-1),
      }),
    ];

    const res = await get("http://localhost/api/issues/ownership?state=");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items.map((item: { id: string }) => item.id)).toEqual([
      "issue-a",
      "issue-b",
    ]);
  });

  it("applies the same id tie-break across the renewed and never-renewed runs", async () => {
    db.issues = [
      makeIssue({ id: "issue-z", number: 2 }),
      makeIssue({ id: "issue-a", number: 1 }),
    ];
    db.leases = [
      // Renewed lease: its activity is the renewal.
      makeLease({
        id: "lease-z",
        issueId: "issue-z",
        createdAt: inMin(-10),
        renewedAt: inMin(-1),
      }),
      // Never-renewed lease: its activity is the claim time — the SAME
      // instant, so only the id tie-break separates the two runs.
      makeLease({
        id: "lease-a",
        issueId: "issue-a",
        createdAt: inMin(-1),
        renewedAt: null,
      }),
    ];

    const res = await get("http://localhost/api/issues/ownership?state=");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items.map((item: { id: string }) => item.id)).toEqual([
      "issue-a",
      "issue-z",
    ]);
  });
});

describe("GET /api/issues/ownership — known bug (the no-filter branch)", () => {
  beforeEach(() => {
    reset();
    db.issues = [makeIssue({ labels: ["agent/alpha"] })];
    db.leases = [makeLease()];
  });

  // Regression (found by this suite, fixed): with the `state` param ABSENT,
  // `searchParams.get("state")?.trim()` yields `undefined`, and the old
  // no-filter guard only matched `""`, so a plain GET filtered on
  // `state === undefined` and always returned `items: []` while counts and
  // examined still reflected the full population.
  it("plain GET (no ?state param) returns the full item list", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.examined).toBe(1);
    expect(body.counts.CLAIMED_ACTIVE).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].assessment.state).toBe("CLAIMED_ACTIVE");
  });
});
