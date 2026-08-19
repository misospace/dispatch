import { describe, expect, it, beforeEach, vi } from "vitest";
import { enqueuePrFixItem, listQueuedPrFixItems, markPrFixItem, toAgentQueuePrFixItem, reconcileStalePrFixItems, requeuePrFixItem, buildPrFixBlockedContext, PrFixQueueClient } from "./pr-fix-queue";

const { surfacingMocks, lessonFeedMocks } = vi.hoisted(() => ({
  surfacingMocks: {
    surfacePrFixBlocked: vi.fn().mockResolvedValue({ labelApplied: true, commentPosted: true, errors: [] }),
    surfacePrFixRequeued: vi.fn().mockResolvedValue({ labelRemoved: true, commentUpdated: true, errors: [] }),
    extractUrlsFromText: vi.fn((text: string) => {
      const passed = text.matchAll(/https:\/\/[^\s"'<>]+/g);
      return Array.from(passed).map((m) => m[0]);
    }),
  },
  lessonFeedMocks: {
    extractLessonFromFixOutcome: vi.fn().mockResolvedValue({ kind: "no_lesson" as const }),
  },
}));

vi.mock("./pr-fix-surfacing", () => ({
  surfacePrFixBlocked: surfacingMocks.surfacePrFixBlocked,
  surfacePrFixRequeued: surfacingMocks.surfacePrFixRequeued,
  extractUrlsFromText: surfacingMocks.extractUrlsFromText,
}));

vi.mock("./lesson-feed", () => ({
  extractLessonFromFixOutcome: lessonFeedMocks.extractLessonFromFixOutcome,
}));

function makeClient(): PrFixQueueClient & { items: any[]; history: any[] } {
  const items: any[] = [];
  const history: any[] = [];
  let seq = 0;
  const client: any = {
    items,
    history,
    $transaction: async (fn: any) => fn(client),
    prFixQueueItem: {
      findUnique: async ({ where }: any) => items.find((i) => i.repo === where.repo_pr.repo && i.pr === where.repo_pr.pr) ?? null,
      create: async ({ data }: any) => {
        const item = {
          id: `item-${++seq}`,
          queuedAt: new Date(Date.UTC(2026, 0, 1, 0, seq)),
          updatedAt: new Date(Date.UTC(2026, 0, 1, 0, seq)),
          ...data,
        };
        items.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const idx = items.findIndex((i) => i.id === where.id);
        items[idx] = { ...items[idx], ...data, updatedAt: new Date(Date.UTC(2026, 0, 1, 1, ++seq)) };
        return items[idx];
      },
      findMany: async ({ where, orderBy }: any) => {
        let result = items.slice();
        if (where?.repo) result = result.filter((i) => i.repo === where.repo);
        if (where?.pr?.in) result = result.filter((i) => where.pr.in.includes(i.pr));
        if (where?.status) {
          result = Array.isArray(where.status.in)
            ? result.filter((i) => where.status.in.includes(i.status))
            : result.filter((i) => i.status === where.status);
        }
        if (where?.lane) result = result.filter((i) => i.lane === where.lane);
        if (orderBy) {
          result.sort((a, b) =>
            (a.queuedAt.getTime() - b.queuedAt.getTime()) ||
            a.repo.localeCompare(b.repo) ||
            a.pr - b.pr,
          );
        }
        return result;
      },
    },
    prFixHistory: {
      create: async ({ data }: any) => {
        const row = { id: `history-${history.length + 1}`, at: new Date(), ...data };
        history.push(row);
        return row;
      },
      findMany: async ({ where, orderBy }: any) => {
        let result = history.slice();
        if (where?.item?.repo) {
          const repo = where.item.repo;
          result = result.filter((h) => {
            const item = items.find((i) => i.id === h.itemId);
            return item?.repo === repo && (where.item.pr == null || item?.pr === where.item.pr);
          });
        }
        if (orderBy?.at) {
          result.sort((a, b) => (orderBy.at === "desc"
            ? new Date(b.at).getTime() - new Date(a.at).getTime()
            : new Date(a.at).getTime() - new Date(b.at).getTime()));
        }
        return result;
      },
    },
  };
  return client;
}

describe("PR review-fix queue", () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
    surfacingMocks.surfacePrFixBlocked.mockReset();
    surfacingMocks.surfacePrFixBlocked.mockResolvedValue({ labelApplied: true, commentPosted: true, errors: [] });
    surfacingMocks.surfacePrFixRequeued.mockReset();
    surfacingMocks.surfacePrFixRequeued.mockResolvedValue({ labelRemoved: true, commentUpdated: true, errors: [] });
  });

  it("dedupes by repo and PR while preserving unique evidence keys and feedback", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 10,
      lane: "NORMAL",
      reason: "review requested",
      feedback: "first comment",
      evidenceKey: "review:1",
      branch: "fix/a",
      author: "itsmiso-ai",
    });

    const updated = await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 10,
      lane: "NORMAL",
      reason: "checks failed",
      feedback: "failing test",
      evidenceKey: "check:2",
      branch: "fix/a",
    });

    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 10,
      lane: "NORMAL",
      reason: "duplicate evidence",
      feedback: "failing test",
      evidenceKey: "check:2",
    });

    expect(client.items).toHaveLength(1);
    expect(updated.evidenceKeys).toEqual(["review:1", "check:2"]);
    expect(client.items[0].feedback).toEqual(["first comment", "failing test"]);
    expect(client.history).toHaveLength(3);
  });

  it("orders queued items before issue work by queuedAt, repo, then PR", async () => {
    await enqueuePrFixItem(client, { repo: "z/repo", pr: 2, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "z" });
    await enqueuePrFixItem(client, { repo: "a/repo", pr: 1, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "a" });
    client.items[0].queuedAt = new Date("2026-01-02T00:00:00Z");
    client.items[1].queuedAt = new Date("2026-01-01T00:00:00Z");

    const queued = await listQueuedPrFixItems(client, { lane: "NORMAL" });
    expect(queued.map((i) => `${i.repo}#${i.pr}`)).toEqual(["a/repo#1", "z/repo#2"]);
    expect(toAgentQueuePrFixItem(queued[0]).type).toBe("pr-review-fix");
  });

  it("filters by lane and excludes needs-human blocked items unless requested", async () => {
    await enqueuePrFixItem(client, { repo: "org/one", pr: 1, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "1" });
    await enqueuePrFixItem(client, { repo: "org/two", pr: 2, lane: "ESCALATED", reason: "r", feedback: "f", evidenceKey: "2" });
    await enqueuePrFixItem(client, { repo: "org/three", pr: 3, lane: "needs-human", reason: "r", feedback: "f", evidenceKey: "3" });

    expect((await listQueuedPrFixItems(client, { lane: "NORMAL" })).map((i) => i.pr)).toEqual([1]);
    expect((await listQueuedPrFixItems(client, { lane: "ESCALATED" })).map((i) => i.pr)).toEqual([2]);
    expect(await listQueuedPrFixItems(client, { lane: "needs-human" })).toEqual([]);
    expect((await listQueuedPrFixItems(client, { lane: "needs-human", includeBlocked: true })).map((i) => i.pr)).toEqual([3]);
  });

  it("supports status transitions with history", async () => {
    await enqueuePrFixItem(client, { repo: "org/repo", pr: 5, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "e" });
    const fixed = await markPrFixItem(client, { repo: "org/repo", pr: 5, status: "fixed", note: "pushed fix + validation" });

    expect(fixed?.status).toBe("FIXED");
    expect(await listQueuedPrFixItems(client, { lane: "NORMAL" })).toEqual([]);
    expect(client.history.at(-1)).toMatchObject({ action: "mark", status: "FIXED", note: "pushed fix + validation" });
  });
});

