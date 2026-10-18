// @vitest-environment node
// Queue-level integration pins for the #1253 recovery policy: the enqueue
// path routes BLOCKED/PARKED/WAITING_EXTERNAL snapshots through
// `evaluateRecovery` inside the #1134/#1253 pinned-write loop, disposition
// stamps ride the disposition writes, the terminal reaps are
// generation-pinned, and structured external waits reconcile their recorded
// triggers. Fake-client based, mirroring pr-fix-queue.test.ts conventions.
// Reactivation tests carry durable-ledger fields (#1249): a reactivation
// requires ledger provenance (control 8), so a legacy cache-only caller can
// surface evidence but never mint a reactivation.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Prisma } from "@prisma/client";

const { surfacingMocks, githubPrsMocks } = vi.hoisted(() => ({
  surfacingMocks: {
    surfacePrFixBlocked: vi.fn().mockResolvedValue({ labelApplied: true, commentPosted: true, errors: [] }),
    surfacePrFixParked: vi.fn().mockResolvedValue({ commentPosted: true, commentUpdated: false, skippedTerminal: false, errors: [] }),
    surfacePrFixRequeued: vi.fn().mockResolvedValue({ labelRemoved: true, commentUpdated: true, errors: [] }),
    surfacePrFixUnblocked: vi.fn().mockResolvedValue({ labelRemoved: true, commentUpdated: true, errors: [] }),
    extractUrlsFromText: vi.fn(() => [] as string[]),
  },
  githubPrsMocks: {
    fetchPullRequestMergeState: vi.fn(async () => ({ mergeableState: null, mergeable: null })),
    fetchPullRequestHeadSha: vi.fn(async () => null),
    // Controls external-wait trigger evaluation: { state: "merged" } →
    // satisfied; { state: null } → unknown.
    fetchPullRequestState: vi.fn(async (_repo: string, _pr: number): Promise<{ state: string | null; mergedAt: string | null }> => ({ state: null, mergedAt: null })),
  },
}));

vi.mock("./pr-fix-surfacing", () => ({
  surfacePrFixBlocked: surfacingMocks.surfacePrFixBlocked,
  surfacePrFixParked: surfacingMocks.surfacePrFixParked,
  surfacePrFixRequeued: surfacingMocks.surfacePrFixRequeued,
  surfacePrFixUnblocked: surfacingMocks.surfacePrFixUnblocked,
  extractUrlsFromText: surfacingMocks.extractUrlsFromText,
}));

vi.mock("./github-prs", () => ({
  fetchPullRequestMergeState: githubPrsMocks.fetchPullRequestMergeState,
  fetchPullRequestHeadSha: githubPrsMocks.fetchPullRequestHeadSha,
  fetchPullRequestState: githubPrsMocks.fetchPullRequestState,
}));

import {
  enqueuePrFixItem,
  markPrFixItem,
  reconcileStalePrFixItems,
  reconcileExternalWaitTriggers,
  type PrFixQueueClient,
} from "./pr-fix-queue";
import { parseStoredExternalWait } from "./pr-fix-external-wait";

const HOUR = 60 * 60 * 1000;

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function matches(row: any, where: any): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      const ops = cond as Record<string, unknown>;
      for (const [op, operand] of Object.entries(ops)) {
        if (op === "equals") {
          if (!sameValue(value, operand)) return false;
        } else if (op === "not") {
          if (sameValue(value, operand)) return false;
        } else if (op === "in") {
          if (!(operand as unknown[]).includes(value)) return false;
        } else if (op === "lte") {
          if (!(value != null && new Date(value).getTime() <= new Date(operand as string).getTime())) return false;
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
    if (value !== null && typeof value === "object" && !Array.isArray(value) && "increment" in (value as any)) {
      row[key] = (row[key] ?? 0) + (value as any).increment;
    } else {
      row[key] = value;
    }
  }
}

