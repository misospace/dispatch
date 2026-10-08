import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createLinkedPrFixItem, enqueuePrFixItem, listQueuedPrFixItems, markPrFixItem, toAgentQueuePrFixItem, reconcileStalePrFixItems, requeuePrFixItem, buildPrFixBlockedContext, parseMarkPrFixInput, resolvePrFixFromAgentReport, PrFixQueueClient, type MarkPrFixResult } from "./pr-fix-queue";

function mutatedItem(result: MarkPrFixResult): any {
  if (!result.mutated) throw new Error(`expected mutation, got ${result.reason}`);
  return result.item;
}

const { surfacingMocks, lessonFeedMocks, githubPrsMocks } = vi.hoisted(() => ({
  surfacingMocks: {
    surfacePrFixBlocked: vi.fn().mockResolvedValue({ labelApplied: true, commentPosted: true, errors: [] }),
    surfacePrFixRequeued: vi.fn().mockResolvedValue({ labelRemoved: true, commentUpdated: true, errors: [] }),
    surfacePrFixUnblocked: vi.fn().mockResolvedValue({ labelRemoved: true, commentUpdated: true, errors: [] }),
    extractUrlsFromText: vi.fn((text: string) => {
      const passed = text.matchAll(/https:\/\/[^\s"'<>]+/g);
      return Array.from(passed).map((m) => m[0]);
    }),
  },
  lessonFeedMocks: {
    extractLessonFromFixOutcome: vi.fn().mockResolvedValue({ kind: "no_lesson" as const }),
  },
  githubPrsMocks: {
    fetchPullRequestMergeState: vi.fn(async (_repo: string, _pr: number): Promise<{ mergeableState: string | null; mergeable: boolean | null }> => ({ mergeableState: null, mergeable: null })),
    fetchPullRequestHeadSha: vi.fn(async (_repo: string, _pr: number): Promise<string | null> => null),
  },
}));

vi.mock("./pr-fix-surfacing", () => ({
  surfacePrFixBlocked: surfacingMocks.surfacePrFixBlocked,
  surfacePrFixRequeued: surfacingMocks.surfacePrFixRequeued,
  surfacePrFixUnblocked: surfacingMocks.surfacePrFixUnblocked,
  extractUrlsFromText: surfacingMocks.extractUrlsFromText,
}));

vi.mock("./lesson-feed", () => ({
  extractLessonFromFixOutcome: lessonFeedMocks.extractLessonFromFixOutcome,
}));

vi.mock("./github-prs", () => ({
  fetchPullRequestMergeState: githubPrsMocks.fetchPullRequestMergeState,
  fetchPullRequestHeadSha: githubPrsMocks.fetchPullRequestHeadSha,
}));

function makeClient(): PrFixQueueClient & {
  items: any[];
  history: any[];
  inTransaction: boolean;
  hooks: {
    beforeUpdateMany: (() => void) | null;
    beforeUpdateManyEvery: (() => void) | null;
  };
} {
  const items: any[] = [];
  const history: any[] = [];
  let seq = 0;
  const client: any = {
    items,
    history,
    // #1124: true while a $transaction callback is executing. Tests use it to
    // prove no network call (e.g. the post-dispatch head fetch) runs inside a
    // transaction.
    inTransaction: false,
    // One-shot gap hook (#1119): a test sets it to land a concurrent enqueue
    // right before a conditional updateMany — i.e. inside the read→write gap
    // the settlement guard is meant to catch. (A findUnique hook cannot hit
    // that window: the mark's pre-check read is repo_pr-form and its post-write
    // re-read is id-form, with no read between them.)
    hooks: { beforeUpdateMany: null, beforeUpdateManyEvery: null },
    $transaction: async (fn: any) => {
      client.inTransaction = true;
      try {
        return await fn(client);
      } finally {
        client.inTransaction = false;
      }
    },
    prFixQueueItem: {
      findUnique: async ({ where }: any) => {
        // Support both lookup shapes: composite repo_pr and primary id.
        if (where.id !== undefined) {
          return items.find((i) => i.id === where.id) ?? null;
        }
        return items.find((i) => i.repo === where.repo_pr.repo && i.pr === where.repo_pr.pr) ?? null;
      },
      create: async ({ data }: any) => {
        const item = {
          id: `item-${++seq}`,
          generation: 1, // mirrors the column's @default(1)
          fixAttempts: 1, // mirrors the column's @default(1)
          // #1119 dispatch-tracking columns: default to their schema values so a
          // freshly created row reads back as "never dispatched, no post-dispatch
          // evidence".
          postDispatchEvidenceKeys: [], // mirrors the column's @default([])
          dispatchedGeneration: null, // Int? — no hand-out recorded yet
          dispatchedAt: null, // DateTime? — no hand-out recorded yet
          queuedAt: new Date(Date.UTC(2026, 0, 1, 0, seq)),
          updatedAt: new Date(Date.UTC(2026, 0, 1, 0, seq)),
          ...data,
        };
        items.push(item);
        return item;
      },
      update: async ({ where, data }: any) => {
        const idx = items.findIndex((i) => i.id === where.id);
        // mirror Prisma P2025 for a missing row (#1134 deleted-row coverage)
        if (idx === -1) {
          const err = new Error("An operation failed because it depends on one or more records that were required but not found. Record to update does not exist.");
          (err as any).code = "P2025";
          throw err;
        }
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
      updateMany: async ({ where, data }: any) => {
        if (client.hooks.beforeUpdateMany) {
          const hook = client.hooks.beforeUpdateMany;
          client.hooks.beforeUpdateMany = null;
          hook();
        }
        // Persistent variant (#1124): fires before EVERY updateMany, so a test
        // can model evidence that keeps landing on each pinned write.
        client.hooks.beforeUpdateManyEvery?.();
        // Generation-conditional (and/or id-scoped) bulk write — mirrors the
        // real client's commit-time revalidation semantics for #1074, plus
        // the post-dispatch evidence guard ({ equals: [...] }) for #1119.
        const matches = items.filter(
          (i) =>
            (where.id === undefined || i.id === where.id) &&
            (where.generation === undefined || i.generation === where.generation) &&
            (where.postDispatchEvidenceKeys === undefined ||
              JSON.stringify(i.postDispatchEvidenceKeys ?? []) ===
                JSON.stringify(where.postDispatchEvidenceKeys.equals ?? [])),
        );
        for (const match of matches) {
          const idx = items.findIndex((i) => i.id === match.id);
          const patch: Record<string, any> = { ...data };
          for (const key of Object.keys(patch)) {
            const value = patch[key];
            if (value && typeof value === "object" && typeof value.increment === "number") {
              patch[key] = (match[key] ?? 0) + value.increment;
            }
          }
          items[idx] = { ...match, ...patch, updatedAt: new Date(Date.UTC(2026, 0, 1, 1, ++seq)) };
        }
        return { count: matches.length };
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

    expect(fixed.mutated).toBe(true);
    expect(mutatedItem(fixed)?.status).toBe("FIXED");
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

  it("blocks a REVIEW_FEEDBACK item after PR_FIX_MAX_ATTEMPTS fix attempts (#1001)", async () => {
    const prev = process.env.PR_FIX_MAX_ATTEMPTS;
    process.env.PR_FIX_MAX_ATTEMPTS = "3";
    try {
      // Each loop is one attempt: the fix is marked FIXED, then a fresh
      // review reopens it.
      for (let i = 1; i <= 3; i++) {
        const item = await enqueuePrFixItem(client, { repo: "org/repo", pr: 9, lane: "NORMAL", reason: "review", feedback: `f${i}`, evidenceKey: `review:${i}` });
        expect(item.status).toBe("QUEUED");
        expect(item.fixAttempts).toBe(i);
        const fixed = await markPrFixItem(client, { repo: "org/repo", pr: 9, status: "fixed" });
        expect(mutatedItem(fixed)?.status).toBe("FIXED");
      }
      // The 4th attempt exceeds the cap → hand to a human instead of
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

describe("item URL is identity, write-once (#1098)", () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
    surfacingMocks.surfacePrFixBlocked.mockReset();
    surfacingMocks.surfacePrFixBlocked.mockResolvedValue({ labelApplied: true, commentPosted: true, errors: [] });
  });

  it("keeps the PR URL when a CI-failure re-enqueue carries a job URL", async () => {
    await enqueuePrFixItem(client, {
      repo: "o/repo", pr: 7, lane: "NORMAL", type: "REVIEW_FEEDBACK",
      reason: "PR review: CHANGES_REQUESTED", feedback: "changes requested",
      evidenceKey: "rev-1",
      url: "https://api.github.com/repos/o/repo/pulls/7",
    });

    const after = await enqueuePrFixItem(client, {
      repo: "o/repo", pr: 7, lane: "NORMAL", type: "CI_FAILURE",
      reason: "checks failed", feedback: "build failed",
      evidenceKey: "cr-1",
      url: "https://github.com/o/repo/actions/runs/9/job/1",
    });

    // The item URL is identity: it must stay the PR URL, never flip to the
    // CI job URL, so next-task keeps handing out pullRequest.url.
    expect(after.url).toBe("https://api.github.com/repos/o/repo/pulls/7");
    expect(client.items[0].url).toBe("https://api.github.com/repos/o/repo/pulls/7");
    // Evidence is still appended even when the URL is not.
    expect(client.items[0].feedback).toEqual(["changes requested", "build failed"]);
    expect(client.items[0].evidenceKeys).toEqual(["rev-1", "cr-1"]);
  });

  it("repairs a stored CI job URL on the next enqueue that carries the PR URL (#1118)", async () => {
    await enqueuePrFixItem(client, {
      repo: "o/repo", pr: 9, lane: "NORMAL", type: "CI_FAILURE",
      reason: "r", feedback: "f1", evidenceKey: "cr-1",
    });
    // A row poisoned by the pre-#1098 ingestion.
    client.items[0].url = "https://github.com/o/repo/actions/runs/9/job/1";

    const after = await enqueuePrFixItem(client, {
      repo: "o/repo", pr: 9, lane: "NORMAL", type: "REVIEW_FEEDBACK",
      reason: "r", feedback: "f2", evidenceKey: "rev-1",
      url: "https://api.github.com/repos/o/repo/pulls/9",
    });

    expect(after.url).toBe("https://api.github.com/repos/o/repo/pulls/9");
  });

  it("leaves a legitimate stored URL alone even when a different one arrives", async () => {
    await enqueuePrFixItem(client, {
      repo: "o/repo", pr: 10, lane: "NORMAL", type: "REVIEW_FEEDBACK",
      reason: "r", feedback: "f1", evidenceKey: "rev-1",
      url: "https://github.com/o/repo/pull/10",
    });

    const after = await enqueuePrFixItem(client, {
      repo: "o/repo", pr: 10, lane: "NORMAL", type: "REVIEW_FEEDBACK",
      reason: "r", feedback: "f2", evidenceKey: "rev-2",
      url: "https://api.github.com/repos/o/repo/pulls/10",
    });

    expect(after.url).toBe("https://github.com/o/repo/pull/10");
  });

  it("never stores a CI job URL as the item URL, on create or on backfill (#1118)", async () => {
    const created = await enqueuePrFixItem(client, {
      repo: "o/repo", pr: 11, lane: "NORMAL", type: "CI_FAILURE",
      reason: "r", feedback: "f1", evidenceKey: "cr-1",
      url: "https://github.com/o/repo/actions/runs/9/job/1",
    });
    expect(created.url).toBeUndefined();

    const reenqueued = await enqueuePrFixItem(client, {
      repo: "o/repo", pr: 11, lane: "NORMAL", type: "CI_FAILURE",
      reason: "r", feedback: "f2", evidenceKey: "cr-2",
      url: "https://github.com/o/repo/actions/runs/10/job/2",
    });
    expect(reenqueued.url).toBeUndefined();
  });

  it("backfills the URL only when the item has none", async () => {
    await enqueuePrFixItem(client, {
      repo: "o/repo", pr: 8, lane: "NORMAL", type: "REVIEW_FEEDBACK",
      reason: "r", feedback: "f1", evidenceKey: "rev-1",
    });
    expect(client.items[0].url).toBeUndefined();

    const after = await enqueuePrFixItem(client, {
      repo: "o/repo", pr: 8, lane: "NORMAL", type: "CI_FAILURE",
      reason: "r", feedback: "f2", evidenceKey: "cr-1",
      url: "https://api.github.com/repos/o/repo/pulls/8",
    });

    expect(after.url).toBe("https://api.github.com/repos/o/repo/pulls/8");
    expect(client.items[0].url).toBe("https://api.github.com/repos/o/repo/pulls/8");
  });

  it("backfills the URL when the stored value is the empty string (String? column shape)", async () => {
    await enqueuePrFixItem(client, {
      repo: "o/repo", pr: 8, lane: "NORMAL", type: "CI_FAILURE",
      reason: "r", feedback: "f1", evidenceKey: "cr-1",
      url: "",
    });
    // The webhook enqueues with url: "" when the PR object has no url (#1098);
    // a String? column can carry the empty string, which the write-once guard
    // must treat as empty.
    client.items[0].url = "";

    const after = await enqueuePrFixItem(client, {
      repo: "o/repo", pr: 8, lane: "NORMAL", type: "CI_FAILURE",
      reason: "r", feedback: "f2", evidenceKey: "cr-2",
      url: "https://api.github.com/repos/o/repo/pulls/8",
    });

    expect(after.url).toBe("https://api.github.com/repos/o/repo/pulls/8");
    expect(client.items[0].url).toBe("https://api.github.com/repos/o/repo/pulls/8");
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
    expect(requeued.mutated).toBe(true);
    expect(mutatedItem(requeued)?.status).toBe("QUEUED");
    expect(mutatedItem(requeued)?.generation).toBe(2);
  });

  it("does not bump generation when marking an already-QUEUED item QUEUED", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 15, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "k1",
    });
    const again = await markPrFixItem(client, { repo: "org/repo", pr: 15, status: "QUEUED" });
    expect(again.mutated).toBe(true);
    expect(mutatedItem(again)?.status).toBe("QUEUED");
    expect(mutatedItem(again)?.generation).toBe(1);
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

    expect(result.mutated).toBe(true);
    expect(mutatedItem(result)?.status).toBe("QUEUED");
    // The refused-FIXED rollback is a fresh worker attempt; an identity a
    // worker already consumed for generation 1 must not be silently reused.
    expect(mutatedItem(result)?.generation).toBe(2);
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

  it("requeue clears the recorded post-dispatch evidence keys and bumps the generation (#1119)", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 74, lane: "NORMAL", reason: "blocked", feedback: "f", evidenceKey: "k1",
    });
    await markPrFixItem(client, { repo: "org/repo", pr: 74, status: "BLOCKED" });
    // Post-dispatch evidence stamped on the row (a stale check that did not
    // actionably reopen the BLOCKED settlement) must not carry into the
    // fresh operator-requeued attempt.
    client.items[0].postDispatchEvidenceKeys = ["check_run:org/repo#74:5@aaaa1111"];

    const item = await requeuePrFixItem(client, { repo: "org/repo", pr: 74, note: "try again" });

    expect(item?.status).toBe("QUEUED");
    expect(item?.generation).toBe(2);
    expect(item?.postDispatchEvidenceKeys).toEqual([]);
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

    expect(fixed.mutated).toBe(true);
    expect(mutatedItem(fixed)?.status).toBe("FIXED");
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

    expect(result.mutated).toBe(true);
    expect(mutatedItem(result)?.status).toBe("QUEUED");
    expect(mutatedItem(result)?.lane).toBe("NORMAL");
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

    expect(fixed.mutated).toBe(true);
    expect(mutatedItem(fixed)?.status).toBe("FIXED");
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

    expect(fixed.mutated).toBe(true);
    expect(mutatedItem(fixed)?.status).toBe("FIXED");
  });

  it("accepts FIXED when GitHub returns null for head SHA", async () => {
    const client = makeClient();
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 1, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "k1",
      headSha: "oldsha",
    });
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue(null);

    const fixed = await markPrFixItem(client, { repo: "org/repo", pr: 1, status: "FIXED" });

    expect(fixed.mutated).toBe(true);
    expect(mutatedItem(fixed)?.status).toBe("FIXED");
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

describe("#1121 already_addressed settlement", () => {
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

  it("settles to FIXED without the #940 head guard and records the evidence", async () => {
    await enqueuePrFixItem(client, {
      repo: "acme/widgets", pr: 1121, lane: "NORMAL", reason: "r", feedback: "f",
      evidenceKey: "k1", headSha: "abc1234",
    });
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("abc1234");

    const result = await markPrFixItem(client, {
      repo: "acme/widgets", pr: 1121, status: "FIXED",
      alreadyAddressed: true, evidence: "addressed in commit abc1234",
    });

    expect(result.mutated).toBe(true);
    expect(mutatedItem(result)?.status).toBe("FIXED");
    const last = client.history.at(-1);
    expect(last).toMatchObject({ action: "mark" });
    expect(last.note ?? "").toContain("already_addressed");
    expect(last.note ?? "").toContain("1121");
    expect(last.note ?? "").toContain("addressed in commit abc1234");
  });

  it("a plain FIXED with an unmoved head is STILL refused by the #940 guard (invariant)", async () => {
    const fresh = makeClient();
    await enqueuePrFixItem(fresh, {
      repo: "acme/widgets", pr: 1121, lane: "NORMAL", reason: "r", feedback: "f",
      evidenceKey: "k1", headSha: "abc1234",
    });
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("abc1234");

    const result = await markPrFixItem(fresh, {
      repo: "acme/widgets", pr: 1121, status: "FIXED",
    });

    expect(mutatedItem(result)?.status).toBe("QUEUED");
    const last = fresh.history.at(-1);
    expect(last.note ?? "").toContain("Refused FIXED");
    expect(last.note ?? "").toContain("940");
  });

  it("new evidence reopens an already_addressed item as a fresh attempt", async () => {
    await enqueuePrFixItem(client, {
      repo: "acme/widgets", pr: 1121, lane: "NORMAL", reason: "r", feedback: "f",
      evidenceKey: "k1", headSha: "abc1234",
    });
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("abc1234");
    const fixed = await markPrFixItem(client, {
      repo: "acme/widgets", pr: 1121, status: "FIXED",
      alreadyAddressed: true, evidence: "done already",
    });
    expect(mutatedItem(fixed)?.status).toBe("FIXED");

    const reopened = await enqueuePrFixItem(client, {
      repo: "acme/widgets", pr: 1121, lane: "NORMAL", reason: "r", feedback: "new review",
      evidenceKey: "k2", headSha: "abc1234",
    });
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.generation).toBe(2);
    expect(reopened.fixAttempts).toBe(2);
  });

  it("a repeated already_addressed disagreement with an unchanged head is bounded to BLOCKED at the cap", async () => {
    const prevCap = process.env.PR_FIX_MAX_ATTEMPTS;
    process.env.PR_FIX_MAX_ATTEMPTS = "3";
    try {
      const fresh = makeClient();
      await enqueuePrFixItem(fresh, {
        repo: "acme/widgets", pr: 1121, lane: "NORMAL", reason: "r", feedback: "f",
        evidenceKey: "k1", headSha: "h",
      });
      githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("h");

      let enq: any;
      for (let i = 0; i < 12; i += 1) {
        enq = await enqueuePrFixItem(fresh, {
          repo: "acme/widgets", pr: 1121, lane: "NORMAL", reason: "r", feedback: "f",
          evidenceKey: "k1", headSha: "h",
        });
        if (enq.status === "BLOCKED") break;
        await markPrFixItem(fresh, {
          repo: "acme/widgets", pr: 1121, status: "FIXED", alreadyAddressed: true,
        });
      }

      expect(enq.status).toBe("BLOCKED");
      const row = await fresh.prFixQueueItem.findUnique({ where: { repo_pr: { repo: "acme/widgets", pr: 1121 } } });
      expect(row.status).toBe("BLOCKED");
      expect(row.lane).toBe("NEEDS_HUMAN");
    } finally {
      if (prevCap === undefined) delete process.env.PR_FIX_MAX_ATTEMPTS;
      else process.env.PR_FIX_MAX_ATTEMPTS = prevCap;
    }
  });
});

describe("attempt baseline + generation-conditional writes (#1074)", () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
    surfacingMocks.surfacePrFixBlocked.mockReset();
    surfacingMocks.surfacePrFixBlocked.mockResolvedValue({ labelApplied: true, commentPosted: true, errors: [] });
    githubPrsMocks.fetchPullRequestHeadSha.mockReset();
    // Default to "head moved" so the guard passes unless a test overrides.
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("movedsha");
  });

  it("captures attemptHeadSha from headSha on a fresh enqueue", async () => {
    const item = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 92, lane: "NORMAL", reason: "r", feedback: "f",
      evidenceKey: "k1", headSha: "abc123",
    });
    expect(item.attemptHeadSha).toBe("abc123");
    expect(item.headSha).toBe("abc123");
  });

  it("re-baselines attemptHeadSha when new evidence reopens a resolved item", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 93, lane: "NORMAL", reason: "r", feedback: "f",
      evidenceKey: "k1", headSha: "oldsha",
    });
    expect(client.items[0].attemptHeadSha).toBe("oldsha");
    // Resolve the item (head moved, so the guard passes).
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("newsha");
    await markPrFixItem(client, { repo: "org/repo", pr: 93, status: "FIXED" });

    // New evidence reopens it as a fresh attempt with a new head baseline.
    const reopened = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 93, lane: "NORMAL", reason: "new round", feedback: "f2",
      evidenceKey: "k2", headSha: "newer",
    });
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.attemptHeadSha).toBe("newer");
  });

  it("exposes attemptHeadSha on the agent-queue item", async () => {
    const item = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 94, lane: "NORMAL", reason: "r", feedback: "f",
      evidenceKey: "k1", headSha: "base42",
    });
    const queued = toAgentQueuePrFixItem(item);
    expect(queued.attemptHeadSha).toBe("base42");
    expect(queued.headSha).toBe("base42");
  });

  it("refuses a generation-conditional FIXED via updateMany when the head is unchanged", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 90, lane: "NORMAL", reason: "r", feedback: "f",
      evidenceKey: "k1", headSha: "base",
    });
    expect(client.items[0].generation).toBe(1);
    // Head has not moved since the attempt baseline.
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("base");

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 90, status: "FIXED", note: "reported done",
      expectedGeneration: 1,
    });

    // The refusal re-queues as a fresh attempt (generation bumped); the
    // conditional write matched the row, so the result is mutated.
    expect(result.mutated).toBe(true);
    expect(mutatedItem(result)?.status).toBe("QUEUED");
    expect(mutatedItem(result)?.generation).toBe(2);
  });

  it("skips a generation-conditional mark when the generation no longer matches", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 91, lane: "NORMAL", reason: "r", feedback: "f",
      evidenceKey: "k1",
    });
    // Simulate a concurrent re-issue: the row is now at generation 2.
    client.items[0].generation = 2;

    // The worker's report carries the stale generation-1 token.
    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 91, status: "BLOCKED", note: "stale report",
      expectedGeneration: 1,
    });

    // No mutation: the conditional write matches nothing.
    expect(result).toEqual({ mutated: false, reason: "generation-mismatch" });
    expect(client.items[0].status).toBe("QUEUED");
    expect(client.items[0].generation).toBe(2);
  });

  it("returns not-found for a mark of an unknown item without mutating", async () => {
    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 999, status: "FIXED",
    });
    expect(result).toEqual({ mutated: false, reason: "not-found" });
    expect(client.items).toHaveLength(0);
  });
});