describe("reconcileStalePrFixItems", () => {
  it("marks queued items stale when the upstream PR is merged/closed", async () => {
    const client = makeClient();
    await enqueuePrFixItem(client, {
      repo: "misospace/miso-chat",
      pr: 566,
      reason: "AI review failed",
      feedback: "feedback",
      evidenceKey: "k1",
    });
    await enqueuePrFixItem(client, {
      repo: "misospace/miso-chat",
      pr: 567,
      reason: "test 567",
      feedback: "f",
      evidenceKey: "k2",
    });
    await enqueuePrFixItem(client, {
      repo: "misospace/miso-chat",
      pr: 568,
      reason: "test 568",
      feedback: "f",
      evidenceKey: "k3",
    });

    const mergedOrClosed = new Map<string, Set<number>>([
      ["misospace/miso-chat", new Set([566, 568])],
    ]);
    const states = new Map<string, Map<number, "merged" | "closed">>([
      ["misospace/miso-chat", new Map([[566, "merged"], [568, "closed"]])],
    ]);

    const result = await reconcileStalePrFixItems(client, mergedOrClosed, states);
    expect(result.checked).toBe(2);
    expect(result.markedStale).toBe(2);
    expect(result.errored).toBe(0);

    // listQueuedPrFixItems filters by status (only QUEUED/[QUEUED,BLOCKED]),
    // so it would not return STALE rows after the reconcile. Inspect the
    // test client's items array directly to verify the state transition.
    const byId = new Map(client.items.map((i) => [i.pr, i]));
    expect(byId.get(566)?.status).toBe("STALE");
    expect(byId.get(567)?.status).toBe("QUEUED"); // not in merged/closed set
    expect(byId.get(568)?.status).toBe("STALE");
  });

  it("marks BLOCKED items stale when the upstream PR is merged/closed", async () => {
    const client = makeClient();
    await enqueuePrFixItem(client, {
      repo: "misospace/miso-chat",
      pr: 580,
      lane: "NEEDS_HUMAN",
      reason: "needs human",
      feedback: "f",
      evidenceKey: "k1",
    });
    await enqueuePrFixItem(client, {
      repo: "misospace/miso-chat",
      pr: 581,
      lane: "NEEDS_HUMAN",
      reason: "needs human",
      feedback: "f",
      evidenceKey: "k2",
    });

    const mergedOrClosed = new Map<string, Set<number>>([
      ["misospace/miso-chat", new Set([580])],
    ]);
    const states = new Map<string, Map<number, "merged" | "closed">>([
      ["misospace/miso-chat", new Map([[580, "merged"]])],
    ]);

    const result = await reconcileStalePrFixItems(client, mergedOrClosed, states);
    expect(result.checked).toBe(1);
    expect(result.markedStale).toBe(1);

    const byId = new Map(client.items.map((i) => [i.pr, i]));
    expect(byId.get(580)?.status).toBe("STALE");
    expect(byId.get(581)?.status).toBe("BLOCKED"); // not in merged/closed set
  });

  it("does not touch items already in terminal status", async () => {
    const client = makeClient();
    await enqueuePrFixItem(client, {
      repo: "misospace/miso-chat",
      pr: 570,
      reason: "x",
      feedback: "f",
      evidenceKey: "k1",
    });
    await markPrFixItem(client, { repo: "misospace/miso-chat", pr: 570, status: "FIXED" });
    const mergedOrClosed = new Map<string, Set<number>>([
      ["misospace/miso-chat", new Set([570])],
    ]);
    const states = new Map<string, Map<number, "merged" | "closed">>([
      ["misospace/miso-chat", new Map([[570, "merged"]])],
    ]);
    const result = await reconcileStalePrFixItems(client, mergedOrClosed, states);
    expect(result.checked).toBe(0);
    expect(result.markedStale).toBe(0);
  });

  it("returns zero counts for repos with no merged/closed PRs", async () => {
    const client = makeClient();
    const result = await reconcileStalePrFixItems(client, new Map(), new Map());
    expect(result.checked).toBe(0);
    expect(result.markedStale).toBe(0);
  });
});