function makeClient(): PrFixQueueClient & { items: any[]; ledger: any[]; history: any[] } {
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
        if (where.repo_pr) return items.find((r) => r.repo === where.repo_pr.repo && r.pr === where.repo_pr.pr) ?? null;
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
          staleDisposition: false,
          disposedAt: null,
          disposedEvidence: null,
          recoveryAppliedAt: null,
          status: "QUEUED",
          lane: "NORMAL",
          feedback: [],
          evidenceKeys: [],
          postDispatchEvidenceKeys: [],
          dispatchedGeneration: null,
          dispatchedAt: null,
          agentHandouts: [],
          handoutAcks: [],
          handoutReceipts: [],
          retryAt: null,
          outcome: null,
          decisionDetail: null,
          queuedAt: new Date(Date.UTC(2026, 0, 1, 0, nextId)),
          updatedAt: new Date(Date.UTC(2026, 0, 1, 0, nextId)),
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
        const hits = items.filter((r) => matches(r, where));
        for (const row of hits) applyData(row, data);
        return { count: hits.length };
      },
      findMany: async ({ where }: any) => items.filter((r) => matches(r, where ?? {})),
    },
    prFixHistory: {
      create: async ({ data }: any) => {
        history.push({ id: `history-${history.length + 1}`, at: new Date(), ...data });
        return data;
      },
      findMany: async () => history,
    },
    // #1249 durable evidence ledger surface (required for reactivation
    // provenance in these tests).
    prFixEvidence: {
      findFirst: async ({ where }: any) =>
        ledger.find((r) => r.itemId === where.itemId && r.identity === where.identity) ?? null,
      findMany: async ({ where }: any) =>
        ledger.filter(
          (r) =>
            (!where?.itemId || r.itemId === where.itemId) &&
            (where?.contentSignature === undefined || r.contentSignature === where.contentSignature),
        ),
      upsert: async ({ where, create, update }: any) => {
        const existing = ledger.find((r) => r.itemId === where.itemId_identity.itemId && r.identity === where.itemId_identity.identity);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { ...create };
        ledger.push(row);
        return row;
      },
    },
    $transaction: async (fn: any) => fn(client),
  };
  return client;
}

/** Durable-ledger observation fields (#1249): version keyed off the head. */
function ledgerFields(key: string, head = "bbb2") {
  return {
    evidenceKey: key,
    evidenceKind: "review",
    evidenceVersion: `state=changes_requested|commit=${head}`,
    evidenceActionable: true,
    evidenceHeadSha: head,
  };
}

async function seedItem(client: any, key = "review:acme/widgets#7:r1", head = "aaa1"): Promise<any> {
  await enqueuePrFixItem(client, {
    repo: "acme/widgets",
    pr: 7,
    lane: "NORMAL",
    reason: "PR review: CHANGES_REQUESTED",
    feedback: "please fix",
    headSha: head,
    ...ledgerFields(key, head),
  });
  return client.items[0];
}

async function seedParked(client: any, overrides: Record<string, unknown> = {}): Promise<any> {
  const item = await seedItem(client);
  await markPrFixItem(client, {
    repo: "acme/widgets",
    pr: 7,
    status: "PARKED",
    expectedGeneration: item.generation,
    outcome: "no_progress",
    note: "worker gave up",
  });
  Object.assign(client.items[0], overrides);
  return client.items[0];
}

const freshEnqueue = (evidenceKey: string) => ({
  repo: "acme/widgets",
  pr: 7,
  lane: "NORMAL",
  reason: "PR review: CHANGES_REQUESTED",
  feedback: "reviewer insists",
  headSha: "bbb2",
  ...ledgerFields(evidenceKey),
});

