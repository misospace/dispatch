import { describe, expect, it, beforeEach, vi } from "vitest";
import { enqueuePrFixItem, listQueuedPrFixItems, markPrFixItem, toAgentQueuePrFixItem, reconcileStalePrFixItems, requeuePrFixItem, buildPrFixBlockedContext, PrFixQueueClient } from "./pr-fix-queue";

const { surfacingMocks, lessonFeedMocks, githubPrsMocks } = vi.hoisted(() => ({
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
  githubPrsMocks: {
    fetchPullRequestMergeState: vi.fn(async () => ({ mergeableState: null, mergeable: null })),
    fetchPullRequestHeadSha: vi.fn(async (_repo: string, _pr: number): Promise<string | null> => null),
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

vi.mock("./github-prs", () => ({
  fetchPullRequestMergeState: githubPrsMocks.fetchPullRequestMergeState,
  fetchPullRequestHeadSha: githubPrsMocks.fetchPullRequestHeadSha,
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
          generation: 1, // mirrors the column's @default(1)
          queuedAt: new Date(Date.UTC(2026, 0, 1, 0, seq)),
          updatedAt: new Date(Date.UTC(2026, 0, 1, 0, seq)),
          ...data,
        };
        items.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const idx = items.findIndex((i) => i.id === where.id);
        // Interpret Prisma atomic operations ({ increment }) like the real client.
        const patch: Record<string, any> = { ...data };
        for (const key of Object.keys(patch)) {
          const value = patch[key];
          if (value && typeof value === "object" && typeof value.increment === "number") {
            patch[key] = (items[idx][key] ?? 0) + value.increment;
          }
        }
        items[idx] = { ...items[idx], ...patch, updatedAt: new Date(Date.UTC(2026, 0, 1, 1, ++seq)) };
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

  it("does not resurrect a STALE item on new evidence (#1000)", async () => {
    await enqueuePrFixItem(client, { repo: "org/repo", pr: 7, lane: "NORMAL", reason: "review", feedback: "f1", evidenceKey: "review:1" });
    // PR merges → the per-sync reap stales it.
    await reconcileStalePrFixItems(
      client,
      new Map([["org/repo", new Set([7])]]),
      new Map([["org/repo", new Map<number, "merged" | "closed">([[7, "merged"]])]]),
    );
    expect(client.items[0].status).toBe("STALE");

    // A fresh automated review lands after the merge (a new evidence key).
    // Before #1000 this flipped the item back to QUEUED and the coder looped
    // forever on a merged PR. It must stay STALE.
    const after = await enqueuePrFixItem(client, { repo: "org/repo", pr: 7, lane: "NORMAL", reason: "review", feedback: "f2", evidenceKey: "review:2" });
    expect(after.status).toBe("STALE");
    expect(await listQueuedPrFixItems(client, { includeBlocked: true })).toEqual([]);
  });

  it("blocks a REVIEW_FEEDBACK item after PR_FIX_MAX_ATTEMPTS distinct attempts (#1001)", async () => {
    const prev = process.env.PR_FIX_MAX_ATTEMPTS;
    process.env.PR_FIX_MAX_ATTEMPTS = "3";
    try {
      for (let i = 1; i <= 3; i++) {
        const item = await enqueuePrFixItem(client, { repo: "org/repo", pr: 9, lane: "NORMAL", reason: "review", feedback: `f${i}`, evidenceKey: `review:${i}` });
        expect(item.status).toBe("QUEUED");
      }
      // The 4th distinct attempt exceeds the cap → hand to a human instead of
      // re-queuing (the human-review-forever case).
      const blocked = await enqueuePrFixItem(client, { repo: "org/repo", pr: 9, lane: "NORMAL", reason: "review", feedback: "f4", evidenceKey: "review:4" });
      expect(blocked.status).toBe("BLOCKED");
      expect(blocked.lane).toBe("NEEDS_HUMAN");
      expect(surfacingMocks.surfacePrFixBlocked).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.PR_FIX_MAX_ATTEMPTS;
      else process.env.PR_FIX_MAX_ATTEMPTS = prev;
    }
  });
});

describe("work generation identity (#1044)", () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
    surfacingMocks.surfacePrFixBlocked.mockReset();
    surfacingMocks.surfacePrFixBlocked.mockResolvedValue({ labelApplied: true, commentPosted: true, errors: [] });
    surfacingMocks.surfacePrFixRequeued.mockReset();
    surfacingMocks.surfacePrFixRequeued.mockResolvedValue({ labelRemoved: true, commentUpdated: true, errors: [] });
    githubPrsMocks.fetchPullRequestHeadSha.mockReset();
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue(null);
  });

  it("starts at generation 1 and stays stable across repeated reads of the same pending work", async () => {
    const item = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 10, lane: "NORMAL", reason: "review requested",
      feedback: "first comment", evidenceKey: "review:1", headSha: "sha-1",
    });
    expect(item.generation).toBe(1);

    // Re-observing the same known evidence while already QUEUED is the same
    // pending unit of work — the identity must not move.
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 10, lane: "NORMAL", reason: "review requested",
      feedback: "first comment", evidenceKey: "review:1", headSha: "sha-1",
    });

    // Additional NEW evidence on already-QUEUED work enriches the same
    // attempt; it does not create a parallel dispatchable unit.
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 10, lane: "NORMAL", reason: "checks failed",
      feedback: "failing test", evidenceKey: "check:2", headSha: "sha-1",
    });

    for (let i = 0; i < 3; i += 1) {
      const queued = await listQueuedPrFixItems(client, { lane: "NORMAL" });
      expect(queued[0].generation).toBe(1);
    }
    expect(toAgentQueuePrFixItem(client.items[0]).generation).toBe(1);
  });

  it("bumps generation on explicit requeue from BLOCKED, and again from FIXED", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 11, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "k1",
    });
    await markPrFixItem(client, { repo: "org/repo", pr: 11, status: "BLOCKED", note: "stuck" });
    expect(client.items[0].status).toBe("BLOCKED");
    expect(client.items[0].generation).toBe(1); // BLOCKED is not fresh work

    const requeued = await requeuePrFixItem(client, { repo: "org/repo", pr: 11, note: "try again" });
    expect(requeued?.status).toBe("QUEUED");
    expect(requeued?.generation).toBe(2);

    await markPrFixItem(client, { repo: "org/repo", pr: 11, status: "FIXED", note: "done" });
    const requeuedAgain = await requeuePrFixItem(client, { repo: "org/repo", pr: 11 });
    expect(requeuedAgain?.status).toBe("QUEUED");
    expect(requeuedAgain?.generation).toBe(3);
  });

  it("bumps generation when genuinely new evidence reopens a FIXED item", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 12, lane: "NORMAL", reason: "r", feedback: "f1", evidenceKey: "review:1",
    });
    await markPrFixItem(client, { repo: "org/repo", pr: 12, status: "FIXED" });
    expect(client.items[0].generation).toBe(1);

    const reopened = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 12, lane: "NORMAL", reason: "new review round", feedback: "f2", evidenceKey: "review:2",
    });
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.generation).toBe(2);
  });

  it("keeps generation when known evidence is re-observed on a FIXED item whose head moved", async () => {
    // A real fix landed — the FIXED tombstone is trusted and the #25
    // anti-churn rule keeps the item resolved. No fresh work exists to
    // identify, so the generation stays put.
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 13, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "review:1", headSha: "oldsha",
    });
    await markPrFixItem(client, { repo: "org/repo", pr: 13, status: "FIXED" });

    const again = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 13, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "review:1", headSha: "newsha",
    });
    expect(again.status).toBe("FIXED");
    expect(again.generation).toBe(1);
  });

  it("bumps generation on #940 recovery from a no-progress FIXED tombstone", async () => {
    const input = {
      repo: "misospace/miso-gallery", pr: 467, lane: "NORMAL", type: "REVIEW_FEEDBACK",
      reason: "PR review: CHANGES_REQUESTED", feedback: "symlink guard",
      evidenceKey: "review:misospace/miso-gallery#467:r1", headSha: "efc36e3d",
    };
    await enqueuePrFixItem(client, input);
    await markPrFixItem(client, { repo: "misospace/miso-gallery", pr: 467, status: "FIXED", note: "foreman succeeded" });
    expect(client.items[0].generation).toBe(1);

    // Same evidence, head SHA unchanged — the tombstone is untrusted and the
    // item reopens as a fresh dispatchable attempt.
    const reopened = await enqueuePrFixItem(client, input);
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.generation).toBe(2);
  });

  it("bumps generation when a BLOCKED item is marked back to QUEUED via markPrFixItem", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 14, lane: "NEEDS_HUMAN", reason: "r", feedback: "f", evidenceKey: "k1",
    });
    expect(client.items[0].status).toBe("BLOCKED");

    const requeued = await markPrFixItem(client, { repo: "org/repo", pr: 14, status: "QUEUED", note: "operator unblock" });
    expect(requeued?.status).toBe("QUEUED");
    expect(requeued?.generation).toBe(2);
  });

  it("does not bump generation when marking an already-QUEUED item QUEUED", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 15, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "k1",
    });
    const again = await markPrFixItem(client, { repo: "org/repo", pr: 15, status: "QUEUED" });
    expect(again?.status).toBe("QUEUED");
    expect(again?.generation).toBe(1);
  });

  it("bumps generation when the head-SHA guard refuses FIXED and returns work to QUEUED", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 16, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "k1", headSha: "oldsha",
    });
    expect(client.items[0].generation).toBe(1);
    // One-shot override so the "head never moved" answer cannot leak into
    // later describes that rely on the shared default mock.
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValueOnce("oldsha");

    const result = await markPrFixItem(client, { repo: "org/repo", pr: 16, status: "FIXED", note: "reported done" });

    expect(result?.status).toBe("QUEUED");
    // The refused-FIXED rollback is a fresh worker attempt; an identity a
    // worker already consumed for generation 1 must not be silently reused.
    expect(result?.generation).toBe(2);
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