// The issue's Done-when areas that the existing suite did not cover:
// in-flight enrichment, no-progress re-baselining, late/duplicate reports,
// commit-time races, and the pre-#1074 baseline fallback.
describe("settlement races and baseline fallback (#1074)", () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
    surfacingMocks.surfacePrFixBlocked.mockReset();
    surfacingMocks.surfacePrFixBlocked.mockResolvedValue({ labelApplied: true, commentPosted: true, errors: [] });
    githubPrsMocks.fetchPullRequestHeadSha.mockReset();
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("movedsha");
    githubPrsMocks.fetchPullRequestMergeState.mockReset();
    githubPrsMocks.fetchPullRequestMergeState.mockResolvedValue({ mergeableState: null, mergeable: null });
  });

  it("keeps the attempt baseline stable when new evidence enriches an in-flight item, and settles without erasing the new feedback", async () => {
    // The worker picks the attempt up: QUEUED at generation 1, the
    // per-attempt baseline is the head the sync observed at dispatch.
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 95, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "k1", headSha: "H1",
    });
    expect(client.items[0].status).toBe("QUEUED");
    expect(client.items[0].generation).toBe(1);
    expect(client.items[0].attemptHeadSha).toBe("H1");

    // A fresh review lands while the worker is mid-work: new evidence, new
    // head. The item is already QUEUED, so this enriches the SAME attempt —
    // no generation bump, and the immutable baseline must stay H1.
    const enriched = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 95, lane: "NORMAL", reason: "r2", feedback: "f2",
      evidenceKey: "k2", headSha: "H2",
    });
    expect(enriched.status).toBe("QUEUED");
    expect(enriched.generation).toBe(1);
    expect(enriched.headSha).toBe("H2");
    expect(enriched.attemptHeadSha).toBe("H1"); // baseline unchanged

    // The in-flight report settles against the ORIGINAL token. The head
    // moved H1 → H2, so the guard compares against the attempt baseline
    // (H1) and passes.
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("H2");
    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 95, status: "FIXED", note: "pushed fix",
      expectedGeneration: 1,
    });

    expect(result.mutated).toBe(true);
    expect(mutatedItem(result)?.status).toBe("FIXED");
    // Settlement must not erase the newer feedback recorded mid-flight.
    expect(client.items[0].feedback).toEqual(["f1", "f2"]);
    expect(client.items[0].evidenceKeys).toEqual(["k1", "k2"]);
    expect(client.history.at(-1)).toMatchObject({ action: "mark", status: "FIXED" });
  });

  it("reopens a no-progress FIXED item with a new generation and a fresh attempt baseline", async () => {
    const input = {
      repo: "org/repo", pr: 96, lane: "NORMAL", reason: "r", feedback: "f",
      evidenceKey: "k1", headSha: "H1",
    };
    await enqueuePrFixItem(client, input);
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("H-moved");
    await markPrFixItem(client, { repo: "org/repo", pr: 96, status: "FIXED" });
    expect(client.items[0].generation).toBe(1);

    // Same evidence, head never moved → untrusted tombstone: the item
    // reopens as a fresh dispatchable attempt with a re-baselined head.
    const reopened = await enqueuePrFixItem(client, input);
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.generation).toBe(2);
    expect(reopened.attemptHeadSha).toBe("H1");
  });

  it("skips a late report carrying a superseded attempt token without any writes", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 97, lane: "NORMAL", reason: "r", feedback: "f",
      evidenceKey: "k1", headSha: "H1",
    });
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("H-moved");
    await markPrFixItem(client, { repo: "org/repo", pr: 97, status: "FIXED" });
    // No-progress re-issue: the row is now at generation 2.
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 97, lane: "NORMAL", reason: "r", feedback: "f",
      evidenceKey: "k1", headSha: "H1",
    });
    expect(client.items[0].generation).toBe(2);

    // The superseded worker's report finally lands, still carrying
    // generation 1.
    githubPrsMocks.fetchPullRequestHeadSha.mockClear();
    githubPrsMocks.fetchPullRequestMergeState.mockClear();
    const historyBefore = client.history.length;
    const lateReport = await resolvePrFixFromAgentReport({
      client: client as PrFixQueueClient,
      repoFullName: "org/repo",
      pullRequestNumber: 97,
      outcome: "pr_updated",
      attempt: { itemId: client.items[0].id, generation: 1 },
    });

    expect(lateReport.matched).toBe(true);
    expect(lateReport.action).toBe("skipped");
    expect(lateReport.reason).toContain("stale attempt generation");
    // Zero writes: no item mutation, no history row, no GitHub round-trips.
    expect(client.items[0].status).toBe("QUEUED");
    expect(client.items[0].generation).toBe(2);
    expect(client.history.length).toBe(historyBefore);
    expect(githubPrsMocks.fetchPullRequestHeadSha).not.toHaveBeenCalled();
    expect(githubPrsMocks.fetchPullRequestMergeState).not.toHaveBeenCalled();
  });

  it("skips settlement when a concurrent re-issue lands between the read and the conditional write", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 98, lane: "NORMAL", reason: "r", feedback: "f",
      evidenceKey: "k1", headSha: "H1",
    });

    // Simulate the race: the resolver's read sees generation 1, but a
    // concurrent re-issue bumps the row just before the conditional
    // commit-time write, so the generation-qualified updateMany matches
    // nothing.
    const originalUpdateMany = client.prFixQueueItem.updateMany;
    let raced = false;
    client.prFixQueueItem.updateMany = async ({ where, data }: any) => {
      if (!raced && where.generation === 1) {
        raced = true;
        const idx = client.items.findIndex((i) => i.id === where.id);
        client.items[idx] = { ...client.items[idx], generation: 2 };
      }
      return originalUpdateMany({ where, data });
    };

    githubPrsMocks.fetchPullRequestMergeState.mockResolvedValueOnce({ mergeable: true, mergeableState: "CLEAN" });
    const historyBefore = client.history.length;
    const result = await resolvePrFixFromAgentReport({
      client: client as PrFixQueueClient,
      repoFullName: "org/repo",
      pullRequestNumber: 98,
      outcome: "pr_updated",
      attempt: { itemId: client.items[0].id, generation: 1 },
    });

    expect(raced).toBe(true);
    expect(result.matched).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("generation-mismatch");
    // The conditional write matched nothing: no status flip, no history row.
    expect(client.items[0].status).toBe("QUEUED");
    expect(client.items[0].generation).toBe(2);
    expect(client.history.length).toBe(historyBefore);
    // Nothing runs after the skip: the merge check and the head check are
    // the only GitHub calls.
    expect(githubPrsMocks.fetchPullRequestMergeState).toHaveBeenCalledTimes(1);
    expect(githubPrsMocks.fetchPullRequestHeadSha).toHaveBeenCalledTimes(1);
  });

  it("uses the mutable headSha as the baseline for legacy rows: unchanged head → refused", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 99, lane: "NORMAL", reason: "r", feedback: "f",
      evidenceKey: "k1", headSha: "H1",
    });
    // Pre-#1074 row: no per-attempt baseline column.
    client.items[0].attemptHeadSha = null;

    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("H1");
    const result = await markPrFixItem(client, { repo: "org/repo", pr: 99, status: "FIXED" });

    expect(result.mutated).toBe(true);
    expect(mutatedItem(result)?.status).toBe("QUEUED");
    expect(mutatedItem(result)?.generation).toBe(2);
    expect(client.history.at(-1).note ?? "").toContain("Refused FIXED");
    expect(client.history.at(-1).note ?? "").toContain("recorded=H1");
  });

  it("settles a legacy row via the headSha fallback when the head moved", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 99, lane: "NORMAL", reason: "r", feedback: "f",
      evidenceKey: "k1", headSha: "H1",
    });
    client.items[0].attemptHeadSha = null;

    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("H2");
    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 99, status: "FIXED", note: "pushed the fix",
    });

    expect(result.mutated).toBe(true);
    expect(mutatedItem(result)?.status).toBe("FIXED");
    expect(client.history.at(-1).note ?? "").toContain("pushed");
  });

  it("accepts FIXED when the row has no baseline at all (no-record)", async () => {
    // Legacy row: neither headSha nor attemptHeadSha recorded.
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 100, lane: "NORMAL", reason: "r", feedback: "f",
      evidenceKey: "k1",
    });
    expect(client.items[0].attemptHeadSha).toBeNull();
    expect(client.items[0].headSha).toBeUndefined();

    const result = await markPrFixItem(client, { repo: "org/repo", pr: 100, status: "FIXED" });

    expect(result.mutated).toBe(true);
    expect(mutatedItem(result)?.status).toBe("FIXED");
    // With no record to compare against, the guard must not even hit GitHub.
    expect(githubPrsMocks.fetchPullRequestHeadSha).not.toHaveBeenCalled();
  });
});