describe("pr-fix surfacing integration", () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
    surfacingMocks.surfacePrFixBlocked.mockReset();
    surfacingMocks.surfacePrFixBlocked.mockResolvedValue({ labelApplied: true, commentPosted: true, errors: [] });
    surfacingMocks.surfacePrFixRequeued.mockReset();
    surfacingMocks.surfacePrFixRequeued.mockResolvedValue({ labelRemoved: true, commentUpdated: true, errors: [] });
  });

  it("enqueue with NEEDS_HUMAN lane (BLOCKED) calls surfacePrFixBlocked once", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 10,
      lane: "NEEDS_HUMAN",
      reason: "needs human review",
      feedback: "f",
      evidenceKey: "k1",
    });

    expect(surfacingMocks.surfacePrFixBlocked).toHaveBeenCalledTimes(1);
    expect(surfacingMocks.surfacePrFixBlocked).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "org/repo",
        pr: 10,
        reason: "needs human review",
        latestNote: null,
      }),
    );
  });

  it("enqueue with NORMAL lane (QUEUED) does not call surfacePrFixBlocked", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 10,
      lane: "NORMAL",
      reason: "ci failure",
      feedback: "f",
      evidenceKey: "k1",
    });

    expect(surfacingMocks.surfacePrFixBlocked).not.toHaveBeenCalled();
  });

  it("re-enqueue already BLOCKED item does not call surfacePrFixBlocked", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 10,
      lane: "NEEDS_HUMAN",
      reason: "first block",
      feedback: "f",
      evidenceKey: "k1",
    });
    surfacingMocks.surfacePrFixBlocked.mockClear();

    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 10,
      lane: "NEEDS_HUMAN",
      reason: "second block",
      feedback: "f2",
      evidenceKey: "k2",
    });

    expect(surfacingMocks.surfacePrFixBlocked).not.toHaveBeenCalled();
  });

  it("mark QUEUED -> BLOCKED calls surfacePrFixBlocked once", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 20,
      lane: "NORMAL",
      reason: "ci failure",
      feedback: "f",
      evidenceKey: "k1",
    });
    surfacingMocks.surfacePrFixBlocked.mockClear();

    await markPrFixItem(client, { repo: "org/repo", pr: 20, status: "BLOCKED", note: "operator reviewed" });

    expect(surfacingMocks.surfacePrFixBlocked).toHaveBeenCalledTimes(1);
    expect(surfacingMocks.surfacePrFixBlocked).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "org/repo",
        pr: 20,
        reason: "ci failure",
        latestNote: "operator reviewed",
      }),
    );
  });

  it("mark BLOCKED -> BLOCKED does not call surfacePrFixBlocked", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 30,
      lane: "NEEDS_HUMAN",
      reason: "needs human",
      feedback: "f",
      evidenceKey: "k1",
    });
    surfacingMocks.surfacePrFixBlocked.mockClear();

    await markPrFixItem(client, { repo: "org/repo", pr: 30, status: "BLOCKED" });

    expect(surfacingMocks.surfacePrFixBlocked).not.toHaveBeenCalled();
  });

  it("mark BLOCKED -> FIXED does not call surfacePrFixBlocked", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 40,
      lane: "NEEDS_HUMAN",
      reason: "needs human",
      feedback: "f",
      evidenceKey: "k1",
    });
    surfacingMocks.surfacePrFixBlocked.mockClear();

    await markPrFixItem(client, { repo: "org/repo", pr: 40, status: "FIXED" });

    expect(surfacingMocks.surfacePrFixBlocked).not.toHaveBeenCalled();
  });

  it("mark QUEUED -> FIXED does not call surfacePrFixBlocked", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 50,
      lane: "NORMAL",
      reason: "ci failure",
      feedback: "f",
      evidenceKey: "k1",
    });
    surfacingMocks.surfacePrFixBlocked.mockClear();

    await markPrFixItem(client, { repo: "org/repo", pr: 50, status: "FIXED" });

    expect(surfacingMocks.surfacePrFixBlocked).not.toHaveBeenCalled();
  });
});

