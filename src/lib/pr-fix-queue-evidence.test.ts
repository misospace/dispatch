// @vitest-environment node
// Durable evidence ledger + attempt-snapshot freshness integration pins
// (#1249). Exercises enqueuePrFixItem / markPrFixItem against an in-memory
// fake that models the PrFixEvidence table, pinning the design's negative
// controls at the queue boundary: replays stay inert forever, late-discovered
// post-watermark evidence reopens settlement even with the bounded cache
// emptied, #940 keeps precedence over dedupe for one-shot kinds, and the
// per-condition baseline survives eviction and unrelated dispositions.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";

/** A ledger-shaped content signature: the bounded 32 lowercase hex the queue
 *  accepts (`normalizeEvidenceContentSignature`). Derived like production so a
 *  fixture can never drift out of the stored representation. */
function signatureFor(reviewId: string): string {
  return createHash("sha256").update(`review-body:${reviewId}`).digest("hex").slice(0, 32);
}

const headShaMock = vi.hoisted(() => ({ current: "bbb2" }));
vi.mock("./github-prs", () => ({
  fetchPullRequestMergeState: vi.fn(async () => "CLEAN"),
  fetchPullRequestHeadSha: vi.fn(async () => headShaMock.current),
  fetchPullRequestState: vi.fn(async () => ({ state: "open", mergedAt: null, headSha: headShaMock.current })),
}));
vi.mock("./pr-fix-surfacing", () => ({
  surfacePrFixBlocked: vi.fn(async () => null),
  surfacePrFixParked: vi.fn(async () => null),
  surfacePrFixRequeued: vi.fn(async () => null),
  surfacePrFixUnblocked: vi.fn(async () => null),
  extractUrlsFromText: vi.fn(() => []),
}));

import { enqueuePrFixItem, markPrFixItem, freshAttemptGeneration, recordPrFixEvidenceBaseline, type PrFixQueueClient } from "./pr-fix-queue";

// ─── In-memory fake with the durable ledger surface ─────────────────────────

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function matches(row: any, where: any): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (key === "OR") {
      if (!(cond as any[]).some((clause) => matches(row, clause))) return false;
      continue;
    }
    if (key === "NOT") {
      if (matches(row, cond)) return false;
      continue;
    }
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      const ops = cond as Record<string, unknown>;
      for (const [op, operand] of Object.entries(ops)) {
        if (op === "equals") {
          if (!sameValue(value, operand)) return false;
        } else if (op === "in") {
          if (!Array.isArray(operand) || !(operand as unknown[]).some((o) => sameValue(value, o))) return false;
        } else if (op === "has") {
          if (!(Array.isArray(value) && value.includes(operand))) return false;
        } else if (op === "not") {
          if (sameValue(value, operand)) return false;
        } else if (op === "gt") {
          if (!(typeof value === "number" && value > (operand as number))) return false;
        } else if (op === "gte") {
          if (!(typeof value === "number" && value >= (operand as number))) return false;
        } else if (op === "lte") {
          const v = value instanceof Date ? value.getTime() : (value as number);
          const o = operand instanceof Date ? operand.getTime() : (operand as number);
          if (!(typeof v === "number" && v <= o)) return false;
        } else {
          throw new Error(`test fake: unsupported where operator ${key}.${op}`);
        }
      }
      continue;
    }
    if (!sameValue(value, cond)) return false;
  }
  return true;
}

function applyData(row: any, data: any): void {
  for (const [key, value] of Object.entries(data ?? {})) {
    if (
      value !== null && typeof value === "object" && !Array.isArray(value) &&
      "increment" in (value as any)
    ) {
      row[key] = (row[key] ?? 0) + (value as any).increment;
    } else if (
      value !== null && typeof value === "object" && !Array.isArray(value) &&
      "push" in (value as any)
    ) {
      row[key] = [...(row[key] ?? []), (value as any).push];
    } else {
      row[key] = value;
    }
  }
}

function makeFake(withLedger = true): PrFixQueueClient & { items: any[]; ledger: any[]; history: any[] } {
  const items: any[] = [];
  const ledger: any[] = [];
  const history: any[] = [];
  let nextId = 1;

  const client: any = {
    items,
    ledger,
    history,
    issue: { findFirst: async () => null },
    prFixQueueItem: {
      findUnique: async ({ where }: any) => {
        if (where.repo_pr) {
          return items.find((r) => r.repo === where.repo_pr.repo && r.pr === where.repo_pr.pr) ?? null;
        }
        return items.find((r) => r.id === where.id) ?? null;
      },
      create: async ({ data }: any) => {
        const row = {
          id: `item-${nextId++}`,
          generation: 1,
          fixAttempts: 1,
          handoutReclaims: 0,
          evidenceSequence: 0,
          attemptEvidenceWatermark: null,
          status: "QUEUED",
          feedback: [],
          evidenceKeys: [],
          postDispatchEvidenceKeys: [],
          agentHandouts: [],
          handoutAcks: [],
          handoutReceipts: [],
          ...data,
        };
        items.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = items.find((r) => r.id === where.id);
        if (!row) throw new Error("P2025");
        applyData(row, data);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const hit = items.filter((r) => matches(r, where));
        for (const row of hit) applyData(row, data);
        return { count: hit.length };
      },
      findMany: async ({ where }: any) => items.filter((r) => matches(r, where ?? {})),
    },
    prFixHistory: {
      create: async ({ data }: any) => {
        history.push(data);
        return data;
      },
      findMany: async () => history,
    },
    $transaction: async (fn: any) => fn(client),
  };

  if (withLedger) {
    client.prFixEvidence = {
      findFirst: async ({ where }: any) =>
        ledger.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where, orderBy }: any) => {
        const found = ledger.filter((row) => matches(row, where ?? {}));
        if (orderBy?.sequence === "asc") found.sort((a, b) => a.sequence - b.sequence);
        return found;
      },
      upsert: async ({ where, create, update }: any) => {
        const { itemId, identity } = where.itemId_identity;
        const existing = ledger.find((row) => row.itemId === itemId && row.identity === identity);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { ...create };
        ledger.push(row);
        return row;
      },
    };
  }
  return client;
}