describe("parseMarkPrFixInput generation (#1074)", () => {
  it("passes a valid integer generation through as expectedGeneration", () => {
    const input = parseMarkPrFixInput({ repo: "org/repo", pr: 1, status: "FIXED", generation: 3 });
    if ("error" in input) throw new Error(input.error);
    expect(input).toEqual({ repo: "org/repo", pr: 1, status: "FIXED", note: null, expectedGeneration: 3, attemptHeadSha: null });
  });

  it("passes attemptHeadSha through when provided", () => {
    const input = parseMarkPrFixInput({ repo: "org/repo", pr: 1, status: "QUEUED", generation: 2, attemptHeadSha: "abc1234" });
    if ("error" in input) throw new Error(input.error);
    expect(input.expectedGeneration).toBe(2);
    expect(input.attemptHeadSha).toBe("abc1234");
  });

  it("trims and accepts a valid attemptHeadSha", () => {
    const input = parseMarkPrFixInput({ repo: "org/repo", pr: 1, status: "FIXED", attemptHeadSha: "  abc123def456  " });
    if ("error" in input) throw new Error(input.error);
    expect(input.attemptHeadSha).toBe("abc123def456");
  });

  it("rejects an attemptHeadSha that is not a git SHA", () => {
    expect(parseMarkPrFixInput({ repo: "org/repo", pr: 1, status: "FIXED", attemptHeadSha: "not-a-sha" })).toEqual({ error: "Invalid attemptHeadSha" });
  });

  it("rejects a too-short attemptHeadSha", () => {
    expect(parseMarkPrFixInput({ repo: "org/repo", pr: 1, status: "FIXED", attemptHeadSha: "abc12" })).toEqual({ error: "Invalid attemptHeadSha" });
  });

  it("rejects a non-string attemptHeadSha", () => {
    expect(parseMarkPrFixInput({ repo: "org/repo", pr: 1, status: "FIXED", attemptHeadSha: 1234567 })).toEqual({ error: "Invalid attemptHeadSha" });
  });

  it("rejects a non-integer generation", () => {
    expect(parseMarkPrFixInput({ repo: "org/repo", pr: 1, status: "FIXED", generation: 1.5 })).toEqual({ error: "generation must be an integer >= 1" });
  });

  it("rejects a generation below 1", () => {
    expect(parseMarkPrFixInput({ repo: "org/repo", pr: 1, status: "FIXED", generation: 0 })).toEqual({ error: "generation must be an integer >= 1" });
  });

  it("leaves expectedGeneration undefined when generation is absent", () => {
    const input = parseMarkPrFixInput({ repo: "org/repo", pr: 1, status: "FIXED" });
    if ("error" in input) throw new Error(input.error);
    expect(input.expectedGeneration).toBeUndefined();
  });
});

