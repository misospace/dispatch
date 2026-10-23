import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authedRequest,
  makeDispatchEnvMock,
  TEST_AGENT_TOKEN as mockToken,
} from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

// maintainer (default token) plus a worker-tier token for the central-tiering
// 403 test; ownership windows kept at their defaults (15m / 45m).
vi.mock("@/lib/dispatch-env", () =>
  makeDispatchEnvMock(mockToken, { "worker-ownership-token": "worker" }),
);

const { mocks, db } = vi.hoisted(() => ({
  mocks: {
    getLiveIssueLabels: vi.fn<(repo: string, num: number) => Promise<string[]>>(async () => []),
  },
  db: {
    issue: null as any,
    leases: [] as any[],
    agentWork: null as any,
    prFix: null as any,
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      findUnique: async ({ where }: any) =>
        db.issue && db.issue.id === where.id ? db.issue : null,
    },
    lease: { findMany: async () => db.leases },
    agentWork: { findFirst: async () => db.agentWork },
    prFixQueueItem: { findFirst: async () => db.prFix },
  },
}));

vi.mock("@/lib/claim-gate", () => ({
  getLiveIssueLabels: mocks.getLiveIssueLabels,
}));

import { GET } from "./route";
import { resetAuthCaches } from "@/lib/auth";

const NOW = new Date();
const inMin = (n: number) => new Date(NOW.getTime() + n * 60_000);
const CLAIM_TOKEN = "SECRET-CLAIM-TOKEN-123";

function makeContext(overrides: { issueId?: string } = {}) {
  return { params: Promise.resolve({ issueId: overrides.issueId ?? "issue-1" }) };
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    number: 42,
    state: "open",
    labels: ["agent/alice", "status/in-progress"],
    blockedReason: null,
    linkedPrNumber: null,
    linkedPrMergeState: null,
    repository: { fullName: "org/repo" },
    ...overrides,
  };
}