function settled(result: any): any {
  if (!result.mutated) throw new Error("markPrFixItem did not mutate: " + result.reason);
  return result.item;
}

async function settleFixed(client: any): Promise<any> {
  const result = await markPrFixItem(client, {
    repo: "acme/widgets",
    pr: 7,
    status: "FIXED",
    expectedGeneration: client.items[0].generation,
  } as any);
  return settled(result);
}

// Durable-enqueue payload aligned with what pr-followup-ingestion builds.
function reviewEvidence(reviewId: string, overrides: Record<string, unknown> = {}) {
  return {
    evidenceKey: `review:acme/widgets#7:${reviewId}`,
    evidenceKind: "review",
    evidenceVersion: "state=changes_requested|commit=aaa1",
    evidenceContentSignature: signatureFor(reviewId),
    evidenceObservedAt: "2026-10-10T10:00:00Z",
    evidenceActionable: true,
    evidenceHeadSha: "aaa1",
    evidenceSource: "sync",
    ...overrides,
  };
}

async function seedReviewItem(client: any, overrides: Record<string, unknown> = {}) {
  return enqueuePrFixItem(client, {
    repo: "acme/widgets",
    pr: 7,
    lane: "NORMAL",
    type: "REVIEW_FEEDBACK",
    reason: "PR review: CHANGES_REQUESTED",
    feedback: "please fix",
    headSha: "aaa1",
    ...reviewEvidence("r1"),
    ...overrides,
  } as any);
}

function dispatchStamp(client: any, watermark: number) {
  const row = client.items[0];
  row.dispatchedGeneration = row.generation;
  row.dispatchedAt = new Date();
  row.attemptEvidenceWatermark = watermark;
  return row;
}

beforeEach(() => {
  headShaMock.current = "bbb2";
});

describe("durable evidence ledger on enqueue (#1249)", () => {
  it("records the first observation as ledger sequence 1 on the create path", async () => {
    const client = makeFake();
    await seedReviewItem(client);
    expect(client.items[0].evidenceSequence).toBe(1);
    expect(client.ledger).toHaveLength(1);
    expect(client.ledger[0]).toMatchObject({
      identity: "review:acme/widgets#7:r1",
      kind: "review",
      version: "state=changes_requested|commit=aaa1",
      sequence: 1,
      actionable: true,
    });
    expect(client.ledger[0].observedAt).toBeInstanceOf(Date);
  });

  it("replay of a stored (identity, version) is inert: no transition, no post-dispatch append", async () => {
    const client = makeFake();
    await seedReviewItem(client);
    dispatchStamp(client, 1);
    // Same identity, same version re-observed after the hand-out (webhook
    // replay / periodic re-read).
    await seedReviewItem(client);
    const row = client.items[0];
    expect(row.evidenceSequence).toBe(1);
    expect(row.postDispatchEvidenceKeys).toEqual([]);
    expect(row.status).toBe("QUEUED");
    expect(client.ledger).toHaveLength(1);
  });

  it("a new version of a known identity IS a transition and appends post-dispatch evidence", async () => {
    const client = makeFake();
    await seedReviewItem(client);
    dispatchStamp(client, 1);
    await seedReviewItem(client, {
      ...reviewEvidence("r1", { evidenceVersion: "state=changes_requested|commit=ccc3" }),
      headSha: "ccc3",
    });
    const row = client.items[0];
    expect(row.evidenceSequence).toBe(2);
    expect(row.postDispatchEvidenceKeys).toEqual(["review:acme/widgets#7:r1@ccc3"]);
    // Same attempt still — no fresh-attempt bump from more evidence.
    expect(row.generation).toBe(1);
    expect(client.ledger[0].version).toBe("state=changes_requested|commit=ccc3");
  });
});

