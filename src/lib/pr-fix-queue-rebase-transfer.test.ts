// @vitest-environment node
// #1675: durable semantic-conflict episode accounting and the bounded
// REBASE→fix transfer. One structured nonmechanical-conflict refusal from the
// mechanical rebase lane — settled against the exact live hand-out receipt at
// a live generation, with the PR head verified unchanged — transfers the
// episode ONE way onto a single ordinary fix attempt. Every other failure
// (changed remote head, stale receipt/generation, concurrent writer, infra
// unreachability, old-client refusals, other refusal kinds) keeps the
// ordinary blocked treatment; the transferred episode can never bounce back
// onto the REBASE lane (resync, restart, re-read), budgets are never reset,
// and exhaustion parks.
//
// Fake-client based, mirroring pr-fix-queue-rebase-reopen.test.ts
// conventions, and driving the real `resolvePrFixFromAgentReport` /
// `ingestMergeConflict` → `enqueuePrFixItem` chains so the transfer, the
// enqueue-side episode gate and the ordinary fallback all run for real.
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
    fetchPullRequestHeadSha: vi.fn(async () => null as string | null),
    fetchPullRequestState: vi.fn(async () => ({ state: null, mergedAt: null })),
  },
}));

vi.mock("./pr-fix-surfacing", () => ({
  surfacePrFixBlocked: surfacingMocks.surfacePrFixBlocked,
  surfacePrFixParked: surfacingMocks.surfacePrFixParked,
  surfacePrFixRequeued: surfacingMocks.surfacePrFixRequeued,
  surfacePrFixUnblocked: surfacingMocks.surfacePrFixUnblocked,
  extractUrlsFromText: surfacingMocks.extractUrlsFromText,
  // Marker constants other modules in the import graph re-export/use.
  NEEDS_HUMAN_LABEL: "needs-human",
  NEEDS_HUMAN_COMMENT_MARKER: "<!-- dispatch-pr-fix-blocked -->",
  PARKED_COMMENT_MARKER: "<!-- dispatch-pr-fix-parked -->",
  DISPATCH_FIX_REPLY_MARKER: "<!-- dispatch-fix-reply -->",
}));

vi.mock("./github-prs", () => ({
  fetchPullRequestMergeState: githubPrsMocks.fetchPullRequestMergeState,
  fetchPullRequestHeadSha: githubPrsMocks.fetchPullRequestHeadSha,
  fetchPullRequestState: githubPrsMocks.fetchPullRequestState,
}));

// report-resolution imports the prisma singleton for its default client; the
// tests always pass the fake client explicitly, so the mock only needs to
// keep the import alive without touching a real database.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { rebaseWorkItem, isMechanicalRebaseInstruction } from "./pr-fix-rebase";
import { conditionEvidenceKey } from "./pr-fix-evidence";
import { ingestMergeConflict, clearResolvedConflictItems } from "./pr-followup-ingestion";
import {
  parseRebaseRefusal,
  rebaseEpisodeIdentity,
  transferRebaseEpisodeToFix,
  isTransferEligibleRefusal,
  NONMECHANICAL_CONFLICT_KIND,
} from "./pr-fix-queue/rebase-transfer";
import { resolvePrFixFromAgentReport } from "./pr-fix-queue/report-resolution";
import { evaluatePrFixHandoutOwnership } from "./pr-fix-queue/handout-ownership";
import { maxPrFixStagnation } from "./pr-fix-queue/external-wait";
import { type PrFixQueueClient } from "./pr-fix-queue/client";

// ─── Fake client (mirrors pr-fix-queue-rebase-reopen.test.ts) ────────────────

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
        // Detached snapshot copy (Prisma read semantics): a concurrent write
        // landing after a read must NOT retroactively change the values the
        // reader derived its pinned CAS from.
        const hit = where.repo_pr
          ? items.find((r) => r.repo === where.repo_pr.repo && r.pr === where.repo_pr.pr)
          : items.find((r) => r.id === where.id);
        return hit ? { ...hit } : null;
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
          rebaseEpisodeId: null,
          rebaseEpisodeTransferred: false,
          rebaseEpisodeTransferredAt: null,
          rebaseEpisodeGeneration: null,
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const REPO = "misospace/miso-gallery";
const PR = 661;
// The head the conflict was observed at and the head the rebase attempt was
// baselined on (a failed mechanical rebase never moves the head).
const HEAD = "54b9b7c691de65f95145c389a106404bd546adcc";
const BRANCH = "courier/misospace/dispatch-pr-661";
const AGENT = "smurf";
const TOKEN = "hnd_abc123def456";
const GENERATION = 3;

function conflictKey() {
  return conditionEvidenceKey("merge_conflict", REPO, PR);
}

function refusalPayload(overrides: Record<string, unknown> = {}) {
  return {
    kind: NONMECHANICAL_CONFLICT_KIND,
    conflictingFiles: ["package-lock.json", "src/lib/a.ts"],
    explanation: "Both sides edited the same retry loop; the resolution is a semantic decision.",
    baseRef: "main",
    expectedRemoteHead: HEAD,
    ...overrides,
  };
}

/** Seed a REBASE row dispatched to AGENT at GENERATION with the live receipt. */
function seedRebaseRow(client: ReturnType<typeof makeClient>, overrides: Record<string, unknown> = {}) {
  const row = {
    id: "item-rebase",
    repo: REPO,
    pr: PR,
    type: "REBASE",
    attemptType: "REBASE",
    lane: "NORMAL",
    status: "QUEUED",
    issue: null,
    branch: BRANCH,
    url: `https://github.com/${REPO}/pull/${PR}`,
    title: "feat: add retry",
    author: "itsmiso-ai",
    reason: "Mechanical rebase: PR dirty against base (#1327)",
    feedback: [rebaseWorkItem("dirty").feedback],
    evidenceKeys: [conflictKey()],
    evidenceSequence: 2,
    postDispatchEvidenceKeys: [],
    generation: GENERATION,
    fixAttempts: 1,
    stagnationCount: 0,
    headSha: HEAD,
    attemptHeadSha: HEAD,
    dispatchedGeneration: GENERATION,
    dispatchedAt: new Date(Date.UTC(2026, 10, 20, 12, 0, 0)),
    agentHandouts: [`${AGENT}@${GENERATION}`],
    handoutAcks: [`${AGENT}@${GENERATION}`],
    handoutAckTimes: [new Date(Date.UTC(2026, 10, 20, 12, 0, 5)).toISOString()],
    handoutReceipts: [`${TOKEN}@${AGENT}@${GENERATION}`],
    rebaseEpisodeId: null,
    rebaseEpisodeTransferred: false,
    rebaseEpisodeTransferredAt: null,
    rebaseEpisodeGeneration: null,
    ...overrides,
  };
  client.items.push(row);
  return row;
}