describe("pr-fix lesson feed trigger removed (#970)", () => {
  // Issue #970: markPrFixItem previously fired extractLessonFromFixOutcome on
  // every clean QUEUED -> FIXED transition with feedback.length >= 2, but the
  // only consumer of the result was a console.info line. Every qualifying
  // transition burned an LLM call whose output was discarded. The trigger
  // block and the `lesson-feed` import were removed from pr-fix-queue.ts;
  // `extractLessonFromFixOutcome` still lives in src/lib/lesson-feed.ts but
  // is opt-in via DISPATCH_LESSON_FEED_ENABLED. These tests guard against
  // the trigger being re-introduced.
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
    surfacingMocks.surfacePrFixBlocked.mockClear();
    lessonFeedMocks.extractLessonFromFixOutcome.mockClear();
  });

  it("does not invoke extractLessonFromFixOutcome on QUEUED -> FIXED with feedback.length >= 2", async () => {
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

    // The pre-#970 trigger was fire-and-forget (void + .then); wait a
    // microtask in case anything sneaks back in asynchronously.
    await new Promise((r) => setTimeout(r, 0));
    expect(lessonFeedMocks.extractLessonFromFixOutcome).not.toHaveBeenCalled();
  });

  it("does not invoke extractLessonFromFixOutcome on BLOCKED -> FIXED with feedback.length >= 2", async () => {
    // Same regression guard but starting from BLOCKED — the original trigger
    // also ran on every FIXED transition regardless of the prior status.
    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 61,
      lane: "NEEDS_HUMAN",
      reason: "needs human",
      feedback: "first",
      evidenceKey: "k1",
    });
    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 61,
      lane: "NEEDS_HUMAN",
      reason: "needs human",
      feedback: "second",
      evidenceKey: "k2",
    });
    lessonFeedMocks.extractLessonFromFixOutcome.mockClear();

    await markPrFixItem(client, { repo: "org/repo", pr: 61, status: "FIXED" });

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

  it("reopens a FIXED item when same evidence re-detected with head SHA unchanged (#940)", async () => {
    // Worked example from the issue: misospace/miso-gallery#467. The sync
    // re-detects the CHANGES_REQUESTED evidence every 15 minutes and writes
    // a fresh `enqueue` history row against a FIXED tombstone whose PR head
    // never moved. The item must reopen to QUEUED so the loop dispatches a
    // fix again instead of stranding the PR.
    const client = makeClient();
    const input = {
      repo: "misospace/miso-gallery", pr: 467, lane: "NORMAL", type: "REVIEW_FEEDBACK",
      reason: "PR review: CHANGES_REQUESTED", feedback: "symlink guard",
      evidenceKey: "review:misospace/miso-gallery#467:r1",
      headSha: "efc36e3d",
    };
    await enqueuePrFixItem(client, input);
    await markPrFixItem(client, { repo: "misospace/miso-gallery", pr: 467, status: "FIXED", note: "foreman succeeded" });

    const before = client.history.length;
    const reopened = await enqueuePrFixItem(client, input);

    expect(reopened.status).toBe("QUEUED");
    expect(reopened.lane).toBe("NORMAL");
    expect(reopened.headSha).toBe("efc36e3d");
    // History records both the re-enqueue and a #940-tagged note explaining
    // why we reopened despite the FIXED tombstone.
    const last = client.history.at(-1);
    expect(last).toMatchObject({ action: "enqueue", evidenceKey: input.evidenceKey });
    expect(last.note ?? "").toContain("940");
    expect(client.history.length).toBeGreaterThan(before);
  });

  it("does NOT reopen a FIXED item whose head SHA has moved (a real fix happened)", async () => {
    // The companion case: the FIXED tombstone is real — the workload pushed a
    // commit and the PR head moved. The sync re-detecting the same evidence
    // is the standard pinchflat#25 loop and must NOT resurrect the item.
    const client = makeClient();
    const firstInput = {
      repo: "o/r", pr: 3, lane: "NORMAL", type: "REVIEW_FEEDBACK",
      reason: "r", feedback: "f", evidenceKey: "review:o/r#3:r1", headSha: "oldsha",
    };
    await enqueuePrFixItem(client, firstInput);
    await markPrFixItem(client, { repo: "o/r", pr: 3, status: "FIXED" });

    // Same evidence, but head SHA is now different — the workload pushed.
    const reopened = await enqueuePrFixItem(client, { ...firstInput, headSha: "newsha" });

    expect(reopened.status).toBe("FIXED");
    expect(reopened.headSha).toBe("newsha");
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
    // Raise the attempt cap out of the way — this test exercises history-based
    // attempt counting, not the #1001 bound (which would otherwise re-lane the
    // later attempts to NEEDS_HUMAN).
    const prev = process.env.PR_FIX_MAX_ATTEMPTS;
    process.env.PR_FIX_MAX_ATTEMPTS = "100";
    try {
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
    } finally {
      if (prev === undefined) delete process.env.PR_FIX_MAX_ATTEMPTS;
      else process.env.PR_FIX_MAX_ATTEMPTS = prev;
    }
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

  it("preserves the wrong-status guard and skips cleanup for a STALE item", async () => {
    // FIXED items are now requeueable (#940); STALE remains terminal because
    // the upstream PR is gone (merged/closed).
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 72, lane: "NORMAL", reason: "queued", feedback: "f", evidenceKey: "k1",
    });
    await markPrFixItem(client, { repo: "org/repo", pr: 72, status: "STALE" });
    surfacingMocks.surfacePrFixRequeued.mockClear();

    await expect(requeuePrFixItem(client, { repo: "org/repo", pr: 72 }))
      .rejects.toThrow("not BLOCKED or FIXED");
    expect(surfacingMocks.surfacePrFixRequeued).not.toHaveBeenCalled();
  });

  it("requeues a FIXED item as a single-call recovery (#940)", async () => {
    // Recovery used to require two calls: mark BLOCKED, then requeue. The
    // BLOCKED step was a lie about the state and flipped the lane to
    // NEEDS_HUMAN. A FIXED item whose PR head hasn't moved should reopen
    // in one honest call.
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 80, lane: "NORMAL", reason: "review nit", feedback: "f", evidenceKey: "k1",
      headSha: "deadbeef",
    });
    await markPrFixItem(client, { repo: "org/repo", pr: 80, status: "FIXED", note: "foreman reported done" });
    surfacingMocks.surfacePrFixRequeued.mockClear();

    const item = await requeuePrFixItem(client, { repo: "org/repo", pr: 80, note: "no progress" });

    expect(item?.status).toBe("QUEUED");
    expect(item?.lane).toBe("NORMAL");
    expect(surfacingMocks.surfacePrFixRequeued).toHaveBeenCalledTimes(1);
    // History records both the source status and the #940 tag so an audit
    // can tell this came from a no-progress FIXED tombstone.
    const lastHistory = client.history.at(-1);
    expect(lastHistory).toMatchObject({
      action: "requeue",
      status: "QUEUED",
      lane: "NORMAL",
    });
    expect(lastHistory.note).toContain("FIXED");
    expect(lastHistory.note).toContain("940");
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