describe("attempt-snapshot freshness at settlement (#1249)", () => {
  it("late-discovered transition after the watermark reopens FIXED even with the cache emptied (control 17/8)", async () => {
    const client = makeFake();
    await seedReviewItem(client); // r1, seq 1
    dispatchStamp(client, 1);
    // A second review lands after hand-out; its ledger transition is seq 2.
    await seedReviewItem(client, { ...reviewEvidence("r2"), feedback: "more changes" });
    // Simulate the bounded cache losing the entry (eviction / lost append).
    client.items[0].postDispatchEvidenceKeys = [];
    const result = await settleFixed(client);
    expect(result.status).toBe("QUEUED");
    expect(result.generation).toBe(2);
    expect(result.fixAttempts).toBe(2);
    // Fresh attempt resets the snapshot boundary.
    expect(result.attemptEvidenceWatermark).toBeNull();
  });

  it("a transition that raced the watermark stamp still reopens with the cache emptied (#1249)", async () => {
    const client = makeFake();
    await seedReviewItem(client); // r1, seq 1 — the payload this hand-out delivered
    const row = client.items[0];
    // Dispatched, but the watermark stamp has not run yet.
    row.dispatchedGeneration = row.generation;
    row.dispatchedAt = new Date();
    // The transition commits in the re-read→stamp gap: seq 2, actionable.
    await seedReviewItem(client, { ...reviewEvidence("r2"), feedback: "more changes" });
    expect(row.evidenceSequence).toBe(2);
    // The stamp runs against the ADVANCED counter at the delivered position:
    // the lower bound admits the raced row where the pre-fix reverse pin missed.
    const stamp = await client.prFixQueueItem.updateMany({
      where: {
        id: row.id,
        generation: row.generation,
        evidenceSequence: { gte: 1 },
        attemptEvidenceWatermark: null,
      },
      data: { attemptEvidenceWatermark: 1 },
    });
    expect(stamp.count).toBe(1);
    expect(row.attemptEvidenceWatermark).toBe(1);
    // The bounded cache loses the append (#1119 eviction); only the durable
    // ledger row past the watermark can still drive the reopen.
    row.postDispatchEvidenceKeys = [];
    expect(client.ledger[1]).toMatchObject({ sequence: 2, actionable: true });

    const result = await settleFixed(client);

    expect(result.status).toBe("QUEUED");
    expect(result.generation).toBe(2);
    expect(result.fixAttempts).toBe(2);
  });

  it("the same raced transition settles silently when the stamp missed (paired control)", async () => {
    const client = makeFake();
    await seedReviewItem(client); // r1, seq 1
    const row = client.items[0];
    row.dispatchedGeneration = row.generation;
    row.dispatchedAt = new Date();
    await seedReviewItem(client, { ...reviewEvidence("r2"), feedback: "more changes" });
    // The stamp predicate misses against the raced counter, so no watermark is
    // ever recorded: the loss the `gte` pin exists to prevent.
    const stamp = await client.prFixQueueItem.updateMany({
      where: {
        id: row.id,
        generation: row.generation,
        evidenceSequence: { lte: 1 },
        attemptEvidenceWatermark: null,
      },
      data: { attemptEvidenceWatermark: 1 },
    });
    expect(stamp.count).toBe(0);
    row.postDispatchEvidenceKeys = [];

    const result = await settleFixed(client);

    expect(result.status).toBe("FIXED");
    expect(row.attemptEvidenceWatermark).toBeNull();
  });

  it("a pre-watermark transition never reopens settlement, even with the cache emptied (control 18)", async () => {
    const client = makeFake();
    await seedReviewItem(client); // seq 1 — part of the hand-out snapshot
    dispatchStamp(client, 1);
    client.items[0].postDispatchEvidenceKeys = [];
    headShaMock.current = "ccc9"; // head moved → #940 guard passes
    const result = await settleFixed(client);
    expect(result.status).toBe("FIXED");
  });

  it("durable rows that are not actionable by kind do not force a reopen", async () => {
    const client = makeFake();
    await seedReviewItem(client);
    dispatchStamp(client, 1);
    // Non-actionable version recorded AFTER hand-out (e.g. review re-read in
    // a dismissed state): recorded for audit, inert for settlement.
    await seedReviewItem(client, {
      ...reviewEvidence("r1", {
        evidenceVersion: "state=dismissed|commit=aaa1",
        evidenceActionable: false,
      }),
    });
    client.items[0].postDispatchEvidenceKeys = [];
    headShaMock.current = "ccc9";
    const result = await settleFixed(client);
    expect(result.status).toBe("FIXED");
    // Still audited as a ledger transition.
    expect(client.items[0].evidenceSequence).toBe(2);
  });

  it("durable check_run entries stay head-gated (stale head is not actionable)", async () => {
    const client = makeFake();
    // Head baseline aaa1; settle-time current head bbb2.
    await seedReviewItem(client);
    dispatchStamp(client, 1);
    await seedReviewItem(client, {
      evidenceKey: "check_run:acme/widgets#7:900",
      evidenceKind: "check_run",
      evidenceVersion: "head=aaa1|status=completed|conclusion=failure",
      evidenceContentSignature: null,
      evidenceActionable: true,
      evidenceHeadSha: "aaa1",
      feedback: "check failed",
    });
    // The durable set survives the cache being emptied — but a failing check
    // on a SUPERSEDED head is still stale at settlement.
    client.items[0].postDispatchEvidenceKeys = [];
    const stale = await settleFixed(client);
    expect(stale.status).toBe("FIXED");
  });

  it("a durable check_run entry at the CURRENT head reopens settlement with the cache emptied", async () => {
    const client = makeFake();
    await seedReviewItem(client); // seq 1 (in the hand-out snapshot)
    dispatchStamp(client, 1);
    await seedReviewItem(client, {
      evidenceKey: "check_run:acme/widgets#7:901",
      evidenceKind: "check_run",
      evidenceVersion: "head=bbb2|status=completed|conclusion=failure",
      evidenceContentSignature: null,
      evidenceActionable: true,
      evidenceHeadSha: "bbb2",
      feedback: "check failed on current head",
    });
    client.items[0].postDispatchEvidenceKeys = [];
    const fresh = await settleFixed(client);
    expect(fresh.status).toBe("QUEUED");
    expect(fresh.generation).toBe(2);
  });
});

