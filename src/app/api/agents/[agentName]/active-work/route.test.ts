import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    leaseFindFirst: vi.fn(),
    leaseDelete: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lease: {
      findFirst: mocks.leaseFindFirst,
      delete: mocks.leaseDelete,
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
  });

  it("returns hasActiveWork: true with context when agent has an active lease", async () => {
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
      },
    });

    const res = await makeActiveWorkRequest("test-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasActiveWork).toBe(true);
    expect(body.context.issueId).toBe("issue-abc");
    expect(body.context.repoFullName).toBe("org/repo");
    expect(body.context.issueNumber).toBe(42);
    expect(body.context.branch).toBe("feat/my-feature");
  });

  it("returns hasActiveWork: false when no active lease exists", async () => {
    mocks.leaseFindFirst.mockResolvedValue(null);

    const res = await makeActiveWorkRequest("unknown-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasActiveWork).toBe(false);
  });

  it("returns hasActiveWork: false when all leases are expired", async () => {
    mocks.leaseFindFirst.mockResolvedValue({
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
      },
    });

    const res = await makeActiveWorkRequest("test-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasActiveWork).toBe(false);
  });

  it("returns hasActiveWork: false when checkpoint is invalid", async () => {
    mocks.leaseFindFirst.mockResolvedValue({
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
      },
    });

    const res = await makeActiveWorkRequest("test-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasActiveWork).toBe(false);
  });
});