describe("parseMarkPrFixInput #1121", () => {
  it("passes through alreadyAddressed and trims the evidence", () => {
    const input = parseMarkPrFixInput({ repo: "o/r", pr: 1, status: "FIXED", alreadyAddressed: true, evidence: "  sha123  " });
    if ("error" in input) throw new Error(input.error);
    expect(input.alreadyAddressed).toBe(true);
    expect(input.evidence).toBe("sha123");
  });

  it("rejects alreadyAddressed on a non-FIXED status", () => {
    expect(parseMarkPrFixInput({ repo: "o/r", pr: 1, status: "QUEUED", alreadyAddressed: true })).toEqual({ error: expect.stringContaining("FIXED") });
  });

  it("rejects a non-boolean alreadyAddressed", () => {
    expect(parseMarkPrFixInput({ repo: "o/r", pr: 1, status: "FIXED", alreadyAddressed: "yes" })).toEqual({ error: expect.any(String) });
  });

  it("rejects a non-string evidence", () => {
    expect(parseMarkPrFixInput({ repo: "o/r", pr: 1, status: "FIXED", evidence: 123 })).toEqual({ error: expect.any(String) });
  });

  it("rejects evidence longer than MAX_EVIDENCE_LENGTH", () => {
    const result = parseMarkPrFixInput({
      repo: "o/r", pr: 1, status: "FIXED", evidence: "a".repeat(2001),
    });
    expect(result).toEqual({ error: expect.stringContaining("2000") });
  });
});

describe("attempt cap counts fix attempts, not evidence (#1103)", () => {
  let client: ReturnType<typeof makeClient>;
  let prev: string | undefined;

  beforeEach(() => {
    client = makeClient();
    prev = process.env.PR_FIX_MAX_ATTEMPTS;
    process.env.PR_FIX_MAX_ATTEMPTS = "2";
    surfacingMocks.surfacePrFixBlocked.mockReset();
    surfacingMocks.surfacePrFixBlocked.mockResolvedValue({ labelApplied: true, commentPosted: true, errors: [] });
    githubPrsMocks.fetchPullRequestHeadSha.mockReset();
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("movedsha");
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.PR_FIX_MAX_ATTEMPTS;
    else process.env.PR_FIX_MAX_ATTEMPTS = prev;
  });

  it("keeps a first-sighting review with many inline comments QUEUED", async () => {
    // One CHANGES_REQUESTED review: six inline comments plus the review
    // itself, all at the same head (misospace/dispatch#1095).
    const keys = [1, 2, 3, 4, 5, 6].map((n) => `review_comment:org/repo#1:${n}`).concat("review:org/repo#1:9");
    let item: any;
    for (const evidenceKey of keys) {
      item = await enqueuePrFixItem(client, {
        repo: "org/repo", pr: 1, lane: "NORMAL", type: "REVIEW_FEEDBACK",
        reason: "review", feedback: evidenceKey, evidenceKey, headSha: "H1",
      });
    }
    expect(item.status).toBe("QUEUED");
    expect(item.lane).toBe("NORMAL");
    expect(item.fixAttempts).toBe(1);
    expect(item.evidenceKeys).toHaveLength(7);
    expect(surfacingMocks.surfacePrFixBlocked).not.toHaveBeenCalled();
  });

  it("requeue resets the attempt count so the item gets a full budget again", async () => {
    await enqueuePrFixItem(client, { repo: "org/repo", pr: 2, lane: "NORMAL", reason: "r", feedback: "f1", evidenceKey: "review:1", headSha: "H1" });
    await markPrFixItem(client, { repo: "org/repo", pr: 2, status: "fixed" });
    await enqueuePrFixItem(client, { repo: "org/repo", pr: 2, lane: "NORMAL", reason: "r", feedback: "f2", evidenceKey: "review:2", headSha: "H2" });
    await markPrFixItem(client, { repo: "org/repo", pr: 2, status: "fixed" });
    const blocked = await enqueuePrFixItem(client, { repo: "org/repo", pr: 2, lane: "NORMAL", reason: "r", feedback: "f3", evidenceKey: "review:3", headSha: "H3" });
    expect(blocked.status).toBe("BLOCKED");

    const requeued = await requeuePrFixItem(client, { repo: "org/repo", pr: 2 });
    expect(requeued.fixAttempts).toBe(1);
    await markPrFixItem(client, { repo: "org/repo", pr: 2, status: "fixed" });
    const reopened = await enqueuePrFixItem(client, { repo: "org/repo", pr: 2, lane: "NORMAL", reason: "r", feedback: "f4", evidenceKey: "review:4", headSha: "H4" });
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.fixAttempts).toBe(2);
  });

  it("counts refused no-push runs and hands the PR to a human past the cap", async () => {
    await enqueuePrFixItem(client, { repo: "org/repo", pr: 3, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "review:1", headSha: "H1" });
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("H1");

    const retried = await markPrFixItem(client, { repo: "org/repo", pr: 3, status: "FIXED", expectedGeneration: 1 });
    expect(mutatedItem(retried).status).toBe("QUEUED");
    expect(mutatedItem(retried).fixAttempts).toBe(2);

    const capped = await markPrFixItem(client, { repo: "org/repo", pr: 3, status: "FIXED", expectedGeneration: 2 });
    expect(mutatedItem(capped).status).toBe("BLOCKED");
    expect(mutatedItem(capped).lane).toBe("NEEDS_HUMAN");
    expect(mutatedItem(capped).generation).toBe(2);
    expect(client.history.at(-1)).toMatchObject({ status: "BLOCKED", lane: "NEEDS_HUMAN" });
    expect(client.history.at(-1).note).toContain("Refused FIXED");
    expect(client.history.at(-1).note).toContain("Bounded at 2 fix attempts");
    expect(surfacingMocks.surfacePrFixBlocked).toHaveBeenCalledTimes(1);
  });

  it("counts a mark back to QUEUED as an attempt without resetting the budget", async () => {
    await enqueuePrFixItem(client, { repo: "org/repo", pr: 4, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "review:1", headSha: "H1" });
    await markPrFixItem(client, { repo: "org/repo", pr: 4, status: "blocked" });

    const queued = mutatedItem(await markPrFixItem(client, { repo: "org/repo", pr: 4, status: "queued" }));
    expect(queued.status).toBe("QUEUED");
    expect(queued.fixAttempts).toBe(2);

    // The budget is spent, so the next return goes to a human.
    expect(mutatedItem(await markPrFixItem(client, { repo: "org/repo", pr: 4, status: "fixed" })).status).toBe("FIXED");
    const blocked = await enqueuePrFixItem(client, { repo: "org/repo", pr: 4, lane: "NORMAL", reason: "r", feedback: "f2", evidenceKey: "review:2", headSha: "H2" });
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.lane).toBe("NEEDS_HUMAN");
  });

  it("caps the #940 no-progress tombstone reopen like any other return to QUEUED", async () => {
    const input = { repo: "org/repo", pr: 5, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "review:1", headSha: "H1" };
    await enqueuePrFixItem(client, input);
    expect(mutatedItem(await markPrFixItem(client, { repo: "org/repo", pr: 5, status: "fixed" })).status).toBe("FIXED");

    // Same evidence, head unchanged: the FIXED tombstone reopens (attempt 2).
    const reopened = await enqueuePrFixItem(client, input);
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.fixAttempts).toBe(2);

    // Past the cap the reopen hands the PR to a human instead.
    expect(mutatedItem(await markPrFixItem(client, { repo: "org/repo", pr: 5, status: "fixed" })).status).toBe("FIXED");
    const capped = await enqueuePrFixItem(client, input);
    expect(capped.status).toBe("BLOCKED");
    expect(capped.lane).toBe("NEEDS_HUMAN");
  });
});