function makeLease(overrides: Record<string, unknown> = {}) {
  return {
    id: "lease-1",
    agentName: "alice",
    issueId: "issue-1",
    expiredAt: inMin(30),
    renewedAt: inMin(-1),
    claimToken: CLAIM_TOKEN,
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

function get(url = "http://localhost/api/issues/issue-1/ownership", opts: { token?: string; includeAuth?: boolean } = {}) {
  return GET(
    authedRequest(url, { token: opts.token, includeAuth: opts.includeAuth }),
    makeContext(),
  );
}

describe("GET /api/issues/[issueId]/ownership — auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuthCaches();
    delete process.env.DISPATCH_AUTH_MODE;
    db.issue = makeIssue();
    db.leases = [makeLease()];
    db.agentWork = null;
    db.prFix = null;
    mocks.getLiveIssueLabels.mockResolvedValue(["agent/alice", "status/in-progress"]);
  });

  it("returns 401 when no authorization header is provided", async () => {
    const res = await get(undefined, { includeAuth: false });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an unknown token", async () => {
    const res = await get(undefined, { token: "wrong-token" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a worker-tier token via the central tiering", async () => {
    const res = await get(undefined, { token: "worker-ownership-token" });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/issues/[issueId]/ownership — derivation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuthCaches();
    delete process.env.DISPATCH_AUTH_MODE;
    db.leases = [makeLease()];
    db.agentWork = null;
    db.prFix = null;
    mocks.getLiveIssueLabels.mockResolvedValue(["agent/alice", "status/in-progress"]);
  });

  it("derives the state, redacts the claim token, and reports its presence", async () => {
    db.issue = makeIssue();
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.found).toBe(true);
    expect(body.issue).toEqual({
      id: "issue-1",
      number: 42,
      repoFullName: "org/repo",
      state: "open",
    });
    expect(body.assessment.state).toBe("CLAIMED_ACTIVE");
    expect(body.assessment.verified).toBe(true);
    expect(body.assessment.ownerAgent).toBe("alice");
    expect(body.evidence.labelSource).toBe("live");
    expect(body.evidence.lease?.claimTokenPresent).toBe(true);

    // The raw claim token must never leak through a read path.
    expect(JSON.stringify(body)).not.toContain(CLAIM_TOKEN);
  });

  it("falls back to the cached set and marks the read unverified when the forge is unreachable", async () => {
    db.issue = makeIssue();
    mocks.getLiveIssueLabels.mockRejectedValue(new Error("github unreachable"));
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.assessment.verified).toBe(false);
    expect(body.evidence.labelSource).toBe("unavailable");
    // First-party evidence (the fresh lease) still drives the ladder.
    expect(body.assessment.state).toBe("CLAIMED_ACTIVE");
    expect(body.assessment.reasonCodes).toContain("labels_unverified");
  });

  it("derives the cached label set without a forge call when live=false", async () => {
    db.issue = makeIssue();
    const res = await get("http://localhost/api/issues/issue-1/ownership?live=false");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.evidence.labelSource).toBe("cache");
    expect(body.assessment.verified).toBe(false);
    expect(mocks.getLiveIssueLabels).not.toHaveBeenCalled();
  });

  it("returns 404 when the issue is not in the local cache", async () => {
    db.issue = null;
    const res = await get();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Issue not found");
  });

  // #1312 — the per-issue lease selection must use the SAME activity key as
  // the bounded ownership scan (`renewedAt ?? createdAt` desc, `id` asc
  // tiebreak), or the scan and this view disagree about which lease on a
  // multi-lease issue is operative.
  it("reports the most recently ACTIVE lease, not the most recently renewed one", async () => {
    db.issue = makeIssue({ labels: ["agent/bob", "status/in-progress"] });
    mocks.getLiveIssueLabels.mockResolvedValue(["agent/bob", "status/in-progress"]);
    db.leases = [
      // alice: claimed 2h ago, last renewed 30m ago (active).
      makeLease({
        id: "lease-alice",
        agentName: "alice",
        createdAt: inMin(-120),
        renewedAt: inMin(-30),
        expiredAt: inMin(20),
        lastRenewalObservedAt: inMin(-30),
        lastRenewalOccurredAt: inMin(-30),
      }),
      // bob: claimed 5m ago, never renewed (active). Its activity (the claim
      // time) is more recent than alice's last renewal, so the scan ranks it
      // first and this view must report it as the operative lease.
      makeLease({
        id: "lease-bob",
        agentName: "bob",
        createdAt: inMin(-5),
        renewedAt: null,
        registeredAt: inMin(-5),
        renewCount: 0,
        lastRenewalObservedAt: null,
        lastRenewalOccurredAt: null,
        expiredAt: inMin(30),
      }),
    ];

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.evidence.lease?.agentName).toBe("bob");
    expect(body.assessment.ownerAgent).toBe("bob");
    expect(body.assessment.state).toBe("CLAIMED_ACTIVE");
    expect(body.assessment.reasonCodes).not.toContain("lease_owner_mismatch");
  });

  it("breaks equal lease activity by id ascending, matching the scan's tie-break", async () => {
    db.issue = makeIssue({ labels: ["agent/carol", "status/in-progress"] });
    mocks.getLiveIssueLabels.mockResolvedValue(["agent/carol", "status/in-progress"]);
    db.leases = [
      // dave: renewed 10m ago (created 90m ago) — activity 10m ago. The ids
      // are cuid-shaped (lower-case alphanumeric) so the tie-break exercises
      // the same id space whose JS-vs-database ordering equivalence the scan
      // relies on.
      makeLease({
        id: "clz0tiebreak0dave",
        agentName: "dave",
        createdAt: inMin(-90),
        renewedAt: inMin(-10),
        expiredAt: inMin(20),
        lastRenewalObservedAt: inMin(-10),
        lastRenewalOccurredAt: inMin(-10),
      }),
      // carol: claimed 10m ago, never renewed — activity 10m ago (equal).
      // The lower id wins, as it does in the scan's `id ASC` tie-break.
      makeLease({
        id: "cla0tiebreak0carol",
        agentName: "carol",
        createdAt: inMin(-10),
        renewedAt: null,
        registeredAt: inMin(-10),
        renewCount: 0,
        lastRenewalObservedAt: null,
        lastRenewalOccurredAt: null,
        expiredAt: inMin(30),
      }),
    ];

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.evidence.lease?.agentName).toBe("carol");
    expect(body.assessment.ownerAgent).toBe("carol");
    expect(body.assessment.state).toBe("CLAIMED_ACTIVE");
  });
});