describe("pr-fix lesson feed trigger (#754)", () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
    surfacingMocks.surfacePrFixBlocked.mockClear();
    lessonFeedMocks.extractLessonFromFixOutcome.mockClear();
  });

  it("fires extractLessonFromFixOutcome on QUEUED -> FIXED when feedback.length >= 2", async () => {
    // Enqueue twice with different feedback so feedback.length reaches 2
    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 60,
      lane: "NORMAL",
      reason: "ci failure",
      feedback: "first attempt",
      evidenceKey: "k1",
    });
    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 60,
      lane: "NORMAL",
      reason: "ci failure",
      feedback: "second attempt",
      evidenceKey: "k2",
    });
    lessonFeedMocks.extractLessonFromFixOutcome.mockClear();

    await markPrFixItem(client, { repo: "org/repo", pr: 60, status: "FIXED" });

    // The trigger is fire-and-forget (void + .then), so wait a microtask
    await new Promise((r) => setTimeout(r, 0));
    expect(lessonFeedMocks.extractLessonFromFixOutcome).toHaveBeenCalledTimes(1);
    const call = lessonFeedMocks.extractLessonFromFixOutcome.mock.calls[0][0];
    expect(call.repo).toBe("org/repo");
    expect(call.feedback.length).toBeGreaterThanOrEqual(2);
  });

  it("does not fire when feedback.length < 2", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 61,
      lane: "NORMAL",
      reason: "ci failure",
      feedback: "f",
      evidenceKey: "k1",
    });
    // No additional feedback entries — feedback.length stays 1
    lessonFeedMocks.extractLessonFromFixOutcome.mockClear();

    await markPrFixItem(client, { repo: "org/repo", pr: 61, status: "FIXED" });

    await new Promise((r) => setTimeout(r, 0));
    expect(lessonFeedMocks.extractLessonFromFixOutcome).not.toHaveBeenCalled();
  });

  it("does not fire on FIXED -> FIXED (only on the transition INTO FIXED)", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 62,
      lane: "NORMAL",
      reason: "ci failure",
      feedback: "first",
      evidenceKey: "k1",
    });
    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 62,
      lane: "NORMAL",
      reason: "ci failure",
      feedback: "second",
      evidenceKey: "k2",
    });
    // First FIXED transition — this one should fire
    await markPrFixItem(client, { repo: "org/repo", pr: 62, status: "FIXED" });
    lessonFeedMocks.extractLessonFromFixOutcome.mockClear();

    // Re-marking FIXED should NOT fire again
    await markPrFixItem(client, { repo: "org/repo", pr: 62, status: "FIXED" });

    await new Promise((r) => setTimeout(r, 0));
    expect(lessonFeedMocks.extractLessonFromFixOutcome).not.toHaveBeenCalled();
  });
});