describe("fresh attempts always get a head baseline (#1104)", () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
    surfacingMocks.surfacePrFixBlocked.mockReset();
    surfacingMocks.surfacePrFixBlocked.mockResolvedValue({ labelApplied: true, commentPosted: true, errors: [] });
    githubPrsMocks.fetchPullRequestHeadSha.mockReset();
  });

  // The worker pushes H2, then the sync re-observes the PR (known evidence,
  // new head) before the worker's report lands.
  async function workerPushesAndSyncObserves(pr: number) {
    await enqueuePrFixItem(client, { repo: "org/repo", pr, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "review:1", headSha: "H2" });
    expect(client.items[0].headSha).toBe("H2");
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("H2");
  }

  it("requeue baselines from the last observed head, so a sync-observed push still settles FIXED", async () => {
    await enqueuePrFixItem(client, { repo: "org/repo", pr: 4, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "review:1", headSha: "H1" });
    await markPrFixItem(client, { repo: "org/repo", pr: 4, status: "blocked" });

    const requeued = await requeuePrFixItem(client, { repo: "org/repo", pr: 4 });
    expect(requeued.attemptHeadSha).toBe("H1");

    await workerPushesAndSyncObserves(4);
    const result = await markPrFixItem(client, { repo: "org/repo", pr: 4, status: "FIXED", expectedGeneration: requeued.generation });
    expect(mutatedItem(result).status).toBe("FIXED");
  });

  it("mark back to QUEUED baselines from the last observed head when the caller passes none", async () => {
    await enqueuePrFixItem(client, { repo: "org/repo", pr: 5, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "review:1", headSha: "H1" });
    await markPrFixItem(client, { repo: "org/repo", pr: 5, status: "blocked" });

    const queued = mutatedItem(await markPrFixItem(client, { repo: "org/repo", pr: 5, status: "queued" }));
    expect(queued.attemptHeadSha).toBe("H1");

    await workerPushesAndSyncObserves(5);
    const result = await markPrFixItem(client, { repo: "org/repo", pr: 5, status: "FIXED", expectedGeneration: queued.generation });
    expect(mutatedItem(result).status).toBe("FIXED");
  });

  it("a refused FIXED keeps its baseline, so the retry's sync-observed push settles FIXED", async () => {
    await enqueuePrFixItem(client, { repo: "org/repo", pr: 6, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "review:1", headSha: "H1" });
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("H1");
    const refused = mutatedItem(await markPrFixItem(client, { repo: "org/repo", pr: 6, status: "FIXED", expectedGeneration: 1 }));
    expect(refused.status).toBe("QUEUED");
    expect(refused.attemptHeadSha).toBe("H1");

    await workerPushesAndSyncObserves(6);
    const result = await markPrFixItem(client, { repo: "org/repo", pr: 6, status: "FIXED", expectedGeneration: refused.generation });
    expect(mutatedItem(result).status).toBe("FIXED");
  });

  it("an enqueue reopen without a head observation keeps the last observed head", async () => {
    await enqueuePrFixItem(client, { repo: "org/repo", pr: 7, lane: "NORMAL", reason: "r", feedback: "f1", evidenceKey: "review:1", headSha: "H1" });
    await markPrFixItem(client, { repo: "org/repo", pr: 7, status: "blocked" });
    const reopened = await enqueuePrFixItem(client, { repo: "org/repo", pr: 7, lane: "NORMAL", reason: "r", feedback: "f2", evidenceKey: "review:2" });
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.attemptHeadSha).toBe("H1");
  });

  it("leaves the baseline null only when no head was ever observed, and FIXED then settles as no-record", async () => {
    await enqueuePrFixItem(client, { repo: "org/repo", pr: 8, lane: "NORMAL", reason: "r", feedback: "f1", evidenceKey: "review:1" });
    await markPrFixItem(client, { repo: "org/repo", pr: 8, status: "blocked" });
    const requeued = await requeuePrFixItem(client, { repo: "org/repo", pr: 8 });
    expect(requeued.attemptHeadSha).toBeNull();

    // Nothing to compare against, and no mutable headSha for a sync to
    // overwrite, so the guard cannot misfire: it accepts without GitHub.
    const result = await markPrFixItem(client, { repo: "org/repo", pr: 8, status: "FIXED", expectedGeneration: requeued.generation });
    expect(mutatedItem(result).status).toBe("FIXED");
    expect(githubPrsMocks.fetchPullRequestHeadSha).not.toHaveBeenCalled();
  });
});

describe("needs-human cleanup on every exit from BLOCKED (#1105)", () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(async () => {
    client = makeClient();
    surfacingMocks.surfacePrFixBlocked.mockReset();
    surfacingMocks.surfacePrFixBlocked.mockResolvedValue({ labelApplied: true, commentPosted: true, errors: [] });
    surfacingMocks.surfacePrFixUnblocked.mockReset();
    surfacingMocks.surfacePrFixUnblocked.mockResolvedValue({ labelRemoved: true, commentUpdated: true, errors: [] });
    githubPrsMocks.fetchPullRequestHeadSha.mockReset();
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("H2");
    await enqueuePrFixItem(client, { repo: "org/repo", pr: 1, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "review:1", headSha: "H1" });
    await markPrFixItem(client, { repo: "org/repo", pr: 1, status: "blocked", note: "stuck" });
    expect(client.items[0].status).toBe("BLOCKED");
  });

  it("folds to a resolved notice when a mark settles the item FIXED", async () => {
    await markPrFixItem(client, { repo: "org/repo", pr: 1, status: "fixed", note: "fixed by hand" });
    expect(surfacingMocks.surfacePrFixUnblocked).toHaveBeenCalledWith("org/repo", 1, "resolved", "fixed by hand");
  });

  it("folds to a requeued notice when a mark returns the item to QUEUED", async () => {
    await markPrFixItem(client, { repo: "org/repo", pr: 1, status: "queued" });
    expect(surfacingMocks.surfacePrFixUnblocked).toHaveBeenCalledWith("org/repo", 1, "requeued", undefined);
  });

  it("folds to a requeued notice when new evidence reopens the item", async () => {
    const reopened = await enqueuePrFixItem(client, { repo: "org/repo", pr: 1, lane: "NORMAL", reason: "r", feedback: "f2", evidenceKey: "review:2", headSha: "H2" });
    expect(reopened.status).toBe("QUEUED");
    expect(surfacingMocks.surfacePrFixUnblocked).toHaveBeenCalledWith("org/repo", 1, "requeued", expect.stringContaining("New evidence"));
  });

  it("folds to a requeued notice when a FIXED mark is refused back to QUEUED", async () => {
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("H1");
    const refused = mutatedItem(await markPrFixItem(client, { repo: "org/repo", pr: 1, status: "fixed" }));
    expect(refused.status).toBe("QUEUED");
    expect(surfacingMocks.surfacePrFixUnblocked).toHaveBeenCalledWith("org/repo", 1, "requeued", undefined);
  });

  it("leaves the surfacing alone while the item stays BLOCKED or never was", async () => {
    await enqueuePrFixItem(client, { repo: "org/repo", pr: 1, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "review:1", headSha: "H1" });
    await markPrFixItem(client, { repo: "org/repo", pr: 1, status: "blocked" });
    await enqueuePrFixItem(client, { repo: "org/repo", pr: 2, lane: "NORMAL", reason: "r", feedback: "f", evidenceKey: "review:1", headSha: "H1" });
    await markPrFixItem(client, { repo: "org/repo", pr: 2, status: "fixed" });
    expect(surfacingMocks.surfacePrFixUnblocked).not.toHaveBeenCalled();
  });

  it("never lets a cleanup failure break the transition", async () => {
    surfacingMocks.surfacePrFixUnblocked.mockRejectedValue(new Error("network down"));
    const result = await markPrFixItem(client, { repo: "org/repo", pr: 1, status: "fixed" });
    expect(mutatedItem(result).status).toBe("FIXED");
  });
});