describe("anti-repetition and #940 precedence (#1249)", () => {
  it("repeated text under a new identity stays a no-op at FIXED, but is audited (controls 3/7)", async () => {
    const client = makeFake();
    await seedReviewItem(client); // r1 (settles FIXED next)
    headShaMock.current = "ccc9";
    await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "FIXED",
      expectedGeneration: client.items[0].generation,
    } as any);
    expect(client.items[0].status).toBe("FIXED");

    await seedReviewItem(client, {
      ...reviewEvidence("r2", { evidenceContentSignature: signatureFor("r1") }),
      headSha: "ddd4",
    });
    expect(client.items[0].status).toBe("FIXED"); // repeated text: no reopen
    expect(client.items[0].generation).toBe(1);
    // Recorded for audit as a transition under the new identity.
    expect(client.items[0].evidenceSequence).toBe(2);
    expect(client.ledger.map((r: any) => r.identity)).toContain("review:acme/widgets#7:r2");
  });

  it("#940 keeps precedence: re-observed KNOWN review evidence at FIXED/unchanged head reopens (control 18)", async () => {
    const client = makeFake();
    await seedReviewItem(client);
    headShaMock.current = "ccc9";
    await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "FIXED",
      expectedGeneration: client.items[0].generation,
    } as any);
    expect(client.items[0].status).toBe("FIXED");

    // Same review, same version, head unchanged (the row's head is still
    // aaa1 — nothing moved it) → the untrusted-tombstone net reopens even
    // though dedupe would call it a duplicate.
    await seedReviewItem(client);
    expect(client.items[0].status).toBe("QUEUED");
    expect(client.items[0].generation).toBe(2);
  });

  it("#1303: a NON-actionable version of a known review stays sticky at FIXED/unchanged head, but is audited (control 4)", async () => {
    const client = makeFake();
    await seedReviewItem(client); // r1, seq 1 (actionable)
    headShaMock.current = "ccc9";
    await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "FIXED",
      expectedGeneration: client.items[0].generation,
    } as any);
    expect(client.items[0].status).toBe("FIXED");

    // Same identity re-observed, but the re-read version is not actionable
    // (review left CHANGES_REQUESTED): recorded for audit, yet the #940 net
    // must not reopen the tombstone — the sticky isKnownEvidence branch holds.
    await seedReviewItem(client, {
      ...reviewEvidence("r1", {
        evidenceVersion: "state=dismissed|commit=aaa1",
        evidenceActionable: false,
      }),
    });
    expect(client.items[0].status).toBe("FIXED");
    expect(client.items[0].generation).toBe(1);
    // The non-actionable transition is still recorded (a NEW version).
    expect(client.items[0].evidenceSequence).toBe(2);
    expect(client.ledger[0]).toMatchObject({
      version: "state=dismissed|commit=aaa1",
      actionable: false,
    });
  });

  it("#1303 paired: a NEW actionable version of the same review still reopens at FIXED/unchanged head", async () => {
    const client = makeFake();
    await seedReviewItem(client); // r1, seq 1 (state=changes_requested|commit=aaa1)
    headShaMock.current = "ccc9";
    await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "FIXED",
      expectedGeneration: client.items[0].generation,
    } as any);
    expect(client.items[0].status).toBe("FIXED");

    // Same identity, a NEW actionable version (a later review round on the
    // same head): not a non-actionable version, so the #1303 restriction does
    // not over-block and the #940 net still reopens the tombstone.
    await seedReviewItem(client, {
      ...reviewEvidence("r1", { evidenceVersion: "state=changes_requested_v2|commit=aaa1" }),
    });
    expect(client.items[0].status).toBe("QUEUED");
    expect(client.items[0].generation).toBe(2);
  });

  it("condition kinds are exempt from #940: an unchanged persistent condition never reopens (control 19)", async () => {
    const client = makeFake();
    await seedReviewItem(client);
    // Persistent `dirty` condition observed before disposition, recorded as
    // its own stable per-condition identity.
    await enqueuePrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      lane: "NORMAL",
      type: "OTHER",
      reason: "Merge state change: dirty",
      feedback: "PR merge state is now dirty",
      headSha: "aaa1",
      evidenceKey: "merge_state:acme/widgets#7",
      evidenceKind: "merge_state",
      evidenceVersion: "state=dirty|head=aaa1",
      evidenceActionable: true,
      evidenceHeadSha: "aaa1",
    } as any);
    headShaMock.current = "ccc9";
    await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "FIXED",
      expectedGeneration: client.items[0].generation,
    } as any);
    // Disposition actually recorded (the review #940 net would reopen on the
    // NEXT re-observation) — settle at head ccc9 with nothing pending:
    expect(client.items[0].status).toBe("FIXED");

    // Re-read of the SAME (state, head) after eviction: identity known,
    // version unchanged → no transition, and the condition-kind exemption
    // from #940 keeps the tombstone closed.
    await enqueuePrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      lane: "NORMAL",
      type: "OTHER",
      reason: "Merge state change: dirty",
      feedback: "PR merge state is now dirty",
      headSha: "ccc9",
      evidenceKey: "merge_state:acme/widgets#7",
      evidenceKind: "merge_state",
      evidenceVersion: "state=dirty|head=aaa1",
      evidenceActionable: true,
      evidenceHeadSha: "aaa1",
    } as any);
    expect(client.items[0].status).toBe("FIXED");
    expect(client.items[0].evidenceSequence).toBe(2); // review seq 1 + dirty seq 2
  });

  it("the SAME condition observed at a NEW head is a transition (paired positive, control 19)", async () => {
    const client = makeFake();
    await enqueuePrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      lane: "NORMAL",
      type: "MERGE_CONFLICT",
      reason: "Merge conflict detected: PR is CONFLICTING",
      feedback: "PR has merge conflicts",
      headSha: "aaa1",
      evidenceKey: "merge_conflict:acme/widgets#7",
      evidenceKind: "merge_conflict",
      evidenceVersion: "mergeable=conflicting|head=aaa1",
      evidenceActionable: true,
      evidenceHeadSha: "aaa1",
    } as any);
    expect(client.items[0].evidenceSequence).toBe(1);
    await enqueuePrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      lane: "NORMAL",
      type: "MERGE_CONFLICT",
      reason: "Merge conflict detected: PR is CONFLICTING",
      feedback: "PR has merge conflicts",
      headSha: "bbb2",
      evidenceKey: "merge_conflict:acme/widgets#7",
      evidenceKind: "merge_conflict",
      evidenceVersion: "mergeable=conflicting|head=bbb2",
      evidenceActionable: true,
      evidenceHeadSha: "bbb2",
    } as any);
    expect(client.items[0].evidenceSequence).toBe(2);
    expect(client.ledger[0].version).toBe("mergeable=conflicting|head=bbb2");
  });
});

