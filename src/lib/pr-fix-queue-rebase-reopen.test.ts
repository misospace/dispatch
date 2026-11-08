// @vitest-environment node
// #1575: a conflicted bot-authored PR whose latest attempt settled must
// materialize a REBASE row again. The conflict episode ends when the conflict
// CLEARS (`clearResolvedConflictItems`), not when an attempt settles — so a
// re-observed CONFLICTING version is not "known evidence" for a FIXED
// tombstone of a REBASE row: it reopens as a fresh, generation-bumped attempt,
// bounded by the #1543 stagnation guard. A conflict persisting across cycles
// on an already-QUEUED row stays one attempt; dispositioned holds (PARKED /
// BLOCKED / STALE) stay sticky; non-REBASE known evidence keeps the pre-#1575
// sticky-FIXED semantics (control 4).
//
// Fake-client based, mirroring pr-fix-queue-recovery.test.ts conventions, and
// driving the real `ingestMergeConflict` → `enqueuePrFixItem` chain so the
// condition-kind evidence fields are produced by their real producer.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { surfacingMocks, githubPrsMocks } = vi.hoisted(() => ({
  surfacingMocks: {
    surfacePrFixBlocked: vi.fn(async () => ({ labelApplied: false, commentPosted: false, errors: [] })),
    surfacePrFixParked: vi.fn(async () => ({
      commentPosted: false,
      commentUpdated: false,
      skippedTerminal: false,
      errors: [],
    })),
    surfacePrFixRequeued: vi.fn(async () => ({ labelRemoved: false, commentUpdated: false, errors: [] })),
    surfacePrFixUnblocked: vi.fn(async () => ({ labelRemoved: false, commentUpdated: false, errors: [] })),
    extractUrlsFromText: vi.fn(() => [] as string[]),
  },
  githubPrsMocks: {
    fetchPullRequestMergeState: vi.fn(async () => ({ mergeableState: null, mergeable: null })),
    fetchPullRequestHeadSha: vi.fn(async () => null),
    fetchPullRequestState: vi.fn(async () => ({ state: null, mergedAt: null })),
  },
}));

vi.mock("./pr-fix-surfacing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pr-fix-surfacing")>()),
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

import { enqueuePrFixItem, maxPrFixStagnation, type PrFixQueueClient } from "./pr-fix-queue";
import { ingestMergeConflict } from "./pr-followup-ingestion";
import { conditionEvidenceKey } from "./pr-fix-evidence";