describe("post-dispatch evidence reopens the attempt (#1119)", () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
    surfacingMocks.surfacePrFixBlocked.mockReset();
    surfacingMocks.surfacePrFixBlocked.mockResolvedValue({ labelApplied: true, commentPosted: true, errors: [] });
    surfacingMocks.surfacePrFixUnblocked.mockReset();
    surfacingMocks.surfacePrFixUnblocked.mockResolvedValue({ labelRemoved: true, commentUpdated: true, errors: [] });
    githubPrsMocks.fetchPullRequestHeadSha.mockReset();
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue(null);
  });

  it("evidence arriving before hand-out stays the same attempt", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 21, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    // Never handed out: dispatchedGeneration stays null.
    expect(client.items[0].dispatchedGeneration).toBeNull();

    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 21, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "review:2", headSha: "H1",
    });

    // Pre-hand-out new evidence joins the same in-flight attempt: no
    // generation bump, and the post-dispatch key list stays empty.
    expect(after.status).toBe("QUEUED");
    expect(after.generation).toBe(1);
    expect(after.postDispatchEvidenceKeys).toEqual([]);
    expect(client.items[0].evidenceKeys).toEqual(["review:1", "review:2"]);
  });

  it("evidence after hand-out turns a BLOCKED settlement into a fresh QUEUED attempt", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 22, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    // Simulate next-task handing the attempt out.
    client.items[0].dispatchedGeneration = client.items[0].generation;

    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 22, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "review:2", headSha: "H1",
    });
    // New evidence lands on a dispatched QUEUED item: recorded, same attempt.
    expect(after.status).toBe("QUEUED");
    expect(after.generation).toBe(1);
    expect(after.postDispatchEvidenceKeys).toEqual(["review:2@H1"]);

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 22, status: "BLOCKED",
      expectedGeneration: 1,
    });

    expect(result.mutated).toBe(true);
    const reopened = mutatedItem(result);
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.generation).toBe(2);
    expect(reopened.fixAttempts).toBe(2);
    expect(reopened.lane).toBe("NORMAL");
    expect(reopened.postDispatchEvidenceKeys).toEqual([]);
  });

  it("evidence after hand-out turns a FIXED settlement into a fresh QUEUED attempt (regardless of head movement)", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 23, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 23, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "review:2", headSha: "H1",
    });
    expect(after.postDispatchEvidenceKeys).toEqual(["review:2@H1"]);

    // Head has NOT moved — a plain FIXED would trip the #940 guard. The
    // #1119 redirect must fire first, before the guard even runs.
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("H1");

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 23, status: "FIXED",
      expectedGeneration: 1,
    });

    expect(result.mutated).toBe(true);
    const reopened = mutatedItem(result);
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.generation).toBe(2);
    expect(reopened.fixAttempts).toBe(2);
    expect(reopened.postDispatchEvidenceKeys).toEqual([]);
    // The #1119 reopen note (not a #940 refusal) proves the redirect won.
    expect(client.history.at(-1).note).toContain("1119");
    // The #940 guard never ran: no GitHub head round-trip.
    expect(githubPrsMocks.fetchPullRequestHeadSha).not.toHaveBeenCalled();
  });

  it("no post-dispatch evidence settles BLOCKED as today", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 24, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    // No new evidence: re-observing a known key leaves the key list empty.
    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 24, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    expect(after.postDispatchEvidenceKeys).toEqual([]);

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 24, status: "BLOCKED",
      expectedGeneration: 1,
    });

    expect(result.mutated).toBe(true);
    const marked = mutatedItem(result);
    expect(marked.status).toBe("BLOCKED");
    expect(marked.lane).toBe("NEEDS_HUMAN");
    expect(marked.postDispatchEvidenceKeys).toEqual([]);
    // No reopen: generation and attempt count are untouched.
    expect(marked.generation).toBe(1);
    expect(marked.fixAttempts).toBe(1);
  });

  it("no post-dispatch evidence settles FIXED as today", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 25, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    // No new evidence: re-observing a known key leaves the key list empty.
    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 25, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    expect(after.postDispatchEvidenceKeys).toEqual([]);

    // Head HAS moved relative to the baseline, so the #940 guard passes and
    // the FIXED is accepted (reusing the #940/#1074 "head moved" pattern).
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("H-moved");

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 25, status: "FIXED",
      expectedGeneration: 1,
    });

    expect(result.mutated).toBe(true);
    const marked = mutatedItem(result);
    expect(marked.status).toBe("FIXED");
    expect(marked.generation).toBe(1); // not reopened
    expect(marked.postDispatchEvidenceKeys).toEqual([]);
  });

  it("post-dispatch evidence past the attempt cap gives up to a human", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 26, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 26, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "review:2", headSha: "H1",
    });
    expect(after.postDispatchEvidenceKeys).toEqual(["review:2@H1"]);

    // Push the item to the attempt cap (maxPrFixAttempts defaults to 5).
    client.items[0].fixAttempts = 5;

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 26, status: "BLOCKED",
      expectedGeneration: 1,
    });

    expect(result.mutated).toBe(true);
    const capped = mutatedItem(result);
    expect(capped.status).toBe("BLOCKED");
    expect(capped.lane).toBe("NEEDS_HUMAN");
    expect(capped.postDispatchEvidenceKeys).toEqual([]);
    // Gave up: no generation bump, no attempt increment.
    expect(capped.generation).toBe(1);
    expect(capped.fixAttempts).toBe(5);
  });

  it("a stale settlement token cannot reopen on post-dispatch evidence", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 27, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 27, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "review:2", headSha: "H1",
    });
    expect(after.postDispatchEvidenceKeys).toEqual(["review:2@H1"]);
    expect(after.generation).toBe(1);

    // The report carries a stale generation token (G+1, G is 1).
    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 27, status: "FIXED",
      expectedGeneration: 2,
    });

    expect(result).toEqual({ mutated: false, reason: "generation-mismatch" });
    // The item is untouched: still QUEUED at generation 1, keys still set.
    expect(client.items[0].status).toBe("QUEUED");
    expect(client.items[0].generation).toBe(1);
    expect(client.items[0].postDispatchEvidenceKeys).toEqual(["review:2@H1"]);
  });

  it("a post-dispatch check on a SUPERSEDED head does NOT reopen: the FIXED settles and the keys are cleared", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 28, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    // A failing check recorded at head aaaa1111 lands after the hand-out.
    // The head is git-shape: a non-git-shape head would sanitize to
    // "unknown" (always actionable) and could not demonstrate staleness.
    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 28, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "check_run:org/repo#28:42", headSha: "aaaa1111",
    });
    expect(after.postDispatchEvidenceKeys).toEqual(["check_run:org/repo#28:42@aaaa1111"]);

    // The PR head has moved past aaaa1111: the recorded check is stale (the
    // worker already pushed past it), so the settlement is not actionable.
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("bbbb2222");

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 28, status: "FIXED",
      expectedGeneration: 1,
    });

    expect(result.mutated).toBe(true);
    const marked = mutatedItem(result);
    expect(marked.status).toBe("FIXED");
    expect(marked.generation).toBe(1); // not reopened
    expect(marked.postDispatchEvidenceKeys).toEqual([]);
  });

  it("a post-dispatch check whose recorded head IS still the PR head reopens as a fresh attempt", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 29, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 29, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "check_run:org/repo#29:43", headSha: "cccc3333",
    });
    expect(after.postDispatchEvidenceKeys).toEqual(["check_run:org/repo#29:43@cccc3333"]);

    // The PR head is STILL cccc3333: the failing check is current, so it is
    // actionable and the settlement reopens.
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("cccc3333");

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 29, status: "FIXED",
      expectedGeneration: 1,
    });

    expect(result.mutated).toBe(true);
    const reopened = mutatedItem(result);
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.generation).toBe(2);
    expect(reopened.fixAttempts).toBe(2);
    expect(reopened.postDispatchEvidenceKeys).toEqual([]);
    // The #1119 reopen note proves the check entry drove the reopen.
    expect(client.history.at(-1).note).toContain("1119");
  });

  it("a post-dispatch check recorded without a head (unknown) reopens without any head fetch", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 30, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    // Enqueued without a head observation: the entry records "unknown".
    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 30, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "check_run:org/repo#30:77",
    });
    expect(after.postDispatchEvidenceKeys).toEqual(["check_run:org/repo#30:77@unknown"]);

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 30, status: "FIXED",
      expectedGeneration: 1,
    });

    expect(result.mutated).toBe(true);
    const reopened = mutatedItem(result);
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.generation).toBe(2);
    expect(reopened.postDispatchEvidenceKeys).toEqual([]);
    // An "unknown" head is actionable as-is: no GitHub round-trip.
    expect(githubPrsMocks.fetchPullRequestHeadSha).not.toHaveBeenCalled();
  });

  it("mixed entries (stale check + review) reopen via the review without any head fetch", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 31, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    // Two post-dispatch entries: a check (listed first) and a review.
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 31, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "check_run:org/repo#31:88", headSha: "H1",
    });
    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 31, lane: "NORMAL", reason: "r", feedback: "f3",
      evidenceKey: "review:2", headSha: "H1",
    });
    expect(after.postDispatchEvidenceKeys).toEqual([
      "check_run:org/repo#31:88@H1",
      "review:2@H1",
    ]);

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 31, status: "FIXED",
      expectedGeneration: 1,
    });

    expect(result.mutated).toBe(true);
    const reopened = mutatedItem(result);
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.generation).toBe(2);
    expect(reopened.postDispatchEvidenceKeys).toEqual([]);
    // The review entry short-circuits: the check's head is never fetched.
    expect(githubPrsMocks.fetchPullRequestHeadSha).not.toHaveBeenCalled();
  });

  it("evidence landing in the read→write gap reopens instead of being swallowed (#1119)", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 32, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    // A review lands between markPrFixItem's pre-check read and its
    // conditional settlement write: the one-shot updateMany hook applies it
    // right before the write, so the guard's { equals: [] } predicate no-ops
    // the settlement and the gap logic re-decides on the fresh row.
    client.hooks.beforeUpdateMany = () => {
      client.items[0].postDispatchEvidenceKeys = ["review:2@H1"];
    };

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 32, status: "FIXED",
      expectedGeneration: 1,
    });

    expect(result.mutated).toBe(true);
    const reopened = mutatedItem(result);
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.generation).toBe(2);
    expect(reopened.fixAttempts).toBe(2);
    expect(reopened.postDispatchEvidenceKeys).toEqual([]);
    // The gap-reopen note says the evidence landed mid-settlement.
    expect(client.history.at(-1).note).toContain("in flight");
  });

  it("a post-dispatch check with an unavailable head (fetch resolves null) reopens instead of absorbing", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 33, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 33, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "check_run:org/repo#33:55", headSha: "H1",
    });
    expect(after.postDispatchEvidenceKeys).toEqual(["check_run:org/repo#33:55@H1"]);

    // fetchPullRequestHeadSha swallows network errors and RESOLVES null —
    // the conservative rule must treat that as actionable, not absorb.
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue(null);

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 33, status: "FIXED",
      expectedGeneration: 1,
    });

    expect(result.mutated).toBe(true);
    const reopened = mutatedItem(result);
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.generation).toBe(2);
    expect(reopened.postDispatchEvidenceKeys).toEqual([]);
  });

  it("a post-dispatch check whose head fetch throws reopens instead of absorbing", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 34, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 34, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "check_run:org/repo#34:66", headSha: "H1",
    });
    expect(after.postDispatchEvidenceKeys).toEqual(["check_run:org/repo#34:66@H1"]);

    githubPrsMocks.fetchPullRequestHeadSha.mockRejectedValue(new Error("unexpected throw"));

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 34, status: "FIXED",
      expectedGeneration: 1,
    });

    expect(result.mutated).toBe(true);
    const reopened = mutatedItem(result);
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.generation).toBe(2);
    expect(reopened.postDispatchEvidenceKeys).toEqual([]);
  });

  it("a STALE mark clears the recorded post-dispatch keys (terminal, moot)", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 35, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 35, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "review:2", headSha: "H1",
    });
    expect(after.postDispatchEvidenceKeys).toEqual(["review:2@H1"]);

    const marked = mutatedItem(await markPrFixItem(client, { repo: "org/repo", pr: 35, status: "stale" }));
    expect(marked.status).toBe("STALE");
    expect(marked.postDispatchEvidenceKeys).toEqual([]);
  });

  it("the gap re-decision head fetch never runs inside a transaction (#1124)", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 36, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    // A check_run lands in the read→write gap: the one-shot hook records it
    // right before the guarded settlement write, so the settlement no-ops and
    // the re-decision loop must classify the check — which REQUIRES a head
    // fetch. (review entries would short-circuit without any fetch.)
    client.hooks.beforeUpdateMany = () => {
      // Git-shape head: the check is NOT an "unknown" short-circuit, so the
      // re-decision genuinely has to fetch the head to classify it.
      client.items[0].postDispatchEvidenceKeys = ["check_run:org/repo#36:90@dddd4444"];
    };
    let headFetchInsideTx = false;
    githubPrsMocks.fetchPullRequestHeadSha.mockImplementation(async () => {
      if (client.inTransaction) {
        headFetchInsideTx = true;
        throw new Error("head fetch called inside a transaction");
      }
      return null;
    });

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 36, status: "FIXED",
      expectedGeneration: 1,
    });

    expect(headFetchInsideTx).toBe(false);
    // The gap re-decision landed the reopen, outside any transaction.
    expect(result.mutated).toBe(true);
    const reopened = mutatedItem(result);
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.generation).toBe(2);
    expect(reopened.postDispatchEvidenceKeys).toEqual([]);
  });

  it("a pinned-retry-loses-race settle mark never strands the item at the consumed generation (#1124)", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 37, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    // Concurrent evidence keeps landing on EVERY pinned write — more times
    // than the bounded re-decision loop permits — so every keys-pinned
    // reopen/settle write no-ops. The mark must still mutate the row.
    let landCount = 0;
    client.hooks.beforeUpdateManyEvery = () => {
      landCount += 1;
      const row = client.items[0];
      row.postDispatchEvidenceKeys = [
        ...(row.postDispatchEvidenceKeys ?? []),
        `check_run:org/repo#37:${landCount}@unknown`,
      ];
    };

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 37, status: "FIXED",
      expectedGeneration: 1,
    });

    expect(result.mutated).toBe(true);
    // Evidence landed on the fast path, every loop iteration, AND the forced
    // fallback write — strictly more than the 3-iteration loop allows.
    expect(landCount).toBeGreaterThan(3);
    const item = client.items[0];
    // Not stranded QUEUED at the generation the worker already consumed:
    // the forced fallback (pinned without the keys predicate) moved it.
    expect(item.status).toBe("QUEUED");
    expect(item.generation).toBe(2);
    expect(item.fixAttempts).toBe(2);
    expect(item.postDispatchEvidenceKeys).toEqual([]);
    // The forced-fallback history row explains the outcome.
    expect(client.history.at(-1).note).toContain("forced a fresh attempt");
  });

  it("a stale-clear settle that keeps losing the race never strands the item (#1124)", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 48, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "aaaa1111",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;
    // A post-dispatch check recorded at head aaaa1111 — now superseded. The
    // baseline (attemptHeadSha/headSha) is aaaa1111 from the enqueue, and the
    // PR head has moved to bbbb2222: the SAME mock feeds both the #940
    // head-moved guard (baseline aaaa1111 ≠ bbbb2222 → PASSES) and the
    // actionability check (recorded aaaa1111 ≠ bbbb2222 → superseded →
    // NON-actionable), so no reopen — only the clear-settle path.
    client.items[0].postDispatchEvidenceKeys = ["check_run:org/repo#48:70@aaaa1111"];
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("bbbb2222");

    // A NON-actionable entry (merge_state) lands before EVERY updateMany, with
    // a unique suffix, so the keys-pinned clear-settle write misses on all 3
    // loop iterations.
    let landCount = 0;
    client.hooks.beforeUpdateManyEvery = () => {
      landCount += 1;
      const row = client.items[0];
      row.postDispatchEvidenceKeys = [
        ...(row.postDispatchEvidenceKeys ?? []),
        `merge_state:xyz${landCount}@unknown`,
      ];
    };

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 48, status: "FIXED",
      expectedGeneration: 1,
    });

    expect(result.mutated).toBe(true);
    const item = client.items[0];
    // Not stranded QUEUED at the generation the worker already consumed:
    // the forced fallback (pinned without the keys predicate) moved it.
    expect(item.status).toBe("QUEUED");
    expect(item.generation).toBe(2);
    expect(item.fixAttempts).toBe(2);
    expect(item.postDispatchEvidenceKeys).toEqual([]);
    // The forced-fallback history row explains the outcome.
    expect(client.history.at(-1).note).toContain("forced a fresh attempt");
  });

  it("the forced fallback gives up to a human when the item is at the cap (#1124)", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 38, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;
    // At the attempt cap (maxPrFixAttempts defaults to 5).
    client.items[0].fixAttempts = 5;

    let landCount = 0;
    client.hooks.beforeUpdateManyEvery = () => {
      landCount += 1;
      const row = client.items[0];
      row.postDispatchEvidenceKeys = [
        ...(row.postDispatchEvidenceKeys ?? []),
        `check_run:org/repo#38:${landCount}@unknown`,
      ];
    };

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 38, status: "FIXED",
      expectedGeneration: 1,
    });

    expect(result.mutated).toBe(true);
    const item = client.items[0];
    // Capped: the forced fallback routes to a human instead of a fresh run.
    expect(item.status).toBe("BLOCKED");
    expect(item.lane).toBe("NEEDS_HUMAN");
    expect(item.generation).toBe(1);
    expect(item.fixAttempts).toBe(5);
    expect(item.postDispatchEvidenceKeys).toEqual([]);
    expect(surfacingMocks.surfacePrFixBlocked).toHaveBeenCalled();
    // Evidence landed on the fast path, every loop iteration, AND the forced
    // fallback write — strictly more than the 3-iteration loop allows.
    expect(landCount).toBeGreaterThan(3);
    // The capped forced-fallback history row names the human hand-off.
    expect(client.history.at(-1).note).toContain("routed to a human (#1119)");
  });

  it("a post-dispatch check encoded from an `@`-bearing headSha degrades to an unknown head and still reopens", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 40, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    // Unvalidated caller string with an "@" in it. Encoding is a plain trim,
    // so the raw entry is stored as-is; the FIRST-@ split must not read back
    // the bogus fragment "def" a LAST-@ split would produce.
    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 40, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "check_run:org/repo#40:71", headSha: "abc@def",
    });
    expect(after.postDispatchEvidenceKeys).toEqual(["check_run:org/repo#40:71@abc@def"]);

    // The fetch mock resolves the fragment the old parser would have
    // revalidated against — the sanitized "unknown" head must short-circuit
    // before any comparison, so no head fetch may happen.
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("def");

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 40, status: "FIXED",
      expectedGeneration: 1,
    });

    expect(result.mutated).toBe(true);
    const reopened = mutatedItem(result);
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.generation).toBe(2);
    expect(reopened.postDispatchEvidenceKeys).toEqual([]);
    expect(githubPrsMocks.fetchPullRequestHeadSha).not.toHaveBeenCalled();
  });

  it("an `@`-bearing evidenceKey parses its event type from the pre-first-`@` half and stays actionable", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 41, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    // The evidenceKey namespace is internal: "review@x:1" encodes to
    // "review@x:1@H1". The first-@ split yields keyPart "review" (no ":"),
    // so the event type is "review" — actionable by the review short-circuit
    // — and the head half "x:1@H1" is not git-shape, so it reads back as
    // "unknown". The documented contract: it acts as a review entry.
    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 41, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "review@x:1", headSha: "H1",
    });
    expect(after.postDispatchEvidenceKeys).toEqual(["review@x:1@H1"]);

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 41, status: "FIXED",
      expectedGeneration: 1,
    });

    expect(result.mutated).toBe(true);
    const reopened = mutatedItem(result);
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.generation).toBe(2);
    expect(reopened.postDispatchEvidenceKeys).toEqual([]);
    // The review entry short-circuits: no head fetch.
    expect(githubPrsMocks.fetchPullRequestHeadSha).not.toHaveBeenCalled();
  });

  it("a normal git-shape head still revalidates: exact match reopens, a moved head settles", async () => {
    // PR 42: recorded head == current head → the check is current.
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 42, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "aaaa1111",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 42, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "check_run:org/repo#42:10", headSha: "aaaa1111",
    });

    // PR 43: recorded head != current head → the check is superseded.
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 43, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "bbbb2222",
    });
    client.items[1].dispatchedGeneration = client.items[1].generation;
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 43, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "check_run:org/repo#43:11", headSha: "bbbb2222",
    });

    githubPrsMocks.fetchPullRequestHeadSha.mockImplementation(async (_repo: string, pr: number) =>
      pr === 42 ? "aaaa1111" : "cccc3333");

    const reopened = mutatedItem(await markPrFixItem(client, {
      repo: "org/repo", pr: 42, status: "FIXED", expectedGeneration: 1,
    }));
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.generation).toBe(2);
    expect(reopened.postDispatchEvidenceKeys).toEqual([]);

    const settled = mutatedItem(await markPrFixItem(client, {
      repo: "org/repo", pr: 43, status: "FIXED", expectedGeneration: 1,
    }));
    expect(settled.status).toBe("FIXED");
    expect(settled.generation).toBe(1); // not reopened
    expect(settled.postDispatchEvidenceKeys).toEqual([]);
  });

  it("a post-dispatch reopen retracts the needs-human marker (surfacePrFixUnblocked)", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 44, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 44, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "review:2", headSha: "H1",
    });
    surfacingMocks.surfacePrFixUnblocked.mockClear();

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 44, status: "BLOCKED",
      expectedGeneration: 1,
    });

    // The initial post-dispatch reopen leaves the would-be settlement: the
    // needs-human marker must be folded back into a requeued notice.
    expect(mutatedItem(result).status).toBe("QUEUED");
    expect(surfacingMocks.surfacePrFixUnblocked).toHaveBeenCalledWith("org/repo", 44, "requeued", undefined);
  });

  it("a gap-loop post-dispatch reopen retracts the needs-human marker too", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 45, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    // Evidence lands in the read→write gap: the fast-path settle no-ops and
    // the re-decision loop takes the reopen.
    client.hooks.beforeUpdateMany = () => {
      client.items[0].postDispatchEvidenceKeys = ["review:2@H1"];
    };
    surfacingMocks.surfacePrFixUnblocked.mockClear();

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 45, status: "FIXED",
      expectedGeneration: 1,
    });

    expect(mutatedItem(result).status).toBe("QUEUED");
    expect(surfacingMocks.surfacePrFixUnblocked).toHaveBeenCalledWith("org/repo", 45, "requeued", undefined);
  });

  it("a capped post-dispatch reopen surfaces the block when the item was not already BLOCKED", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 46, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 46, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "review:2", headSha: "H1",
    });
    // At the attempt cap (maxPrFixAttempts defaults to 5).
    client.items[0].fixAttempts = 5;
    surfacingMocks.surfacePrFixBlocked.mockClear();

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 46, status: "FIXED",
      expectedGeneration: 1,
    });

    // The give-up routes to a human; the item was QUEUED (not BLOCKED), so
    // the block must be surfaced.
    const capped = mutatedItem(result);
    expect(capped.status).toBe("BLOCKED");
    expect(capped.lane).toBe("NEEDS_HUMAN");
    expect(surfacingMocks.surfacePrFixBlocked).toHaveBeenCalledTimes(1);
  });

  it("a stale post-dispatch check settles with the 'no longer applies' history note", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 47, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 47, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "check_run:org/repo#47:60", headSha: "aaaa5555",
    });
    expect(client.items[0].postDispatchEvidenceKeys).toEqual(["check_run:org/repo#47:60@aaaa5555"]);

    // The head moved past the recorded one: the check is stale, so the
    // settle goes through the re-decision loop, which records WHY the
    // entries were cleared.
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("bbbb6666");

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 47, status: "FIXED",
      expectedGeneration: 1,
    });

    expect(mutatedItem(result).status).toBe("FIXED");
    expect(client.items[0].postDispatchEvidenceKeys).toEqual([]);
    expect(client.history.at(-1).note ?? "").toContain("no longer applies (intermediate head); cleared (#1119)");
  });

  it("evicts the oldest non-priority entry, never an actionable review (#1119)", async () => {
    const client = makeClient();
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 51, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:org/repo#51:r1", headSha: "H1",
    });
    const row = client.items[0];
    // Dispatched: new evidence now lands post-dispatch.
    row.dispatchedGeneration = row.generation;
    // 20 recorded entries: a leading actionable review plus 19 stale checks.
    row.postDispatchEvidenceKeys = [
      "review:org/repo#51:r1@H1",
      ...Array.from({ length: 19 }, (_, i) => `check_run:org/repo#51:${i + 1}@H1`),
    ];

    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 51, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "check_run:org/repo#51:20", headSha: "H1",
    });

    expect(after.postDispatchEvidenceKeys).toHaveLength(20);
    // The actionable review survived the eviction.
    expect(after.postDispatchEvidenceKeys[0]).toBe("review:org/repo#51:r1@H1");
    // The oldest NON-priority entry was evicted, not the review.
    expect(after.postDispatchEvidenceKeys).not.toContain("check_run:org/repo#51:1@H1");
    // The new entry is present.
    expect(after.postDispatchEvidenceKeys.at(-1)).toBe("check_run:org/repo#51:20@H1");
  });

  it("evicts the oldest priority entry when every entry is priority (#1119)", async () => {
    const client = makeClient();
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 52, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:org/repo#52:r1", headSha: "H1",
    });
    const row = client.items[0];
    row.dispatchedGeneration = row.generation;
    row.postDispatchEvidenceKeys = Array.from(
      { length: 20 },
      (_, i) => `review:org/repo#52:r${i + 1}@H1`,
    );

    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 52, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "review:org/repo#52:r21", headSha: "H1",
    });

    expect(after.postDispatchEvidenceKeys).toHaveLength(20);
    // Every entry is priority: the oldest review is evicted.
    expect(after.postDispatchEvidenceKeys).not.toContain("review:org/repo#52:r1@H1");
    expect(after.postDispatchEvidenceKeys[0]).toBe("review:org/repo#52:r2@H1");
    expect(after.postDispatchEvidenceKeys.at(-1)).toBe("review:org/repo#52:r21@H1");
  });

  it("an unqualified FIXED settle settles a stamped row with empty post-dispatch keys", async () => {
    const client = makeClient();
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 53, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:org/repo#53:r1", headSha: "aaaa1111",
    });
    const row = client.items[0];
    // Dispatched (stamped), with no post-dispatch evidence recorded.
    row.dispatchedGeneration = row.generation;
    row.postDispatchEvidenceKeys = [];

    // No expectedGeneration: the settleWhere is guarded only by the
    // { equals: [] } keys predicate, which matches the stamped row.
    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 53, status: "FIXED",
    });

    expect(result.mutated).toBe(true);
    const marked = mutatedItem(result);
    expect(marked.status).toBe("FIXED");
    expect(marked.generation).toBe(1);
    expect(marked.postDispatchEvidenceKeys).toEqual([]);
    // The settlement history row landed.
    expect(client.history.at(-1)).toMatchObject({ action: "mark", status: "FIXED" });
  });

  it("an unqualified settle whose keys guard no-ops on a gap review reopens at generation+1 (#1119)", async () => {
    const client = makeClient();
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 54, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:org/repo#54:r1", headSha: "H1",
    });
    const row = client.items[0];
    row.dispatchedGeneration = row.generation;
    row.postDispatchEvidenceKeys = [];

    // A review lands between the pre-check read and the guarded settlement
    // write: the one-shot hook applies it right before the write, so the
    // { equals: [] } keys guard no-ops the unqualified settle and the gap
    // re-decision reopens the attempt.
    client.hooks.beforeUpdateMany = () => {
      client.items[0].postDispatchEvidenceKeys = ["review:org/repo#54:r2@H1"];
    };

    const result = await markPrFixItem(client, {
      repo: "org/repo", pr: 54, status: "FIXED",
    });

    expect(result.mutated).toBe(true);
    const reopened = mutatedItem(result);
    expect(reopened.status).toBe("QUEUED");
    expect(reopened.generation).toBe(2);
    expect(reopened.postDispatchEvidenceKeys).toEqual([]);
  });
});