describe("enqueuePrFixItem evidence dedupe", () => {
  it("does not move a resolved item back to QUEUED on evidence it already has", async () => {
    // The pinchflat#25 loop: an undismissed CHANGES_REQUESTED review is re-read
    // every sweep, so each resolution was undone 15 minutes later.
    const client = makeClient();
    const input = {
      repo: "misospace/pinchflat", pr: 25, lane: "NORMAL", type: "REVIEW_FEEDBACK",
      reason: "PR review: CHANGES_REQUESTED", feedback: "changes please",
      evidenceKey: "review:misospace/pinchflat#25:r1",
    };
    await enqueuePrFixItem(client, input);
    client.items[0].status = "FIXED";

    const again = await enqueuePrFixItem(client, input);

    expect(again.status).toBe("FIXED");
  });

  it("still records the repeat enqueue in history", async () => {
    // The status flip causes the churn, not the audit row — knowing the sync
    // re-observed the evidence stays visible.
    const client = makeClient();
    const input = {
      repo: "o/r", pr: 1, lane: "NORMAL", type: "REVIEW_FEEDBACK", reason: "r", feedback: "f",
      evidenceKey: "review:o/r#1:r1",
    };
    await enqueuePrFixItem(client, input);
    const afterFirst = client.history.length;
    await enqueuePrFixItem(client, input);
    expect(client.history.length).toBeGreaterThan(afterFirst);
  });

  it("new evidence re-queues a resolved item as before", async () => {
    const client = makeClient();
    const base = {
      repo: "o/r", pr: 2, lane: "NORMAL", type: "REVIEW_FEEDBACK", reason: "r", feedback: "f",
    };
    await enqueuePrFixItem(client, { ...base, evidenceKey: "review:o/r#2:r1" });
    client.items[0].status = "FIXED";
    const again = await enqueuePrFixItem(client, { ...base, evidenceKey: "review:o/r#2:r2" });
    expect(again.status).toBe("QUEUED");
  });
});