const PARSED_REFUSAL = (() => {
  const parsed = parseRebaseRefusal(refusalPayload());
  if (!parsed.ok) throw new Error("fixture refusal must parse");
  return parsed.refusal;
})();

function transferInput(client: any, overrides: Record<string, unknown> = {}) {
  return {
    client,
    itemId: "item-rebase",
    generation: GENERATION,
    agentName: AGENT,
    handoutToken: TOKEN,
    refusal: PARSED_REFUSAL,
    ...overrides,
  };
}

function reportInput(client: any, overrides: Record<string, unknown> = {}) {
  return {
    repoFullName: REPO,
    pullRequestNumber: PR,
    outcome: "blocked" as const,
    blockReason: "human_decision",
    summary: "Mechanical rebase stopped on a non-mechanical conflict",
    rebaseRefusal: refusalPayload(),
    agentName: AGENT,
    attempt: { itemId: "item-rebase", generation: GENERATION, handoutToken: TOKEN },
    client,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue(HEAD);
  vi.stubEnv("PR_FIX_MAX_STAGNATION", "5");
  // The merge-conflict ingestion's bot-author gate (mirrors the reopen test).
  process.env.PR_FOLLOWUP_BOT_IDENTITIES = "itsmiso-ai";
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.PR_FOLLOWUP_BOT_IDENTITIES;
});

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe("rebaseEpisodeIdentity (#1675)", () => {
  it("is stable for the same authoritative PR/base/head/ref state", () => {
    const a = rebaseEpisodeIdentity(REPO, PR, BRANCH, HEAD);
    const b = rebaseEpisodeIdentity(REPO, PR, BRANCH, HEAD);
    expect(a).toBe(b);
    expect(a).toBe(`rebase-episode:${REPO}#${PR}:${BRANCH}:${HEAD}`);
  });

  it("changes when the head changes (a new push is a NEW episode)", () => {
    const moved = rebaseEpisodeIdentity(REPO, PR, BRANCH, "f".repeat(40));
    expect(moved).not.toBe(rebaseEpisodeIdentity(REPO, PR, BRANCH, HEAD));
  });

  it("changes when the head ref changes", () => {
    expect(rebaseEpisodeIdentity(REPO, PR, "other-branch", HEAD)).not.toBe(
      rebaseEpisodeIdentity(REPO, PR, BRANCH, HEAD),
    );
  });

  it("folds a missing branch/head deterministically so both sides of the gate agree", () => {
    expect(rebaseEpisodeIdentity(REPO, PR, null, HEAD)).toBe(
      rebaseEpisodeIdentity(REPO, PR, "unknown", HEAD),
    );
    expect(rebaseEpisodeIdentity(REPO, PR, null, null)).toBe(
      rebaseEpisodeIdentity(REPO, PR, undefined, ""),
    );
  });

  it("carries no poll timestamp and no human text", () => {
    const id = rebaseEpisodeIdentity(REPO, PR, BRANCH, HEAD);
    expect(id).not.toMatch(/2026|T\d\d:/);
    expect(id).toBe(`rebase-episode:${REPO}#${PR}:${BRANCH}:${HEAD}`);
  });
});

describe("parseRebaseRefusal (#1675)", () => {
  it("parses and bounds a well-formed refusal", () => {
    const parsed = parseRebaseRefusal(refusalPayload());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.refusal.kind).toBe(NONMECHANICAL_CONFLICT_KIND);
      expect(parsed.refusal.conflictingFiles).toEqual(["package-lock.json", "src/lib/a.ts"]);
      expect(parsed.refusal.explanation).toContain("semantic decision");
    }
  });

  it("refuses a non-object, an absent kind, and oversized evidence", () => {
    expect(parseRebaseRefusal(null).ok).toBe(false);
    expect(parseRebaseRefusal("semantic conflict").ok).toBe(false);
    expect(parseRebaseRefusal({}).ok).toBe(false);
    expect(parseRebaseRefusal({ kind: "x".repeat(65) }).ok).toBe(false);
    expect(parseRebaseRefusal(refusalPayload({ conflictingFiles: Array.from({ length: 21 }, () => "a.ts") })).ok).toBe(false);
    expect(parseRebaseRefusal(refusalPayload({ conflictingFiles: [""] })).ok).toBe(false);
    expect(parseRebaseRefusal(refusalPayload({ conflictingFiles: [42] })).ok).toBe(false);
    expect(parseRebaseRefusal(refusalPayload({ explanation: "x".repeat(1001) })).ok).toBe(false);
    expect(parseRebaseRefusal(refusalPayload({ baseRef: "x".repeat(201) })).ok).toBe(false);
    expect(parseRebaseRefusal(refusalPayload({ expectedRemoteHead: "x".repeat(101) })).ok).toBe(false);
  });

  it("rejects control characters in conflicting-file entries so the route 400s, not storage", () => {
    // A NUL byte in a stored path would make Postgres reject the report
    // write (dispatch#1126) instead of failing closed at the shape gate.
    for (const hostile of ["src/\u0000lib/a.ts", "src/\u0001lib/a.ts", "src/lib/\u007Fts", "src/\u001Blib/a.ts"]) {
      const parsed = parseRebaseRefusal(refusalPayload({ conflictingFiles: [hostile] }));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toMatch(/must not contain control characters/);
      }
    }
    // The hostile entry is refused as a whole: nothing is stored.
    expect(parseRebaseRefusal(refusalPayload({ conflictingFiles: ["src/lib/a.ts", "bad\u0000path"] })).ok).toBe(false);
  });

  it("accepts other kinds for RECORDING but they never authorize a transfer", () => {
    const parsed = parseRebaseRefusal({ kind: "auth_failure" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(isTransferEligibleRefusal(parsed.refusal)).toBe(false);
    }
    expect(isTransferEligibleRefusal(null)).toBe(false);
    expect(isTransferEligibleRefusal(undefined)).toBe(false);
    expect(isTransferEligibleRefusal(PARSED_REFUSAL)).toBe(true);
  });
});

