import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    leaseFindUnique: vi.fn(),
    leaseFindUniqueOrThrow: vi.fn(),
    leaseCreate: vi.fn(),
    leaseUpdate: vi.fn(),
    leaseDelete: vi.fn(),
    leaseDeleteMany: vi.fn(),
    leaseFindFirst: vi.fn(),
    leaseFindMany: vi.fn(),
    issueFindUnique: vi.fn(),
    auditLogCreate: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lease: {
      findUnique: mocks.leaseFindUnique,
      findUniqueOrThrow: mocks.leaseFindUniqueOrThrow,
      create: mocks.leaseCreate,
      update: mocks.leaseUpdate,
      delete: mocks.leaseDelete,
      deleteMany: mocks.leaseDeleteMany,
      findFirst: mocks.leaseFindFirst,
      findMany: mocks.leaseFindMany,
    },
    issue: {
      findUnique: mocks.issueFindUnique,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
  },
}));

vi.mock("@/lib/next-action", () => ({
  buildResumeContext: vi.fn((input) => ({ ...input, nextAction: "inspect_issue" })),
  isValidCheckpoint: vi.fn((cp) => ["issue_claimed", "branch_created", "changes_made"].includes(cp)),
}));

import { upsertLease, isLeaseExpired, findActiveLeasesForIssue, findExpiredLeasesForIssue, releaseLease, releaseExpiredLeases, resolveActiveWork, findLeasedIssueIds, calculateLeaseExpiry, DEFAULT_LEASE_TTL_MS } from "./lease";

function makeNow() { return new Date(); }
function makeLease(overrides: Partial<any> = {}) {
  const now = makeNow();
  return { id: "l-1", agentName: "saffron", issueId: "i-1", checkpoint: "issue_claimed", branch: null, prUrl: null, expiredAt: now, renewedAt: null, createdAt: now, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("calculateLeaseExpiry", () => {
  it("returns a date TTL milliseconds in the future", () => {
    const expiry = calculateLeaseExpiry(60_000);
    expect(expiry.getTime()).toBeGreaterThan(Date.now());
    expect(expiry.getTime() - Date.now()).toBeGreaterThan(59_000);
  });

  it("uses DEFAULT_LEASE_TTL_MS when no TTL provided", () => {
    const before = Date.now();
    const expiry = calculateLeaseExpiry();
    const after = Date.now();
    expect(expiry.getTime() - before).toBeGreaterThanOrEqual(DEFAULT_LEASE_TTL_MS - 2);
    expect(expiry.getTime() - before).toBeLessThanOrEqual(DEFAULT_LEASE_TTL_MS + 2);
  });
});

describe("isLeaseExpired", () => {
  it("returns true when expiredAt is in the past", () => {
    const lease = { expiredAt: new Date(Date.now() - 1000) };
    expect(isLeaseExpired(lease)).toBe(true);
  });

  it("returns false when expiredAt is in the future", () => {
    const lease = { expiredAt: new Date(Date.now() + 1000) };
    expect(isLeaseExpired(lease)).toBe(false);
  });

  it("returns true when expiredAt equals now (at boundary)", () => {
    const now = new Date();
    const lease = { expiredAt: now };
    expect(isLeaseExpired(lease, now)).toBe(true);
  });
});

describe("upsertLease", () => {
  describe("create path", () => {
    it("creates a new lease when none exists", async () => {
      mocks.leaseFindUnique.mockImplementation(() => Promise.resolve(null));
      const now = makeNow();
      mocks.leaseCreate.mockImplementation((args: any) => Promise.resolve({ id: "l-1", ...args.data }));

      const result = await upsertLease({ agentName: "saffron", issueId: "i-1" });

      expect(result.created).toBe(true);
      const callData = (mocks.leaseCreate.mock.calls[0] as any)[0].data;
      expect(callData.agentName).toBe("saffron");
      expect(callData.issueId).toBe("i-1");
      expect(callData.checkpoint).toBe("issue_claimed");
    });

    it("passes checkpoint and branch to create", async () => {
      mocks.leaseFindUnique.mockImplementation(() => Promise.resolve(null));
      mocks.leaseCreate.mockImplementation((args: any) => Promise.resolve({ id: "l-1", ...args.data }));

      await upsertLease({ agentName: "saffron", issueId: "i-1", checkpoint: "branch_created", branch: "fix/123" });

      const callData = (mocks.leaseCreate.mock.calls[0] as any)[0].data;
      expect(callData.checkpoint).toBe("branch_created");
      expect(callData.branch).toBe("fix/123");
    });

    it("passes prUrl to create", async () => {
      mocks.leaseFindUnique.mockImplementation(() => Promise.resolve(null));
      mocks.leaseCreate.mockImplementation((args: any) => Promise.resolve({ id: "l-1", ...args.data }));

      await upsertLease({ agentName: "saffron", issueId: "i-1", checkpoint: "pr_opened", branch: "fix/123", prUrl: "https://github.com/org/repo/pull/456" });

      const callData = (mocks.leaseCreate.mock.calls[0] as any)[0].data;
      expect(callData.prUrl).toBe("https://github.com/org/repo/pull/456");
    });
  });

  describe("renew path", () => {
    it("renews an existing lease (same agent, same issue)", async () => {
      const now = makeNow();
      mocks.leaseFindUnique.mockImplementation(() => Promise.resolve(makeLease({ id: "l-1" })));
      mocks.leaseUpdate.mockImplementation((args: any) => Promise.resolve({ ...makeLease(args.where), ...args.data }));
      mocks.leaseFindUniqueOrThrow.mockImplementation(() => Promise.resolve(makeLease({ renewedAt: now })));

      const result = await upsertLease({ agentName: "saffron", issueId: "i-1" });

      expect(result.created).toBe(false);
      expect(mocks.leaseUpdate).toHaveBeenCalled();
      const updateData = (mocks.leaseUpdate.mock.calls[0] as any)[0].data;
      expect(updateData.renewedAt).toBeDefined();
    });

    it("updates checkpoint on renewal", async () => {
      mocks.leaseFindUnique.mockImplementation(() => Promise.resolve(makeLease({ id: "l-1" })));
      mocks.leaseUpdate.mockImplementation((args: any) => Promise.resolve({ ...makeLease(args.where), ...args.data }));
      mocks.leaseFindUniqueOrThrow.mockImplementation(() => Promise.resolve(makeLease({ checkpoint: "branch_created", branch: "fix/123" })));

      await upsertLease({ agentName: "saffron", issueId: "i-1", checkpoint: "branch_created", branch: "fix/123" });

      const updateData = (mocks.leaseUpdate.mock.calls[0] as any)[0].data;
      expect(updateData.checkpoint).toBe("branch_created");
      expect(updateData.branch).toBe("fix/123");
    });
  });
});

describe("findActiveLeasesForIssue", () => {
  it("returns leases with expiredAt in the future", async () => {
    mocks.leaseFindMany.mockImplementation(() => Promise.resolve([makeLease({ id: "l-1", expiredAt: new Date(Date.now() + 1000) })]));

    const result = await findActiveLeasesForIssue("i-1");

    expect(result).toHaveLength(1);
    expect(mocks.leaseFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ issueId: "i-1", expiredAt: { gt: expect.any(Date) } }),
    }));
  });

  it("returns empty array when no active leases exist", async () => {
    mocks.leaseFindMany.mockImplementation(() => Promise.resolve([]));

    const result = await findActiveLeasesForIssue("i-99");

    expect(result).toEqual([]);
  });
});