describe("buildPrFixBlockedContext", () => {
  it("derives totalAttempts and lastAttemptSummary from feedback", async () => {
    const client = makeClient();
    const item = { repo: "org/repo", pr: 7, feedback: ["first attempt", "final attempt"] };
    const context = await buildPrFixBlockedContext(client, item);
    expect(context.totalAttempts).toBe(2);
    expect(context.lastAttemptSummary).toBe("final attempt");
  });

  it("records the BLOCKED mark note as the final failure signature and groups attempts by lane", async () => {
    const client = makeClient();
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 7, lane: "NORMAL", reason: "ci failure", feedback: "first", evidenceKey: "k1",
    });
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 7, lane: "ESCALATED", reason: "still failing", feedback: "second", evidenceKey: "k2",
    });
    await markPrFixItem(client, { repo: "org/repo", pr: 7, status: "BLOCKED", note: "tests failed after 3 attempts" });
    const item = client.items.find((i) => i.pr === 7);
    const context = await buildPrFixBlockedContext(client, item);
    expect(context.finalFailureSignature).toBe("tests failed after 3 attempts");
    expect(context.attemptsByLane).toEqual({ NORMAL: 1, ESCALATED: 1 });
  });

  it("extracts and dedupes failing run links from feedback", async () => {
    const client = makeClient();
    const item = {
      repo: "org/repo",
      pr: 7,
      feedback: [
        "run: https://github.com/org/repo/actions/runs/1",
        "again https://github.com/org/repo/actions/runs/1",
      ],
    };
    const context = await buildPrFixBlockedContext(client, item);
    expect(context.failingRunLinks).toEqual(["https://github.com/org/repo/actions/runs/1"]);
  });

  it("uses uncapped history for totalAttempts", async () => {
    const client = makeClient();
    for (let i = 0; i < 13; i += 1) {
      await enqueuePrFixItem(client, {
        repo: "org/repo",
        pr: 8,
        lane: "NORMAL",
        reason: `failure ${i}`,
        feedback: `attempt ${i}`,
        evidenceKey: `k${i}`,
      });
    }

    const context = await buildPrFixBlockedContext(client, client.items.find((item) => item.pr === 8));
    expect(context.totalAttempts).toBe(13);
    expect(context.attemptsByLane).toEqual({ NORMAL: 13 });
  });

  it("returns no per-lane/signature data when absent (backwards compatible)", async () => {
    const client = makeClient();
    const context = await buildPrFixBlockedContext(client, { repo: "org/repo", pr: 1, feedback: [] });
    expect(context.totalAttempts).toBeUndefined();
    expect(context.finalFailureSignature).toBeUndefined();
    expect(context.lastAttemptSummary).toBeUndefined();
    expect(context.failingRunLinks).toBeUndefined();
  });
});

describe("requeuePrFixItem surface cleanup", () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
    surfacingMocks.surfacePrFixRequeued.mockReset();
    surfacingMocks.surfacePrFixRequeued.mockResolvedValue({ labelRemoved: true, commentUpdated: true, errors: [] });
  });

  it("requeues a BLOCKED item and calls surfacePrFixRequeued cleanup", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 70, lane: "NEEDS_HUMAN", reason: "blocked", feedback: "f", evidenceKey: "k1",
    });
    await markPrFixItem(client, { repo: "org/repo", pr: 70, status: "BLOCKED", note: "tombstone" });
    surfacingMocks.surfacePrFixRequeued.mockClear();

    const item = await requeuePrFixItem(client, { repo: "org/repo", pr: 70, note: "back to work" });

    expect(item?.status).toBe("QUEUED");
    expect(surfacingMocks.surfacePrFixRequeued).toHaveBeenCalledTimes(1);
    expect(surfacingMocks.surfacePrFixRequeued).toHaveBeenCalledWith("org/repo", 70, "back to work");
  });

  it("preserves the terminal guard and skips cleanup on a merged/closed PR", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 71, lane: "NEEDS_HUMAN", reason: "blocked", feedback: "f", evidenceKey: "k1",
    });
    await markPrFixItem(client, { repo: "org/repo", pr: 71, status: "BLOCKED" });
    surfacingMocks.surfacePrFixRequeued.mockClear();

    await expect(requeuePrFixItem(client, { repo: "org/repo", pr: 71, isPrMergedOrClosed: true }))
      .rejects.toThrow("upstream PR is merged or closed");
    expect(surfacingMocks.surfacePrFixRequeued).not.toHaveBeenCalled();
  });

  it("preserves the wrong-status guard and skips cleanup for a non-BLOCKED item", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 72, lane: "NORMAL", reason: "queued", feedback: "f", evidenceKey: "k1",
    });
    await markPrFixItem(client, { repo: "org/repo", pr: 72, status: "FIXED" });
    surfacingMocks.surfacePrFixRequeued.mockClear();

    await expect(requeuePrFixItem(client, { repo: "org/repo", pr: 72 }))
      .rejects.toThrow("not BLOCKED");
    expect(surfacingMocks.surfacePrFixRequeued).not.toHaveBeenCalled();
  });

  it("cleanup failure does not fail the requeue", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 73, lane: "NEEDS_HUMAN", reason: "blocked", feedback: "f", evidenceKey: "k1",
    });
    await markPrFixItem(client, { repo: "org/repo", pr: 73, status: "BLOCKED" });
    surfacingMocks.surfacePrFixRequeued.mockRejectedValue(new Error("network down"));

    const item = await requeuePrFixItem(client, { repo: "org/repo", pr: 73 });

    expect(item?.status).toBe("QUEUED");
  });
});