// ─── The transfer writer ─────────────────────────────────────────────────────

describe("transferRebaseEpisodeToFix (#1675)", () => {
  it("ONE transition: settles the receipt, opens one fix attempt, records the episode", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("transferred");

    const row = client.items[0];
    // One authorized ordinary fix attempt at the next generation. The row is
    // an ORDINARY model-assisted repair attempt, never a mechanical-only
    // MERGE_CONFLICT row (the worker contract gives that type the same
    // mechanical-only walls as REBASE).
    expect(row.status).toBe("QUEUED");
    expect(row.type).toBe("OTHER");
    expect(row.type).not.toBe("MERGE_CONFLICT");
    expect(row.type).not.toBe("REBASE");
    expect(row.generation).toBe(GENERATION + 1);
    expect(row.attemptType).toBeNull(); // re-stamped by the next hand-out
    expect(row.fixAttempts).toBe(2);
    // Budgets never reset: the consumed rebase attempt counts as no progress.
    expect(row.stagnationCount).toBe(1);
    expect(row.attemptHeadSha).toBe(HEAD);
    expect(row.outcome).toBeNull();
    // The exact receipt/hand-out/ack of the settled rebase attempt is released.
    expect(row.handoutReceipts).toEqual([]);
    expect(row.agentHandouts).toEqual([]);
    expect(row.handoutAcks).toEqual([]);
    // The durable episode record.
    expect(row.rebaseEpisodeTransferred).toBe(true);
    expect(row.rebaseEpisodeId).toBe(rebaseEpisodeIdentity(REPO, PR, BRANCH, HEAD));
    expect(row.rebaseEpisodeGeneration).toBe(GENERATION);
    expect(row.rebaseEpisodeTransferredAt).toBeInstanceOf(Date);
    // The fix worker receives the bounded mechanical-failure context — and
    // NOT the mechanical-only instruction wall: contradictory instructions
    // would make the transfer something other than an ordinary repair
    // attempt. Ordinary non-mechanical feedback (none in this fixture) is
    // retained.
    expect(row.feedback.some((line: string) => line.includes("single authorized repair attempt"))).toBe(true);
    expect(row.feedback.some((line: string) => line.includes("package-lock.json"))).toBe(true);
    expect(row.feedback.some((line: string) => line.includes("semantic decision"))).toBe(true);
    expect(row.feedback.some((line: string) => isMechanicalRebaseInstruction(line))).toBe(false);
    expect(row.feedback.some((line: string) => line.includes("resolve conflicts MECHANICALLY ONLY"))).toBe(false);
    // Exactly one audit row.
    const transfers = client.history.filter((h: any) => h.action === "rebase_transfer");
    expect(transfers).toHaveLength(1);
    expect(transfers[0].status).toBe("QUEUED");
    expect(transfers[0].note).toContain("ONE ordinary fix attempt is authorized");
    expect(transfers[0].note).toContain(rebaseEpisodeIdentity(REPO, PR, BRANCH, HEAD));
    // The head precondition ran exactly once.
    expect(githubPrsMocks.fetchPullRequestHeadSha).toHaveBeenCalledTimes(1);
    // No needs-human surfacing: this was not a BLOCKED settlement.
    expect(surfacingMocks.surfacePrFixBlocked).not.toHaveBeenCalled();
  });

  it("keeps a frontier parent exclusive: the transferred attempt re-derives the lane (#1503)", async () => {
    // vitest.setup.ts configures the 3-tier lanes with `frontier` as the
    // escalation role; the transferred attempt must re-derive that from the
    // linked issue instead of collapsing to NORMAL.
    const client = makeClient();
    seedRebaseRow(client, { issue: 77, lane: "NORMAL" });
    (client.issue as any).findFirst = async () => ({ currentLane: "frontier" });
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("transferred");
    expect(client.items[0].lane).toBe("ESCALATED");
  });

  it("duplicate report is inert: an already-transferred episode never transfers twice", async () => {
    const client = makeClient();
    const episodeId = rebaseEpisodeIdentity(REPO, PR, BRANCH, HEAD);
    seedRebaseRow(client, {
      rebaseEpisodeId: episodeId,
      rebaseEpisodeTransferred: true,
      rebaseEpisodeGeneration: GENERATION - 1,
      rebaseEpisodeTransferredAt: new Date(Date.UTC(2026, 10, 19, 0, 0, 0)),
    });
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("already transferred");
    expect(client.items[0].rebaseEpisodeGeneration).toBe(GENERATION - 1); // untouched
    expect(client.history.filter((h: any) => h.action === "rebase_transfer")).toHaveLength(0);
    expect(githubPrsMocks.fetchPullRequestHeadSha).not.toHaveBeenCalled();
  });

  it("changed remote head stops the transfer (declined, never silently transferred)", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("f".repeat(40));
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("declined");
    expect(result.reason).toContain("no longer matches");
    const row = client.items[0];
    expect(row.status).toBe("QUEUED"); // untouched by the transfer writer
    expect(row.type).toBe("REBASE");
    expect(row.rebaseEpisodeTransferred).toBe(false);
    expect(row.handoutReceipts).toHaveLength(1); // receipt NOT consumed
    expect(client.history.filter((h: any) => h.action === "rebase_transfer")).toHaveLength(0);
  });

  it("an unverifiable head (infra failure) is not a semantic conflict: declined", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue(null);
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("declined");
    expect(client.items[0].rebaseEpisodeTransferred).toBe(false);
    expect(client.items[0].handoutReceipts).toHaveLength(1);
  });

  it("stale handout token authorizes nothing (fail closed)", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    const result = await transferRebaseEpisodeToFix(client, transferInput(client, { handoutToken: "hnd_deadbeef00" }));
    expect(result.action).toBe("declined");
    expect(result.reason).toContain("no live hand-out receipt");
    expect(client.items[0].handoutReceipts).toHaveLength(1);
    expect(client.items[0].rebaseEpisodeTransferred).toBe(false);
    expect(client.history).toHaveLength(0);
  });

  it("a non-REBASE dispatched lane never transfers", async () => {
    const client = makeClient();
    seedRebaseRow(client, { attemptType: "CI_FAILURE", type: "CI_FAILURE" });
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("declined");
    expect(result.reason).toContain("not dispatched as a REBASE attempt");
    expect(client.items[0].rebaseEpisodeTransferred).toBe(false);
  });

  it("another live writer at the same generation refuses the transfer with zero mutation", async () => {
    const client = makeClient();
    seedRebaseRow(client, {
      agentHandouts: [`${AGENT}@${GENERATION}`, "other@3"],
      handoutReceipts: [`${TOKEN}@${AGENT}@${GENERATION}`, "hnd_999999999999@other@3"],
    });
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("other live hand-out");
    const row = client.items[0];
    expect(row.status).toBe("QUEUED");
    expect(row.type).toBe("REBASE");
    expect(row.generation).toBe(GENERATION);
    expect(row.handoutReceipts).toHaveLength(2); // both writers intact
    expect(row.rebaseEpisodeTransferred).toBe(false);
    expect(client.history).toHaveLength(0);
  });

  it("a stale generation (the attempt was re-issued) skips without mutation", async () => {
    const client = makeClient();
    seedRebaseRow(client, { generation: GENERATION + 1, dispatchedGeneration: GENERATION + 1 });
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("skipped");
    expect(client.items[0].generation).toBe(GENERATION + 1);
    expect(client.items[0].handoutReceipts).toHaveLength(1);
    expect(githubPrsMocks.fetchPullRequestHeadSha).not.toHaveBeenCalled();
  });

  it("bounded attempt exhaustion: an exhausted stagnation budget parks instead of minting a repair", async () => {
    const client = makeClient();
    seedRebaseRow(client, { stagnationCount: maxPrFixStagnation() - 1 });
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("parked");
    const row = client.items[0];
    expect(row.status).toBe("PARKED");
    expect(row.outcome).toBe("no_progress");
    expect(row.stagnationCount).toBe(maxPrFixStagnation());
    // No transfer happened: the episode is NOT marked, no fix attempt minted.
    expect(row.rebaseEpisodeTransferred).toBe(false);
    expect(row.type).toBe("REBASE");
    expect(row.generation).toBe(GENERATION);
    expect(row.handoutReceipts).toEqual([]); // the consumed attempt's hand-out is released
    const transfers = client.history.filter((h: any) => h.action === "rebase_transfer");
    expect(transfers).toHaveLength(1);
    expect(transfers[0].status).toBe("PARKED");
    expect(transfers[0].note).toContain("stagnation budget is exhausted");
  });

  it("a lost CAS race (concurrent write in the read→write gap) skips rather than double-transfers", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    // Sabotage the pinned writes: every transfer-shaped updateMany misses (a
    // concurrent write keeps landing in the gap) while the row itself reads
    // back unchanged, so both passes re-run their preconditions and lose.
    const originalUpdateMany = client.prFixQueueItem.updateMany;
    let transferWrites = 0;
    client.prFixQueueItem.updateMany = async (args: any) => {
      if (args.data?.rebaseEpisodeTransferred !== undefined) {
        transferWrites += 1;
        return { count: 0 };
      }
      return originalUpdateMany(args);
    };
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("compare-and-swap");
    expect(transferWrites).toBe(2); // both passes pinned and missed
    const row = client.items[0];
    expect(row.generation).toBe(GENERATION);
    expect(row.rebaseEpisodeTransferred).toBe(false);
    expect(row.handoutReceipts).toHaveLength(1);
    expect(client.history.filter((h: any) => h.action === "rebase_transfer")).toHaveLength(0);
  });
});