describe("enqueue reactivation of a budget-available PARKED item (row 8, #1253)", () => {
  let client: any;
  beforeEach(() => {
    client = makeClient();
    surfacingMocks.surfacePrFixParked.mockClear();
    surfacingMocks.surfacePrFixRequeued.mockClear();
  });

  it("reactivates after the cooldown with a fresh attempt", async () => {
    const parked = await seedParked(client, { disposedAt: new Date(Date.now() - 7 * HOUR) });
    expect(parked.status).toBe("PARKED");

    const reactivated = await enqueuePrFixItem(client, freshEnqueue("review:acme/widgets#7:r2"));

    expect(reactivated.status).toBe("QUEUED");
    expect(reactivated.lane).toBe("NORMAL");
    // Fresh attempt: generation bump, attempt consumed, baseline reset.
    expect(reactivated.generation).toBe(2);
    expect(reactivated.fixAttempts).toBe(2);
    expect(reactivated.attemptHeadSha).toBe("bbb2");
    // The hold's bookkeeping is shed.
    expect(reactivated.outcome).toBeNull();
    expect(reactivated.decisionDetail).toBeNull();
    expect(reactivated.staleDisposition).toBe(false);
    expect(reactivated.disposedAt).toBeNull();
    expect(reactivated.disposedEvidence).toBeNull();
    expect(reactivated.recoveryAppliedAt).toBeInstanceOf(Date);
    expect(client.history.at(-1)).toMatchObject({
      action: "enqueue",
      note: expect.stringContaining("Reactivated on fresh actionable evidence after the recovery cooldown (#1253)"),
    });
  });

  it("stays PARKED while the cooldown is still running", async () => {
    await seedParked(client, { disposedAt: new Date(Date.now() - HOUR) });
    const row = await enqueuePrFixItem(client, freshEnqueue("review:acme/widgets#7:r2"));
    expect(row.status).toBe("PARKED");
    expect(row.generation).toBe(1);
    expect(row.fixAttempts).toBe(1);
    expect(row.recoveryAppliedAt).toBeNull();
  });

  it("flags a cap-exhausted PARKED item instead of reopening (row 9, control 7)", async () => {
    await seedParked(client, {
      disposedAt: new Date(Date.now() - 7 * HOUR),
      fixAttempts: 5,
    });
    const row = await enqueuePrFixItem(client, freshEnqueue("review:acme/widgets#7:r2"));
    expect(row.status).toBe("PARKED");
    expect(row.generation).toBe(1);
    expect(row.fixAttempts).toBe(5);
    expect(row.staleDisposition).toBe(true);
    expect(client.history.at(-1)).toMatchObject({
      note: expect.stringContaining("budget exhausted"),
    });
  });

  it("flags the #1250 invalid_wait fail-closed park instead of reopening (B1, control 16)", async () => {
    await seedParked(client, {
      disposedAt: new Date(Date.now() - 7 * HOUR),
      outcome: "invalid_wait",
    });
    const row = await enqueuePrFixItem(client, freshEnqueue("review:acme/widgets#7:r2"));
    expect(row.status).toBe("PARKED");
    expect(row.generation).toBe(1);
    expect(row.fixAttempts).toBe(1);
    expect(row.staleDisposition).toBe(true);
    expect(client.history.at(-1)).toMatchObject({
      note: expect.stringContaining("invalid_wait, fail-closed"),
    });
  });

  it("holds a cache-only fresh observation without a ledger record — no reactivation, no flag (N3, control 8)", async () => {
    await seedParked(client, { disposedAt: new Date(Date.now() - 7 * HOUR) });
    // Legacy caller: identity-key only, no durable ledger fields.
    const row = await enqueuePrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      lane: "NORMAL",
      reason: "PR review: CHANGES_REQUESTED",
      feedback: "reviewer insists",
      evidenceKey: "review:acme/widgets#7:r2",
      headSha: "bbb2",
    });
    expect(row.status).toBe("PARKED");
    expect(row.staleDisposition).toBe(false);
    expect(row.generation).toBe(1);
    expect(row.recoveryAppliedAt).toBeNull();
  });

  it("holds duplicate ledger observations on a PARKED item without flagging (replay inert)", async () => {
    await seedParked(client, { disposedAt: new Date(Date.now() - 7 * HOUR) });
    // Exact replay of the seed observation: same identity, same version.
    const row = await enqueuePrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      lane: "NORMAL",
      reason: "PR review: CHANGES_REQUESTED",
      feedback: "reviewer insists",
      headSha: "aaa1",
      ...ledgerFields("review:acme/widgets#7:r1", "aaa1"),
    });
    expect(row.status).toBe("PARKED");
    expect(row.staleDisposition).toBe(false);
    expect(row.generation).toBe(1);
  });

  it("re-arms the cooldown on a re-park: the fresh disposedAt outweighs the stale recoveryAppliedAt (S1)", async () => {
    // Cycle: park@T0 → reactivate@T1 (recoveryAppliedAt=T1) → re-park@T2
    // (fresh disposedAt, recoveryAppliedAt survives) → fresh evidence at
    // T2+ε must HOLD until the cooldown elapses from T2.
    await seedParked(client, { disposedAt: new Date(Date.now() - 7 * HOUR) });
    const reactivated = await enqueuePrFixItem(client, freshEnqueue("review:acme/widgets#7:r2"));
    expect(reactivated.status).toBe("QUEUED");
    expect(reactivated.recoveryAppliedAt).toBeInstanceOf(Date);

    await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "PARKED",
      expectedGeneration: reactivated.generation,
      outcome: "no_progress",
      note: "still no progress",
    });
    const reparked = client.items[0];
    expect(reparked.status).toBe("PARKED");
    // The re-park wrote a FRESH disposition stamp; the reactivation's
    // cooldown stamp survived it.
    expect(reparked.disposedAt).toBeInstanceOf(Date);
    expect(reparked.recoveryAppliedAt).toBeInstanceOf(Date);

    // Make the ordering decisive: recoveryAppliedAt is stale (T1, long past
    // the cooldown) but the re-park's disposedAt (T2) is recent.
    reparked.recoveryAppliedAt = new Date(Date.now() - 7 * HOUR);
    reparked.disposedAt = new Date(Date.now() - 1000);

    const held = await enqueuePrFixItem(client, freshEnqueue("review:acme/widgets#7:r3"));
    expect(held.status).toBe("PARKED");
    expect(held.generation).toBe(2);
    expect(held.staleDisposition).toBe(false);
    // The survived stamp is untouched by a cooldown hold.
    expect(held.recoveryAppliedAt).toBeInstanceOf(Date);
  });
});