describe("legacy fallback and snapshot lifecycle (#1249)", () => {
  it("a client without the ledger surface keeps pre-#1249 cache semantics", async () => {
    const client = makeFake(false);
    await seedReviewItem(client);
    expect(client.items[0].evidenceSequence ?? 0).toBe(0);
    dispatchStamp(client, 0);
    await seedReviewItem(client, { ...reviewEvidence("r2"), feedback: "more changes" });
    // Cache fast path still records the post-dispatch entry...
    expect(client.items[0].postDispatchEvidenceKeys).toEqual(["review:acme/widgets#7:r2@aaa1"]);
    const result = await settleFixed(client);
    // ...and settlement still reopens on it (#1119 unchanged).
    expect(result.status).toBe("QUEUED");
  });

  it("WAITING_EXTERNAL clears the snapshot boundary", async () => {
    const client = makeFake();
    await seedReviewItem(client);
    dispatchStamp(client, 1);
    const result = await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "WAITING_EXTERNAL",
      expectedGeneration: client.items[0].generation,
      note: "waiting on upstream merge",
      externalWait: { kind: "upstream_pr", ref: "acme/deps#3", evidence: "upstream PR still open", trigger: { kind: "merged" } },
    } as any);
    expect(result.mutated).toBe(true);
    expect(settled(result).status).toBe("WAITING_EXTERNAL");
    expect(settled(result).attemptEvidenceWatermark).toBeNull();
  });

  it("freshAttemptGeneration resets the watermark everywhere a fresh attempt is minted", () => {
    // #495: every generation bump also clears the CI park deferral columns —
    // the deferral's leash (no TTL, no env var; every fresh attempt is
    // dispatchable again and a crashed Courier cycle leaves no suppression).
    expect(freshAttemptGeneration()).toEqual({
      generation: { increment: 1 },
      attemptEvidenceWatermark: null,
      ciParkState: null,
      ciParkHead: null,
      ciParkKey: null,
      ciParkFence: null,
      ciParkAt: null,
    });
  });
});

