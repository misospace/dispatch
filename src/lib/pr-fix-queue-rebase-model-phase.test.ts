// @vitest-environment node
// #1676: the MODEL-REPAIR phase in front of the #1675 ordinary fix-pr fallback.
// A deterministic nonmechanical-conflict refusal from the mechanical rebase
// lane now has TWO repair stages ahead of any human:
//   a. MODEL REPAIR — pool declared (DISPATCH_REBASE_MODEL_AGENTS) + parent
//      verifies NOT_ESCALATED → the first accepted refusal settles the exact
//      mechanical receipt and persists the bounded context (semanticConflict +
//      the episode id) on the row, which stays a fresh QUEUED REBASE attempt
//      that only a model-authorized poll may take (#1674 gates).
//   b. ORDINARY FIX-PR FALLBACK — a refusal whose CURRENT episode already
//      carries the persisted context (proof a model-authorized attempt ran), an
//      undeclared pool, or an ESCALATED/UNKNOWN parent. The undeclared-pool
//      deployment never reads the linked issue for the classification.
// Fake-client based, mirroring pr-fix-queue-rebase-transfer.test.ts.
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

import { rebaseWorkItem, isMechanicalRebaseInstruction, semanticConflictFromRefusal, scopedRebaseSemanticConflict } from "./pr-fix-rebase";
import { conditionEvidenceKey } from "./pr-fix-evidence";
import {
  parseRebaseRefusal,
  rebaseEpisodeIdentity,
  transferRebaseEpisodeToFix,
  NONMECHANICAL_CONFLICT_KIND,
} from "./pr-fix-queue/rebase-transfer";
import { resolvePrFixFromAgentReport } from "./pr-fix-queue/report-resolution";
import { rebaseModelWorkerPoolDeclared } from "./pr-fix-queue/lane-admission";
import { evaluatePrFixHandoutOwnership } from "./pr-fix-queue/handout-ownership";
import { maxPrFixStagnation } from "./pr-fix-queue/external-wait";
import { type PrFixQueueClient } from "./pr-fix-queue/client";

// ─── Fake client (mirrors pr-fix-queue-rebase-transfer.test.ts) ───────────────

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
        // Detached snapshot copy (Prisma read semantics).
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
const HEAD = "54b9b7c691de65f95145c389a106404bd546adcc";
const BRANCH = "courier/misospace/dispatch-pr-661";
const AGENT = "smurf";
const TOKEN = "hnd_abc123def456";
const GENERATION = 3;
const MODEL_POOL = "courier-rebase-model";

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

function parsedRefusal(overrides: Record<string, unknown> = {}) {
  const parsed = parseRebaseRefusal(refusalPayload(overrides));
  if (!parsed.ok) throw new Error("fixture refusal must parse");
  return parsed.refusal;
}

const PARSED_REFUSAL = parsedRefusal();

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

/** The transport context the model-phase write is expected to persist. */
const EXPECTED_CONTEXT = semanticConflictFromRefusal({
  baseRef: "main",
  conflictingFiles: ["package-lock.json", "src/lib/a.ts"],
  explanation: PARSED_REFUSAL.explanation,
});