describe("findExpiredLeasesForIssue", () => {
  it("returns leases with expiredAt in the past", async () => {
    mocks.leaseFindMany.mockImplementation(() => Promise.resolve([makeLease({ id: "l-1", expiredAt: new Date(Date.now() - 1000) })]));

    const result = await findExpiredLeasesForIssue("i-1");

    expect(result).toHaveLength(1);
    expect(mocks.leaseFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ issueId: "i-1", expiredAt: { lte: expect.any(Date) } }),
    }));
  });
});

describe("releaseLease", () => {
  it("deletes the lease and returns it", async () => {
    mocks.leaseDelete.mockImplementation(() => Promise.resolve(makeLease({ id: "l-1" })));

    const result = await releaseLease("l-1");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("l-1");
    expect(mocks.leaseDelete).toHaveBeenCalledWith({ where: { id: "l-1" } });
  });

  it("returns null on failure", async () => {
    mocks.leaseDelete.mockImplementation(() => Promise.reject(new Error("not found")));

    const result = await releaseLease("nonexistent");

    expect(result).toBeNull();
  });
});

describe("releaseExpiredLeases", () => {
  it("deletes all expired leases for an issue and returns count", async () => {
    mocks.leaseFindMany.mockImplementation(() => Promise.resolve([{ id: "l-1" }, { id: "l-2" }]));
    mocks.leaseDeleteMany.mockImplementation(() => Promise.resolve({ count: 2 }));

    const result = await releaseExpiredLeases("i-1");

    expect(result).toBe(2);
    expect(mocks.leaseDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["l-1", "l-2"] } },
    });
  });

  it("returns 0 and skips delete when no expired leases exist", async () => {
    mocks.leaseFindMany.mockImplementation(() => Promise.resolve([]));

    const result = await releaseExpiredLeases("i-99");

    expect(result).toBe(0);
    expect(mocks.leaseDeleteMany).not.toHaveBeenCalled();
  });
});

