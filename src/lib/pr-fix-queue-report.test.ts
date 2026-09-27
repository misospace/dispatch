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
      // #1074: generation-conditional settlement writes go through updateMany.
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    agentRun: { create: vi.fn() },
    prFixHistory: {
      create: vi.fn(),
    },
  };
  // markPrFixItem reads the row OUTSIDE the transaction (the snapshot the
  // #940/#1074 guards decide on); $transaction wraps only the writes
  // (generation-conditional updateMany + history row). Passthrough so the
  // test mock chain mirrors what the real prisma client would receive.
  client.$transaction = async (fn: any) => fn(client);
  return { prisma: client };
});

// Mock github-prs to control fetchPullRequestMergeState per test.
const fetchPullRequestMergeStateMock = vi.fn();
vi.mock("./github-prs", () => ({
  fetchPullRequestMergeState: (...args: unknown[]) => fetchPullRequestMergeStateMock(...args),
}));

// Mock pr-fix-surfacing so side-effects don't reach real subs. The lesson
// feed used to be mocked here too, but #970 removed the pr-fix-queue -> lesson
// feed wiring — there is no longer anything to mock from this surface.
vi.mock("./pr-fix-surfacing", () => ({
  surfacePrFixBlocked: vi.fn(async () => null),
  surfacePrFixRequeued: vi.fn(async () => null),
  extractUrlsFromText: vi.fn(() => []),
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
  id: "item-42",
  repo: "acme/widgets",
  pr: 1234,
  status: "QUEUED",
  type: null,
  lane: null,
  note: null,
  generation: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
} as const;

// The (id, generation) attempt token next-task issues on a followup-pr task
// and the worker echoes back in tasks/report (#1074).
const ATTEMPT = { itemId: "item-42", generation: 1 };

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
    const result = await resolvePrFixFromAgentReport(baseInput({ attempt: ATTEMPT }));
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
    const result = await resolvePrFixFromAgentReport(baseInput({ attempt: ATTEMPT }));
    expect(result.action).toBe("skipped");
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
  });

  it("is a no-op when the pr-fix item is already BLOCKED (idempotent)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FIXTURE_ITEM,
      status: "BLOCKED",
    });
    const result = await resolvePrFixFromAgentReport(baseInput({ attempt: ATTEMPT }));
    expect(result.action).toBe("skipped");
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
  });

  it("resolves a QUEUED item as FIXED when the agent reports done and PR is mergeable", async () => {
    const queuedItem = { ...FIXTURE_ITEM };
    // findUnique is called for the resolve lookup (by id), the markPrFixItem
    // load (by repo_pr), and the post-write row read (by id) — same item.
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(queuedItem);
    fetchPullRequestMergeStateMock.mockResolvedValue({ mergeable: true, mergeableState: "clean" });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "pr_updated",
      attempt: ATTEMPT,
    }));

    expect(result.matched).toBe(true);
    expect(result.action).toBe("fixed");
    // Bridge merge check WAS performed before marking.
    expect(fetchPullRequestMergeStateMock).toHaveBeenCalledWith("acme/widgets", 1234);
    // #1074: the settlement write is generation-conditional (updateMany).
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalled();
  });

  it("resolves a QUEUED item as FIXED when no_changes_needed and PR is mergeable", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FIXTURE_ITEM });
    fetchPullRequestMergeStateMock.mockResolvedValue({ mergeable: true, mergeableState: "clean" });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "no_changes_needed",
      attempt: ATTEMPT,
    }));
    expect(result.action).toBe("fixed");
  });

  it("does NOT mark FIXED when the PR is not mergeable (CONFLICTING state)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FIXTURE_ITEM,
    });
    fetchPullRequestMergeStateMock.mockResolvedValue({
      mergeable: false,
      mergeableState: "CONFLICTING",
    });

    const result = await resolvePrFixFromAgentReport(baseInput({ attempt: ATTEMPT }));
    // Deferred — the bridge reconcile pass will re-verify rather than us
    // tombstoning a red PR off unverified success.
    expect(result.matched).toBe(true);
    expect(result.action).toBe("deferred");
    expect(result.reason).toContain("not mergeable");
    expect(prisma.prFixQueueItem.update).not.toHaveBeenCalled();
  });

  it("does NOT mark FIXED when the PR mergeable flag is null (unknown)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FIXTURE_ITEM,
    });
    fetchPullRequestMergeStateMock.mockResolvedValue({ mergeable: null, mergeableState: null });

    const result = await resolvePrFixFromAgentReport(baseInput({ attempt: ATTEMPT }));
    expect(result.action).toBe("deferred");
    expect(prisma.prFixQueueItem.update).not.toHaveBeenCalled();
  });

  it("defers rather than marking FIXED if the GitHub call throws", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FIXTURE_ITEM,
    });
    fetchPullRequestMergeStateMock.mockRejectedValue(new Error("network timeout"));

    const result = await resolvePrFixFromAgentReport(baseInput({ attempt: ATTEMPT }));
    expect(result.matched).toBe(true);
    expect(result.action).toBe("deferred");
    expect(result.reason).toContain("merge state check failed");
    expect(prisma.prFixQueueItem.update).not.toHaveBeenCalled();
  });

  it("marks the item BLOCKED immediately on a `blocked` outcome (no PR check)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FIXTURE_ITEM });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "blocked",
      attempt: ATTEMPT,
    }));
    expect(result.action).toBe("blocked");
    // No need to hit GitHub for a hard block — the agent hit a wall.
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
    // #1074: generation-conditional write.
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalled();
  });

  it("leaves a QUEUED item alone on a `failed` outcome (let bridge reconcile decide)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FIXTURE_ITEM,
    });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "failed",
      attempt: ATTEMPT,
    }));
    expect(result.matched).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("bridge reconcile");
    expect(prisma.prFixQueueItem.update).not.toHaveBeenCalled();
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
  });

  it("a repeated report is idempotent for the second `done` report after FIXED", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FIXTURE_ITEM });
    fetchPullRequestMergeStateMock.mockResolvedValue({ mergeable: true, mergeableState: "clean" });

    const first = await resolvePrFixFromAgentReport(baseInput({ attempt: ATTEMPT }));
    expect(first.action).toBe("fixed");

    // Second call sees status FIXED (either because we updated it, or in a
    // pending-transaction read of the same value).
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FIXTURE_ITEM,
      status: "FIXED",
    });
    const second = await resolvePrFixFromAgentReport(baseInput({ attempt: ATTEMPT }));
    expect(second.action).toBe("skipped");
  });

  it("skips settlement when the attempt generation is stale (attempt re-issued)", async () => {
    // The item was re-issued to generation 2 after this worker was dispatched
    // with generation 1. The stale report must not clobber the newer attempt.
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FIXTURE_ITEM,
      generation: 2,
    });
    const result = await resolvePrFixFromAgentReport(baseInput({
      attempt: { itemId: "item-42", generation: 1 },
    }));
    expect(result.matched).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("stale attempt generation");
    // No mutation, no GitHub.
    expect(prisma.prFixQueueItem.update).not.toHaveBeenCalled();
    expect(prisma.prFixQueueItem.updateMany).not.toHaveBeenCalled();
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
  });

  it("skips settlement when the token's item does not match the reported repo/PR", async () => {
    // The token names an item for a different PR than the report claims.
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FIXTURE_ITEM,
      pr: 9999,
    });
    const result = await resolvePrFixFromAgentReport(baseInput({ attempt: ATTEMPT }));
    expect(result.matched).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("does not match reported repo/PR");
    expect(prisma.prFixQueueItem.update).not.toHaveBeenCalled();
    expect(prisma.prFixQueueItem.updateMany).not.toHaveBeenCalled();
  });

  it("never settles a legacy report without an attempt token (#1074)", async () => {
    // A pre-token worker (no prFixItem in the report) matches the item but
    // must not mutate it or call GitHub.
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FIXTURE_ITEM });
    fetchPullRequestMergeStateMock.mockResolvedValue({ mergeable: true, mergeableState: "clean" });
    const result = await resolvePrFixFromAgentReport(baseInput());
    expect(result.matched).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("attempt token");
    expect(prisma.prFixQueueItem.upsert).not.toHaveBeenCalled();
    expect(prisma.prFixQueueItem.update).not.toHaveBeenCalled();
    expect(prisma.prFixQueueItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.prFixHistory.create).not.toHaveBeenCalled();
  });

  // The issue's commit-time race: the read sees generation 1, a concurrent
  // re-issue bumps the row before the conditional write, so the
  // generation-qualified updateMany matches nothing.
  it("skips settlement when the conditional write matches nothing (concurrent re-issue between read and commit)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FIXTURE_ITEM });
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
    fetchPullRequestMergeStateMock.mockResolvedValue({ mergeable: true, mergeableState: "clean" });

    const result = await resolvePrFixFromAgentReport(baseInput({ attempt: ATTEMPT }));

    expect(result.matched).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("generation-mismatch");
    // The conditional write ran, matched nothing, and nothing was written:
    // no status write, no history row.
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.prFixQueueItem.update).not.toHaveBeenCalled();
    expect(prisma.prFixHistory.create).not.toHaveBeenCalled();
    // The merge-state check is the only GitHub call: nothing after the skip.
    expect(fetchPullRequestMergeStateMock).toHaveBeenCalledTimes(1);
  });

  it("writes no BLOCKED state when a blocked report hits a concurrent re-issue at commit time", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FIXTURE_ITEM });
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "blocked",
      attempt: ATTEMPT,
    }));

    expect(result.matched).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("generation-mismatch");
    // The BLOCKED write was generation-conditional and matched nothing.
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledWith({
      where: { id: "item-42", generation: 1 },
      data: expect.objectContaining({ status: "BLOCKED" }),
    });
    expect(prisma.prFixQueueItem.update).not.toHaveBeenCalled();
    expect(prisma.prFixHistory.create).not.toHaveBeenCalled();
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
  });

  it("writes no BLOCKED state when the attempt generation is stale (read-time check)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FIXTURE_ITEM,
      generation: 2,
    });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "blocked",
      attempt: ATTEMPT,
    }));

    expect(result.matched).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("stale attempt generation");
    expect(prisma.prFixQueueItem.update).not.toHaveBeenCalled();
    expect(prisma.prFixQueueItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.prFixHistory.create).not.toHaveBeenCalled();
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
  });

  it("performs no writes for reports against BLOCKED or STALE items with a valid current token", async () => {
    for (const status of ["BLOCKED", "STALE"] as const) {
      (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FIXTURE_ITEM,
        status,
      });
      const result = await resolvePrFixFromAgentReport(baseInput({
        outcome: "pr_updated",
        attempt: ATTEMPT,
      }));
      expect(result.matched).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.reason).toContain(status);
      expect(prisma.prFixQueueItem.update).not.toHaveBeenCalled();
      expect(prisma.prFixQueueItem.updateMany).not.toHaveBeenCalled();
      expect(prisma.prFixHistory.create).not.toHaveBeenCalled();
      expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
    }
  });
});