// ─── Contention with concurrent enqueue observations (#1675 re-review) ──────

describe("REBASE observation vs transfer interleaving (#1675 re-review)", () => {
  it("a repeat CONFLICTING observation that read before the transfer can never write after it", async () => {
    // The exact review interleaving: the periodic sync reads the dispatched
    // QUEUED REBASE row at generation g (NO episode marker) and decides the
    // REBASE type + mechanical instruction wall; the transfer then commits
    // generation g+1 OTHER with the marker; the stale observation write lands
    // AFTER. The generation/episode pins must turn the stale write into a
    // miss and the in-transaction re-decide must see the marker — the row
    // stays the ordinary repair attempt, with no mechanical re-entry and no
    // rebase hand-out for the transferred episode.
    const client = makeClient();
    seedRebaseRow(client);
    let interleaved = false;
    const originalUpdateMany = client.prFixQueueItem.updateMany;
    const originalUpdate = client.prFixQueueItem.update;
    const intercept = async (args: any, next: (a: any) => Promise<any>) => {
      if (!interleaved && args.data?.type === "REBASE") {
        // The enqueue has computed its decision from the marker-less snapshot
        // and is about to write: run the WHOLE transfer in that gap.
        interleaved = true;
        const transfer = await transferRebaseEpisodeToFix(client, transferInput(client));
        expect(transfer.action).toBe("transferred");
      }
      return next(args);
    };
    client.prFixQueueItem.updateMany = (args: any) => intercept(args, originalUpdateMany);
    client.prFixQueueItem.update = (args: any) => intercept(args, originalUpdate);
    await ingestMergeConflict(client as any, {
      repoFullName: REPO,
      prNumber: PR,
      branch: BRANCH,
      headRepoFullName: REPO,
      url: `https://github.com/${REPO}/pull/${PR}`,
      title: "feat: add retry",
      author: "itsmiso-ai",
      mergeable: "CONFLICTING",
      headSha: HEAD,
      source: "sync",
    });
    expect(interleaved).toBe(true);
    const row = client.items[0];
    // The transferred identity survived: ordinary repair attempt, one
    // generation bump (the transfer's), marker intact.
    expect(row.type).toBe("OTHER");
    expect(row.status).toBe("QUEUED");
    expect(row.generation).toBe(GENERATION + 1);
    expect(row.rebaseEpisodeTransferred).toBe(true);
    expect(row.rebaseEpisodeId).toBe(rebaseEpisodeIdentity(REPO, PR, BRANCH, HEAD));
    // The mechanical instruction wall was NOT restored; the repair contract
    // is what the next hand-out carries.
    expect(row.feedback.filter((line: string) => isMechanicalRebaseInstruction(line))).toHaveLength(0);
    expect(row.feedback.some((line: string) => line.includes("single authorized repair attempt"))).toBe(true);
    // No mechanical re-entry was issued: no hand-out/receipt/dispatch state.
    expect(row.agentHandouts).toEqual([]);
    expect(row.handoutReceipts).toEqual([]);
    expect(row.attemptType).toBeNull();
    // Exactly one transfer audit row; the observation re-decided to the
    // suppressed-gate path (its note explains why nothing changed).
    expect(client.history.filter((h: any) => h.action === "rebase_transfer")).toHaveLength(1);
    expect(
      client.history.filter(
        (h: any) => h.action === "enqueue" && String(h.note ?? "").includes("REBASE type write was suppressed"),
      ),
    ).toHaveLength(1);
  });

  it("a concurrent newer observation that moved the row's head stops the transfer (declined, zero mutation)", async () => {
    // The reciprocal fence: enqueue's metadataPatch refreshes headSha (and
    // post-dispatch evidence) on the dispatched QUEUED row WITHOUT bumping the
    // generation. A sync observation landing between the transfer's verified
    // head read and its CAS write must make the write miss, and the re-read
    // must find the identity MOVED — the transfer declines rather than
    // re-basing a stale refusal onto the newer identity observation.
    const client = makeClient();
    const row = seedRebaseRow(client);
    const newHead = "f".repeat(40);
    let raced = false;
    githubPrsMocks.fetchPullRequestHeadSha.mockImplementation(async () => {
      if (!raced) {
        // A newer sync observation commits right after our verification read:
        // the mutable identity moves, generation/hand-outs untouched — the
        // shape the old transfer CAS could not see.
        raced = true;
        row.headSha = newHead;
        (row as any).postDispatchEvidenceKeys = [`merge_state@${newHead}`];
      }
      return HEAD;
    });
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(raced).toBe(true);
    expect(result.action).toBe("declined");
    expect(result.reason).toContain("identity moved");
    expect(result.reason).toContain("headSha");
    // Zero mutation: the newer observation survives, nothing was transferred.
    expect(row.type).toBe("REBASE");
    expect(row.status).toBe("QUEUED");
    expect(row.generation).toBe(GENERATION);
    expect(row.headSha).toBe(newHead);
    expect(row.postDispatchEvidenceKeys).toEqual([`merge_state@${newHead}`]); // NOT cleared
    expect(row.rebaseEpisodeTransferred).toBe(false);
    expect(row.handoutReceipts).toHaveLength(1); // receipt not consumed
    expect(client.history.filter((h: any) => h.action === "rebase_transfer")).toHaveLength(0);
  });

  it("a non-identity concurrent append still re-decides: the transfer commits on the fresh read", async () => {
    // The re-decide path stays available for races that do NOT move the
    // decision identity: a post-dispatch evidence append landing in the gap
    // misses the pinned write once, and the fresh re-read re-decides the same
    // verified episode and commits.
    const client = makeClient();
    const row = seedRebaseRow(client);
    let raced = false;
    githubPrsMocks.fetchPullRequestHeadSha.mockImplementation(async () => {
      if (!raced) {
        raced = true;
        (row as any).postDispatchEvidenceKeys = [`review@${HEAD}`];
      }
      return HEAD;
    });
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(raced).toBe(true);
    expect(result.action).toBe("transferred");
    expect(row.type).toBe("OTHER");
    expect(row.generation).toBe(GENERATION + 1);
    expect(row.rebaseEpisodeTransferred).toBe(true);
    // The fresh attempt resets the post-dispatch list (the append belonged to
    // the dead generation either way).
    expect(row.postDispatchEvidenceKeys).toEqual([]);
  });
});