describe("review-round pins (#1249 review)", () => {
  it("repeated text recorded mid-attempt cannot reopen at settlement (controls 3/7 durable-side)", async () => {
    const client = makeFake();
    await seedReviewItem(client); // r1, sequence 1
    dispatchStamp(client, 1);
    // A NEW identity repeating r1's signature lands after hand-out: audited
    // as a transition, but stamped non-actionable so neither the enqueue
    // decision nor the settlement durable read can treat it as fresh work.
    await seedReviewItem(client, {
      ...reviewEvidence("r2", { evidenceContentSignature: signatureFor("r1") }),
      feedback: "bot boilerplate again",
    });
    expect(client.items[0].postDispatchEvidenceKeys).toEqual([]);
    expect(client.ledger[1]).toMatchObject({
      identity: "review:acme/widgets#7:r2",
      sequence: 2,
      actionable: false,
    });
    // Cache emptied: the durable set is the only remaining source, and the
    // repeated row must not surface from it.
    client.items[0].postDispatchEvidenceKeys = [];
    headShaMock.current = "ccc9";
    const result = await settleFixed(client);
    expect(result.status).toBe("FIXED");
  });

  it("evidence fields without a version fail closed to the cache: no ledger row, no counter bump", async () => {
    const client = makeFake();
    await seedReviewItem(client); // seq 1
    dispatchStamp(client, 1);
    // A caller that supplies identity+kind but no version cannot be
    // version-compared; recording it would mint a transition on every re-read.
    await enqueuePrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      lane: "NORMAL",
      type: "REVIEW_FEEDBACK",
      reason: "PR review: CHANGES_REQUESTED",
      feedback: "versionless payload",
      headSha: "aaa1",
      evidenceKey: "review:acme/widgets#7:r9",
      evidenceKind: "review",
      evidenceActionable: true,
    } as any);
    expect(client.items[0].evidenceSequence).toBe(1);
    expect(client.ledger).toHaveLength(1);
    // Legacy identity-only cache semantics stand: new identity → recorded.
    expect(client.items[0].evidenceKeys).toContain("review:acme/widgets#7:r9");
    expect(client.items[0].postDispatchEvidenceKeys).toEqual(["review:acme/widgets#7:r9@aaa1"]);
  });
});

describe("terminal dispositions retire the attempt snapshot (#1276 review)", () => {
  it("FIXED clears the watermark and the post-dispatch list", async () => {
    const client = makeFake();
    await seedReviewItem(client);
    dispatchStamp(client, 1);
    const result = await settleFixed(client);
    expect(result.status).toBe("FIXED");
    expect(result.attemptEvidenceWatermark).toBeNull();
    expect(result.postDispatchEvidenceKeys).toEqual([]);
  });

  it("BLOCKED clears the watermark", async () => {
    const client = makeFake();
    await seedReviewItem(client);
    dispatchStamp(client, 1);
    const result = await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "BLOCKED",
      expectedGeneration: client.items[0].generation,
      note: "needs a human decision",
      decision: "waiting on upstream API",
    } as any);
    expect(settled(result).status).toBe("BLOCKED");
    expect(settled(result).attemptEvidenceWatermark).toBeNull();
  });

  it("PARKED clears the watermark", async () => {
    const client = makeFake();
    await seedReviewItem(client);
    dispatchStamp(client, 1);
    const result = await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "PARKED",
      expectedGeneration: client.items[0].generation,
      outcome: "no_progress",
      note: "worker made no progress",
    } as any);
    expect(settled(result).status).toBe("PARKED");
    expect(settled(result).attemptEvidenceWatermark).toBeNull();
  });

  it("a mark back to QUEUED keeps the snapshot for the SAME attempt and drops it for a fresh one", async () => {
    const client = makeFake();
    await seedReviewItem(client);
    dispatchStamp(client, 1);
    // QUEUED → QUEUED is the same attempt: its entries and boundary survive.
    const sameAttempt = await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "QUEUED",
      expectedGeneration: client.items[0].generation,
      note: "operator requeue",
    } as any);
    expect(settled(sameAttempt).attemptEvidenceWatermark).toBe(1);

    // A settled item marked back to QUEUED mints a fresh attempt, which has no
    // hand-out yet and therefore no snapshot to bound.
    await settleFixed(client);
    expect(client.items[0].attemptEvidenceWatermark).toBeNull();
    dispatchStamp(client, 2);
    const fresh = await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "QUEUED",
      expectedGeneration: client.items[0].generation,
      note: "operator requeue",
    } as any);
    expect(settled(fresh).attemptEvidenceWatermark).toBeNull();
  });
});

describe("bounded content signature (#1276 review)", () => {
  it("records a bounded 32-hex signature and rejects anything outside that shape", async () => {
    const client = makeFake();
    await seedReviewItem(client);
    expect(client.ledger[0].contentSignature).toBe(signatureFor("r1"));
    // A caller-supplied signature outside the stored representation is dropped
    // rather than persisted into the indexed column.
    await seedReviewItem(client, {
      ...reviewEvidence("r2", { evidenceContentSignature: "not-a-digest" }),
    });
    expect(client.ledger[1].contentSignature).toBeNull();
    await seedReviewItem(client, {
      ...reviewEvidence("r3", { evidenceContentSignature: "A".repeat(32) }),
    });
    expect(client.ledger[2].contentSignature).toBeNull();
    await seedReviewItem(client, {
      ...reviewEvidence("r4", { evidenceContentSignature: `${"a".repeat(31)}b` }),
    });
    expect(client.ledger[3].contentSignature).toBe(`${"a".repeat(31)}b`);
    await seedReviewItem(client, {
      ...reviewEvidence("r5", { evidenceContentSignature: "a".repeat(33) }),
    });
    expect(client.ledger[4].contentSignature).toBeNull();
  });
});

