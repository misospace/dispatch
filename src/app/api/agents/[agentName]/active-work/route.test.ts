import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    leaseFindFirst: vi.fn(),
    leaseDelete: vi.fn(),
    issueFindUnique: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lease: {
      findFirst: mocks.leaseFindFirst,
      delete: mocks.leaseDelete,
    },
    issue: {
      findUnique: mocks.issueFindUnique,
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/next-action", () => ({
  buildResumeContext: vi.fn((input) => ({ ...input, nextAction: "inspect_issue" })),
  isValidCheckpoint: vi.fn((cp) => ["issue_claimed", "branch_created", "changes_made"].includes(cp)),
}));

import { GET as handleActiveWork } from "./route";

function makeActiveWorkRequest(agentName: string) {
  return handleActiveWork(
    new Request(`http://localhost/api/agents/${agentName}/active-work`),
    { params: Promise.resolve({ agentName }) }
  );
}

describe("GET /api/agents/:agentName/active-work", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: return the same lease for both findFirst calls (resolveActiveWork and leaseId fetch)
    mocks.leaseFindFirst.mockResolvedValue({
      id: "l-1",
      agentName: "test-agent",
      issueId: "issue-abc",
      checkpoint: "issue_claimed",
      branch: "feat/my-feature",
      prUrl: null,
      expiredAt: new Date(Date.now() + 60000),
      renewedAt: new Date(),
      issue: {
        number: 42,
        repository: { fullName: "org/repo" },
        state: "status/in-progress",
        labels: ["agent/test-agent", "priority/p1"],
        currentLane: "local",
      },
    });
    mocks.issueFindUnique.mockResolvedValue({ id: "issue-abc" });
  });

  it("returns hasActiveWork: true with context and leaseId when agent has an active lease", async () => {
    const res = await makeActiveWorkRequest("test-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasActiveWork).toBe(true);
    expect(body.context.issueId).toBe("issue-abc");
    expect(body.context.repoFullName).toBe("org/repo");
    expect(body.context.issueNumber).toBe(42);
    expect(body.context.branch).toBe("feat/my-feature");
    expect(body.context.leaseId).toBe("l-1");
    expect(body.context.lane).toBe("local");
    expect(body.context.status).toBe("status/in-progress");
    expect(body.context.labels).toEqual(["agent/test-agent", "priority/p1"]);
  });

  it("returns hasActiveWork: false when no active lease exists", async () => {
    mocks.leaseFindFirst.mockResolvedValueOnce(null);

    const res = await makeActiveWorkRequest("unknown-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasActiveWork).toBe(false);
  });

  it("returns hasActiveWork: false when all leases are expired", async () => {
    mocks.leaseFindFirst.mockResolvedValueOnce({
      id: "l-1",
      agentName: "test-agent",
      issueId: "issue-abc",
      checkpoint: "issue_claimed",
      branch: null,
      prUrl: null,
      expiredAt: new Date(Date.now() - 60000),
      renewedAt: new Date(Date.now() - 120000),
      issue: {
        number: 42,
        repository: { fullName: "org/repo" },
        state: "status/in-progress",
        labels: [],
        currentLane: "local",
      },
    });

    const res = await makeActiveWorkRequest("test-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasActiveWork).toBe(false);
  });

  it("returns hasActiveWork: false when checkpoint is invalid", async () => {
    mocks.leaseFindFirst.mockResolvedValueOnce({
      id: "l-1",
      agentName: "test-agent",
      issueId: "issue-abc",
      checkpoint: "invalid_checkpoint",
      branch: null,
      prUrl: null,
      expiredAt: new Date(Date.now() + 60000),
      renewedAt: new Date(),
      issue: {
        number: 42,
        repository: { fullName: "org/repo" },
        state: "status/in-progress",
        labels: [],
        currentLane: "local",
      },
    });

    const res = await makeActiveWorkRequest("test-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasActiveWork).toBe(false);
  });

  it("returns hasActiveWork: false when referenced issue is missing (orphaned lease)", async () => {
    mocks.leaseFindFirst.mockResolvedValueOnce({
      id: "l-1",
      agentName: "test-agent",
      issueId: "issue-missing",
      checkpoint: "issue_claimed",
      branch: null,
      prUrl: null,
      expiredAt: new Date(Date.now() + 60000),
      renewedAt: new Date(),
      issue: {
        number: 999,
        repository: { fullName: "org/repo" },
        state: "status/in-progress",
        labels: [],
        currentLane: "local",
      },
    });

    mocks.issueFindUnique.mockResolvedValueOnce(null);

    const res = await makeActiveWorkRequest("test-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasActiveWork).toBe(false);
  });

  it("returns escalated lane metadata when issue is in escalated lane", async () => {
    mocks.leaseFindFirst.mockResolvedValueOnce({
      id: "l-2",
      agentName: "escalated-agent",
      issueId: "issue-xyz",
      checkpoint: "changes_made",
      branch: "feat/esc-fix",
      prUrl: null,
      expiredAt: new Date(Date.now() + 60000),
      renewedAt: new Date(),
      issue: {
        number: 55,
        repository: { fullName: "org/repo" },
        state: "status/in-progress",
        labels: ["agent/escalated-agent", "priority/p1"],
        currentLane: "frontier",
      },
    });

    const res = await makeActiveWorkRequest("escalated-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasActiveWork).toBe(true);
    expect(body.context.lane).toBe("frontier");
    expect(body.context.status).toBe("status/in-progress");
    expect(body.context.labels).toEqual(["agent/escalated-agent", "priority/p1"]);
  });

  it("returns backlog lane metadata when issue is in backlog lane", async () => {
    mocks.leaseFindFirst.mockResolvedValueOnce({
      id: "l-3",
      agentName: "test-agent",
      issueId: "issue-backlog",
      checkpoint: "issue_claimed",
      branch: null,
      prUrl: null,
      expiredAt: new Date(Date.now() + 60000),
      renewedAt: new Date(),
      issue: {
        number: 77,
        repository: { fullName: "org/repo" },
        state: "status/backlog",
        labels: ["agent/test-agent"],
        currentLane: "backlog",
      },
    });

    const res = await makeActiveWorkRequest("test-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasActiveWork).toBe(true);
    expect(body.context.lane).toBe("backlog");
    expect(body.context.status).toBe("status/backlog");
  });

  it("defaults lane to default when currentLane is null", async () => {
    mocks.leaseFindFirst.mockResolvedValueOnce({
      id: "l-4",
      agentName: "test-agent",
      issueId: "issue-null-lane",
      checkpoint: "issue_claimed",
      branch: null,
      prUrl: null,
      expiredAt: new Date(Date.now() + 60000),
      renewedAt: new Date(),
      issue: {
        number: 88,
        repository: { fullName: "org/repo" },
        state: "status/ready",
        labels: [],
        currentLane: null,
      },
    });

    const res = await makeActiveWorkRequest("test-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasActiveWork).toBe(true);
    expect(body.context.lane).toBe("default");
  });

  it("returns lane/status metadata for closed issue (stale lease still resolvable)", async () => {
    mocks.leaseFindFirst.mockResolvedValueOnce({
      id: "l-5",
      agentName: "test-agent",
      issueId: "issue-closed",
      checkpoint: "changes_made",
      branch: "feat/closed-issue-fix",
      prUrl: null,
      expiredAt: new Date(Date.now() + 60000),
      renewedAt: new Date(),
      issue: {
        number: 200,
        repository: { fullName: "org/repo" },
        state: "status/done",
        labels: ["type/bug", "priority/p1"],
        currentLane: "local",
      },
    });

    const res = await makeActiveWorkRequest("test-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasActiveWork).toBe(true);
    expect(body.context.lane).toBe("local");
    expect(body.context.status).toBe("status/done");
    expect(body.context.labels).toEqual(["type/bug", "priority/p1"]);
  });

  it("returns hasActiveWork: false when referenced issue is missing (orphaned lease)", async () => {
    mocks.leaseFindFirst.mockResolvedValueOnce({
      id: "l-1",
      agentName: "test-agent",
      issueId: "issue-missing",
      checkpoint: "issue_claimed",
      branch: null,
      prUrl: null,
      expiredAt: new Date(Date.now() + 60000),
      renewedAt: new Date(),
      issue: {
        number: 999,
        repository: { fullName: "org/repo" },
        state: "status/in-progress",
        labels: [],
        currentLane: "local",
      },
    });

    mocks.issueFindUnique.mockResolvedValueOnce(null);

    const res = await makeActiveWorkRequest("test-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasActiveWork).toBe(false);
  });
});
