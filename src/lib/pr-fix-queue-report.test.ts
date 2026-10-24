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
  surfacePrFixParked: vi.fn(async () => null),
  surfacePrFixRequeued: vi.fn(async () => null),
  surfacePrFixUnblocked: vi.fn(async () => null),
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
  it.each([ATTEMPT, null])("hands off without looking up or mutating queue state (attempt: %j)", async (attempt) => {
    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "handed-off",
      attempt,
    }));
    expect(result.action).toBe("none");
    expect(result.reason).toContain("handed off");
    for (const method of Object.values(prisma.prFixQueueItem)) {
      expect(method).not.toHaveBeenCalled();
    }
    expect(prisma.prFixHistory.create).not.toHaveBeenCalled();
    expect(prisma.agentRun.create).not.toHaveBeenCalled();
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
  });

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

  it("parks the item immediately on a bare `blocked` outcome (no PR check)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FIXTURE_ITEM });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "blocked",
      attempt: ATTEMPT,
    }));
    // #1218: a bare give-up is bounded no-progress exhaustion, not a human
    // decision — it is PARKED, never labeled needs-human.
    expect(result.action).toBe("parked");
    expect(result.reason).toContain("parked");
    // No need to hit GitHub for a hard block — the agent hit a wall.
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
    // #1074: generation-conditional write.
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PARKED", lane: "NORMAL", outcome: "no_progress" }),
      }),
    );
  });

  it("marks the item BLOCKED when a `blocked` outcome carries a human_decision reason", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FIXTURE_ITEM });
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    const decision = { question: "Which behavior is intended?", options: ["A", "B"], evidence: "see thread" };
    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "blocked",
      attempt: ATTEMPT,
      blockReason: "human_decision",
      decision,
    }));
    expect(result.action).toBe("blocked");
    // No need to hit GitHub for a hard block — the agent hit a wall.
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "BLOCKED",
          lane: "NEEDS_HUMAN",
          outcome: "human_decision",
          decisionDetail: decision,
        }),
      }),
    );
  });

  it("reopens a fresh attempt on a `failed` outcome (#1133)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FIXTURE_ITEM,
    });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "failed",
      attempt: ATTEMPT,
    }));
    expect(result.matched).toBe(true);
    expect(result.action).toBe("requeued");
    expect(result.reason).toContain("fresh attempt");
    // The consumed generation must not stay QUEUED: the settlement write is
    // generation- and status-conditional and opens a fresh attempt counted
    // toward the cap, clearing post-dispatch evidence and hand-out records.
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "item-42", status: "QUEUED", generation: 1 }),
        data: expect.objectContaining({
          status: "QUEUED",
          generation: { increment: 1 },
          fixAttempts: { increment: 1 },
          postDispatchEvidenceKeys: [],
          agentHandouts: [],
        }),
      }),
    );
    // A failure needs no PR state check — the agent hit a wall regardless.
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
  });

  it("parks a `failed` outcome past the fix-attempt cap (#1133, #1218)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FIXTURE_ITEM,
      fixAttempts: 5,
    });
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "failed",
      attempt: ATTEMPT,
    }));
    expect(result.matched).toBe(true);
    expect(result.action).toBe("parked");
    expect(result.reason).toContain("cap");
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "item-42", status: "QUEUED", generation: 1 },
        data: expect.objectContaining({
          status: "PARKED",
          lane: "NORMAL",
          outcome: "no_progress",
        }),
      }),
    );
  });

  it("skips the `failed` settlement when every pinned write no-ops (#1133)", async () => {
    // A concurrent transition (requeue/reopen, or a settle at the same
    // generation) owned the row across every re-decision pass: the bounded
    // retry never settles and the report is a skip.
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FIXTURE_ITEM,
    });
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ count: 0 }));

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "failed",
      attempt: ATTEMPT,
    }));
    expect(result.matched).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("no longer QUEUED at the reported generation");
    // Bounded: three re-decision passes, no unbounded retry.
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledTimes(3);
    // Restore the default write for the following tests.
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ count: 1 }));
  });

  it("baselines the failed fresh attempt from a same-generation headSha update (#1133)", async () => {
    // A same-generation enqueue (new evidence) updates the mutable headSha
    // without moving status or generation: the settlement must re-read the
    // row and baseline the fresh attempt from the UPDATED head — a stale
    // baseline would let the #940 guard mistake pre-attempt head movement
    // for worker progress (#1074/#1104).
    const headBefore = "a".repeat(40);
    const headAfter = "b".repeat(40);
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>)
      // The resolver's initial read still sees the old head.
      .mockResolvedValueOnce({ ...FIXTURE_ITEM, headSha: headBefore })
      // The settlement's re-read observes the same-generation enqueue.
      .mockResolvedValue({ ...FIXTURE_ITEM, headSha: headAfter });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "failed",
      attempt: ATTEMPT,
    }));
    expect(result.matched).toBe(true);
    expect(result.action).toBe("requeued");
    // The write is pinned to the head snapshot the baseline was derived
    // from, and that baseline is the updated head.
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ headSha: headAfter }),
        data: expect.objectContaining({ attemptHeadSha: headAfter }),
      }),
    );
  });

  it("retries the failed settlement against the newer head when the pinned write loses the race (#1133)", async () => {
    const head1 = "c".repeat(40);
    const head2 = "d".repeat(40);
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...FIXTURE_ITEM, headSha: head1 })
      .mockResolvedValueOnce({ ...FIXTURE_ITEM, headSha: head1 })
      // The re-decision pass after the miss observes the newer head.
      .mockResolvedValue({ ...FIXTURE_ITEM, headSha: head2 });
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>)
      // Pass 0's head pin misses: the row's headSha moved to head2.
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValue({ count: 1 });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "failed",
      attempt: ATTEMPT,
    }));
    expect(result.matched).toBe(true);
    expect(result.action).toBe("requeued");
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledTimes(2);
    // The retry baselines from — and pins — the newer head snapshot.
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ headSha: head2 }),
        data: expect.objectContaining({ attemptHeadSha: head2 }),
      }),
    );
  });

  it("does not settle with a stale baseline when the head races every pass (#1133)", async () => {
    // Every pass re-reads a newer head than the last, and the write loses
    // the race each time: all three passes miss their head-snapshot pin.
    // The report must return the bounded skip — settling the third pass
    // anyway (unpinned) would baseline the fresh attempt at head3 while
    // head4 was already live, defeating the #940 guard. The skip does not
    // starve the lane: the per-agent hand-out records make next-task skip
    // the consumed generation for this agent while the item stays
    // available to others (#1133).
    const heads = ["a".repeat(40), "b".repeat(40), "c".repeat(40), "d".repeat(40)];
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>)
      // The resolver's initial read, then one re-read per pass.
      .mockResolvedValueOnce({ ...FIXTURE_ITEM, headSha: heads[0] })
      .mockResolvedValueOnce({ ...FIXTURE_ITEM, headSha: heads[1] })
      .mockResolvedValueOnce({ ...FIXTURE_ITEM, headSha: heads[2] })
      .mockResolvedValue({ ...FIXTURE_ITEM, headSha: heads[3] });
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ count: 0 }));

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "failed",
      attempt: ATTEMPT,
    }));
    expect(result.matched).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("no longer QUEUED at the reported generation");
    // Bounded: exactly three pinned passes, each against its own snapshot.
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledTimes(3);
    for (let pass = 1; pass <= 3; pass++) {
      expect(prisma.prFixQueueItem.updateMany).toHaveBeenNthCalledWith(
        pass,
        expect.objectContaining({
          where: expect.objectContaining({ headSha: heads[pass] }),
        }),
      );
    }
    // Restore the default write for the following tests.
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ count: 1 }));
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
    // Faithful re-issue mock (#1119): the token lookup and markPrFixItem's
    // pre-read see generation 1; the in-transaction re-read after the guarded
    // write no-ops sees the row re-issued at a newer generation. A guarded
    // write that misses while the row still reads back at the SAME generation
    // with empty keys is impossible — the keys guard is exactly what turns a
    // miss at unchanged generation into a re-issue signal.
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...FIXTURE_ITEM })
      .mockResolvedValueOnce({ ...FIXTURE_ITEM })
      .mockResolvedValueOnce({ ...FIXTURE_ITEM, generation: 2 });
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

  it("writes no parked state when a blocked report hits a concurrent re-issue at commit time", async () => {
    // Same faithful re-issue chain as the FIXED case above (#1119): the
    // guarded parked write must not retry once the re-read shows the row
    // moved — exactly one updateMany call.
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...FIXTURE_ITEM })
      .mockResolvedValueOnce({ ...FIXTURE_ITEM })
      .mockResolvedValueOnce({ ...FIXTURE_ITEM, generation: 2 });
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "blocked",
      attempt: ATTEMPT,
    }));

    expect(result.matched).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("generation-mismatch");
    // The parked write was generation-conditional (and, for a settlement,
    // guarded on the post-dispatch evidence list being empty, #1119) and
    // matched nothing.
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledTimes(1);
    // #1218 review: the worker-tier PARKED settle is also guarded on the row
    // being QUEUED, so a stale generation pins status: QUEUED alongside the
    // post-dispatch evidence guard (#1119) and id/generation (#1074).
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledWith({
      where: { id: "item-42", generation: 1, postDispatchEvidenceKeys: { equals: [] }, status: "QUEUED" },
      data: expect.objectContaining({ status: "PARKED" }),
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

  it("routes an already_addressed report to an unguarded FIXED settlement and records the evidence", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FIXTURE_ITEM });
    // Set the settlement write explicitly: an earlier test in this file leaves
    // updateMany returning count 0 and clearAllMocks() does not reset it.
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    fetchPullRequestMergeStateMock.mockResolvedValue({ mergeable: true, mergeableState: "clean" });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "already_addressed",
      attempt: ATTEMPT,
      evidence: "already addressed in commit f7f8c5a",
    }));

    expect(result.matched).toBe(true);
    expect(result.action).toBe("fixed");
    expect(result.reason).toContain("already_addressed");
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FIXED" }) }),
    );
    const histCall = (prisma.prFixHistory.create as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(histCall?.data?.note ?? "").toContain("f7f8c5a");
    expect(histCall?.data?.note ?? "").toContain("1121");
    // The already_addressed settlement is gated on the PR merge state before
    // it settles (a red PR is never marked FIXED off an unverified report).
    expect(fetchPullRequestMergeStateMock).toHaveBeenCalledWith("acme/widgets", 1234);
  });

  it("keeps a human_decision report sticky even with actionable post-dispatch evidence (#1218)", async () => {
    // A dispatched worker reports `blocked` carrying a `human_decision`
    // reason while a fresh review arrived after hand-out. The pre-#1218
    // reopen path silently flipped the row back to QUEUED (or PARKED at
    // cap), cleared the decision payload, and re-dispatched without an
    // operator. The fix: a BLOCKED settlement is sticky — fresh evidence
    // is absorbed by the BLOCKED, the operator-facing decision payload is
    // preserved, and only an explicit operator requeue releases it.
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FIXTURE_ITEM,
      postDispatchEvidenceKeys: ["review:fresh@H1"],
    });
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    const decision = { question: "needs a human decision", evidence: "fresh review" };
    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "blocked",
      attempt: ATTEMPT,
      blockReason: "human_decision",
      decision,
    }));

    expect(result.action).toBe("blocked");
    expect(result.matched).toBe(true);
    // Sticky: the settlement write is status=BLOCKED with the decision
    // payload preserved, NOT a reopen write that would set status=QUEUED.
    const calls = (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastWrite = calls.at(-1)?.[0];
    expect(lastWrite).toMatchObject({
      where: expect.objectContaining({ id: "item-42", generation: 1 }),
      data: expect.objectContaining({
        status: "BLOCKED",
        lane: "NEEDS_HUMAN",
        outcome: "human_decision",
        decisionDetail: decision,
      }),
    });
    // No FIXED-redirect reopen was attempted: no fresh generation bump, no
    // attempt increment, no queued reset.
    expect(lastWrite?.data).not.toMatchObject({ generation: expect.anything() });
    expect(lastWrite?.data).not.toMatchObject({ fixAttempts: expect.anything() });
    // The merge-state probe was skipped — a hard block never reaches GitHub.
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
  });

  // #1340: settling the attempt ends the reporting agent's hand-out. The
  // per-agent hand-out/ack/receipt entries for the settled generation are
  // released so a live receipt does not keep pinning the settled item —
  // while another agent's hand-out at the same generation survives (the
  // item stays dispatched to it).
  it("releases the reporting agent's hand-out records when a blocked report settles the attempt (#1340)", async () => {
    const row = {
      ...FIXTURE_ITEM,
      agentHandouts: ["fixer@1", "other@1"],
      handoutAcks: ["fixer@1"],
      handoutReceipts: ["hnd_aabbccddeeff@fixer@1"],
      dispatchedGeneration: 1,
      dispatchedAt: "2026-01-01T00:02:00.000Z",
      attemptEvidenceWatermark: "watermark-1",
    };
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row);
    // Stateful write: the release re-reads the row AFTER the settlement
    // landed, so the mock tracks the writes as they land.
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }: any) => {
      Object.assign(row, data);
      return { count: 1 };
    });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "blocked",
      summary: "the spec is ambiguous about retry semantics",
      agentName: "fixer",
      attempt: { ...ATTEMPT, handoutToken: "hnd_aabbccddeeff" },
    }));

    expect(result.matched).toBe(true);
    expect(result.action).toBe("parked");
    expect(result.itemId).toBe("item-42");
    expect(result.attemptGeneration).toBe(1);
    // Two writes: the PARKED settlement, then the hand-out release.
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledTimes(2);
    const releaseCall = (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    // The release CAS-pins the arrays it just read (the fixture's, since the
    // mock re-reads the same row) so a concurrent hand-out/sweep cannot
    // clobber the release.
    expect(releaseCall?.where).toEqual({
      id: "item-42",
      generation: 1,
      handoutReceipts: { equals: ["hnd_aabbccddeeff@fixer@1"] },
      agentHandouts: { equals: ["fixer@1", "other@1"] },
      handoutAcks: { equals: ["fixer@1"] },
    });
    // fixer's entries are gone; other@1's hand-out survives, so the
    // dispatch stamps stay.
    expect(releaseCall?.data).toEqual({
      handoutReceipts: [],
      agentHandouts: ["other@1"],
      handoutAcks: [],
    });
  });

  it("clears the dispatch stamps when a blocked report releases the last live hand-out (#1340)", async () => {
    const row = {
      ...FIXTURE_ITEM,
      agentHandouts: ["fixer@1"],
      handoutAcks: ["fixer@1"],
      handoutReceipts: ["hnd_aabbccddeeff@fixer@1"],
      dispatchedGeneration: 1,
      dispatchedAt: "2026-01-01T00:02:00.000Z",
      attemptEvidenceWatermark: "watermark-1",
    };
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row);
    // Stateful write: the release re-reads the row AFTER the settlement landed.
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }: any) => {
      Object.assign(row, data);
      return { count: 1 };
    });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "blocked",
      summary: "repeated no-progress runs",
      agentName: "fixer",
      attempt: { ...ATTEMPT, handoutToken: "hnd_aabbccddeeff" },
    }));

    expect(result.matched).toBe(true);
    expect(result.action).toBe("parked");
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledTimes(2);
    const releaseCall = (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    // The release CAS-pins the arrays it just read, the way it does in
    // every case (mock re-reads the same row).
    expect(releaseCall?.where).toEqual({
      id: "item-42",
      generation: 1,
      handoutReceipts: { equals: ["hnd_aabbccddeeff@fixer@1"] },
      agentHandouts: { equals: ["fixer@1"] },
      handoutAcks: { equals: ["fixer@1"] },
    });
    // No hand-out left — the item is no longer dispatched.
    expect(releaseCall?.data).toEqual({
      handoutReceipts: [],
      agentHandouts: [],
      handoutAcks: [],
      dispatchedGeneration: null,
      dispatchedAt: null,
      attemptEvidenceWatermark: null,
    });
  });

  // #1340: a human_decision blocked report without a structured decision
  // payload still records one — the settlement write carries a synthesized
  // question and evidence so the needs-human surface has something to act on.
  it("records a synthesized decision context when a human_decision blocked report carries no decision payload (#1340)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FIXTURE_ITEM });
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "blocked",
      blockReason: "human_decision",
      summary: "the spec is ambiguous about retry semantics",
      agentName: "fixer",
      attempt: ATTEMPT,
    }));

    expect(result.matched).toBe(true);
    expect(result.action).toBe("blocked");
    expect(result.itemId).toBe("item-42");
    expect(result.attemptGeneration).toBe(1);
    // FIXTURE_ITEM carries no hand-out records, so the release is a no-op
    // and the only write is the BLOCKED settlement.
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledTimes(1);
    const settleCall = (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(settleCall?.data?.status).toBe("BLOCKED");
    expect(settleCall?.data?.lane).toBe("NEEDS_HUMAN");
    expect(typeof settleCall?.data?.decisionDetail?.question).toBe("string");
    expect(settleCall?.data?.decisionDetail?.question?.trim().length).toBeGreaterThan(0);
    expect(settleCall?.data?.decisionDetail?.evidence).toBe("the spec is ambiguous about retry semantics");
  });

  // #1340 follow-up: a blocked report against an ALREADY-settled row is an
  // idempotent skip, but the reporting agent's hand-out records must not
  // linger on the terminal row — the release runs even though the
  // settlement itself does nothing.
  it("releases the reporting agent's stale hand-out when a blocked report skips an already-BLOCKED item (#1340)", async () => {
    const row = {
      ...FIXTURE_ITEM,
      status: "BLOCKED",
      agentHandouts: ["fixer@1"],
      handoutAcks: ["fixer@1"],
      handoutReceipts: ["hnd_aabbccddeeff@fixer@1"],
      dispatchedGeneration: 1,
      dispatchedAt: "2026-01-01T00:02:00.000Z",
      attemptEvidenceWatermark: "watermark-1",
    };
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row);
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "blocked",
      blockReason: "human_decision",
      summary: "the spec is ambiguous about retry semantics",
      agentName: "fixer",
      attempt: { ...ATTEMPT, handoutToken: "hnd_aabbccddeeff" },
    }));

    expect(result.matched).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.reason).toBe("pr-fix item already BLOCKED");
    expect(result.attemptGeneration).toBe(1);
    // Exactly one write: the CAS hand-out release. No settlement write —
    // the row is already terminal, and no history row, no GitHub probe.
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledTimes(1);
    const releaseCall = (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(releaseCall?.where).toEqual({
      id: "item-42",
      generation: 1,
      handoutReceipts: { equals: ["hnd_aabbccddeeff@fixer@1"] },
      agentHandouts: { equals: ["fixer@1"] },
      handoutAcks: { equals: ["fixer@1"] },
    });
    expect(releaseCall?.data).toEqual({
      handoutReceipts: [],
      agentHandouts: [],
      handoutAcks: [],
      dispatchedGeneration: null,
      dispatchedAt: null,
      attemptEvidenceWatermark: null,
    });
    expect(prisma.prFixHistory.create).not.toHaveBeenCalled();
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
  });

  // #1340 review: when the report echoes the issued receipt token, the release
  // is authorized by the EXACT issuance (#1256 rule): only that receipt is
  // dropped, another agent's live hand-out at the generation survives, and the
  // dispatch stamps stay while any hand-out is still live.
  it("releases the exact issuance when a blocked report echoes the issued handoutToken (#1340 review)", async () => {
    const row = {
      ...FIXTURE_ITEM,
      agentHandouts: ["fixer@1", "other@1"],
      handoutAcks: ["fixer@1"],
      handoutReceipts: ["hnd_aabbccddeeff@fixer@1", "hnd_112233445566@other@1"],
      dispatchedGeneration: 1,
      dispatchedAt: "2026-01-01T00:02:00.000Z",
      attemptEvidenceWatermark: "watermark-1",
    };
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row);
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }: any) => {
      Object.assign(row, data);
      return { count: 1 };
    });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "blocked",
      summary: "the spec is ambiguous about retry semantics",
      agentName: "fixer",
      attempt: { itemId: "item-42", generation: 1, handoutToken: "hnd_aabbccddeeff" },
    }));

    expect(result.action).toBe("parked");
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledTimes(2);
    const releaseCall = (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(releaseCall?.where).toEqual({
      id: "item-42",
      generation: 1,
      handoutReceipts: { equals: ["hnd_aabbccddeeff@fixer@1", "hnd_112233445566@other@1"] },
      agentHandouts: { equals: ["fixer@1", "other@1"] },
      handoutAcks: { equals: ["fixer@1"] },
    });
    // Only fixer's issued receipt is dropped; other@1's live hand-out keeps
    // the dispatch stamps.
    expect(releaseCall?.data).toEqual({
      handoutReceipts: ["hnd_112233445566@other@1"],
      agentHandouts: ["other@1"],
      handoutAcks: [],
    });
  });

  // #1340 review: a report still carrying the token of a PREVIOUS hand-out of
  // the same agent at the same generation (rotated after a reclaim/re-release)
  // authorizes no release — the live rotated receipt and hand-out survive.
  // The settlement itself stays authorized by the (id, generation) attempt
  // descriptor plus the agent-bound report route.
  it("a stale handoutToken on a blocked report cannot release the rotated live hand-out (#1340 review)", async () => {
    const row = {
      ...FIXTURE_ITEM,
      agentHandouts: ["fixer@1"],
      handoutAcks: ["fixer@1"],
      handoutReceipts: ["hnd_111111111111111a@fixer@1"],
      dispatchedGeneration: 1,
      dispatchedAt: "2026-01-01T00:02:00.000Z",
      attemptEvidenceWatermark: "watermark-1",
    };
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row);
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }: any) => {
      Object.assign(row, data);
      return { count: 1 };
    });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "blocked",
      summary: "the spec is ambiguous about retry semantics",
      agentName: "fixer",
      attempt: { itemId: "item-42", generation: 1, handoutToken: "hnd_000000000000000a" },
    }));

    expect(result.action).toBe("parked");
    // Exactly one write: the PARKED settlement. The release refuses with zero
    // mutation because the presented receipt is not the live issuance.
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledTimes(1);
    expect(row.agentHandouts).toEqual(["fixer@1"]);
    expect(row.handoutReceipts).toEqual(["hnd_111111111111111a@fixer@1"]);
  });

  // #1340 review: the token fence also guards the already-settled skip path —
  // the release runs with zero settlement writes and still keeps its exact
  // (agent, generation, token) authorization there.
  it("releases the exact issuance on an already-settled skip when the report echoes the live handoutToken (#1340 review)", async () => {
    const row = {
      ...FIXTURE_ITEM,
      status: "BLOCKED",
      agentHandouts: ["fixer@1", "other@1"],
      handoutAcks: ["fixer@1"],
      handoutReceipts: ["hnd_aabbccddeeff@fixer@1", "hnd_112233445566@other@1"],
      dispatchedGeneration: 1,
      dispatchedAt: "2026-01-01T00:02:00.000Z",
      attemptEvidenceWatermark: "watermark-1",
    };
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row);
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "blocked",
      blockReason: "human_decision",
      summary: "the spec is ambiguous about retry semantics",
      agentName: "fixer",
      attempt: { itemId: "item-42", generation: 1, handoutToken: "hnd_aabbccddeeff" },
    }));

    expect(result.action).toBe("skipped");
    // Exactly one write: the fenced release. No settlement write.
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledTimes(1);
    const releaseCall = (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(releaseCall?.where).toEqual({
      id: "item-42",
      generation: 1,
      handoutReceipts: { equals: ["hnd_aabbccddeeff@fixer@1", "hnd_112233445566@other@1"] },
      agentHandouts: { equals: ["fixer@1", "other@1"] },
      handoutAcks: { equals: ["fixer@1"] },
    });
    expect(releaseCall?.data).toEqual({
      handoutReceipts: ["hnd_112233445566@other@1"],
      agentHandouts: ["other@1"],
      handoutAcks: [],
    });
  });

  // #1340 review: the fenced-only contract guards the already-settled skip
  // path too — a token-less blocked report against a terminal row performs
  // zero writes (the idempotent skip stays a pure no-op; nothing releases
  // without the exact receipt).
  it("releases nothing on an already-settled skip when a blocked report carries no handoutToken (#1340 review)", async () => {
    const row = {
      ...FIXTURE_ITEM,
      status: "BLOCKED",
      agentHandouts: ["fixer@1"],
      handoutAcks: ["fixer@1"],
      handoutReceipts: ["hnd_aabbccddeeff@fixer@1"],
      dispatchedGeneration: 1,
      dispatchedAt: "2026-01-01T00:02:00.000Z",
    };
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row);
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "blocked",
      summary: "still blocked, waiting on the product call",
      agentName: "fixer",
      attempt: ATTEMPT,
    }));

    expect(result.action).toBe("skipped");
    expect(result.reason).toBe("pr-fix item already BLOCKED");
    // Fail closed: no release write despite the terminal row and the agent's
    // live entries at this generation.
    expect(prisma.prFixQueueItem.updateMany).not.toHaveBeenCalled();
    expect(row.agentHandouts).toEqual(["fixer@1"]);
    expect(row.handoutReceipts).toEqual(["hnd_aabbccddeeff@fixer@1"]);
  });

  // #1340 review (round 2, after courier#516/#523 shipped the token echo on
  // every followup-pr report): the release is fenced to the exact issuance
  // ONLY. A report without the echoed handoutToken authorizes no release —
  // even when its settlement lands on a settled row, the agent's hand-out
  // entries stay untouched (fail closed; they clear on the next generation
  // change).
  it("releases nothing when a no-token blocked report settles (fenced-only release, #1340 review)", async () => {
    const row = {
      ...FIXTURE_ITEM,
      agentHandouts: ["fixer@1"],
      handoutAcks: ["fixer@1"],
      handoutReceipts: ["hnd_aabbccddeeff@fixer@1"],
      dispatchedGeneration: 1,
      dispatchedAt: "2026-01-01T00:02:00.000Z",
    };
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row);
    // Stateful write: the settlement lands; the release must not follow.
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }: any) => {
      Object.assign(row, data);
      return { count: 1 };
    });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "blocked",
      summary: "repeated no-progress runs",
      agentName: "fixer",
      attempt: ATTEMPT,
    }));

    // The settlement itself still lands (PARKED) — only the release is refused.
    expect(result.action).toBe("parked");
    // Exactly one write: the settlement. No release-shaped write (one pinning
    // the hand-out arrays) was attempted, settled row or not.
    expect(prisma.prFixQueueItem.updateMany).toHaveBeenCalledTimes(1);
    const writes = (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mock.calls.map((c: any) => c[0]);
    expect(writes.every((w: any) => w.data?.agentHandouts === undefined)).toBe(true);
    expect(row.agentHandouts).toEqual(["fixer@1"]);
    expect(row.handoutReceipts).toEqual(["hnd_aabbccddeeff@fixer@1"]);
  });

  it("performs zero writes when a blocked report skips an already-FIXED item with no hand-out records (#1340)", async () => {
    (prisma.prFixQueueItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FIXTURE_ITEM,
      status: "FIXED",
    });
    (prisma.prFixQueueItem.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    const result = await resolvePrFixFromAgentReport(baseInput({
      outcome: "blocked",
      blockReason: "human_decision",
      summary: "the spec is ambiguous about retry semantics",
      agentName: "fixer",
      attempt: ATTEMPT,
    }));

    expect(result.matched).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.reason).toBe("pr-fix item already FIXED");
    // No hand-out records to release, so the idempotent skip is a pure no-op.
    expect(prisma.prFixQueueItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.prFixHistory.create).not.toHaveBeenCalled();
    expect(fetchPullRequestMergeStateMock).not.toHaveBeenCalled();
  });
});
