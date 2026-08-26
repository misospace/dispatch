import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @/lib/prisma so the test never touches a real DB.
vi.mock("@/lib/prisma", () => {
  const client: any = {
    prFixQueueItem: {
      findUnique: vi.fn(),
      upsert: vi.fn(async () => ({ id: 42 })),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(async () => ({ id: 42 })),
      update: vi.fn(async (args: any) => ({ ...args.data, id: 42 })),
    },
    agentRun: { create: vi.fn() },
    prFixHistory: {
      create: vi.fn(),
    },
  };
  // markPrFixItem runs in a $transaction — passthrough so the test mock chain
  // mirrors what the real prisma client would receive.
  client.$transaction = async (fn: any) => fn(client);
  return { prisma: client };
});

// Mock github-prs to control fetchPullRequestMergeState per test.
const fetchPullRequestMergeStateMock = vi.fn();
vi.mock("./github-prs", () => ({
  fetchPullRequestMergeState: (...args: unknown[]) => fetchPullRequestMergeStateMock(...args),
}));

// Mock pr-fix-surfacing & lesson-feed so side-effects don't reach real subs.
vi.mock("./pr-fix-surfacing", () => ({
  surfacePrFixBlocked: vi.fn(async () => null),
  surfacePrFixRequeued: vi.fn(async () => null),
  extractUrlsFromText: vi.fn(() => []),
}));
vi.mock("./lesson-feed", () => ({
  extractLessonFromFixOutcome: vi.fn(async () => null),
}));

// Mock the queue table that markPrFixItem writes to.
vi.mock("@/lib/redis-streams", () => ({
  enqueueAgentRunJob: vi.fn(async () => null),
  enqueuePrFixAuditJob: vi.fn(async () => null),
  dequeuePrFixAudit: vi.fn(() => null),
  popPrFixReconcile: vi.fn(async () => null),
  pushPrFixAudit: vi.fn(async () => null),
  pushPrFixReconcile: vi.fn(async () => null),
  pushPrFixEvent: vi.fn(async () => null),
  readAllPrFixAudit: vi.fn(async () => []),
  readAllPrFixEvents: vi.fn(async () => []),
  readAllPrFixReconcile: vi.fn(async () => []),
  tryReservePrFixTombstone: vi.fn(async () => null),
}));

import { prisma } from "@/lib/prisma";
import {
  resolvePrFixFromAgentReport,
  type ResolvePrFixFromAgentReportInput,
} from "./pr-fix-queue";