describe("enqueue surfacing of fresh evidence on holds evidence must not override (#1253)", () => {
  let client: any;
  beforeEach(() => {
    client = makeClient();
  });

  it("flags a BLOCKED (human hold) item without reopening it (row 16, control 13)", async () => {
    await seedItem(client);
    await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "BLOCKED",
      note: "scope question",
      outcome: "human_decision",
    });
    const row = await enqueuePrFixItem(client, freshEnqueue("review:acme/widgets#7:r2"));
    expect(row.status).toBe("BLOCKED");
    expect(row.lane).toBe("NEEDS_HUMAN");
    expect(row.generation).toBe(1);
    expect(row.staleDisposition).toBe(true);
    expect(client.history.at(-1)).toMatchObject({
      note: expect.stringContaining("surfaced as a stale disposition"),
    });
  });

  it("reactivates a structured WAITING_EXTERNAL item on fresh evidence (row 13)", async () => {
    await seedItem(client);
    const item = client.items[0];
    await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "WAITING_EXTERNAL",
      expectedGeneration: item.generation,
      note: "waiting on upstream",
      externalWait: { kind: "upstream_pr", ref: "acme/deps#3", evidence: "upstream open", trigger: { kind: "merged" } },
    });
    expect(client.items[0].status).toBe("WAITING_EXTERNAL");
    // Fresh feedback reopens immediately, cooldown-independent (retryAt is
    // still in the future).
    const row = await enqueuePrFixItem(client, freshEnqueue("review:acme/widgets#7:r2"));
    expect(row.status).toBe("QUEUED");
    expect(row.generation).toBe(2);
    expect(row.fixAttempts).toBe(2);
    expect(row.recoveryAppliedAt).toBeInstanceOf(Date);
    expect(parseStoredExternalWait(row.externalWait)).toBeNull();
    expect(client.history.at(-1)).toMatchObject({
      note: expect.stringContaining("Reactivated on fresh actionable feedback during the external wait"),
    });
  });

  it("holds a legacy free-text WAITING_EXTERNAL row without flagging (#1250 fail-closed)", async () => {
    await seedItem(client);
    const item = client.items[0];
    await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "WAITING_EXTERNAL",
      expectedGeneration: item.generation,
      note: "waiting on upstream",
      externalWait: { kind: "upstream_pr", ref: "acme/deps#3", evidence: "upstream open", trigger: { kind: "merged" } },
    });
    // Pre-#1250 shape: the contract degrades to free text.
    client.items[0].externalWait = "waiting on upstream merge";
    const row = await enqueuePrFixItem(client, freshEnqueue("review:acme/widgets#7:r2"));
    expect(row.status).toBe("WAITING_EXTERNAL");
    expect(row.generation).toBe(1);
    expect(row.staleDisposition).toBe(false);
  });

  it("a cap-flipped wait reactivation lands PARKED with the wait shed but the outcome intact (S3)", async () => {
    await seedItem(client);
    const item = client.items[0];
    item.fixAttempts = 5; // at the attempt cap
    await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "WAITING_EXTERNAL",
      expectedGeneration: item.generation,
      note: "waiting on upstream",
      externalWait: { kind: "upstream_pr", ref: "acme/deps#3", evidence: "upstream open", trigger: { kind: "merged" } },
    });
    const row = await enqueuePrFixItem(client, freshEnqueue("review:acme/widgets#7:r2"));
    // The cap check flipped the reactivation to a row-9 park.
    expect(row.status).toBe("PARKED");
    expect(row.generation).toBe(1); // no fresh attempt minted
    expect(row.outcome).toBe("no_progress"); // cap park outcome survives
    // But the wait itself is shed and the recovery bookkeeping applied.
    expect(parseStoredExternalWait(row.externalWait)).toBeNull();
    expect(row.retryAt).toBeNull();
    expect(row.recoveryAppliedAt).toBeInstanceOf(Date);
    expect(row.staleDisposition).toBe(true); // capParked spread wins
    // Composed history note (N1): recovery rationale + cap park.
    const note = String(client.history.at(-1)?.note ?? "");
    expect(note).toContain("Reactivated on fresh actionable feedback during the external wait");
    expect(note).toContain("Bounded at 5 fix attempts");
  });
});