beforeEach(() => {
  vi.clearAllMocks();
  githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue(HEAD);
  vi.stubEnv("PR_FIX_MAX_STAGNATION", "5");
  // Deterministic-only baseline: an undeclared model pool unless a test opts in.
  vi.stubEnv("DISPATCH_REBASE_MODEL_AGENTS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. MODEL-REPAIR phase on the first accepted refusal ─────────────────────

describe("model-repair phase: pool declared + NOT_ESCALATED parent (#1676)", () => {
  beforeEach(() => {
    vi.stubEnv("DISPATCH_REBASE_MODEL_AGENTS", MODEL_POOL);
  });

  it("first refusal settles the receipt onto a MODEL-REQUIRED REBASE attempt, not a fix-pr transfer", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("model_repair");

    const row = client.items[0];
    // The row STAYS on the mechanical lane as a fresh queued attempt: the
    // model worker IS this lane's authorized consumer (#1674 gates).
    expect(row.status).toBe("QUEUED");
    expect(row.type).toBe("REBASE");
    expect(row.lane).toBe("NORMAL");
    // The bounded semantic-conflict context is persisted from the refusal, so
    // the row is now MODEL-REQUIRED.
    expect(row.semanticConflict).toEqual(EXPECTED_CONTEXT);
    expect(row.semanticConflict?.base).toBe("main");
    expect(row.semanticConflict?.files).toEqual(["package-lock.json", "src/lib/a.ts"]);
    expect(row.semanticConflict?.reason).toContain("semantic decision");
    // The episode record: id + generation stamp, but NOT the one-way transfer
    // marker — the episode has not left the REBASE lane.
    expect(row.rebaseEpisodeId).toBe(rebaseEpisodeIdentity(REPO, PR, BRANCH, HEAD));
    expect(row.rebaseEpisodeGeneration).toBe(GENERATION);
    expect(row.rebaseEpisodeTransferred).toBe(false);
    // Fresh attempt: generation bump, dispatched lane reset.
    expect(row.generation).toBe(GENERATION + 1);
    expect(row.attemptType).toBeNull();
    // The consumed mechanical receipt/hand-out/ack is released.
    expect(row.handoutReceipts).toEqual([]);
    expect(row.agentHandouts).toEqual([]);
    expect(row.handoutAcks).toEqual([]);
    expect(row.handoutAckTimes).toEqual([]);
    // #1543 budget: the consumed no-progress mechanical attempt counts.
    expect(row.stagnationCount).toBe(1);
    // The fresh attempt's baseline is the verified, unchanged remote head.
    expect(row.attemptHeadSha).toBe(HEAD);
    expect(row.outcome).toBeNull();
    expect(row.postDispatchEvidenceKeys).toEqual([]);
    // The mechanical instruction wall is UNCHANGED: this is still a REBASE
    // row; the model wall composes at hand-out time, not on the row.
    expect(row.feedback.some((line: string) => isMechanicalRebaseInstruction(line))).toBe(true);
    // The audit trail records the MODEL-REQUIRED decision, not a transfer.
    const modelRepairs = client.history.filter((h: any) => h.action === "rebase_model_repair");
    expect(modelRepairs).toHaveLength(1);
    expect(modelRepairs[0].status).toBe("QUEUED");
    expect(modelRepairs[0].note).toContain("MODEL-REQUIRED");
    expect(modelRepairs[0].note).toContain(rebaseEpisodeIdentity(REPO, PR, BRANCH, HEAD));
    expect(modelRepairs[0].note).toContain("package-lock.json");
    expect(client.history.filter((h: any) => h.action === "rebase_transfer")).toHaveLength(0);
    expect(githubPrsMocks.fetchPullRequestHeadSha).toHaveBeenCalledTimes(1);
  });
});

// ─── 2. Undeclared pool: pre-#1676 shape, no classification read ─────────────

describe("undeclared model pool: straight to the ordinary fallback (#1676)", () => {
  it("unset DISPATCH_REBASE_MODEL_AGENTS transfers on the FIRST refusal without the model-phase issue read", async () => {
    const client = makeClient();
    // A linked issue so a model-phase classification WOULD query Issue.findFirst
    // if the pool check did not short-circuit ahead of it.
    seedRebaseRow(client, { issue: 77 });
    const findFirst = vi.fn(async () => ({ currentLane: "local" }));
    (client.issue as any).findFirst = findFirst;

    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("transferred");
    const row = client.items[0];
    expect(row.type).toBe("OTHER");
    expect(row.status).toBe("QUEUED");
    expect(row.rebaseEpisodeTransferred).toBe(true);
    expect(row.semanticConflict == null).toBe(true);
    // The model-phase classification is short-circuited by the pool check
    // BEFORE any read: a deterministic-only deployment performs NO extra issue
    // read for the classification. The exactly-one read that DOES happen is
    // the pre-existing #1503 lane re-derivation of the fallback itself
    // (rebase-transfer.ts transferData.lane) — present identically before
    // #1676, so the deployment's read cost is unchanged.
    expect(findFirst).toHaveBeenCalledTimes(1);
    // The fallback reason names the undeclared pool (no model worker on this
    // deployment), proving the short-circuit branch ran.
    const transfer = client.history.find((h: any) => h.action === "rebase_transfer");
    expect(transfer.note).toContain("No model-rebase worker is authorized for this episode on this deployment");
  });
});

// ─── 3. Frontier parent: never the model phase, never demoted ────────────────

describe("ESCALATED parent: ordinary fallback, exclusive lane preserved (#1676)", () => {
  beforeEach(() => {
    vi.stubEnv("DISPATCH_REBASE_MODEL_AGENTS", MODEL_POOL);
  });

  it("a row already stored ESCALATED short-circuits the parent read and transfers without demotion", async () => {
    const client = makeClient();
    seedRebaseRow(client, { lane: "ESCALATED", issue: 77 });
    const findFirst = vi.fn(async () => null);
    (client.issue as any).findFirst = findFirst;

    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("transferred");
    const row = client.items[0];
    // Never demoted: the exclusive lane survives the mechanical exception.
    expect(row.lane).toBe("ESCALATED");
    expect(row.type).toBe("OTHER");
    expect(row.semanticConflict == null).toBe(true);
    // row.lane === "ESCALATED" is ESCALATED by its own authority: the model
    // phase performs no parent read. The single read that DOES happen is the
    // fallback's own #1503 lane re-derivation (an un-short-circuited model
    // phase would make it two).
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("a linked Issue.currentLane on the configured escalation lane routes to the fallback, lane ESCALATED", async () => {
    const client = makeClient();
    seedRebaseRow(client, { issue: 77 });
    // vitest.setup.ts configures the 3-tier lanes with `frontier` as the
    // escalation role.
    (client.issue as any).findFirst = vi.fn(async () => ({ currentLane: "frontier" }));

    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("transferred");
    const row = client.items[0];
    expect(row.lane).toBe("ESCALATED");
    expect(row.semanticConflict == null).toBe(true);
    expect(row.rebaseEpisodeTransferred).toBe(true);
    const transfer = client.history.find((h: any) => h.action === "rebase_transfer");
    expect(transfer.note).toContain("goes directly to the ordinary fix-pr fallback");
  });
});

// ─── 4. modelPhasePending: the episode already carries the context ───────────

describe("model phase already pending: the refusal proves a model attempt ran (#1676)", () => {
  beforeEach(() => {
    vi.stubEnv("DISPATCH_REBASE_MODEL_AGENTS", MODEL_POOL);
  });

  it("transfers to the ordinary fix-pr fallback with the model-attempt feedback line", async () => {
    const client = makeClient();
    const episodeId = rebaseEpisodeIdentity(REPO, PR, BRANCH, HEAD);
    seedRebaseRow(client, {
      semanticConflict: { base: "main", files: ["src/lib/a.ts"], reason: "persisted by the first refusal" },
      rebaseEpisodeId: episodeId,
      rebaseEpisodeGeneration: GENERATION - 1,
    });

    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("transferred");
    const row = client.items[0];
    expect(row.type).toBe("OTHER");
    expect(row.status).toBe("QUEUED");
    // The one-way marker now lands: the episode left the mechanical lane.
    expect(row.rebaseEpisodeTransferred).toBe(true);
    expect(row.rebaseEpisodeId).toBe(episodeId);
    // FIRST feedback line attributes the episode to the model-assisted attempt
    // (the mechanical-only wall was dropped from the retained feedback).
    expect(row.feedback[0]).toContain("The authorized model-assisted rebase attempt refused this conflict episode");
    expect(row.feedback[0]).toContain(episodeId);
    expect(row.feedback.some((line: string) => isMechanicalRebaseInstruction(line))).toBe(false);
    const transfer = client.history.find((h: any) => h.action === "rebase_transfer");
    expect(transfer.note).toContain("The authorized model-assisted rebase attempt also refused this episode");
    expect(client.history.filter((h: any) => h.action === "rebase_model_repair")).toHaveLength(0);
  });
});

// ─── 5. The phase marker is episode-scoped ───────────────────────────────────

describe("episode-scoped phase marker: a new episode re-decides (#1676)", () => {
  beforeEach(() => {
    vi.stubEnv("DISPATCH_REBASE_MODEL_AGENTS", MODEL_POOL);
  });

  it("a stale context from an OLDER episode id does not count — the model phase runs again", async () => {
    const client = makeClient();
    const staleEpisodeId = rebaseEpisodeIdentity(REPO, PR, BRANCH, "f".repeat(40));
    seedRebaseRow(client, {
      semanticConflict: { base: "main", files: ["stale/old.ts"], reason: "context from a previous episode" },
      rebaseEpisodeId: staleEpisodeId,
      rebaseEpisodeGeneration: GENERATION - 1,
    });

    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("model_repair");
    const row = client.items[0];
    // The phase does not inherit: the CURRENT episode re-decides, and the
    // persisted context is replaced with this refusal's evidence.
    expect(row.rebaseEpisodeId).toBe(rebaseEpisodeIdentity(REPO, PR, BRANCH, HEAD));
    expect(row.rebaseEpisodeId).not.toBe(staleEpisodeId);
    expect(row.semanticConflict).toEqual(EXPECTED_CONTEXT);
    expect(row.semanticConflict?.files).not.toContain("stale/old.ts");
    expect(row.type).toBe("REBASE");
    expect(row.generation).toBe(GENERATION + 1);
    expect(client.history.filter((h: any) => h.action === "rebase_model_repair")).toHaveLength(1);
  });
});

// ─── 6. Duplicate reports after a successful model_repair ────────────────────

describe("duplicate report after model_repair: no second phase, no fallback (#1676)", () => {
  beforeEach(() => {
    vi.stubEnv("DISPATCH_REBASE_MODEL_AGENTS", MODEL_POOL);
  });

  it("the replayed refusal sees the moved generation and settles inert through both entry points", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    const first = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(first.action).toBe("model_repair");
    const afterModelRepair = JSON.parse(JSON.stringify({ ...client.items[0], handoutAckTimes: undefined }));

    // Same agent / generation / token, receipts now cleared: the generation
    // gate fires first (the model phase bumped it atomically with the receipt
    // release), so the duplicate is inert with ZERO mutation.
    const duplicate = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(duplicate.action).toBe("skipped");
    expect(duplicate.reason).toContain("not QUEUED and dispatched at the reported generation");
    expect(JSON.stringify(client.history.filter((h: any) => h.action === "rebase_model_repair"))).not.toBe("[]");
    expect(client.history.filter((h: any) => h.action === "rebase_transfer")).toHaveLength(0);

    // Through the report resolver: the replayed attempt token is a stale
    // generation — inert, no second phase, no fix-pr fallback.
    const replay = await resolvePrFixFromAgentReport(reportInput(client) as any);
    expect(replay.action).toBe("skipped");
    expect(replay.reason).toContain("stale attempt generation");

    const row = client.items[0];
    expect(row.generation).toBe(GENERATION + 1); // no second bump
    expect(row.stagnationCount).toBe(1); // no second budget burn
    expect(row.type).toBe("REBASE"); // no fallback minted
    expect(row.rebaseEpisodeTransferred).toBe(false);
    expect(row.semanticConflict).toEqual(EXPECTED_CONTEXT); // untouched
    expect(JSON.parse(JSON.stringify({ ...row, handoutAckTimes: undefined }))).toEqual(afterModelRepair);
  });

  it("a context-carrying episode with no live receipt declines: nothing is minted without the exact receipt", async () => {
    const client = makeClient();
    const episodeId = rebaseEpisodeIdentity(REPO, PR, BRANCH, HEAD);
    // The receipt is gone (settled/released) while the generation still
    // matches: the exact-receipt fence authorizes NEITHER a second phase nor
    // the fallback.
    seedRebaseRow(client, {
      semanticConflict: { base: "main", files: ["src/lib/a.ts"], reason: "persisted" },
      rebaseEpisodeId: episodeId,
      agentHandouts: [],
      handoutAcks: [],
      handoutAckTimes: [],
      handoutReceipts: [],
    });
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("declined");
    expect(result.reason).toContain("no live hand-out receipt");
    const row = client.items[0];
    expect(row.type).toBe("REBASE");
    expect(row.generation).toBe(GENERATION);
    expect(row.rebaseEpisodeTransferred).toBe(false);
    expect(client.history).toHaveLength(0);
  });
});

// ─── 7. Budget exhaustion during the model phase ─────────────────────────────

describe("stagnation budget during the model phase (#1676)", () => {
  beforeEach(() => {
    vi.stubEnv("DISPATCH_REBASE_MODEL_AGENTS", MODEL_POOL);
  });

  it("an exhausted budget parks instead of entering the model phase; no context is written", async () => {
    const client = makeClient();
    seedRebaseRow(client, { stagnationCount: maxPrFixStagnation() - 1 });
    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("parked");
    const row = client.items[0];
    expect(row.status).toBe("PARKED");
    expect(row.outcome).toBe("no_progress");
    expect(row.stagnationCount).toBe(maxPrFixStagnation());
    // No model phase: no context, no episode id, no fresh attempt.
    expect(row.semanticConflict == null).toBe(true);
    expect(row.rebaseEpisodeId).toBeNull();
    expect(row.rebaseEpisodeTransferred).toBe(false);
    expect(row.generation).toBe(GENERATION);
    expect(row.type).toBe("REBASE");
    const parks = client.history.filter((h: any) => h.action === "rebase_transfer" && h.status === "PARKED");
    expect(parks).toHaveLength(1);
    expect(client.history.filter((h: any) => h.action === "rebase_model_repair")).toHaveLength(0);
  });
});

// ─── 8. A refusal with no usable context cannot enter the model phase ────────

describe("refusal reporting no usable context (#1676)", () => {
  beforeEach(() => {
    vi.stubEnv("DISPATCH_REBASE_MODEL_AGENTS", MODEL_POOL);
  });

  it("empty evidence yields the ordinary fallback; the row is never made MODEL-REQUIRED with no context", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    const emptyRefusal = parsedRefusal({ conflictingFiles: [], explanation: null, baseRef: null });
    const result = await transferRebaseEpisodeToFix(
      client,
      transferInput(client, { refusal: emptyRefusal }),
    );
    expect(result.action).toBe("transferred");
    const row = client.items[0];
    expect(row.type).toBe("OTHER");
    expect(row.semanticConflict == null).toBe(true);
    expect(row.rebaseEpisodeTransferred).toBe(true);
    const transfer = client.history.find((h: any) => h.action === "rebase_transfer");
    expect(transfer.note).toContain("none reported");
  });
});

// ─── 9. rebaseModelWorkerPoolDeclared unit cases ─────────────────────────────

describe("rebaseModelWorkerPoolDeclared (#1676)", () => {
  it("unset, empty, and whitespace-only values declare no model worker", () => {
    expect(rebaseModelWorkerPoolDeclared(undefined)).toBe(false);
    expect(rebaseModelWorkerPoolDeclared("")).toBe(false);
    expect(rebaseModelWorkerPoolDeclared("   ")).toBe(false);
  });

  it("a named pool (any case/separator) declares a model worker", () => {
    expect(rebaseModelWorkerPoolDeclared("courier-rebase")).toBe(true);
    expect(rebaseModelWorkerPoolDeclared("A, b")).toBe(true);
  });

  it("the bare * wildcard is the explicit unrestricted opt-in", () => {
    expect(rebaseModelWorkerPoolDeclared("*")).toBe(true);
  });

  it("reads DISPATCH_REBASE_MODEL_AGENTS from the environment by default", () => {
    expect(rebaseModelWorkerPoolDeclared()).toBe(false); // beforeEach stubbed ""
    vi.stubEnv("DISPATCH_REBASE_MODEL_AGENTS", "  courier-model  ");
    expect(rebaseModelWorkerPoolDeclared()).toBe(true);
  });
});

// ─── 10. Through resolvePrFixFromAgentReport ─────────────────────────────────

describe("resolvePrFixFromAgentReport: model_repair settles the report as requeued (#1676)", () => {
  beforeEach(() => {
    vi.stubEnv("DISPATCH_REBASE_MODEL_AGENTS", MODEL_POOL);
  });

  it("a blocked + human_decision + nonmechanical_conflict report re-queues the MODEL-REQUIRED row", async () => {
    const client = makeClient();
    seedRebaseRow(client);
    const result = await resolvePrFixFromAgentReport(reportInput(client) as any);
    expect(result.matched).toBe(true);
    // NOT "blocked": the mechanical attempt is settled and the episode is
    // re-queued as model-required work; the vocabulary stays what old clients
    // already handle.
    expect(result.action).toBe("requeued");
    expect(result.reason).toContain("model-assisted repair");

    const row = client.items[0];
    expect(row.status).toBe("QUEUED");
    expect(row.type).toBe("REBASE");
    expect(row.generation).toBe(GENERATION + 1);
    expect(row.semanticConflict).toEqual(EXPECTED_CONTEXT);
    expect(row.rebaseEpisodeId).toBe(rebaseEpisodeIdentity(REPO, PR, BRANCH, HEAD));
    expect(row.rebaseEpisodeTransferred).toBe(false);
    // Not a BLOCKED settlement: no needs-human surfacing, no parked surfacing.
    expect(surfacingMocks.surfacePrFixBlocked).not.toHaveBeenCalled();
    expect(surfacingMocks.surfacePrFixParked).not.toHaveBeenCalled();
    expect(client.history.filter((h: any) => h.action === "rebase_model_repair")).toHaveLength(1);
  });
});

// ─── Review regressions: the model-phase flag/head write and the UNKNOWN parent ─

const OLD_HEAD = "a".repeat(40);
const NEW_HEAD = "f".repeat(40);

describe("model_repair clears the stale transferred flag and re-anchors headSha (#1676)", () => {
  beforeEach(() => {
    vi.stubEnv("DISPATCH_REBASE_MODEL_AGENTS", MODEL_POOL);
  });

  it("A1: a NEW head after an earlier transfer re-decides into the model phase and clears the old episode's flag", async () => {
    const client = makeClient();
    // Episode 1 transferred long ago (fix attempt spent); a NEW push started a
    // NEW episode: the row carries the new head while the episode columns
    // still name the OLD head's transfer.
    seedRebaseRow(client, {
      headSha: NEW_HEAD,
      attemptHeadSha: NEW_HEAD,
      rebaseEpisodeId: rebaseEpisodeIdentity(REPO, PR, BRANCH, OLD_HEAD),
      rebaseEpisodeTransferred: true,
      rebaseEpisodeTransferredAt: new Date(Date.UTC(2026, 10, 19, 0, 0, 0)),
      rebaseEpisodeGeneration: GENERATION - 1,
    });
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue(NEW_HEAD);

    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    // The dedup gate keys on the CURRENT episode id, so the stale flag from
    // the superseded transfer must not swallow the new episode.
    expect(result.action).toBe("model_repair");

    const row = client.items[0];
    // The blocker fix: the write clears the flag and its timestamp — the
    // CURRENT episode awaits the model phase, it is NOT transferred.
    expect(row.rebaseEpisodeTransferred).toBe(false);
    expect(row.rebaseEpisodeTransferredAt).toBeNull();
    // headSha rides the verified remote head: the persisted episode id and the
    // row's freshest head knowledge cannot drift (the dispatch-side context
    // scoping keys on it).
    expect(row.headSha).toBe(NEW_HEAD);
    expect(row.rebaseEpisodeId).toBe(rebaseEpisodeIdentity(REPO, PR, BRANCH, NEW_HEAD));
    expect(row.type).toBe("REBASE");
    expect(row.status).toBe("QUEUED");
    expect(row.generation).toBe(GENERATION + 1);
    expect(row.semanticConflict).toEqual(EXPECTED_CONTEXT);
  });

  it("A2: the MODEL worker's refusal of the same episode transfers (the flag clear unblocks the fallback)", async () => {
    const client = makeClient();
    seedRebaseRow(client, {
      headSha: NEW_HEAD,
      attemptHeadSha: NEW_HEAD,
      rebaseEpisodeId: rebaseEpisodeIdentity(REPO, PR, BRANCH, OLD_HEAD),
      rebaseEpisodeTransferred: true,
      rebaseEpisodeTransferredAt: new Date(Date.UTC(2026, 10, 19, 0, 0, 0)),
      rebaseEpisodeGeneration: GENERATION - 1,
    });
    githubPrsMocks.fetchPullRequestHeadSha.mockResolvedValue(NEW_HEAD);
    expect((await transferRebaseEpisodeToFix(client, transferInput(client))).action).toBe("model_repair");

    // The model-authorized hand-out the persisted context now allows: fresh
    // receipt at the new generation, the model worker the only live writer.
    const MODEL_AGENT = "model-smurf";
    const MODEL_TOKEN = "hnd_a11ce00d12345678"; // Dispatch receipt shape: hnd_[0-9a-f]{8,}
    const row = client.items[0];
    row.attemptType = "REBASE";
    row.dispatchedGeneration = GENERATION + 1;
    row.dispatchedAt = new Date(Date.UTC(2026, 10, 21, 9, 0, 0));
    row.agentHandouts = [`${MODEL_AGENT}@${GENERATION + 1}`];
    row.handoutAcks = [`${MODEL_AGENT}@${GENERATION + 1}`];
    row.handoutAckTimes = [new Date(Date.UTC(2026, 10, 21, 9, 0, 5)).toISOString()];
    row.handoutReceipts = [`${MODEL_TOKEN}@${MODEL_AGENT}@${GENERATION + 1}`];

    const result = await transferRebaseEpisodeToFix(
      client,
      transferInput(client, { generation: GENERATION + 1, agentName: MODEL_AGENT, handoutToken: MODEL_TOKEN }),
    );
    // The pre-fix blocker: the uncleared `rebaseEpisodeTransferred` made the
    // dedup gate swallow this refusal (skipped), minting no fallback and
    // stranding the model worker's live receipt on the QUEUED row — wedging
    // the concurrency-1 rebase lane.
    expect(result.action).not.toBe("skipped");
    expect(result.action).toBe("transferred");

    const after = client.items[0];
    expect(after.type).toBe("OTHER");
    expect(after.status).toBe("QUEUED");
    expect(after.rebaseEpisodeTransferred).toBe(true);
    // The model worker's receipt is settled with the fallback, not stranded.
    expect(after.handoutReceipts).toEqual([]);
    expect(after.agentHandouts).toEqual([]);
    // The first feedback line attributes the episode to the model attempt.
    expect(after.feedback[0]).toContain("The authorized model-assisted rebase attempt refused this conflict episode");
    expect(after.feedback[0]).toContain(rebaseEpisodeIdentity(REPO, PR, BRANCH, NEW_HEAD));
    const transfer = client.history.find((h: any) => h.action === "rebase_transfer");
    expect(transfer.note).toContain("The authorized model-assisted rebase attempt also refused this episode");
  });
});

describe("UNKNOWN parent classification routes to the fallback (#1676)", () => {
  beforeEach(() => {
    vi.stubEnv("DISPATCH_REBASE_MODEL_AGENTS", MODEL_POOL);
  });

  it("an unverifiable parent never authorizes the model phase; the row keeps its stored lane", async () => {
    const client = makeClient();
    // Distinct from the ESCALATED cases above: there the read ANSWERS
    // frontier; here it THROWS, and UNKNOWN fails closed the same way —
    // neither is an affirmative NOT_ESCALATED, so no model phase.
    seedRebaseRow(client, { issue: 77 });
    const findFirst = vi.fn(async () => {
      throw new Error("database unreachable");
    });
    (client.issue as any).findFirst = findFirst;

    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("transferred");
    expect(findFirst).toHaveBeenCalled();

    const row = client.items[0];
    expect(row.type).toBe("OTHER");
    expect(row.semanticConflict == null).toBe(true);
    // UNKNOWN never demotes a stored lane and never raises an unverified one:
    // the row keeps the lane it had.
    expect(row.lane).toBe("NORMAL");
    const transfer = client.history.find((h: any) => h.action === "rebase_transfer");
    expect(transfer.note).toContain("goes directly to the ordinary fix-pr fallback");
  });
});

describe("a superseded-head context is not a pending model phase (#1676)", () => {
  beforeEach(() => {
    vi.stubEnv("DISPATCH_REBASE_MODEL_AGENTS", MODEL_POOL);
  });

  it("re-decides into the model phase and the fresh write makes the context scoped-current again", async () => {
    const client = makeClient();
    // A push moved the head after the previous episode persisted its context:
    // the row still carries the context, but its episode id keys an OLDER
    // head, so the scoping reads the context as none — the refusal is a FIRST
    // accepted refusal of the CURRENT episode, not proof a model attempt ran.
    seedRebaseRow(client, {
      semanticConflict: { base: "main", files: ["stale/old.ts"], reason: "context from a superseded episode" },
      rebaseEpisodeId: rebaseEpisodeIdentity(REPO, PR, BRANCH, OLD_HEAD),
      rebaseEpisodeGeneration: GENERATION - 1,
    });

    const result = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(result.action).toBe("model_repair");

    const row = client.items[0];
    // The write re-anchors headSha + episode id together, so the persisted
    // context is scoped-current for the dispatch-side gates afterwards.
    expect(scopedRebaseSemanticConflict(row)).not.toBeNull();
    expect(scopedRebaseSemanticConflict(row)).toEqual(EXPECTED_CONTEXT);
    expect(row.rebaseEpisodeId).toBe(rebaseEpisodeIdentity(REPO, PR, BRANCH, HEAD));
    expect(row.type).toBe("REBASE");
    expect(client.history.filter((h: any) => h.action === "rebase_model_repair")).toHaveLength(1);
  });
});

// ─── 9. An absent parent row declines the model phase (#1676 strict read) ────

describe("an absent linked issue declines the model phase (#1676)", () => {
  beforeEach(() => {
    vi.stubEnv("DISPATCH_REBASE_MODEL_AGENTS", MODEL_POOL);
  });

  it("a pruned parent row is UNKNOWN to the strict read, so the fallback runs and no marker is committed", async () => {
    const client = makeClient();
    // The LENIENT #1503 read treats a missing Issue row as a definitive
    // NOT_ESCALATED, which would commit a durable MODEL-REQUIRED marker the
    // locked issuance read (absence = UNKNOWN) could never release: model polls
    // would defer on the locked UNKNOWN while deterministic polls deferred on
    // the marker. The strict read declines instead.
    seedRebaseRow(client, { issue: 77 });
    (client.issue as any).findFirst = vi.fn(async () => null);

    const result = await transferRebaseEpisodeToFix(client, transferInput(client));

    expect(result.action).toBe("transferred");
    const row = client.items[0];
    expect(row.type).toBe("OTHER");
    expect(row.semanticConflict == null).toBe(true);
    expect(row.rebaseEpisodeTransferred).toBe(true);
    expect(client.history.filter((h: any) => h.action === "rebase_model_repair")).toHaveLength(0);
  });
});

// ─── 10. #1615 claimant through BOTH phases ─────────────────────────────────

describe("#1615 claimant survives the model phase and transitions on the fallback (#1676)", () => {
  const REBASE_EXECUTOR = "courier-rebase";
  const FIXER = "fixbot";
  const MODEL_TOKEN = "hnd_b22ce00d12345678";

  beforeEach(() => {
    vi.stubEnv("DISPATCH_REBASE_MODEL_AGENTS", MODEL_POOL);
    vi.stubEnv("DISPATCH_REBASE_AGENTS", REBASE_EXECUTOR);
    vi.stubEnv("DISPATCH_PR_FIX_AGENTS", FIXER);
  });

  it("the model phase keeps the rebase-executor claimant; the fallback re-resolves it", async () => {
    const client = makeClient();
    seedRebaseRow(client, { issue: 99, claimant: REBASE_EXECUTOR, claimantSource: "agent-label" });
    (client.issue as any).findFirst = vi.fn(async () => ({ id: "iss-99", labels: [`agent/${FIXER}`] }));

    // Phase 1: the row STAYS REBASE, so a rebase-executor claimant is legal
    // (#1615 excludes that pool from NON-REBASE claimant evidence only) and the
    // transfer's ownership transition must not run.
    const first = await transferRebaseEpisodeToFix(client, transferInput(client));
    expect(first.action).toBe("model_repair");
    const row = client.items[0];
    expect(row.type).toBe("REBASE");
    expect(row.claimant).toBe(REBASE_EXECUTOR);
    expect(row.claimantSource).toBe("agent-label");
    expect(client.history.find((h: any) => h.action === "rebase_model_repair").note).not.toContain("Claimant transition");

    // Phase 2: the model worker's refusal makes the row an ORDINARY fix attempt,
    // so the same #1615 transition the pre-#1676 transfer applies must run — the
    // model phase may not leave the unroutable claimant behind.
    row.attemptType = "REBASE";
    row.dispatchedGeneration = GENERATION + 1;
    row.dispatchedAt = new Date(Date.UTC(2026, 10, 21, 9, 0, 0));
    row.agentHandouts = [`${MODEL_POOL}@${GENERATION + 1}`];
    row.handoutAcks = [`${MODEL_POOL}@${GENERATION + 1}`];
    row.handoutAckTimes = [new Date(Date.UTC(2026, 10, 21, 9, 0, 5)).toISOString()];
    row.handoutReceipts = [`${MODEL_TOKEN}@${MODEL_POOL}@${GENERATION + 1}`];

    const second = await transferRebaseEpisodeToFix(
      client,
      transferInput(client, { generation: GENERATION + 1, agentName: MODEL_POOL, handoutToken: MODEL_TOKEN }),
    );
    expect(second.action).toBe("transferred");
    const after = client.items[0];
    expect(after.type).toBe("OTHER");
    expect(after.claimant).toBe(FIXER);
    expect(after.claimantSource).toBe("agent-label");
    const transfer = client.history.find((h: any) => h.action === "rebase_transfer");
    expect(transfer.note).toContain(`${REBASE_EXECUTOR} (provenance "agent-label") -> ${FIXER}`);
    // The transferred generation is hand-out eligible; the untouched pair is not.
    expect(
      evaluatePrFixHandoutOwnership({
        repo: after.repo,
        pr: after.pr,
        generation: after.generation,
        claimant: after.claimant,
        claimantSource: after.claimantSource,
        fixType: after.attemptType ?? after.type,
      }).decision,
    ).toBe("eligible");
  });
});
