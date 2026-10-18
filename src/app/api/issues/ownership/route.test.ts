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
const { db } = vi.hoisted(() => ({
  db: {
    issues: [] as any[],
    leases: [] as any[],
    agentWorks: [] as any[],
    prFixes: [] as any[],
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      // list route: { where: { repository: { enabled }, state } }
      findMany: async ({ where }: any) =>
        db.issues.filter(
          (i) =>
            i.state === where.state &&
            (!where.repository ||
              i.repository?.enabled === where.repository.enabled),
        ),
      // inspectIssueOwnership: { where: { id }, include: { repository } }
      findUnique: async ({ where }: any) =>
        db.issues.find((i) => i.id === where.id) ?? null,
    },
    lease: {
      // list route: { where: { expiredAt: { gt } } }
      // inspect:     { where: { issueId } }
      findMany: async (args?: any) => {
        const w = args?.where;
        if (w?.issueId) return db.leases.filter((l) => l.issueId === w.issueId);
        if (w?.expiredAt?.gt) {
          const t = new Date(w.expiredAt.gt).getTime();
          return db.leases.filter((l) => l.expiredAt.getTime() > t);
        }
        return db.leases;
      },
    },
    agentWork: {
      // list route: { where: { issueId: { not: null }, state: { in } } }
      findMany: async ({ where }: any) =>
        db.agentWorks.filter(
          (w) =>
            w.issueId !== null &&
            (where.state?.in ?? []).includes(w.state),
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

describe("GET /api/issues/ownership — known bug (route.ts:122-126)", () => {
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