// ─── Record-only state transitions (#1276) ──────────────────────────────────
//
// A review that LEAVES CHANGES_REQUESTED is a state transition the ledger must
// learn about, and it is not work. These pins hold both halves at once: the
// transition is recorded (non-actionable), and nothing about the item's work
// state moves — no status, no lane, no feedback, no generation, no history row.

describe("record-only evidence baseline (#1276)", () => {
  /** The same (repo, pr) ownership key `seedReviewItem` uses. */
  const recordBaseline = (evidence: Record<string, unknown>) => ({
    repo: "acme/widgets",
    pr: 7,
    ...evidence,
  });
  const approvedBaseline = () =>
    recordBaseline(
      reviewEvidence("r1", {
        evidenceVersion: "state=approved|commit=aaa1",
        evidenceActionable: false,
      }),
    );

  it("records a non-actionable transition with the next sequence, leaving work state untouched", async () => {
    const client = makeFake();
    await seedReviewItem(client); // CHANGES_REQUESTED, sequence 1
    const before = { ...client.items[0], feedback: [...client.items[0].feedback] };

    const recorded = await recordPrFixEvidenceBaseline(client, approvedBaseline() as any);

    expect(recorded).toBe(true);
    const row = client.items[0];
    // The item's atomic counter is what advances (one bump per transition);
    // the per-identity row is restamped in place, one row per identity.
    expect(row.evidenceSequence).toBe(2);
    expect(client.ledger).toHaveLength(1);
    expect(client.ledger[0]).toMatchObject({
      identity: "review:acme/widgets#7:r1",
      kind: "review",
      version: "state=approved|commit=aaa1",
      actionable: false,
    });
    // Work state is untouched: no enqueue happened, so nothing about the
    // attempt may move.
    expect(row.status).toBe(before.status);
    expect(row.lane).toBe(before.lane);
    expect(row.generation).toBe(before.generation);
    expect(row.fixAttempts).toBe(before.fixAttempts);
    expect(row.feedback).toEqual(before.feedback);
    expect(row.evidenceKeys).toEqual(before.evidenceKeys);
    // The ledger row IS the audit record — no enqueue history row for work
    // that was never enqueued.
    expect(client.history).toHaveLength(1);
    expect(client.history[0].action).toBe("enqueue");
  });

  it("replay of the recorded state is inert: no counter bump, no restamp, no write", async () => {
    const client = makeFake();
    await seedReviewItem(client);
    await recordPrFixEvidenceBaseline(client, approvedBaseline() as any);
    const stamped = { ...client.ledger[0] };
    expect(client.items[0].evidenceSequence).toBe(2);

    // Periodic re-read of the same dismissed/approved review: the stored
    // (identity, version) pair is not a transition.
    expect(await recordPrFixEvidenceBaseline(client, approvedBaseline() as any)).toBe(false);
    expect(await recordPrFixEvidenceBaseline(client, approvedBaseline() as any)).toBe(false);

    expect(client.items[0].evidenceSequence).toBe(2);
    expect(client.ledger).toHaveLength(1);
    expect(client.ledger[0]).toEqual(stamped);
    expect(client.history).toHaveLength(1);
  });

  it("with no item for (repo, pr) it records nothing and creates nothing", async () => {
    const client = makeFake();
    const recorded = await recordPrFixEvidenceBaseline(client, {
      ...approvedBaseline(),
      pr: 99,
    } as any);
    expect(recorded).toBe(false);
    expect(client.items).toHaveLength(0);
    expect(client.ledger).toHaveLength(0);
    expect(client.history).toHaveLength(0);
  });

  it("a record-only observation on ANOTHER review's identity never enqueues work", async () => {
    const client = makeFake();
    await seedReviewItem(client);
    const before = { status: client.items[0].status, feedback: [...client.items[0].feedback] };

    // A different review on the same PR, dismissed: recorded under its own
    // identity, and still no work item.
    const recorded = await recordPrFixEvidenceBaseline(client, recordBaseline(
      reviewEvidence("r2", {
        evidenceVersion: "state=dismissed|commit=aaa1",
        evidenceActionable: false,
      }),
    ) as any);

    expect(recorded).toBe(true);
    expect(client.ledger[1]).toMatchObject({
      identity: "review:acme/widgets#7:r2",
      version: "state=dismissed|commit=aaa1",
      sequence: 2,
      actionable: false,
    });
    expect(client.items[0].status).toBe(before.status);
    expect(client.items[0].feedback).toEqual(before.feedback);
    expect(client.items[0].fixAttempts).toBe(1);
    expect(client.history).toHaveLength(1);
  });

  it("a pin that keeps missing gives up in a bounded loop without a partial write", async () => {
    const client = makeFake();
    await seedReviewItem(client); // sequence 1
    // Sustained contention: every pinned counter claim misses (a concurrent
    // transition moved the counter in the read→write gap, every time). A
    // missed pin means the write never happened — nothing applied.
    let attempts = 0;
    client.prFixQueueItem.updateMany = async () => {
      attempts += 1;
      return { count: 0 };
    };

    const recorded = await recordPrFixEvidenceBaseline(client, approvedBaseline() as any);

    // Bounded, and nothing half-written: no counter bump, no ledger row for a
    // sequence the item write never claimed. The next sweep re-observes.
    expect(recorded).toBe(false);
    expect(attempts).toBe(3);
    expect(client.items[0].evidenceSequence).toBe(1);
    expect(client.ledger).toHaveLength(1);
    expect(client.ledger[0].version).toBe("state=changes_requested|commit=aaa1");
    expect(client.history).toHaveLength(1);
  });

  it("a re-versioned row moves to its new position, so settlement cannot absorb it", async () => {
    const client = makeFake();
    await seedReviewItem(client); // CHANGES_REQUESTED, sequence 1
    dispatchStamp(client, 1); // hand-out snapshot = sequence 1
    // The reviewer dismisses, then requests changes again on the SAME review
    // identity. The second transition is newer than the hand-out, so a settle
    // must see it — which requires the row to carry its CURRENT position
    // rather than the one it was first recorded at.
    await recordPrFixEvidenceBaseline(client, approvedBaseline() as any);
    await recordPrFixEvidenceBaseline(
      client,
      recordBaseline(
        reviewEvidence("r1", {
          evidenceVersion: "state=changes_requested|commit=bbb2",
          evidenceActionable: true,
        }),
      ) as any,
    );

    expect(client.items[0].evidenceSequence).toBe(3);
    expect(client.ledger).toHaveLength(1);
    expect(client.ledger[0]).toMatchObject({
      identity: "review:acme/widgets#7:r1",
      sequence: 3,
      actionable: true,
    });

    // Cache emptied: only the durable read can surface the re-request, and it
    // does — the row is at sequence 3, past the watermark of 1.
    client.items[0].postDispatchEvidenceKeys = [];
    headShaMock.current = "ddd4";
    const result = await settleFixed(client);
    expect(result.status).toBe("QUEUED"); // reopened: fresh post-watermark evidence
  });

  it("a settled item records the transition without settling, reopening or enqueueing", async () => {
    const client = makeFake();
    await seedReviewItem(client);
    await settleFixed(client); // terminal: watermark and keys cleared

    const recorded = await recordPrFixEvidenceBaseline(client, approvedBaseline() as any);

    // No status filter: a dismissal on a FIXED item is still the durable truth
    // a later requeue (and the #1253 reconciliation) reads. It cannot reopen —
    // the settled item carries no watermark, so the durable read is empty.
    expect(recorded).toBe(true);
    const row = client.items[0];
    expect(row.status).toBe("FIXED");
    expect(row.attemptEvidenceWatermark).toBeNull();
    expect(row.generation).toBe(1);
    expect(row.fixAttempts).toBe(1);
    expect(client.ledger[0]).toMatchObject({ version: "state=approved|commit=aaa1", actionable: false });
    // Nothing durable survives for a settle to read: no watermark, no cache
    // entries, so the post-watermark set is empty by construction.
    expect(row.postDispatchEvidenceKeys).toEqual([]);
  });

  it("the unpinned exhausted-loop fallback writes no ledger row, and the next read records it", async () => {
    const client = makeFake();
    await seedReviewItem(client); // r1, sequence 1
    dispatchStamp(client, 1);
    // Every pinned write misses (sustained contention), so the enqueue path
    // takes its documented pre-#1134 fallback: a plain, unpinned update whose
    // counter bump nobody can vouch for.
    client.prFixQueueItem.updateMany = async () => ({ count: 0 });

    await seedReviewItem(client, {
      ...reviewEvidence("r2", { evidenceVersion: "state=changes_requested|commit=ccc3" }),
      feedback: "second observation",
    });

    expect(client.items[0].evidenceSequence).toBeGreaterThan(1);
    // No row was written at the unclaimed position: a re-versioned row here
    // would MOVE its sequence, potentially below a live watermark.
    const identities = client.ledger.map((row: any) => row.identity);
    expect(new Set(identities)).toEqual(new Set(["review:acme/widgets#7:r1"]));

    // Self-healing: the next observation of that identity records the
    // transition, because the stored version still differs.
    const client2 = makeFake();
    await seedReviewItem(client2);
    await seedReviewItem(client2, {
      ...reviewEvidence("r2", { evidenceVersion: "state=changes_requested|commit=ccc3" }),
      feedback: "second observation",
    });
    expect(client2.ledger).toHaveLength(2);
    expect(client2.ledger[1]).toMatchObject({ identity: "review:acme/widgets#7:r2", sequence: 2 });
  });
});
