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
    groomingRun: delegate({
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    }),
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

import {
  collectObservabilitySnapshot,
  groomingStallIntervals,
  strandedAssignmentThresholdMs,
} from "./observability-snapshot";

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

describe("groomingStallIntervals", () => {
  it("defaults to two groomer intervals", () => {
    expect(groomingStallIntervals({})).toBe(2);
  });

  it("honours a valid env override, floored", () => {
    expect(groomingStallIntervals({ DISPATCH_GROOMING_STALL_INTERVALS: "5" })).toBe(5);
    expect(groomingStallIntervals({ DISPATCH_GROOMING_STALL_INTERVALS: "1.9" })).toBe(1);
  });

  it("falls back to the default for zero and non-numeric values", () => {
    expect(groomingStallIntervals({ DISPATCH_GROOMING_STALL_INTERVALS: "0" })).toBe(2);
    expect(groomingStallIntervals({ DISPATCH_GROOMING_STALL_INTERVALS: "abc" })).toBe(2);
  });

  it("clamps into the allowed range", () => {
    expect(groomingStallIntervals({ DISPATCH_GROOMING_STALL_INTERVALS: "999" })).toBe(24);
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
    mocks.groomingRun.findFirst.mockResolvedValue(null);
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

  it("passes the operator's sync-pipeline declaration through and derives the arm state", async () => {
    const previous = process.env.DISPATCH_SYNC_PIPELINE;
    try {
      process.env.DISPATCH_SYNC_PIPELINE = "external";
      const external = await collectObservabilitySnapshot(NOW);
      expect(external.config.syncPipeline).toBe("external");
      expect(external.pipeline.syncPipelineState).toBe("armed");

      process.env.DISPATCH_SYNC_PIPELINE = "off";
      const off = await collectObservabilitySnapshot(NOW);
      expect(off.config.syncPipeline).toBe("off");
      expect(off.pipeline.syncPipelineState).toBe("off");

      delete process.env.DISPATCH_SYNC_PIPELINE;
      const auto = await collectObservabilitySnapshot(NOW);
      expect(auto.config.syncPipeline).toBe("auto");
      // No in-process scheduler and no declared topology: the state cannot be
      // told (sync history is never evidence of a pipeline).
      expect(auto.pipeline.syncPipelineState).toBe("unknown");
    } finally {
      if (previous === undefined) delete process.env.DISPATCH_SYNC_PIPELINE;
      else process.env.DISPATCH_SYNC_PIPELINE = previous;
    }
  });

  it("tracks the last successful applied grooming run as the stall baseline", async () => {
    const previous = process.env.DISPATCH_GROOMER_INTERVAL_MS;
    try {
      process.env.DISPATCH_GROOMER_INTERVAL_MS = "300000";
      const completedAt = new Date("2026-01-02T02:04:05.000Z");
      mocks.groomingRun.findFirst.mockResolvedValue({ completedAt });

      const snapshot = await collectObservabilitySnapshot(NOW);

      expect(snapshot.grooming.lastSuccessTimestampSeconds).toBe(
        Math.floor(completedAt.getTime() / 1000),
      );
      expect(snapshot.grooming.secondsSinceLastSuccess).toBe(3600);
      expect(snapshot.grooming.everSucceeded).toBe(true);
      // 300000ms × 2 intervals / 1000.
      expect(snapshot.grooming.stallThresholdSeconds).toBe(600);
      expect(mocks.groomingRun.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "completed", dryRun: false }),
        }),
      );
    } finally {
      if (previous === undefined) delete process.env.DISPATCH_GROOMER_INTERVAL_MS;
      else process.env.DISPATCH_GROOMER_INTERVAL_MS = previous;
    }
  });
});