const FIXTURE_ITEM = {
  id: 42,
  repo: "acme/widgets",
  pr: 1234,
  status: "QUEUED",
  type: null,
  lane: null,
  note: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as const;

type QueriedItem = (typeof FIXTURE_ITEM) | null;

beforeEach(() => {
  vi.clearAllMocks();
});

function baseInput(overrides: Partial<ResolvePrFixFromAgentReportInput> = {}) {
  return {
    repoFullName: "acme/widgets",
    pullRequestNumber: 1234,
    pullRequestUrl: null,
    outcome: "pr_updated" as const,
    summary: "fixed the lint nit",
    ...overrides,
  };
}

describe("resolvePrFixFromAgentReport", () => {
  it("does nothing when the report carries no PR coordinates", async () => {
    const result = await resolvePrFixFromAgentReport(baseInput({
      repoFullName: null,
      pullRequestNumber: null,
    }));
    expect(result).toEqual({
      matched: false,
      action: "none",
      reason: "no pr coordinates in report",
    });
    expect(prisma.prFixQueueItem.findUnique).not.toHaveBeenCalled();
  });

  it("does nothing when no matching pr-fix queue item exists", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "no_changes_needed",
    }));
    expect(result.matched).toBe(false);
    expect(result.action).toBe("none");
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
  });

  it("is a no-op when the pr-fix item is already FIXED (idempotent)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FIXTURE_ITEM,
      status: "FIXED",
    });
    fetchPullRequestMergeStateMock.mockResolvedValue({ mergeable: true, mergeableState: "clean" });
    const result = await resolvePrFixFromAgentReport(baseInput());
    expect(result.matched).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("FIXED");
    // Must NOT have re-queried GitHub or rewritten state — idempotent.
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
    expect(prisma.prFixQueueItem.update).not.toHaveBeenCalled();
    expect(prisma.prFixQueueItem.update).not.toHaveBeenCalled();
  });

  it("is a no-op when the pr-fix item is already STALE (idempotent)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FIXTURE_ITEM,
      status: "STALE",
    });
    const result = await resolvePrFixFromAgentReport(baseInput());
    expect(result.action).toBe("skipped");
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
  });

  it("is a no-op when the pr-fix item is already BLOCKED (idempotent)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FIXTURE_ITEM,
      status: "BLOCKED",
    });
    const result = await resolvePrFixFromAgentReport(baseInput());
    expect(result.action).toBe("skipped");
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
  });

  it("resolves a QUEUED item as FIXED when the agent reports done and PR is mergeable", async () => {
    const queuedItem = { ...FIXTURE_ITEM };
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(queuedItem) // resolvePrFixFromAgentReport lookup
      .mockResolvedValueOnce(queuedItem); // markPrFixItem lookup inside
    fetchPullRequestMergeStateMock.mockResolvedValue({ mergeable: true, mergeableState: "clean" });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "pr_updated",
    }));

    expect(result.matched).toBe(true);
    expect(result.action).toBe("fixed");
    // Bridge merge check WAS performed before marking.
    expect(fetchPullRequestMergeStateMock).toHaveBeenCalledWith("acme/widgets", 1234);
    // markPrFixItem was called with FIXED (via update).
    expect(prisma.prFixQueueItem.update).toHaveBeenCalled();
  });

  it("resolves a QUEUED item as FIXED when no_changes_needed and PR is mergeable", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...FIXTURE_ITEM })
      .mockResolvedValueOnce({ ...FIXTURE_ITEM });
    fetchPullRequestMergeStateMock.mockResolvedValue({ mergeable: true, mergeableState: "clean" });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "no_changes_needed",
    }));
    expect(result.action).toBe("fixed");
  });

  it("does NOT mark FIXED when the PR is not mergeable (CONFLICTING state)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...FIXTURE_ITEM,
    });
    fetchPullRequestMergeStateMock.mockResolvedValue({
      mergeable: false,
      mergeableState: "CONFLICTING",
    });

    const result = await resolvePrFixFromAgentReport(baseInput());
    // Deferred — the bridge reconcile pass will re-verify rather than us
    // tombstoning a red PR off unverified success.
    expect(result.matched).toBe(true);
    expect(result.action).toBe("deferred");
    expect(result.reason).toContain("not mergeable");
    expect(prisma.prFixQueueItem.update).not.toHaveBeenCalled();
  });

  it("does NOT mark FIXED when the PR mergeable flag is null (unknown)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...FIXTURE_ITEM,
    });
    fetchPullRequestMergeStateMock.mockResolvedValue({ mergeable: null, mergeableState: null });

    const result = await resolvePrFixFromAgentReport(baseInput());
    expect(result.action).toBe("deferred");
    expect(prisma.prFixQueueItem.update).not.toHaveBeenCalled();
  });

  it("defers rather than marking FIXED if the GitHub call throws", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...FIXTURE_ITEM,
    });
    fetchPullRequestMergeStateMock.mockRejectedValue(new Error("network timeout"));

    const result = await resolvePrFixFromAgentReport(baseInput());
    expect(result.matched).toBe(true);
    expect(result.action).toBe("deferred");
    expect(result.reason).toContain("merge state check failed");
    expect(prisma.prFixQueueItem.update).not.toHaveBeenCalled();
  });

  it("marks the item BLOCKED immediately on a `blocked` outcome (no PR check)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...FIXTURE_ITEM })
      .mockResolvedValueOnce({ ...FIXTURE_ITEM });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "blocked",
    }));
    expect(result.action).toBe("blocked");
    // No need to hit GitHub for a hard block — the agent hit a wall.
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
    expect(prisma.prFixQueueItem.update).toHaveBeenCalled();
  });

  it("leaves a QUEUED item alone on a `failed` outcome (let bridge reconcile decide)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...FIXTURE_ITEM,
    });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "failed",
    }));
    expect(result.matched).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("bridge reconcile");
    expect(prisma.prFixQueueItem.update).not.toHaveBeenCalled();
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
  });

  it("a repeated report is idempotent for the second `done` report after FIXED", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...FIXTURE_ITEM })
      .mockResolvedValueOnce({ ...FIXTURE_ITEM });
    fetchPullRequestMergeStateMock.mockResolvedValue({ mergeable: true, mergeableState: "clean" });

    const first = await resolvePrFixFromAgentReport(baseInput());
    expect(first.action).toBe("fixed");

    // Second call sees status FIXED (either because we updated it, or in a
    // pending-transaction read of the same value).
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...FIXTURE_ITEM,
      status: "FIXED",
    });
    const second = await resolvePrFixFromAgentReport(baseInput());
    expect(second.action).toBe("skipped");
  });
});