describe("resolveActiveWork", () => {
  it("returns resume context when agent has an active lease", async () => {
    mocks.leaseFindFirst.mockImplementation(() => Promise.resolve({
      id: "l-1",
      agentName: "saffron",
      issueId: "i-1",
      checkpoint: "issue_claimed",
      branch: null,
      prUrl: null,
      expiredAt: new Date(Date.now() + 60_000),
      renewedAt: makeNow(),
      createdAt: makeNow(),
      issue: { number: 42, repository: { fullName: "misospace/dispatch" } },
    }));

    mocks.issueFindUnique.mockImplementation(() => Promise.resolve({ id: "i-1" }));

    const result = await resolveActiveWork("saffron");

    expect(result).not.toBeNull();
    expect(result!.issueNumber).toBe(42);
    expect(result!.repoFullName).toBe("misospace/dispatch");
  });

  it("returns null when agent has no active lease", async () => {
    mocks.leaseFindFirst.mockImplementation(() => Promise.resolve(null));

    const result = await resolveActiveWork("opencode");

    expect(result).toBeNull();
  });

  it("returns most recently renewed lease when multiple exist", async () => {
    mocks.leaseFindFirst.mockImplementation(() => Promise.resolve({
      id: "l-2",
      agentName: "saffron",
      issueId: "i-2",
      checkpoint: "branch_created",
      branch: "fix/123",
      prUrl: null,
      expiredAt: new Date(Date.now() + 60_000),
      renewedAt: makeNow(),
      createdAt: makeNow(),
      issue: { number: 123, repository: { fullName: "org/repo" } },
    }));

    mocks.issueFindUnique.mockImplementation(() => Promise.resolve({ id: "i-2" }));

    const result = await resolveActiveWork("saffron");

    expect(result!.issueNumber).toBe(123);
    expect(mocks.leaseFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { renewedAt: "desc" },
    }));
  });

  it("releases and returns null for corrupted checkpoint", async () => {
    mocks.leaseFindFirst.mockImplementation(() => Promise.resolve({
      id: "l-1",
      agentName: "saffron",
      issueId: "i-1",
      checkpoint: "invalid_checkpoint_value",
      branch: null,
      prUrl: null,
      expiredAt: new Date(Date.now() + 60_000),
      renewedAt: makeNow(),
      createdAt: makeNow(),
      issue: { number: 42, repository: { fullName: "misospace/dispatch" } },
    }));

    const result = await resolveActiveWork("saffron");

    expect(result).toBeNull();
    expect(mocks.leaseDelete).toHaveBeenCalledWith({ where: { id: "l-1" } });
  });

  it("releases and returns null when referenced issue is missing (orphaned lease)", async () => {
    mocks.leaseFindFirst.mockImplementation(() => Promise.resolve({
      id: "l-1",
      agentName: "saffron",
      issueId: "i-missing",
      checkpoint: "issue_claimed",
      branch: null,
      prUrl: null,
      expiredAt: new Date(Date.now() + 60_000),
      renewedAt: makeNow(),
      createdAt: makeNow(),
      issue: { number: 999, repository: { fullName: "misospace/dispatch" } },
    }));

    mocks.issueFindUnique.mockImplementation(() => Promise.resolve(null));

    const result = await resolveActiveWork("saffron");

    expect(result).toBeNull();
    expect(mocks.leaseDelete).toHaveBeenCalledWith({ where: { id: "l-1" } });
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "orphan_lease_released",
          notes: expect.stringContaining("referenced issue i-missing not found in Dispatch"),
        }),
      })
    );
  });

  it("returns context and does not release when referenced issue exists", async () => {
    mocks.leaseFindFirst.mockImplementation(() => Promise.resolve({
      id: "l-1",
      agentName: "saffron",
      issueId: "i-1",
      checkpoint: "issue_claimed",
      branch: null,
      prUrl: null,
      expiredAt: new Date(Date.now() + 60_000),
      renewedAt: makeNow(),
      createdAt: makeNow(),
      issue: { number: 42, repository: { fullName: "misospace/dispatch" } },
    }));

    mocks.issueFindUnique.mockImplementation(() => Promise.resolve({ id: "i-1" }));

    const result = await resolveActiveWork("saffron");

    expect(result).not.toBeNull();
    expect(result!.issueNumber).toBe(42);
    expect(mocks.leaseDelete).not.toHaveBeenCalled();
  });
});

describe("findLeasedIssueIds", () => {
  it("returns issue IDs of leases from other agents", async () => {
    mocks.leaseFindMany.mockImplementation(() => Promise.resolve([
      { issueId: "i-1" },
      { issueId: "i-2" },
    ]));

    const result = await findLeasedIssueIds("saffron");

    expect(result).toEqual(["i-1", "i-2"]);
    expect(mocks.leaseFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ agentName: { not: "saffron" } }),
    }));
  });

  it("returns empty array when no other-agent leases exist", async () => {
    mocks.leaseFindMany.mockImplementation(() => Promise.resolve([]));

    const result = await findLeasedIssueIds("saffron");

    expect(result).toEqual([]);
  });
});