describe("enqueue post-dispatch append pinning (#1134)", () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
    surfacingMocks.surfacePrFixBlocked.mockReset();
    surfacingMocks.surfacePrFixBlocked.mockResolvedValue({ labelApplied: true, commentPosted: true, errors: [] });
    surfacingMocks.surfacePrFixUnblocked.mockReset();
    surfacingMocks.surfacePrFixUnblocked.mockResolvedValue({ labelRemoved: true, commentUpdated: true, errors: [] });
    githubPrsMocks.fetchPullRequestHeadSha.mockReset();
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue(null);
  });

  it("a concurrent append landing in the enqueue read→write gap is re-decided, not lost (#1134)", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 55, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    // Simulate next-task handing the attempt out.
    client.items[0].dispatchedGeneration = client.items[0].generation;

    // A concurrent enqueue's entry commits right before the pinned write —
    // i.e. inside the read→write gap the keys pin is meant to catch — so the
    // { equals: [] } predicate no-ops and the re-decision loop must re-read.
    client.hooks.beforeUpdateMany = () => {
      const row = client.items[0];
      row.postDispatchEvidenceKeys = [
        ...(row.postDispatchEvidenceKeys ?? []),
        "review:2@CONCURRENT",
      ];
    };

    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 55, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "check_run:org/repo#1134:5", headSha: "aaaa1111",
    });

    // The pin missed exactly once: the in-transaction re-read re-decided from
    // the fresh row and the retry pinned the FRESH key list, so the
    // concurrent entry is kept (concurrent first, the new entry last) and
    // nothing was clobbered.
    expect(after.postDispatchEvidenceKeys).toEqual([
      "review:2@CONCURRENT",
      "check_run:org/repo#1134:5@aaaa1111",
    ]);
    // Same attempt: a post-dispatch append never opens a fresh attempt.
    expect(after.status).toBe("QUEUED");
    expect(after.generation).toBe(1);
    expect(after.evidenceKeys).toEqual(["review:1", "check_run:org/repo#1134:5"]);
  });

  it("sustained contention on the enqueue append still records the enqueue (#1134 fallback)", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 56, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    // Concurrent evidence keeps landing on EVERY pinned write — more times
    // than the bounded re-decision loop permits — so every keys-pinned
    // append write no-ops. The enqueue must still mutate the row.
    let landCount = 0;
    client.hooks.beforeUpdateManyEvery = () => {
      landCount += 1;
      const row = client.items[0];
      row.postDispatchEvidenceKeys = [
        ...(row.postDispatchEvidenceKeys ?? []),
        `check_run:org/repo#56:${landCount}@unknown`,
      ];
    };

    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 56, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "check_run:org/repo#56:71", headSha: "H1",
    });

    // All 3 pinned attempts lost the race (one landing per attempt). The
    // unpinned fallback is a plain `update` — no updateMany hook — so its
    // exhaustion is exactly these 3 lands (unlike the mark flow, whose
    // forced fallback is itself a pinned updateMany and lands a 4th+).
    expect(landCount).toBe(3);
    // The enqueue is never dropped: the fallback write recorded it.
    const item = client.items[0];
    expect(after.status).toBe("QUEUED");
    expect(item.evidenceKeys).toContain("check_run:org/repo#56:71");
    // Every gap entry that landed AND the new one are all present.
    expect(item.postDispatchEvidenceKeys).toEqual([
      "check_run:org/repo#56:1@unknown",
      "check_run:org/repo#56:2@unknown",
      "check_run:org/repo#56:3@unknown",
      "check_run:org/repo#56:71@H1",
    ]);
  });

  it("non-append enqueue writes are unchanged by the pin (#1134 guard)", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 57, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    client.items[0].dispatchedGeneration = client.items[0].generation;

    // A known-evidence re-observation takes the plain-update path: no
    // updateMany may fire at all, and the post-dispatch key list is
    // untouched, exactly as before #1134.
    let updateManyFired = false;
    client.hooks.beforeUpdateMany = () => {
      updateManyFired = true;
    };

    const after = await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 57, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });

    expect(updateManyFired).toBe(false);
    expect(after.postDispatchEvidenceKeys).toEqual([]);
    expect(after.status).toBe("QUEUED");
    expect(after.generation).toBe(1);
  });

  it("a row deleted mid-loop surfaces a P2025 from the fallback write (#1134)", async () => {
    await enqueuePrFixItem(client, {
      repo: "org/repo", pr: 58, lane: "NORMAL", reason: "r", feedback: "f1",
      evidenceKey: "review:1", headSha: "H1",
    });
    // Simulate next-task handing the attempt out.
    client.items[0].dispatchedGeneration = client.items[0].generation;
    const historyRowsAfterSeed = client.history.length;

    // The row is deleted inside the read→write gap, right before the pinned
    // write: the pin no-ops, the in-transaction re-read finds nothing, the
    // loop breaks, and the exhausted-loop fallback plain `update` must
    // surface P2025 — exactly like the pre-#1134 path did for a deleted row.
    client.hooks.beforeUpdateMany = () => {
      client.items.length = 0;
    };

    await expect(enqueuePrFixItem(client, {
      repo: "org/repo", pr: 58, lane: "NORMAL", reason: "r", feedback: "f2",
      evidenceKey: "check_run:org/repo#1134:58", headSha: "aaaa1111",
    })).rejects.toMatchObject({ code: "P2025" });

    // The row is gone and the failed attempt wrote nothing: no new
    // `enqueue` history row beyond the seed's.
    expect(client.items).toHaveLength(0);
    expect(client.history).toHaveLength(historyRowsAfterSeed);
  });
});