describe("fresh attempts clear the recovery bookkeeping (S2)", () => {
  let client: any;
  beforeEach(() => {
    client = makeClient();
  });

  it("a maintainer mark to FIXED clears staleDisposition and the disposition stamps", async () => {
    await seedParked(client, { disposedAt: new Date(Date.now() - 7 * HOUR), recoveryAppliedAt: new Date(Date.now() - 8 * HOUR) });
    // Flag the row first (fresh evidence on a budget-exhausted park).
    client.items[0].fixAttempts = 5;
    const flagged = await enqueuePrFixItem(client, freshEnqueue("review:acme/widgets#7:r2"));
    expect(flagged.staleDisposition).toBe(true);

    const fixed = await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "FIXED",
      actorTier: "maintainer",
      allowStickyReclassify: true,
      note: "operator resolved",
    });
    if (!fixed.mutated) throw new Error("expected mutation: " + fixed.reason);
    expect(fixed.item.staleDisposition).toBe(false);
    expect(fixed.item.disposedAt).toBeNull();
    expect(fixed.item.disposedEvidence).toBeNull();
    expect(fixed.item.recoveryAppliedAt).toBeNull();
  });

  it("an isFreshAttempt enqueue write (#940 reopen of a flagged FIXED row) clears the flag and stamp", async () => {
    await seedItem(client);
    await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "FIXED",
      expectedGeneration: client.items[0].generation,
      note: "pushed a fix",
    });
    // Fixture: the tombstone was previously flagged by a hold it superseded.
    client.items[0].staleDisposition = true;
    client.items[0].disposedAt = new Date(Date.now() - HOUR);
    client.items[0].disposedEvidence = "review:acme/widgets#7:r0";

    // #940: same evidence identity+version, unchanged head → the untrusted
    // tombstone reopens as a fresh attempt.
    const reopened = await enqueuePrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      lane: "NORMAL",
      reason: "PR review: CHANGES_REQUESTED",
      feedback: "still broken",
      headSha: "aaa1",
      ...ledgerFields("review:acme/widgets#7:r1", "aaa1"),
    });

    expect(reopened.status).toBe("QUEUED");
    expect(reopened.generation).toBe(2);
    expect(reopened.staleDisposition).toBe(false);
    expect(reopened.disposedAt).toBeNull();
    expect(reopened.disposedEvidence).toBeNull();
  });
});

