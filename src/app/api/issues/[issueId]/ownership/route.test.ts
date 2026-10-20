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
});