describe("createLinkedPrFixItem materialization (#1145)", () => {
  it("creates a QUEUED row with history and the observed head baseline", async () => {
    const client = makeClient();
    const { item, created } = await createLinkedPrFixItem(client, {
      repo: "org/repo",
      pr: 15,
      issue: 42,
      lane: "NORMAL",
      reason: "changes_requested",
      feedback: ["changes_requested", "failing_checks"],
      evidenceKey: "linked-health:42:2026-01-01T00:00:00.000Z",
      url: "https://github.com/org/repo/pull/15",
      title: "Follow up linked PR for org/repo#42",
      headSha: "a".repeat(40),
    });

    expect(created).toBe(true);
    expect(item).toMatchObject({
      repo: "org/repo",
      pr: 15,
      issue: 42,
      lane: "NORMAL",
      status: "QUEUED",
      type: "OTHER",
      generation: 1,
      headSha: "a".repeat(40),
      attemptHeadSha: "a".repeat(40),
      feedback: ["changes_requested", "failing_checks"],
    });
    expect(client.history).toEqual([
      expect.objectContaining({
        itemId: item.id,
        action: "enqueue",
        lane: "NORMAL",
        evidenceKey: "linked-health:42:2026-01-01T00:00:00.000Z",
      }),
    ]);
  });

  it("leaves the baseline null when GitHub could not be read", async () => {
    const client = makeClient();
    const { item } = await createLinkedPrFixItem(client, {
      repo: "org/repo",
      pr: 15,
      issue: 42,
      lane: "ESCALATED",
      reason: "failing_checks",
      feedback: ["failing_checks"],
      evidenceKey: "linked-health:42:unknown",
      headSha: null,
    });
    expect(item.headSha).toBeNull();
    expect(item.attemptHeadSha).toBeNull();
  });

  it("returns the concurrent winner untouched on a unique-constraint race", async () => {
    const client = makeClient();
    await enqueuePrFixItem(client, {
      repo: "org/repo",
      pr: 15,
      lane: "escalated",
      reason: "operator blocked",
      feedback: "wait for approval",
      evidenceKey: "operator:1",
    });
    const winner = client.items[0];
    const winnerSnapshot = { ...winner };
    const historyRowsBefore = client.history.length;

    // A concurrent enqueue won the (repo, pr) unique key between our create
    // attempt and its commit: Prisma raises P2002 on the losing insert.
    client.prFixQueueItem.create = async () => {
      const err = new Error("Unique constraint failed on the fields: (`repo`,`pr`)");
      (err as any).code = "P2002";
      throw err;
    };

    const result = await createLinkedPrFixItem(client, {
      repo: "org/repo",
      pr: 15,
      issue: 42,
      lane: "NORMAL",
      reason: "failing_checks",
      feedback: ["failing_checks"],
      evidenceKey: "linked-health:42:unknown",
    });

    expect(result.created).toBe(false);
    expect(result.item.id).toBe(winner.id);
    // No mutation of the winner, and no orphaned history row from the loser.
    expect(client.items).toHaveLength(1);
    expect(client.items[0]).toEqual(winnerSnapshot);
    expect(client.history).toHaveLength(historyRowsBefore);
  });

  it("rethrows a non-constraint failure", async () => {
    const client = makeClient();
    client.prFixQueueItem.create = async () => {
      throw Object.assign(new Error("connection reset"), { code: "P2024" });
    };
    await expect(
      createLinkedPrFixItem(client, {
        repo: "org/repo",
        pr: 15,
        issue: 42,
        lane: "NORMAL",
        reason: "failing_checks",
        feedback: ["failing_checks"],
        evidenceKey: "linked-health:42:unknown",
      }),
    ).rejects.toThrow("connection reset");
    expect(client.history).toHaveLength(0);
  });
});