describe("park→reopen→park cycle terminates at the cap (S4, control 6)", () => {
  const ORIGINAL = process.env.PR_FIX_MAX_ATTEMPTS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PR_FIX_MAX_ATTEMPTS;
    else process.env.PR_FIX_MAX_ATTEMPTS = ORIGINAL;
  });

  it("repeated reactivation cycles end in a flagged cap park, not an infinite reopen", async () => {
    process.env.PR_FIX_MAX_ATTEMPTS = "3";
    const client = makeClient();
    await seedParked(client, { disposedAt: new Date(Date.now() - 7 * HOUR) });

    let keyIndex = 2;
    let finalRow: any = null;
    // Bounded driver: the queue itself must terminate the cycle at the cap;
    // this loop only feeds evidence and re-parks, and FAILS if it never
    // reaches the cap park within the bound.
    for (let cycle = 0; cycle < 8; cycle++) {
      const row = await enqueuePrFixItem(client, freshEnqueue(`review:acme/widgets#7:r${keyIndex++}`));
      if (row.status === "PARKED") {
        finalRow = row;
        break;
      }
      expect(row.status).toBe("QUEUED");
      await markPrFixItem(client, {
        repo: "acme/widgets",
        pr: 7,
        status: "PARKED",
        expectedGeneration: row.generation,
        outcome: "no_progress",
        note: "cycle park",
      });
      // Backdate the hold stamps so the next cycle's cooldown has elapsed,
      // preserving the real ordering the max anchor requires (S1): the
      // re-park's disposedAt (T2) is NEWER than the survived
      // recoveryAppliedAt (T1) — the fresh disposition re-arms the cooldown.
      client.items[0].disposedAt = new Date(Date.now() - 7 * HOUR);
      client.items[0].recoveryAppliedAt = new Date(Date.now() - 8 * HOUR);
    }

    expect(finalRow).not.toBeNull();
    expect(finalRow.status).toBe("PARKED");
    expect(finalRow.fixAttempts).toBe(3);
    expect(finalRow.staleDisposition).toBe(true);
    expect(finalRow.generation).toBe(3); // 2 reactivations = 2 bumps
    expect(client.items[0].outcome).toBe("no_progress");
  });
});

describe("FIXED reopened at the attempt cap lands a flagged park (S4, control 9)", () => {
  it("the capParked write sets staleDisposition true on the FIXED reopen path", async () => {
    const client = makeClient();
    await seedItem(client);
    client.items[0].fixAttempts = 5;
    await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "FIXED",
      expectedGeneration: client.items[0].generation,
      note: "pushed a fix",
    });
    expect(client.items[0].status).toBe("FIXED");

    // Fresh evidence (new identity) reopens → the cap check parks it.
    const row = await enqueuePrFixItem(client, freshEnqueue("review:acme/widgets#7:r2"));
    expect(row.status).toBe("PARKED");
    expect(row.outcome).toBe("no_progress");
    expect(row.staleDisposition).toBe(true);
    expect(row.generation).toBe(1);
    expect(row.disposedAt).toBeInstanceOf(Date);
    expect(row.disposedEvidence).toBe("review:acme/widgets#7:r2");
  });
});

describe("pinned re-decide under a concurrent generation bump (#1253)", () => {
  it("re-decides from the fresh row when a requeue bumps the generation in the read→write gap", async () => {
    const client = makeClient();
    await seedParked(client, { disposedAt: new Date(Date.now() - 7 * HOUR) });
    const row = client.items[0];

    const originalUpdateMany = client.prFixQueueItem.updateMany.bind(client.prFixQueueItem);
    let calls = 0;
    client.prFixQueueItem.updateMany = async (args: any) => {
      calls += 1;
      if (calls === 1) {
        // A concurrent operator requeue lands before the write: fresh
        // attempt (generation bump) back to QUEUED with budgets reset —
        // the exact write requeuePrFixItem performs.
        expect(args.where.generation).toBe(1);
        Object.assign(row, {
          generation: 2,
          status: "QUEUED",
          outcome: null,
          fixAttempts: 1,
          staleDisposition: false,
          disposedAt: null,
          recoveryAppliedAt: null,
        });
        // The stale-generation-pinned write misses.
        return { count: 0 };
      }
      // The retry re-decided from the QUEUED fresh row: the requeue already
      // owns the reopen, so the enqueue records evidence on THAT attempt
      // (same-attempt semantics, no generation pin).
      expect(args.where.generation).toBeUndefined();
      return originalUpdateMany(args);
    };

    const updated = await enqueuePrFixItem(client, freshEnqueue("review:acme/widgets#7:r2"));
    expect(calls).toBe(2);
    // The requeue's fresh attempt is preserved — the enqueue does not
    // double-bump a row that is already dispatchable.
    expect(updated.status).toBe("QUEUED");
    expect(updated.generation).toBe(2);
    expect(updated.recoveryAppliedAt).toBeNull();
    expect(client.history.at(-1)).toMatchObject({ action: "enqueue" });
    // No recovery note: the requeue owns the reopen; the enqueue is plain
    // same-attempt evidence recording.
    expect(client.history.at(-1)?.note).toBeUndefined();
  });

  it("re-decides and still reactivates when the bumped row is still PARKED", async () => {
    const client = makeClient();
    await seedParked(client, { disposedAt: new Date(Date.now() - 7 * HOUR) });
    const row = client.items[0];

    const originalUpdateMany = client.prFixQueueItem.updateMany.bind(client.prFixQueueItem);
    let calls = 0;
    client.prFixQueueItem.updateMany = async (args: any) => {
      calls += 1;
      if (calls === 1) {
        // A concurrent writer bumped the generation while the row stayed
        // PARKED; the stale-generation-pinned write misses.
        expect(args.where.generation).toBe(1);
        row.generation = 2;
        return { count: 0 };
      }
      // The retry pins the FRESH generation it re-decided from.
      expect(args.where.generation).toBe(2);
      return originalUpdateMany(args);
    };

    const reactivated = await enqueuePrFixItem(client, freshEnqueue("review:acme/widgets#7:r2"));
    expect(calls).toBe(2);
    expect(reactivated.status).toBe("QUEUED");
    expect(reactivated.generation).toBe(3);
    expect(reactivated.recoveryAppliedAt).toBeInstanceOf(Date);
    expect(client.history.at(-1)).toMatchObject({
      note: expect.stringContaining("Reactivated on fresh actionable evidence"),
    });
  });
});

