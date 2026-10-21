import { describe, expect, it, vi, beforeEach } from "vitest";

process.env.DISPATCH_QUEUE_ADMISSION_MODE = "off";

const { mocks, writes } = vi.hoisted(() => {
  const writeMethodNames = ["create", "update", "updateMany", "upsert", "delete", "deleteMany"] as const;
  type MockFn = ReturnType<typeof vi.fn>;
  const writes: Array<MockFn> = [];
  const delegate = (reads: Record<string, MockFn>) => {
    const out: Record<string, MockFn> = { ...reads };
    for (const name of writeMethodNames) {
      const fn = vi.fn().mockRejectedValue(new Error(`write attempted: ${name}`));
      out[name] = fn;
      writes.push(fn);
    }
    return out;
  };
  const mocks = {
    issue: delegate({
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    }),
    lease: delegate({ findMany: vi.fn().mockResolvedValue([]) }),
    agentWork: delegate({ findMany: vi.fn().mockResolvedValue([]) }),
    prFixQueueItem: delegate({ findMany: vi.fn().mockResolvedValue([]) }),
    prFixHistory: delegate({ findMany: vi.fn().mockResolvedValue([]) }),
    agentRun: delegate({ findMany: vi.fn().mockResolvedValue([]) }),
    auditLog: delegate({ findMany: vi.fn().mockResolvedValue([]) }),
    groomingRun: delegate({ findMany: vi.fn().mockResolvedValue([]) }),
    issueSyncRun: delegate({
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    }),
    automationRepo: delegate({ findMany: vi.fn().mockResolvedValue([]) }),
  };
  return { mocks, writes };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks }));

import { collectObservabilitySnapshot, strandedAssignmentThresholdMs } from "./observability-snapshot";

const NOW = new Date("2026-01-02T03:04:05.000Z");

const READY_ISSUE = {
  id: "issue-1",
  number: 42,
  state: "open",
  labels: ["status/ready"],
  title: "Do the thing",
  body: null,
  currentLane: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  lastSyncedAt: NOW,
  nativeBlockedBy: [],
  groomedRunId: null,
  groomedIssueFingerprint: null,
  groomedEvidenceDigest: null,
  groomedEvidenceScope: null,
  groomingStaleAt: null,
  groomingStaleReasons: [],
  groomingVerifiedSha: null,
  groomingRetryAfter: null,
  admissionOverrideId: null,
  repository: { fullName: "owner/repo" },
};

describe("strandedAssignmentThresholdMs", () => {
  it("defaults to 30 minutes", () => {
    expect(strandedAssignmentThresholdMs({})).toBe(1_800_000);
  });

  it("honours a valid env override", () => {
    expect(
      strandedAssignmentThresholdMs({ DISPATCH_OBSERVABILITY_STRANDED_ASSIGNMENT_MS: "600000" }),
    ).toBe(600_000);
  });

  it("falls back to the default for zero and non-numeric values", () => {
    expect(strandedAssignmentThresholdMs({ DISPATCH_OBSERVABILITY_STRANDED_ASSIGNMENT_MS: "0" })).toBe(
      1_800_000,
    );
    expect(strandedAssignmentThresholdMs({ DISPATCH_OBSERVABILITY_STRANDED_ASSIGNMENT_MS: "abc" })).toBe(
      1_800_000,
    );
  });

  it("clamps into the allowed range", () => {
    expect(strandedAssignmentThresholdMs({ DISPATCH_OBSERVABILITY_STRANDED_ASSIGNMENT_MS: "1000" })).toBe(
      60_000,
    );
    expect(
      strandedAssignmentThresholdMs({ DISPATCH_OBSERVABILITY_STRANDED_ASSIGNMENT_MS: "99999999999" }),
    ).toBe(86_400_000);
  });
});

describe("collectObservabilitySnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DISPATCH_QUEUE_ADMISSION_MODE = "off";
    mocks.issue.findMany.mockResolvedValue([READY_ISSUE]);
    mocks.issue.findFirst.mockResolvedValue(null);
    mocks.issue.count.mockResolvedValue(0);
    mocks.lease.findMany.mockResolvedValue([]);
    mocks.agentWork.findMany.mockResolvedValue([]);
    mocks.prFixQueueItem.findMany.mockResolvedValue([]);
    mocks.prFixHistory.findMany.mockResolvedValue([]);
    mocks.agentRun.findMany.mockResolvedValue([]);
    mocks.auditLog.findMany.mockResolvedValue([]);
    mocks.groomingRun.findMany.mockResolvedValue([]);
    mocks.issueSyncRun.findMany.mockResolvedValue([]);
    mocks.issueSyncRun.findFirst.mockResolvedValue(null);
    mocks.issueSyncRun.count.mockResolvedValue(0);
    mocks.automationRepo.findMany.mockResolvedValue([]);
  });

  it("computes the signal snapshot from read-only rows", async () => {
    const snapshot = await collectObservabilitySnapshot(NOW);

    expect(snapshot.workSupply.openClaimable).toBe(1);
    expect(snapshot.pipeline.sync.everSucceeded).toBe(false);
    expect(snapshot.observations.neverSyncedSuccessfully).toBe(true);
    expect(snapshot.execution.executionActive).toBe(0);
    for (const write of writes) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("selects only open issues", async () => {
    await collectObservabilitySnapshot(NOW);

    expect(mocks.issue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ state: "open" }),
      }),
    );
  });
});