// ─── #1615 ownership transition on the transferred attempt ───────────────────

describe("#1615 ownership transition on the transferred attempt (#1675 review)", () => {
  const REBASE_EXECUTOR = "courier-rebase";
  const FIXER = "fixbot";

  beforeEach(() => {
    // The operator-declared pools: `courier-rebase` may run mechanical rebases
    // but is NOT a fix-work owner; `fixbot` is the intended repair consumer.
    vi.stubEnv("DISPATCH_REBASE_AGENTS", REBASE_EXECUTOR);
    vi.stubEnv("DISPATCH_PR_FIX_AGENTS", FIXER);
  });

  it("re-resolves a DISPATCH_REBASE_AGENTS claimant: the transferred OTHER generation is hand-out eligible", async () => {
    const client = makeClient();
    seedRebaseRow(client, { issue: 99, claimant: REBASE_EXECUTOR, claimantSource: "agent-label" });
    // The authoritative records name an ordinary fix owner via the issue's
    // agent label; resolution runs under the #1615 non-REBASE exclusion, so
    // the pool name can never come back out of ANY source.
    (client.issue as any).findFirst = async () => ({ id: "iss-99", labels: [`agent/${FIXER}`] });
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("transferred");
    const row = client.items[0];
    // The un-routable identity is gone; the row carries the re-resolved owner.
    expect(row.claimant).toBe(FIXER);
    expect(row.claimantSource).toBe("agent-label");
    // The transition is audited on the settlement note.
    const transfer = client.history.find((h: any) => h.action === "rebase_transfer");
    expect(transfer.note).toContain("Claimant transition");
    expect(transfer.note).toContain(`${REBASE_EXECUTOR} (provenance "agent-label") -> ${FIXER}`);
    // Without the transition this exact pair is the #1615 poison — with the
    // worker space undeclared (so Part A is inert) the gate refuses it
    // deterministically on the ordinary fix lane as the rebase-executor arm:
    expect(
      evaluatePrFixHandoutOwnership(
        {
          repo: REPO,
          pr: PR,
          claimant: REBASE_EXECUTOR,
          claimantSource: "agent-label",
          fixType: "OTHER",
        },
        "enforce",
        new Set<string>(),
      ),
    ).toMatchObject({ decision: "refuse", refusal: "rebase-executor-claimant" });
    // …and the transferred generation as it is NOW passes the very same
    // issuance gate (fixType derived like next-task: attemptType ?? type).
    const ownership = evaluatePrFixHandoutOwnership({
      repo: row.repo,
      pr: row.pr,
      generation: row.generation,
      claimant: row.claimant,
      claimantSource: row.claimantSource,
      fixType: row.attemptType ?? row.type,
    });
    expect(ownership.decision).toBe("eligible");
    expect(ownership.refusal).toBeNull();
  });

  it("an unresolvable repair claimant lands as the honest unresolved state (#1569 recovery), never as the refused pair", async () => {
    const client = makeClient();
    seedRebaseRow(client, { issue: 99, claimant: REBASE_EXECUTOR, claimantSource: "lease" });
    // No issue row: no lease, no labels, no linked-issue source at all.
    (client.issue as any).findFirst = async () => null;
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("transferred");
    const row = client.items[0];
    expect(row.claimant).toBeNull();
    expect(row.claimantSource).toBe("missing");
    const transfer = client.history.find((h: any) => h.action === "rebase_transfer");
    expect(transfer.note).toContain(`-> unresolved (missing)`);
    // The gate now refuses as the recoverable #1569 "unresolved" class — the
    // lazy issuance backfill (claimant IS NULL) or an operator stamp can heal
    // it with zero attempt burn — NEVER the structurally stuck
    // rebase-executor pair.
    const ownership = evaluatePrFixHandoutOwnership({
      repo: row.repo,
      pr: row.pr,
      claimant: row.claimant,
      claimantSource: row.claimantSource,
      fixType: row.attemptType ?? row.type,
    });
    expect(ownership.decision).toBe("refuse");
    expect(ownership.refusal).toBe("unresolved");
  });

  it("a failed authoritative claimant read declines the WHOLE transfer: zero mutation, safe hold", async () => {
    const client = makeClient();
    seedRebaseRow(client, { issue: 99, claimant: REBASE_EXECUTOR, claimantSource: "agent-label" });
    (client.issue as any).findFirst = async () => {
      throw new Error("database unreachable");
    };
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("declined");
    expect(result.reason).toContain("ownership could not be re-established");
    const row = client.items[0];
    expect(row.status).toBe("QUEUED");
    expect(row.type).toBe("REBASE");
    expect(row.claimant).toBe(REBASE_EXECUTOR);
    expect(row.rebaseEpisodeTransferred).toBe(false);
    expect(row.handoutReceipts).toHaveLength(1); // receipt NOT consumed
    expect(client.history.filter((h: any) => h.action === "rebase_transfer")).toHaveLength(0);
  });

  it("leaves a claimant outside the rebase pool untouched: no fact read, no rewrite", async () => {
    const client = makeClient();
    seedRebaseRow(client, { claimant: "alice", claimantSource: "owner-label" });
    const findFirst = vi.fn(async () => null);
    (client.issue as any).findFirst = findFirst;
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("transferred");
    const row = client.items[0];
    expect(row.claimant).toBe("alice");
    expect(row.claimantSource).toBe("owner-label");
    // No linked issue and no pool membership: the transfer never reads claimant
    // facts and never touches the recorded identity.
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("a concurrent operator stamp wins the pin: the re-pass preserves it", async () => {
    const client = makeClient();
    seedRebaseRow(client, { issue: 99, claimant: REBASE_EXECUTOR, claimantSource: "agent-label" });
    (client.issue as any).findFirst = async () => ({ id: "iss-99", labels: [`agent/${FIXER}`] });
    const originalUpdateMany = client.prFixQueueItem.updateMany;
    let stamped = false;
    client.prFixQueueItem.updateMany = async (args: any) => {
      if (args.data?.rebaseEpisodeTransferred !== undefined && !stamped) {
        // An operator claimant transfer commits between our read and our
        // pinned CAS write.
        stamped = true;
        client.items[0].claimant = "ops-picker";
        client.items[0].claimantSource = "operator";
      }
      return originalUpdateMany(args);
    };
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("transferred");
    const row = client.items[0];
    // Pass 1 lost the claimant pin; pass 2 re-reads the operator identity —
    // outside the pool, so the transfer preserves it untouched.
    expect(stamped).toBe(true);
    expect(row.rebaseEpisodeTransferred).toBe(true);
    expect(row.claimant).toBe("ops-picker");
    expect(row.claimantSource).toBe("operator");
  });
});

// ─── Resolution integration ──────────────────────────────────────────────────

describe("resolvePrFixFromAgentReport: REBASE→fix transfer (#1675)", () => {
  it("one transition: an eligible refusal settles the report as requeued with the transfer", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    const result = await resolvePrFixFromAgentReport(reportInput(client) as any);
    expect(result.matched).toBe(true);
    expect(result.action).toBe("requeued");
    expect(result.reason).toContain("transferred");
    // An ordinary model-assisted repair attempt, never a mechanical-only row.
    expect(client.items[0].type).toBe("OTHER");
    expect(client.items[0].generation).toBe(GENERATION + 1);
    expect(client.items[0].rebaseEpisodeTransferred).toBe(true);
    // Not a BLOCKED settlement: no needs-human surfacing.
    expect(surfacingMocks.surfacePrFixBlocked).not.toHaveBeenCalled();
  });

  it("duplicate report (same attempt token replayed) is a stale-generation skip: no second transfer", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    await resolvePrFixFromAgentReport(reportInput(client) as any);
    expect(client.items[0].generation).toBe(GENERATION + 1);
    // The exact same report arrives again (client retry, courier restart).
    const replay = await resolvePrFixFromAgentReport(reportInput(client) as any);
    expect(replay.action).toBe("skipped");
    expect(replay.reason).toContain("stale attempt generation");
    expect(client.items[0].generation).toBe(GENERATION + 1); // no second bump
    expect(client.history.filter((h: any) => h.action === "rebase_transfer")).toHaveLength(1);
    expect(githubPrsMocks.fetchPullRequestHeadSha).toHaveBeenCalledTimes(1); // no second precondition run
  });

  it("restart/resync: a repeat CONFLICTING observation of the transferred episode never bounces the row back onto REBASE", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    await resolvePrFixFromAgentReport(reportInput(client) as any);
    const after = client.items[0];
    expect(after.type).toBe("OTHER");
    expect(after.status).toBe("QUEUED");

    // The periodic sync re-reads the still-conflicting PR at the SAME head.
    const key = await ingestMergeConflict(client as any, {
      repoFullName: REPO,
      prNumber: PR,
      branch: BRANCH,
      headRepoFullName: REPO,
      url: `https://github.com/${REPO}/pull/${PR}`,
      title: "feat: add retry",
      author: "itsmiso-ai",
      mergeable: "CONFLICTING",
      headSha: HEAD,
      source: "sync",
    });
    expect(key).toBe(conflictKey());
    const row = client.items[0];
    // The lane write was suppressed and no fresh attempt was minted: the
    // transferred fix attempt is untouched.
    expect(row.type).toBe("OTHER");
    expect(row.status).toBe("QUEUED");
    expect(row.generation).toBe(GENERATION + 1);
    expect(row.rebaseEpisodeTransferred).toBe(true);
    const suppressionNotes = client.history.filter(
      (h: any) => h.action === "enqueue" && String(h.note ?? "").includes("REBASE type write was suppressed"),
    );
    expect(suppressionNotes).toHaveLength(1);
    // The mechanical instruction wall the transfer dropped is NOT
    // re-appended by the suppressed resync: the row keeps the ordinary
    // repair attempt's feedback.
    expect(row.feedback.filter((line: string) => isMechanicalRebaseInstruction(line))).toHaveLength(0);
  });

  it("restart/resync with a branch-less observation derives the SAME episode identity (no bounce)", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    await resolvePrFixFromAgentReport(reportInput(client) as any);
    await ingestMergeConflict(client as any, {
      repoFullName: REPO,
      prNumber: PR,
      branch: null, // the sync could not read the head ref
      headRepoFullName: REPO,
      url: `https://github.com/${REPO}/pull/${PR}`,
      title: "feat: add retry",
      author: "itsmiso-ai",
      mergeable: "CONFLICTING",
      headSha: HEAD,
      source: "sync",
    });
    expect(client.items[0].type).toBe("OTHER");
    expect(client.items[0].rebaseEpisodeTransferred).toBe(true);
  });

  it("restart/resync with a head-less observation falls back to the row's stored head (no bounce)", async () => {
    // The metadata keeps the row's LAST authoritative head observation when a
    // resync cannot read one; the episode comparison must fail toward
    // no-bounce, never mint the `:unknown` identity that would rewrite the
    // active transferred OTHER row back onto REBASE.
    const client = makeClient();
    seedRebaseRow(client);
    await resolvePrFixFromAgentReport(reportInput(client) as any);
    expect(client.items[0].type).toBe("OTHER");
    await ingestMergeConflict(client as any, {
      repoFullName: REPO,
      prNumber: PR,
      branch: BRANCH,
      headRepoFullName: REPO,
      url: `https://github.com/${REPO}/pull/${PR}`,
      title: "feat: add retry",
      author: "itsmiso-ai",
      mergeable: "CONFLICTING",
      // headSha deliberately absent: this observation could not read it.
      source: "sync",
    });
    const row = client.items[0];
    expect(row.type).toBe("OTHER");
    expect(row.status).toBe("QUEUED");
    expect(row.generation).toBe(GENERATION + 1);
    expect(row.rebaseEpisodeTransferred).toBe(true);
    const suppressionNotes = client.history.filter(
      (h: any) => h.action === "enqueue" && String(h.note ?? "").includes("REBASE type write was suppressed"),
    );
    expect(suppressionNotes).toHaveLength(1);
  });

  it("a NEW head is a NEW episode: the rebase lane re-opens (and the stale gate releases)", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    await resolvePrFixFromAgentReport(reportInput(client) as any);
    const newHead = "f".repeat(40);
    await ingestMergeConflict(client as any, {
      repoFullName: REPO,
      prNumber: PR,
      branch: BRANCH,
      headRepoFullName: REPO,
      url: `https://github.com/${REPO}/pull/${PR}`,
      title: "feat: add retry",
      author: "itsmiso-ai",
      mergeable: "CONFLICTING",
      headSha: newHead,
      source: "sync",
    });
    const row = client.items[0];
    expect(row.type).toBe("REBASE");
    // The rebase instruction wall is back with the new episode.
    expect(row.feedback.some((line: string) => line.includes("resolve conflicts MECHANICALLY ONLY"))).toBe(true);
  });

  it("no infinite loop: the transferred fix attempt's failure ladder stays on the fix lane and parks", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    await resolvePrFixFromAgentReport(reportInput(client) as any);
    expect(client.items[0].generation).toBe(GENERATION + 1);
    expect(client.items[0].stagnationCount).toBe(1);

    // The transferred fix attempt fails without pushing (head unchanged).
    const failed = await resolvePrFixFromAgentReport({
      repoFullName: REPO,
      pullRequestNumber: PR,
      outcome: "failed",
      summary: "could not resolve the conflict",
      agentName: "other-fixer",
      attempt: { itemId: "item-rebase", generation: GENERATION + 1, handoutToken: TOKEN },
      client,
    } as any);
    expect(failed.action).toBe("requeued");
    expect(client.items[0].generation).toBe(GENERATION + 2);
    expect(client.items[0].stagnationCount).toBe(2);
    expect(client.items[0].type).toBe("OTHER");
    // A resync between failures still cannot bounce the row onto REBASE.
    await ingestMergeConflict(client as any, {
      repoFullName: REPO,
      prNumber: PR,
      branch: BRANCH,
      headRepoFullName: REPO,
      url: `https://github.com/${REPO}/pull/${PR}`,
      title: "feat: add retry",
      author: "itsmiso-ai",
      mergeable: "CONFLICTING",
      headSha: HEAD,
      source: "sync",
    });
    expect(client.items[0].type).toBe("OTHER");
  });

  it("changed remote head settles the report as an ordinary BLOCKED human decision, with the decline audited", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue("f".repeat(40));
    const result = await resolvePrFixFromAgentReport(reportInput(client) as any);
    expect(result.action).toBe("blocked");
    const row = client.items[0];
    expect(row.status).toBe("BLOCKED");
    expect(row.lane).toBe("NEEDS_HUMAN");
    expect(row.outcome).toBe("human_decision");
    expect(row.rebaseEpisodeTransferred).toBe(false);
    expect(row.type).toBe("REBASE");
    // The ordinary settlement's note carries the decline reason.
    const markNotes = client.history.filter((h: any) => h.action === "mark" && h.status === "BLOCKED");
    expect(markNotes).toHaveLength(1);
    expect(markNotes[0].note).toContain("[#1675]");
    expect(markNotes[0].note).toContain("no longer matches");
  });

  it("stale handout token/generation: the stale generation skips before anything runs", async () => {
    const client = makeClient();
    seedRebaseRow(client, { generation: GENERATION + 1, dispatchedGeneration: GENERATION + 1 });
    const result = await resolvePrFixFromAgentReport(reportInput(client) as any);
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("stale attempt generation");
    expect(client.items[0].handoutReceipts).toHaveLength(1);
    expect(client.items[0].rebaseEpisodeTransferred).toBe(false);
    expect(githubPrsMocks.fetchPullRequestHeadSha).not.toHaveBeenCalled();
    expect(client.history.filter((h: any) => h.action === "rebase_transfer")).toHaveLength(0);
  });

  it("stale handout token at the live generation fails closed to the ordinary BLOCKED hold", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    const result = await resolvePrFixFromAgentReport(
      reportInput(client, { attempt: { itemId: "item-rebase", generation: GENERATION, handoutToken: "hnd_rotated0000" } }) as any,
    );
    expect(result.action).toBe("blocked");
    expect(client.items[0].status).toBe("BLOCKED");
    expect(client.items[0].rebaseEpisodeTransferred).toBe(false);
    expect(client.history.filter((h: any) => h.action === "rebase_transfer")).toHaveLength(0);
  });

  it("ordinary old-client refusal (no rebaseRefusal) keeps the pre-#1675 BLOCKED hold", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    const result = await resolvePrFixFromAgentReport(
      reportInput(client, { rebaseRefusal: undefined }) as any,
    );
    expect(result.action).toBe("blocked");
    const row = client.items[0];
    expect(row.status).toBe("BLOCKED");
    expect(row.lane).toBe("NEEDS_HUMAN");
    expect(row.outcome).toBe("human_decision");
    expect(row.rebaseEpisodeTransferred).toBe(false);
    expect(row.type).toBe("REBASE");
    // No head verification, no transfer, no history beyond the mark.
    expect(githubPrsMocks.fetchPullRequestHeadSha).not.toHaveBeenCalled();
    expect(client.history.filter((h: any) => h.action === "rebase_transfer")).toHaveLength(0);
  });

  it("a refusal of any other kind (auth/infra/ambiguous workspace) never transfers", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    const result = await resolvePrFixFromAgentReport(
      reportInput(client, { rebaseRefusal: { kind: "auth_failure", explanation: "token rejected" } }) as any,
    );
    expect(result.action).toBe("blocked");
    expect(client.items[0].status).toBe("BLOCKED");
    expect(client.items[0].rebaseEpisodeTransferred).toBe(false);
    expect(githubPrsMocks.fetchPullRequestHeadSha).not.toHaveBeenCalled();
  });

  it("bounded attempt exhaustion on the transfer settles the report as parked", async () => {
    const client = makeClient();
    seedRebaseRow(client, { stagnationCount: maxPrFixStagnation() - 1 });
    const result = await resolvePrFixFromAgentReport(reportInput(client) as any);
    expect(result.action).toBe("parked");
    expect(client.items[0].status).toBe("PARKED");
    expect(client.items[0].rebaseEpisodeTransferred).toBe(false);
    expect(surfacingMocks.surfacePrFixParked).toHaveBeenCalledTimes(1);
  });

  it("the transferred conflict fix keeps its success path: a cleared conflict settles the row FIXED", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    await resolvePrFixFromAgentReport(reportInput(client) as any);
    const cleared = await clearResolvedConflictItems(client as any, {
      repoFullName: REPO,
      prNumber: PR,
      mergeable: "MERGEABLE",
      headSha: HEAD,
    });
    expect(cleared).toBe(true);
    expect(client.items[0].status).toBe("FIXED");
  });
});