describe("generation-pinned terminal reaps (#1253)", () => {
  it("pins the STALE write on status + generation and skips the history row on a lost race", async () => {
    const client = makeClient();
    await seedItem(client);
    const row = client.items[0];

    const wheres: any[] = [];
    client.prFixQueueItem.updateMany = async (args: any) => {
      wheres.push(args.where);
      // Race loss: the row was requeued (generation moved) before the write.
      row.generation = row.generation + 1;
      return { count: 0 };
    };

    const result = await reconcileStalePrFixItems(
      client,
      new Map([["acme/widgets", new Set([7])]]),
      new Map([["acme/widgets", new Map<number, "merged" | "closed">([[7, "merged"]])]]),
    );

    expect(result.markedStale).toBe(0);
    expect(wheres).toHaveLength(1);
    expect(wheres[0]).toMatchObject({ id: row.id, status: "QUEUED", generation: 1 });
    expect(row.status).toBe("QUEUED");
    // Only the seed enqueue's own history row exists — the reap wrote none.
    expect(client.history).toHaveLength(1);
    expect(client.history[0].action).toBe("enqueue");
  });
});

describe("reconcileExternalWaitTriggers (row 12, #1253)", () => {
  let client: any;
  beforeEach(() => {
    client = makeClient();
    githubPrsMocks.fetchPullRequestState.mockClear();
  });

  async function seedWaiting(ref: string): Promise<any> {
    await enqueuePrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      lane: "NORMAL",
      reason: "r",
      feedback: "f",
      headSha: "aaa1",
      ...ledgerFields(`review:acme/widgets#7:${ref}`, "aaa1"),
    });
    const item = client.items[0];
    await markPrFixItem(client, {
      repo: "acme/widgets",
      pr: 7,
      status: "WAITING_EXTERNAL",
      expectedGeneration: item.generation,
      note: "waiting",
      externalWait: { kind: "upstream_pr", ref, evidence: "upstream open", trigger: { kind: "merged" } },
    });
    return client.items[0];
  }

  it("reactivates (uncharged) when the recorded trigger is satisfied", async () => {
    const waiting = await seedWaiting("acme/deps#3");
    githubPrsMocks.fetchPullRequestState.mockResolvedValue({ state: "merged", mergedAt: new Date().toISOString() });

    const result = await reconcileExternalWaitTriggers(client);

    expect(result).toEqual({ evaluated: 1, reactivated: 1 });
    expect(waiting.status).toBe("QUEUED");
    expect(waiting.generation).toBe(2);
    // Uncharged recheck: no attempt consumed.
    expect(waiting.fixAttempts).toBe(1);
    expect(waiting.retryAt).toBeNull();
    expect(parseStoredExternalWait(waiting.externalWait)).toBeNull();
    expect(client.history.at(-1)).toMatchObject({
      note: "External-wait dependency satisfied; rechecking prerequisite (#1253).",
    });
  });

  it("does nothing when the dependency evaluates unknown (fetch failure)", async () => {
    const waiting = await seedWaiting("acme/deps#4");
    githubPrsMocks.fetchPullRequestState.mockResolvedValue({ state: null, mergedAt: null });

    const result = await reconcileExternalWaitTriggers(client);

    expect(result).toEqual({ evaluated: 1, reactivated: 0 });
    expect(waiting.status).toBe("WAITING_EXTERNAL");
    expect(waiting.generation).toBe(1);
    expect(client.history).toHaveLength(2); // enqueue + wait mark only
  });

  it("no-ops on a lost generation race: no history row, wait preserved (S4 pin-miss)", async () => {
    const waiting = await seedWaiting("acme/deps#5");
    githubPrsMocks.fetchPullRequestState.mockResolvedValue({ state: "merged", mergedAt: new Date().toISOString() });
    const historyBefore = client.history.length;

    const originalUpdateMany = client.prFixQueueItem.updateMany.bind(client.prFixQueueItem);
    let calls = 0;
    client.prFixQueueItem.updateMany = async (args: any) => {
      calls += 1;
      // A concurrent requeue bumped the generation before the pinned write
      // evaluated: count 0, no retry loop in the reconciliation pass.
      expect(args.where.generation).toBe(waiting.generation);
      waiting.generation += 1;
      return { count: 0 };
    };

    const result = await reconcileExternalWaitTriggers(client);

    expect(calls).toBe(1);
    expect(result).toEqual({ evaluated: 1, reactivated: 0 });
    expect(waiting.status).toBe("WAITING_EXTERNAL");
    expect(client.history).toHaveLength(historyBefore);
    expect(originalUpdateMany).toBeDefined();
  });

  it("bounds the pass at maxEvaluations network reads", async () => {
    // Distinct (repo, pr) rows: one per seed.
    const seeded: any[] = [];
    for (let i = 0; i < 5; i++) {
      await enqueuePrFixItem(client, {
        repo: "acme/widgets",
        pr: 100 + i,
        lane: "NORMAL",
        reason: "r",
        feedback: "f",
        headSha: "aaa1",
        ...ledgerFields(`review:acme/widgets#${100 + i}:r1`, "aaa1"),
      });
      await markPrFixItem(client, {
        repo: "acme/widgets",
        pr: 100 + i,
        status: "WAITING_EXTERNAL",
        expectedGeneration: client.items.at(-1).generation,
        note: "waiting",
        externalWait: { kind: "upstream_pr", ref: `acme/deps#${100 + i}`, evidence: "upstream open", trigger: { kind: "merged" } },
      });
      seeded.push(client.items.at(-1));
    }
    githubPrsMocks.fetchPullRequestState.mockResolvedValue({ state: "merged", mergedAt: new Date().toISOString() });

    const result = await reconcileExternalWaitTriggers(client, { maxEvaluations: 3 });

    expect(result).toEqual({ evaluated: 3, reactivated: 3 });
    expect(seeded.filter((r) => r.status === "QUEUED")).toHaveLength(3);
    expect(seeded.filter((r) => r.status === "WAITING_EXTERNAL")).toHaveLength(2);
    expect(githubPrsMocks.fetchPullRequestState).toHaveBeenCalledTimes(3);
  });

  it("skips cooldown_recheck and service_ready waits without spending an evaluation", async () => {
    await seedWaiting("acme/deps#9");
    client.items[0].externalWait = {
      kind: "external_service",
      ref: "vendor-api",
      evidence: "5xx",
      trigger: { kind: "service_ready" },
    };

    const result = await reconcileExternalWaitTriggers(client);

    expect(result).toEqual({ evaluated: 0, reactivated: 0 });
    expect(githubPrsMocks.fetchPullRequestState).not.toHaveBeenCalled();
    expect(client.items[0].status).toBe("WAITING_EXTERNAL");
  });
});

// Silence the unused-import lint for the DbNull sentinel re-export used by
// applyData round-trips above.
void Prisma;