// ─── Fake client (mirrors pr-fix-queue-recovery.test.ts) ────────────────────

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
        } else if (op === "in") {
          if (!(operand as unknown[]).includes(value)) return false;
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
          stagnationCount: 0,
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
          handoutAckTimes: [],
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
        if (!row) throw Object.assign(new Error("P2025"), { code: "P2025" });
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
        const existing = ledger.find(
          (r) => r.itemId === where.itemId_identity.itemId && r.identity === where.itemId_identity.identity,
        );
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

// ─── Scenario helpers ────────────────────────────────────────────────────────

const REPO = "misospace/miso-gallery";
const PR = 661;
// The head the PR carried when the conflict was first observed and the head
// the settled attempt left it at (base advanced — the head never moved).
const HEAD = "54b9b7c691de65f95145c389a106404bd546adcc";

function conflictKey() {
  return conditionEvidenceKey("merge_conflict", REPO, PR);
}

/** Seed a REBASE row in a given disposition, carrying the conflict identity
 * at `HEAD` — the state the sync left behind after an earlier episode. */
function seedSettledRow(
  client: any,
  status: "FIXED" | "PARKED" | "BLOCKED" | "STALE" | "QUEUED",
  overrides: Record<string, unknown> = {},
) {
  const row = {
    id: "item-seeded",
    repo: REPO,
    pr: PR,
    type: "REBASE",
    lane: "NORMAL",
    status,
    reason: "Mechanical rebase: PR dirty against base (#1327)",
    feedback: ["Mechanical rebase required: this PR is dirty against its base branch (#1327)."],
    evidenceKeys: [conflictKey()],
    evidenceSequence: 4,
    postDispatchEvidenceKeys: [],
    agentHandouts: [],
    handoutAcks: [],
    handoutAckTimes: [],
    handoutReceipts: [],
    handoutReclaims: 0,
    generation: 3,
    fixAttempts: 3,
    stagnationCount: 0,
    headSha: HEAD,
    attemptHeadSha: HEAD,
    dispatchedGeneration: 3,
    dispatchedAt: new Date(Date.UTC(2026, 10, 8, 12, 0, 0)),
    attemptEvidenceWatermark: null,
    staleDisposition: false,
    disposedAt: null,
    disposedEvidence: null,
    recoveryAppliedAt: null,
    retryAt: null,
    outcome: null,
    decisionDetail: null,
    url: `https://github.com/${REPO}/pull/${PR}`,
    queuedAt: new Date(Date.UTC(2026, 10, 8, 11, 0, 0)),
    updatedAt: new Date(Date.UTC(2026, 10, 8, 12, 0, 0)),
    ...overrides,
  };
  client.items.push(row);
  return row;
}

function observeConflict(client: any) {
  return ingestMergeConflict(client, {
    repoFullName: REPO,
    prNumber: PR,
    branch: "courier/misospace/miso-gallery/issue-654",
    url: `https://github.com/${REPO}/pull/${PR}`,
    title: "fix(security): reject null-byte paths in sanitize_path",
    author: "itsmiso-ai",
    mergeable: "CONFLICTING",
    linkedIssue: 654,
    headSha: HEAD,
    source: "sync",
  });
}

describe("REBASE materialization on a settled earlier attempt (#1575)", () => {
  beforeEach(() => {
    process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
  });
  afterEach(() => {
    delete process.env.PR_FOLLOWUP_BOT_IDENTITIES;
    vi.clearAllMocks();
  });

  it("reopens a FIXED rebase tombstone when the conflict identity re-observes unchanged (cache arm)", async () => {
    // The pre-#1575 behavior this closes: the identity sits in the bounded
    // `evidenceKeys` cache, the head never moved (BASE advanced to create the
    // conflict), so the version reads unchanged and the sticky arm kept the
    // FIXED row closed while the PR stayed unmergeable.
    const client = makeClient();
    seedSettledRow(client, "FIXED");

    const key = await observeConflict(client);
    expect(key).toBe(conflictKey());

    const row = client.items[0];
    expect(row.status, "a still-conflicting PR must not stay FIXED").toBe("QUEUED");
    expect(row.type).toBe("REBASE");
    expect(row.generation, "reopen is a fresh generation").toBe(4);
    expect(row.fixAttempts, "reopen opens a new attempt").toBe(4);
    expect(row.attemptHeadSha).toBe(HEAD);
    // The rebase lane's contract wall is the item's feedback.
    expect(row.feedback[row.feedback.length - 1]).toContain("Mechanical rebase required");
  });

  it("reopens the FIXED tombstone when the durable ledger holds the same CONFLICTING version (ledger arm)", async () => {
    // Same scenario through the #1249 durable ledger instead of the bounded
    // cache: `prior.version === input.evidenceVersion` made the re-read
    // "known evidence" and kept the tombstone closed.
    const client = makeClient();
    const row = seedSettledRow(client, "FIXED");
    client.ledger.push({
      itemId: row.id,
      identity: conflictKey(),
      version: `mergeable=conflicting|head=${HEAD.toLowerCase()}`,
      sequence: 4,
      contentSignature: null,
      actionable: true,
    });

    await observeConflict(client);

    const after = client.items[0];
    expect(after.status).toBe("QUEUED");
    expect(after.generation).toBe(4);
    // The (identity, version) pair is stored: no new ledger transition is
    // minted for the reopen itself — the attempt, not the evidence, is new.
    expect(after.evidenceSequence).toBe(4);
    expect(client.ledger).toHaveLength(1);
  });

  it("keeps one attempt when the conflict persists across cycles on a QUEUED row", async () => {
    // Anti-duplicate: the sync re-observes the same conflict every 15 minutes.
    // The row stays the SAME QUEUED attempt — no generation churn, no second
    // row, no stagnation burn.
    const client = makeClient();
    seedSettledRow(client, "QUEUED");

    await observeConflict(client);
    await observeConflict(client);

    const row = client.items[0];
    expect(row.status).toBe("QUEUED");
    expect(row.generation, "a persistent conflict is one logical item, not a new generation per cycle").toBe(3);
    expect(row.fixAttempts).toBe(3);
    expect(row.stagnationCount).toBe(0);
  });

  it("does not resurrect dispositions: PARKED, BLOCKED and STALE stay sticky", async () => {
    // #1327: a failed rebase attempt parks as the one-attempt-per-episode
    // terminal; #1218 human holds and #1000 gone-PR dispositions stay
    // operator-only. The reopen applies to the FIXED settle only.
    for (const status of ["PARKED", "BLOCKED", "STALE"] as const) {
      const client = makeClient();
      seedSettledRow(client, status, {
        ...(status === "PARKED" ? { outcome: "no_progress", stagnationCount: 3, staleDisposition: true } : {}),
        ...(status === "BLOCKED" ? { outcome: "human_decision" } : {}),
      });

      await observeConflict(client);

      expect(client.items[0].status, `${status} must stay ${status}`).toBe(status);
      expect(client.items[0].generation).toBe(3);
    }
  });

  it("parks instead of endlessly reopening once the stagnation budget is exhausted (#1543 fence)", async () => {
    // The generation-fence for the reopen loop: settling an attempt without
    // advancing the head counts as stagnation. At the cap the reopened row
    // parks (bounded exhaustion, surfaced to the operator) instead of
    // re-queuing forever.
    const client = makeClient();
    seedSettledRow(client, "FIXED", { stagnationCount: maxPrFixStagnation() - 1 });

    await observeConflict(client);

    const row = client.items[0];
    expect(row.status, "the reopen at the stagnation cap parks").toBe("PARKED");
    expect(row.staleDisposition).toBe(true);
    expect(row.outcome).toBe("no_progress");
  });

  it("keeps the sticky-FIXED semantics for non-REBASE known evidence (control 4 regression)", async () => {
    // #1276 control 4: a re-read review whose known version is NOT actionable
    // never reopens. The #1575 reopen is scoped to REBASE work only.
    const client = makeClient();
    const row = {
      id: "item-seeded-review",
      repo: "acme/widgets",
      pr: 900,
      type: "REVIEW_FEEDBACK",
      lane: "NORMAL",
      status: "FIXED",
      reason: "PR review: APPROVED",
      feedback: ["lgtm"],
      evidenceKeys: ["review:acme/widgets#900:r1"],
      evidenceSequence: 2,
      postDispatchEvidenceKeys: [],
      agentHandouts: [],
      handoutAcks: [],
      handoutAckTimes: [],
      handoutReceipts: [],
      handoutReclaims: 0,
      generation: 2,
      fixAttempts: 2,
      stagnationCount: 0,
      headSha: "aaa1",
      attemptHeadSha: "aaa1",
      dispatchedGeneration: 2,
      dispatchedAt: new Date(),
      attemptEvidenceWatermark: null,
      staleDisposition: false,
      disposedAt: null,
      disposedEvidence: null,
      recoveryAppliedAt: null,
      retryAt: null,
      outcome: null,
      decisionDetail: null,
      queuedAt: new Date(),
      updatedAt: new Date(),
    };
    client.items.push(row);

    await enqueuePrFixItem(client, {
      repo: "acme/widgets",
      pr: 900,
      lane: "NORMAL",
      type: "REVIEW_FEEDBACK",
      reason: "PR review: APPROVED",
      feedback: "lgtm",
      headSha: "aaa1",
      evidenceKey: "review:acme/widgets#900:r1",
      evidenceKind: "review",
      evidenceVersion: "state=approved|commit=aaa1",
      evidenceActionable: false,
      evidenceHeadSha: "aaa1",
    });

    expect(client.items[0].status, "non-REBASE known evidence keeps the tombstone closed").toBe("FIXED");
    expect(client.items[0].generation).toBe(2);
  });
});