describe("markPrFixItem head SHA guard (#940)", () => {
  beforeEach(() => {
    surfacingMocks.surfacePrFixBlocked.mockClear();
    githubPrsMocks.fetchPullRequestHeadSha.mockReset();
    // Default to "head moved" so the rest of the test file is unaffected
    // unless an individual test overrides this.
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("newsha");
  });

  it("marks FIXED normally when the recorded headSha matches a different current head", async () => {
    const client = makeClient();
    await enqueuePrFixItem(client, {
      repo: "misospace/miso-gallery", pr: 467, lane: "NORMAL", reason: "r", feedback: "f",
      evidenceKey: "k1", headSha: "efc36e3d",
    });
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("newsha");

    const fixed = await markPrFixItem(client, {
      repo: "misospace/miso-gallery", pr: 467, status: "FIXED", note: "pushed",
    });

    expect(fixed?.status).toBe("FIXED");
    expect(githubPrsMocks.fetchPullRequestHeadSha).toHaveBeenCalledWith(
      "misospace/miso-gallery", 467,
    );
  });

  it("refuses FIXED and rolls back to QUEUED when the PR head SHA has not moved", async () => {
    // Worked example from #940: workload reported success but pushed nothing.
    const client = makeClient();
    await enqueuePrFixItem(client, {
      repo: "misospace/miso-gallery", pr: 467, lane: "NORMAL", reason: "r", feedback: "f",
      evidenceKey: "k1", headSha: "efc36e3d",
    });
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("efc36e3d");

    const result = await markPrFixItem(client, {
      repo: "misospace/miso-gallery", pr: 467, status: "FIXED", note: "foreman reported done",
    });

    expect(result?.status).toBe("QUEUED");
    expect(result?.lane).toBe("NORMAL");
    // A refusal note is recorded in history for the audit log.
    const last = client.history.at(-1);
    expect(last).toMatchObject({ action: "mark", status: "QUEUED", lane: "NORMAL" });
    expect(last.note ?? "").toContain("Refused FIXED");
    expect(last.note ?? "").toContain("940");
  });

  it("accepts FIXED when the item has no recorded headSha (legacy rows)", async () => {
    // Pre-#940 rows were enqueued without headSha. The guard cannot run;
    // accept rather than strand the PR.
    const client = makeClient();
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 1, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "k1",
    });
    // No headSha was passed at enqueue.
    expect(client.items[0].headSha).toBeUndefined();

    const fixed = await markPrFixItem(client, { repo: "org/repo", pr: 1, status: "FIXED" });

    expect(fixed?.status).toBe("FIXED");
    // Guard should not have run — no comparison possible without a record.
    expect(githubPrsMocks.fetchPullRequestHeadSha).not.toHaveBeenCalled();
  });

  it("accepts FIXED when the GitHub head SHA fetch fails (best-effort guard)", async () => {
    const client = makeClient();
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 1, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "k1",
      headSha: "oldsha",
    });
    githubPrsMocks.fetchPullRequestHeadSha.mockRejectedValue(new Error("network timeout"));

    const fixed = await markPrFixItem(client, { repo: "org/repo", pr: 1, status: "FIXED" });

    expect(fixed?.status).toBe("FIXED");
  });

  it("accepts FIXED when GitHub returns null for head SHA", async () => {
    const client = makeClient();
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 1, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "k1",
      headSha: "oldsha",
    });
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue(null);

    const fixed = await markPrFixItem(client, { repo: "org/repo", pr: 1, status: "FIXED" });

    expect(fixed?.status).toBe("FIXED");
  });

  it("does NOT run the head SHA guard for non-FIXED transitions", async () => {
    // BLOCKED, QUEUED, and STALE must not pay the GitHub round-trip.
    const client = makeClient();
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 1, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "k1",
      headSha: "oldsha",
    });

    await markPrFixItem(client, { repo: "org/repo", pr: 1, status: "BLOCKED" });
    await markPrFixItem(client, { repo: "org/repo", pr: 1, status: "QUEUED" });

    expect(githubPrsMocks.fetchPullRequestHeadSha).not.toHaveBeenCalled();
  });
});
