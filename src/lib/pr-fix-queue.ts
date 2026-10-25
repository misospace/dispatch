import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { normalizePrFixLane, normalizePrFixStatus, normalizePrFixType, normalizePrFixOutcome, PrFixLane, PrFixOutcome, PrFixStatus, PrFixType, PrFixDecisionContext, PR_FIX_TYPE_PRIORITY } from "@/types";
import { surfacePrFixBlocked, surfacePrFixParked, surfacePrFixRequeued, surfacePrFixUnblocked, extractUrlsFromText, type PrFixUnblockOutcome } from "./pr-fix-surfacing";
import { prisma } from "@/lib/prisma";
import { fetchPullRequestMergeState, fetchPullRequestHeadSha, fetchPullRequestState } from "./github-prs";
import { capacityCooldownMs, capacityEquals } from "./capacity-handoff";
import { fetchRepositoryMetadata } from "./github-code-search";
import { sanitizeForStorage } from "./groomer/sanitize";
import {
  isPrFixEvidenceKind,
  ledgerRowsToPostDispatchEntries,
  normalizeEvidenceContentSignature,
  type PrFixEvidenceKind,
} from "./pr-fix-evidence";
import { parseExternalWaitInput, parseStoredExternalWait, evaluateExternalWaitTrigger, type ExternalWaitContract } from "./pr-fix-external-wait";
import { evaluateRecovery, recoveryCooldownMs, type RecoveryDecision } from "./pr-fix-recovery";

export type PrFixQueueClient = {
  issue: {
    findFirst: (args: any) => Promise<any>;
  };
  prFixQueueItem: {
    findUnique: (args: any) => Promise<any>;
    findMany: (args?: any) => Promise<any[]>;
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  prFixHistory: {
    create: (args: any) => Promise<any>;
    findMany?: (args: any) => Promise<any[]>;
  };
  // #1256: capacity-scoped cooldown rows. Optional so legacy/test clients
  // without the table still settle other outcomes; capacity-exhausted
  // settlement records the cooldown whenever the surface exists.
  capacityHandoff?: {
    create: (args: any) => Promise<any>;
    findMany?: (args: any) => Promise<any[]>;
  };
  // #1249: durable per-item evidence ledger. Optional so legacy/test clients
  // without the table keep settling: with no surface the enqueue falls back to
  // the bounded `evidenceKeys` cache (identity-only, pre-#1249 semantics) and
  // settlement consults only the cached post-dispatch list.
  prFixEvidence?: {
    findFirst: (args: any) => Promise<any>;
    findMany: (args: any) => Promise<any[]>;
    upsert: (args: any) => Promise<any>;
  };
  $transaction: <T>(fn: (tx: PrFixQueueClient) => Promise<T>) => Promise<T>;
  // Raw SQL surface used by the #1327 rebase-lane advisory lock. Optional on
  // the type (legacy/test clients may omit it) but MANDATORY for a rebase
  // admission: `withRebaseLaneAdmission` REFUSES to admit without it, because
  // an admission that cannot take the advisory lock would run the gate read
  // and the hand-out write unlocked — the check-then-write fan-out the lane
  // forbids. Every real Prisma transaction client has it.
  $executeRaw?: (query: Prisma.Sql, ...values: unknown[]) => Promise<number>;
};

/**
 * #1327 review: advisory transaction-lock key serializing REBASE lane
 * admission. One global key — the lane is concurrency 1 across ALL rows and
 * ALL agents, so every REBASE hand-out contends on exactly this lock.
 */
export const REBASE_LANE_ADVISORY_LOCK_KEY = 13270001327n;

/**
 * #1327: the rebase lane's worker pool is LOCAL-only by contract — git is its
 * tool surface and it must not consume paid cloud capacity. Dispatch has no
 * model/runner knowledge of agents, so the pool is operator-declared via
 * `DISPATCH_REBASE_AGENTS`: only the listed agent names (comma or whitespace
 * separated, case-insensitive) receive REBASE hand-outs; any other agent's
 * poll defers the REBASE candidate for an eligible poller (the item stays
 * QUEUED, the poll keeps serving other work).
 *
 * FAIL CLOSED: an unset, empty, or whitespace-only value admits NOBODY. #1327
 * exists to keep rebases on free local capacity, so a missing allowlist must
 * not hand the lane to every polling agent — the lane stays QUEUED until the
 * operator names workers. A bare `*` value is the explicit unrestricted
 * opt-in (debugging/backcompat): every polling agent is eligible. A `*`
 * mixed into a list is just an agent name that matches nothing — the opt-in
 * must be the entire value to count.
 */
export function parseRebaseAgentPool(raw: string | undefined): Set<string> | null {
  if (raw?.trim() === "*") return null;
  const names = (raw ?? "")
    .split(/[\s,]+/)
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return new Set(names);
}

/** Whether `agentName` may receive a REBASE lane hand-out (see `parseRebaseAgentPool`). */
export function isRebaseLaneAgent(agentName: string): boolean {
  const pool = parseRebaseAgentPool(process.env.DISPATCH_REBASE_AGENTS);
  return pool === null || pool.has(agentName.trim().toLowerCase());
}

/**
 * Run a REBASE hand-out admission (gate read + dispatch stamp + hand-out
 * push) SERIALIZED at the database boundary (#1327 review).
 *
 * The concurrency-1 gate is only sound if the liveness read and the
 * hand-out write commit together — a preflight read followed by separate
 * writes lets two concurrent polls both observe an idle lane and both
 * dispatch (the exact fan-out the lane forbids). This helper runs `run`
 * inside one transaction holding `pg_advisory_xact_lock`: a competing
 * admission blocks on the lock and, when it proceeds, the gate read inside
 * its transaction sees the first admission's COMMITTED hand-out and defers.
 * The lock is transaction-scoped, so commit, rollback, or a dead connection
 * all release it — it can never strand the lane the way a leaked row lock
 * would.
 *
 * FAIL CLOSED (#1327 review): the advisory lock is MANDATORY, not best
 * effort. If the lock cannot be taken — no raw SQL surface, a `lock_timeout`
 * on the wait, an aborted transaction — this helper throws and the caller
 * MUST defer the hand-out (the next poll retries it). There is deliberately
 * no unlocked fallback: an admission that ran the gate read and the
 * hand-out write outside the lock is the check-then-write the lane
 * forbids, and the review finding was exactly that fallback re-opening
 * the fan-out window. Deferring costs one poll; fanning out costs two
 * `--force-with-lease` pushes on one branch.
 *
 * `SET LOCAL lock_timeout` bounds the WAIT so even a pathologically long
 * lock holder cannot stall a poll beyond the timeout: the wait ends on the
 * PG side, the transaction aborts, and the caller fails closed.
 */
export async function withRebaseLaneAdmission<T>(
  client: PrFixQueueClient,
  run: (tx: PrFixQueueClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    if (typeof tx.$executeRaw !== "function") {
      // Fail closed: without the raw surface the advisory lock cannot be
      // taken, so the gate read and the hand-out write would run
      // UNSERIALIZED — the fan-out the lane forbids. Refuse the admission
      // instead of admitting an unlocked hand-out.
      throw new Error(
        "rebase lane admission requires a raw SQL surface to take the advisory lock",
      );
    }
    // `SET` accepts no bind parameters, so the interval is a literal.
    // 3s is deliberately BELOW Prisma's interactive-transaction timeout
    // (default 5s): the lock wait must end on the PG side — statement
    // cancelled, transaction aborted, caller fails closed — before Prisma
    // gives up on a connection still blocked inside the lock function,
    // where its rollback cannot land and the abandoned transaction would
    // transiently re-acquire and hold the lock the failing admission just
    // gave up on.
    await tx.$executeRaw(Prisma.raw("SET LOCAL lock_timeout = '3s'"));
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${REBASE_LANE_ADVISORY_LOCK_KEY})`);
    return run(tx);
  });
}

// #1121: upper bound on an already_addressed evidence string, shared by the
// tasks/report route and the pr-fix-queue/mark parser.
export const MAX_EVIDENCE_LENGTH = 2000;

function alreadyAddressedHistoryNote(input: MarkPrFixInput): string {
  const evidence = input.evidence?.trim();
  return [
    input.note ?? null,
    evidence ? `Evidence: ${evidence}` : null,
    evidence
      ? "Settled as already_addressed: the PR head may be unchanged; the evidence is recorded for the next review (#1121)."
      : "Settled as already_addressed: the PR head may be unchanged; no new push was expected (#1121).",
  ]
    .filter(Boolean)
    .join(" ");
}

export interface EnqueuePrFixInput {
  repo: string;
  pr: number;
  lane?: string | null;
  type?: string | null;
  reason: string;
  feedback: string;
  evidenceKey: string;
  issue?: number | null;
  branch?: string | null;
  /** Item identity — should be the PR URL. Set at first enqueue, only backfilled while empty (#1098). */
  url?: string | null;
  title?: string | null;
  headSha?: string | null;
  author?: string | null;
  /**
   * Structured outcome (#1218). Only meaningful when the enqueue resolves to a
   * PARKED state (e.g. an explicit infra/security failure); a BLOCKED result
   * always records `human_decision`. Defaults to `no_progress` for PARKED.
   */
  outcome?: string | null;
  /** Human-decision payload persisted on a BLOCKED result (#1218). */
  decision?: PrFixDecisionContext | null;
  /**
   * Durable evidence-snapshot fields (#1249). When `evidenceKey` carries these,
   * the enqueue records a versioned transition in the item's durable evidence
   * ledger (one row per identity), and the ledger — not the bounded 40-entry
   * `evidenceKeys` cache — decides whether the observation is known evidence.
   * All optional: legacy callers keep the pre-#1249 identity-only behavior.
   * Build these with the pure helpers in `pr-fix-evidence.ts`.
   */
  /** One of `PrFixEvidenceKind` ("review", "check_run", ...). Unknown kinds
   * are recorded for audit and never treated as fresh work. */
  evidenceKind?: string | null;
  /** Canonical version of the identity's state-bearing fields
   * (`computeEvidenceVersion`). A change is a ledger transition. */
  evidenceVersion?: string | null;
  /** Bounded anti-repetition signature (`computeEvidenceContentSignature`).
   * A new identity whose signature already exists in the ledger at the same
   * commit is recorded but not treated as new evidence. */
  evidenceContentSignature?: string | null;
  /** Forge-side event timestamp (review submitted_at, comment updated_at,
   * check completed_at). Audit provenance ONLY — never a freshness boundary. */
  evidenceObservedAt?: Date | string | null;
  /** Whether the observation's CURRENT version is actionable by kind
   * (`isActionableEvidenceVersion`). Unknown provenance defers, never
   * silently resolves. */
  evidenceActionable?: boolean | null;
  /** Head the observation was taken against (ledger row's head; entries
   * re-encoded for settlement use it). */
  evidenceHeadSha?: string | null;
  /** Ingestion source label recorded on the ledger row for audit
   * ("webhook" | "sync" | ...). */
  evidenceSource?: string | null;
}

export interface CreateLinkedPrFixInput {
  repo: string;
  pr: number;
  issue: number;
  lane: PrFixLane;
  reason: string;
  feedback: string[];
  /**
   * Queue type for the materialized row (#1327). Absent/null writes the
   * ordinary fix lane (OTHER); "REBASE" routes a conflicted PR into the
   * mechanical rebase lane, whose contract the caller supplies in `feedback`.
   */
  type?: string | null;
  evidenceKey: string;
  url?: string | null;
  title?: string | null;
  /**
   * Head observed when the linked follow-up was discovered (#1074). Stored as
   * both the mutable `headSha` and the immutable per-attempt `attemptHeadSha`
   * so the #940 no-progress guard can refuse a FIXED tombstone for a worker
   * that pushed nothing. Null when GitHub could not be read.
   */
  headSha?: string | null;
}

export interface MarkPrFixInput {
  repo: string;
  pr: number;
  status: string;
  note?: string | null;
  // #1250: structured external-wait contract, REQUIRED for a new
  // WAITING_EXTERNAL mark. Absent or malformed → fail-closed PARKED
  // (outcome `invalid_wait`), generation-pinned.
  externalWait?: unknown;
  // Commit-time revalidation (#1074): when provided, every status write goes
  // through `updateMany({ where: { id, generation } })` and the mark is
  // skipped (no mutation) if the row's generation no longer matches — i.e.
  // the attempt was re-issued (new evidence, requeue) between read and write.
  expectedGeneration?: number | null;
  // Fresh per-attempt head baseline carried into the row when this mark bumps
  // the item back to QUEUED as a new attempt (#1074).
  attemptHeadSha?: string | null;
  // #1121: an explicit "already addressed" settlement. When true (and status is
  // FIXED), the #940 no-progress head-moved guard is bypassed and `evidence` is
  // recorded in the settlement history: the worker asserts the feedback was
  // already handled, so no new push is expected. New evidence still reopens the
  // item; a repeated disagreement reopens via #940 and counts toward fixAttempts.
  alreadyAddressed?: boolean;
  evidence?: string | null;
  /**
   * Structured outcome (#1218) for a BLOCKED/PARKED mark. BLOCKED defaults to
   * `human_decision`; PARKED defaults to `no_progress`. Ignored for other
   * statuses.
   */
  outcome?: string | null;
  /** Human-decision payload persisted when the mark resolves to BLOCKED (#1218). */
  decision?: PrFixDecisionContext | null;
  /**
   * Caller's auth tier (#1218 review): used to gate the BLOCKED/PARKED status
   * pin at commit time. A worker-tier mark to BLOCKED/PARKED on an already
   * recorded BLOCKED/PARKED/FIXED row must no-op (return `generation-mismatch`)
   * so a same-generation second mark cannot erase a genuine human decision —
   * with one exception (#1340): a worker-tier BLOCKED mark may escalate a
   * same-generation PARKED row to BLOCKED (bounded exhaustion that turned out
   * to need a human decision); a recorded BLOCKED stays sticky against every
   * other worker mark, and de-escalation (BLOCKED → PARKED/QUEUED) remains
   * operator-only via `allowStickyReclassify`.
   * Defaults to `"worker"` (fail-closed): callers that don't explicitly assert
   * a maintainer tier cannot bypass the pin. The route handler is the only
   * trusted source of this value — `parseMarkPrFixInput` does not accept it
   * from a request body, so a worker cannot forge a maintainer tier.
   */
  actorTier?: "worker" | "maintainer";
  /**
   * Explicit reclassification opt-in (#1218 review). When `true` AND
   * `actorTier === "maintainer"`, the BLOCKED/PARKED status pin is relaxed
   * for a single mark so an operator can correct a recorded classification
   * (BLOCKED → PARKED for an outdated decision, or vice versa). Honored only
   * for non-worker callers; a worker request that sets this is silently
   * ignored (fail-closed). Intended for explicit operator reclassification —
   * it is NEVER the path used by routine worker settlement, which always
   * settles QUEUED → BLOCKED/PARKED.
   */
  allowStickyReclassify?: boolean;
}

export interface RequeuePrFixInput {
  repo: string;
  pr: number;
  note?: string | null;
  isPrMergedOrClosed?: boolean;
  isRepoArchived?: boolean;
}

export function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The structured outcome a status implies (#1218). BLOCKED is reserved for a
 * genuine human decision; PARKED carries the explicit outcome or `no_progress`.
 * Any other status has no outcome.
 */
export function resolvePrFixOutcome(status: PrFixStatus, explicit?: string | null): PrFixOutcome | null {
  if (status === "BLOCKED") return "human_decision";
  if (status === "PARKED") return normalizePrFixOutcome(explicit) ?? "no_progress";
  return null;
}

/**
 * Validate and normalize a `decision` payload (#1218). Returns the cleaned
 * context, `null` when absent, or an error string when malformed.
 */
function parseDecisionContext(value: unknown): { decision: PrFixDecisionContext | null; error?: string } {
  if (value === undefined || value === null) return { decision: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { decision: null, error: "decision must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const decision: PrFixDecisionContext = {};
  if (raw.question !== undefined && raw.question !== null) {
    if (typeof raw.question !== "string") return { decision: null, error: "decision.question must be a string" };
    if (raw.question.trim()) decision.question = raw.question.trim();
  }
  if (raw.options !== undefined && raw.options !== null) {
    if (!Array.isArray(raw.options) || raw.options.some((o) => typeof o !== "string")) {
      return { decision: null, error: "decision.options must be an array of strings" };
    }
    const options = raw.options.map((o) => (o as string).trim()).filter(Boolean);
    if (options.length > 0) decision.options = options;
  }
  if (raw.evidence !== undefined && raw.evidence !== null) {
    if (typeof raw.evidence !== "string") return { decision: null, error: "decision.evidence must be a string" };
    if (raw.evidence.trim()) decision.evidence = raw.evidence.trim();
  }
  return { decision };
}

/**
 * Canonical queue identity for a repository (#1145).
 *
 * GitHub treats `owner/repo` case-insensitively, but the `(repo, pr)` unique
 * key does not. A row written as `Org/Repo` and a lookup for `org/repo` are
 * different records, so two rows could own the same PR — one of them `BLOCKED`
 * — and the second would shadow the human verdict. Every queue write and every
 * identity lookup folds the repo through this so the key is stable regardless
 * of the casing the caller derived it from (GitHub payload, issue cache, or a
 * hand-written API call).
 */
export function normalizeQueueRepo(repo: string): string {
  return repo.trim().toLowerCase();
}

export function parseEnqueuePrFixInput(body: unknown): EnqueuePrFixInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.repo)) return { error: "Missing required field: repo" };
  if (input.pr === undefined || input.pr === null || !Number.isInteger(Number(input.pr))) return { error: "Missing required field: pr" };
  if (!nonEmpty(input.reason)) return { error: "Missing required field: reason" };
  if (!nonEmpty(input.feedback)) return { error: "Missing required field: feedback" };
  if (!nonEmpty(input.evidenceKey)) return { error: "Missing required field: evidenceKey" };
  if (input.outcome !== undefined && input.outcome !== null) {
    if (typeof input.outcome !== "string" || !normalizePrFixOutcome(input.outcome)) {
      return { error: "Invalid outcome" };
    }
  }
  const decisionResult = parseDecisionContext(input.decision);
  if (decisionResult.error) return { error: decisionResult.error };

  return {
    repo: input.repo.trim(),
    pr: Number(input.pr),
    lane: typeof input.lane === "string" ? input.lane : undefined,
    type: typeof input.type === "string" ? input.type : undefined,
    reason: input.reason.trim(),
    feedback: input.feedback.trim(),
    evidenceKey: input.evidenceKey.trim(),
    issue: input.issue === undefined || input.issue === null ? null : Number(input.issue),
    branch: typeof input.branch === "string" ? input.branch : null,
    url: typeof input.url === "string" ? input.url : null,
    title: typeof input.title === "string" ? input.title : null,
    headSha: typeof input.headSha === "string" ? input.headSha : null,
    author: typeof input.author === "string" ? input.author : null,
    ...(typeof input.outcome === "string" ? { outcome: normalizePrFixOutcome(input.outcome) } : {}),
    ...(decisionResult.decision ? { decision: decisionResult.decision } : {}),
  };
}

export function parseMarkPrFixInput(body: unknown): MarkPrFixInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.repo)) return { error: "Missing required field: repo" };
  if (input.pr === undefined || input.pr === null || !Number.isInteger(Number(input.pr))) return { error: "Missing required field: pr" };
  if (!nonEmpty(input.status)) return { error: "Missing required field: status" };
  if (!normalizePrFixStatus(input.status)) return { error: "Invalid status" };
  if (input.generation !== undefined && input.generation !== null) {
    if (typeof input.generation !== "number" || !Number.isInteger(input.generation) || input.generation < 1) {
      return { error: "generation must be an integer >= 1" };
    }
  }
  if (input.attemptHeadSha !== undefined && input.attemptHeadSha !== null) {
    if (typeof input.attemptHeadSha !== "string" || !/^[0-9a-fA-F]{7,40}$/.test(input.attemptHeadSha.trim())) {
      return { error: "Invalid attemptHeadSha" };
    }
  }
  if (input.alreadyAddressed !== undefined && typeof input.alreadyAddressed !== "boolean") {
    return { error: "alreadyAddressed must be a boolean" };
  }
  const alreadyAddressed = input.alreadyAddressed === true;
  if (alreadyAddressed && normalizePrFixStatus(input.status) !== "FIXED") {
    return { error: "alreadyAddressed requires status FIXED" };
  }
  if (input.evidence !== undefined && input.evidence !== null && typeof input.evidence !== "string") {
    return { error: "evidence must be a string" };
  }
  const evidence = typeof input.evidence === "string" ? input.evidence.trim() : null;
  if (evidence && evidence.length > MAX_EVIDENCE_LENGTH) {
    return { error: `evidence must be at most ${MAX_EVIDENCE_LENGTH} characters` };
  }
  const status = normalizePrFixStatus(input.status) as PrFixStatus;
  if (input.outcome !== undefined && input.outcome !== null) {
    if (typeof input.outcome !== "string" || !normalizePrFixOutcome(input.outcome)) {
      return { error: "Invalid outcome" };
    }
  }
  const decisionResult = parseDecisionContext(input.decision);
  if (decisionResult.error) return { error: decisionResult.error };
  const explicitOutcome = typeof input.outcome === "string" ? normalizePrFixOutcome(input.outcome) : null;
  const outcome = resolvePrFixOutcome(status, explicitOutcome);
  return {
    repo: input.repo.trim(),
    pr: Number(input.pr),
    status,
    note: typeof input.note === "string" ? input.note : null,
    expectedGeneration:
      typeof input.generation === "number" && input.generation !== null ? input.generation : undefined,
    attemptHeadSha: typeof input.attemptHeadSha === "string" ? input.attemptHeadSha.trim() : null,
    ...(alreadyAddressed ? { alreadyAddressed: true } : {}),
    ...(evidence ? { evidence } : {}),
    ...(outcome ? { outcome } : {}),
    ...(decisionResult.decision ? { decision: decisionResult.decision } : {}),
    // #1250: validated again at mark time; parse here only to reject a
    // structurally impossible body early with a clear error.
    ...(input.externalWait !== undefined ? { externalWait: input.externalWait } : {}),
  };
}

function uniqueAppend(values: string[], value: string, maxItems: number): string[] {
  const next = values.includes(value) ? values : [...values, value];
  return next.slice(-maxItems);
}

// ─── Durable evidence ledger helpers (#1249) ────────────────────────────────

/**
 * Normalize a forge-side event timestamp for audit storage. Malformed values
 * store NULL rather than throwing: provenance is audit data and must never
 * block an enqueue.
 */
function parseEvidenceObservedAt(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** The item's ledger state relevant to ONE incoming observation. */
interface EvidenceLedgerView {
  /** Whether this enqueue carries durable evidence fields AND the client
   * exposes the ledger table. False keeps pre-#1249 cache semantics. */
  records: boolean;
  /** The CURRENTLY stored row for this identity, if any. */
  prior: { version: string; sequence: number } | null;
  /** Another identity already holds this observation's content signature. */
  repeatedSignature: boolean;
}

/**
 * The evidence block of ONE observation: the identity/provenance fields the
 * durable ledger records, and nothing about the work itself. `EnqueuePrFixInput`
 * carries these plus lane/type/reason/feedback, so it satisfies this shape;
 * a record-only observation that must never touch work (#1276) passes exactly
 * this and nothing more, which makes "records evidence, enqueues no work" a
 * property of the signature rather than of reviewer discipline.
 */
export type EvidenceObservation = Pick<
  EnqueuePrFixInput,
  | "evidenceKey"
  | "evidenceKind"
  | "evidenceVersion"
  | "evidenceContentSignature"
  | "evidenceObservedAt"
  | "evidenceHeadSha"
  | "evidenceSource"
  | "evidenceActionable"
>;

/**
 * Whether an enqueue carries a COMPLETE durable evidence block. A missing or
 * blank `evidenceVersion` fails closed to the pre-#1249 cache semantics:
 * without a version there is no way to tell a re-read from a transition, and
 * defaulting it to "" would mint a fresh ledger transition (and counter bump)
 * on every periodic re-observation of the same evidence.
 */
function carriesLedgerFields(input: EvidenceObservation): boolean {
  return (
    !!input.evidenceKey &&
    isPrFixEvidenceKind(input.evidenceKind) &&
    typeof input.evidenceVersion === "string" &&
    input.evidenceVersion.trim().length > 0
  );
}

async function readEvidenceLedgerView(
  tx: PrFixQueueClient,
  itemId: string,
  input: EvidenceObservation,
): Promise<EvidenceLedgerView> {
  if (!carriesLedgerFields(input) || !tx.prFixEvidence) {
    return { records: false, prior: null, repeatedSignature: false };
  }
  const prior = (await tx.prFixEvidence.findFirst({
    where: { itemId, identity: input.evidenceKey },
  })) as { version: string; sequence: number } | null;
  let repeatedSignature = false;
  const signature = normalizeEvidenceContentSignature(input.evidenceContentSignature);
  if (signature) {
    const matches = await tx.prFixEvidence.findMany({
      where: { itemId, contentSignature: signature },
    });
    repeatedSignature = (matches ?? []).some((row: any) => row.identity !== input.evidenceKey);
  }
  return { records: true, prior: prior ?? null, repeatedSignature };
}

/**
 * Upsert the ledger row for a NEW transition, claiming `sequence` (the value
 * the incrementing item write assigned from the same snapshot). Only called
 * when the (identity, version) pair actually changed — re-recording a stored
 * version never reaches here, so replays never restamp or resequence.
 *
 * Two concurrent transitions for DIFFERENT identities can both assign the
 * same sequence under contention when the pinned write fell back to the
 * unpinned exhausted-loop update (the pin below covers the common path; the
 * fallback is the documented #1134 degradation). Duplicate sequence numbers
 * are benign for watermark comparisons: both rows straddle any watermark
 * together, so a collision can at most reproduce the bounded
 * redundant-attempt cost #1119 already accepts — it can never fake a
 * post-watermark transition that never happened.
 */
async function recordEvidenceTransition(
  tx: PrFixQueueClient,
  itemId: string,
  input: EvidenceObservation,
  sequence: number,
  repeatedSignature = false,
): Promise<void> {
  if (!tx.prFixEvidence || !input.evidenceKey || !isPrFixEvidenceKind(input.evidenceKind)) return;
  const row = {
    kind: input.evidenceKind,
    version: input.evidenceVersion ?? "",
    contentSignature: normalizeEvidenceContentSignature(input.evidenceContentSignature),
    observedAt: parseEvidenceObservedAt(input.evidenceObservedAt),
    headSha: input.evidenceHeadSha ?? null,
    source: input.evidenceSource ?? null,
    // Missing provenance (legacy caller without the field) records as
    // actionable = true only for kinds the caller gated already; `unknown`
    // kinds stay non-actionable, never silently fresh (design: unknown
    // evidence defers, it does not resolve).
    //
    // #1249 controls 3/7: a NEW identity repeating an already-recorded
    // content signature is recorded as a transition for audit but stamped
    // NON-actionable, so neither the enqueue decision (sticky via
    // isKnownEvidence) nor the settlement durable read (filtered on
    // actionable:true) can ever treat repeated text as fresh work.
    actionable: input.evidenceActionable !== false && !repeatedSignature,
    // The row's ledger position tracks its CURRENT version's transition. A
    // re-versioned row (a dismissed review that is requested again, a
    // condition that reappears) that kept its first version's sequence would
    // sit at or below any live watermark and be silently absorbed at
    // settlement — a false silence, the loss class the watermark exists to
    // prevent. Replay inertness is upstream of this function: a stored
    // (identity, version) never reaches it.
    sequence,
  };
  await tx.prFixEvidence.upsert({
    where: { itemId_identity: { itemId, identity: input.evidenceKey } },
    create: { itemId, identity: input.evidenceKey, ...row, sequence },
    update: row,
  });
}

/**
 * Durable post-dispatch entries for a settling attempt (#1249): actionable
 * ledger transitions recorded AFTER the attempt's evidence-snapshot watermark,
 * projected into the #1119 `<evidenceKey>@<head>` format so settlement
 * revalidates them (head-gated for checks) through `hasActionablePostDispatch-
 * Evidence` exactly like the bounded cache. No watermark → empty list: the
 * cache fast path stands (legacy rows and lost best-effort stamps behave as
 * before #1249; they never gain a false reopen from ledger rows they cannot
 * bound).
 */
async function listDurablePostDispatchEntries(
  client: PrFixQueueClient,
  row: any,
): Promise<string[]> {
  if (!client.prFixEvidence || typeof row.attemptEvidenceWatermark !== "number") return [];
  const rows = await client.prFixEvidence.findMany({
    where: { itemId: row.id, sequence: { gt: row.attemptEvidenceWatermark }, actionable: true },
    orderBy: { sequence: "asc" },
  });
  return ledgerRowsToPostDispatchEntries(rows ?? []);
}

/**
 * Append one post-dispatch evidence entry, evicting the OLDEST NON-PRIORITY
 * entry when the list would exceed `maxItems` (#1119). Priority = parsed
 * eventType is `review` / `review_comment` / `comment`: a human asking for
 * changes is actionable no matter what the PR head is, so an actionable
 * review must not be silently evicted in favor of a stale check — the exact
 * loss class #1119 exists to prevent. If every entry is priority, the
 * oldest priority entry is evicted (nothing better to drop).
 */
function appendPostDispatchEvidenceEntry(values: string[], entry: string, maxItems: number): string[] {
  const next = values.includes(entry) ? values : [...values, entry];
  if (next.length <= maxItems) return next;
  const isPriority = (value: string) => {
    const { eventType } = parsePostDispatchEvidenceEntry(value);
    return eventType === "review" || eventType === "review_comment" || eventType === "comment";
  };
  const firstNonPriority = next.findIndex((value) => !isPriority(value));
  const evictIndex = firstNonPriority === -1 ? 0 : firstNonPriority;
  return [...next.slice(0, evictIndex), ...next.slice(evictIndex + 1)];
}

/**
 * Encode one post-dispatch evidence entry as `<evidenceKey>@<head>` (#1119):
 * `head` is the enqueue input's headSha (trimmed, verbatim) when present,
 * else the literal "unknown", so a check_run entry can later be revalidated
 * against the PR's current head at settlement time.
 *
 * Exact contract, honored by `parsePostDispatchEvidenceEntry`:
 * - the entry is split on the FIRST "@": an `@` inside the headSha (an
 *   unvalidated caller string) is part of the head half, not a separator;
 * - a head that is not git-shape (4-64 hex chars) reads back as "unknown" —
 *   so an `@`-bearing headSha degrades to an unknown head, whose entry stays
 *   actionable (conservative) instead of being revalidated against a
 *   fragment of the real head;
 * - the evidenceKey namespace is internal: an `@`-bearing key is not forged
 *   into an actionable check entry, because the event type comes from the
 *   part before the FIRST "@".
 */
function encodePostDispatchEvidenceKey(evidenceKey: string, headSha: string | null | undefined): string {
  const head = typeof headSha === "string" && headSha.trim() ? headSha.trim() : "unknown";
  return `${evidenceKey}@${head}`;
}

/**
 * Parse one post-dispatch evidence entry back into { eventType, head }
 * (#1119): the entry is split on the FIRST "@" — `eventType` is the
 * substring before the FIRST ":" of the part before it, and `head` is the
 * substring after it. `head` is then sanitized to "unknown" unless it is
 * git-shape (`/^[0-9a-fA-F]{4,64}$/`): an invalid-shape head cannot be
 * revalidated, and "unknown" counts as actionable. An absent head reads
 * back as "unknown" — it was never recorded. Unknown event types are
 * non-actionable (fail-closed) in `hasActionablePostDispatchEvidence`.
 */
function parsePostDispatchEvidenceEntry(entry: string): { eventType: string; head: string } {
  const at = entry.indexOf("@");
  const keyPart = at >= 0 ? entry.slice(0, at) : entry;
  const headPart = at >= 0 ? entry.slice(at + 1) : "";
  const colon = keyPart.indexOf(":");
  const eventType = colon >= 0 ? keyPart.slice(0, colon) : keyPart;
  const head = /^[0-9a-fA-F]{4,64}$/.test(headPart) ? headPart : "unknown";
  return { eventType, head };
}

/**
 * Whether any recorded post-dispatch evidence entry is ACTIONABLE for the
 * current PR state, i.e. would justify reopening a settlement as a fresh
 * attempt (#1119, per the #1124 review):
 *
 * - review / review_comment / comment entries are actionable as-is: a human
 *   asking for changes is actionable no matter what the PR head is, so this
 *   is a short-circuit with NO GitHub call (checked first, so a mixed list
 *   with a check entry listed before the review still skips the fetch).
 * - a check_run entry is actionable only when its recorded head is "unknown"
 *   (the check ran on a head we never recorded) or equals the PR's current
 *   head (fetched ONCE, shared by all check entries). A failing check on a
 *   superseded head is stale — the worker already pushed past it. An
 *   unavailable head (fetchPullRequestHeadSha RETURNS null on unreachable
 *   GitHub / unknown shape / deleted PR, and THROWS only in genuinely
 *   unexpected cases) counts the entry as ACTIONABLE (conservative): missing
 *   a reopen silently absorbs the evidence — the exact #1119 bug class —
 *   while a false reopen is cheap, because a merged/deleted PR is reaped to
 *   STALE by the reconcile pass before a worker wastes a run on it.
 * - anything else (merge_state, merge_conflict, unknown) is not actionable.
 *
 * Empty list → false.
 */
async function hasActionablePostDispatchEvidence(
  entries: string[],
  repo: string,
  pr: number,
): Promise<boolean> {
  if (entries.length === 0) return false;

  for (const entry of entries) {
    const { eventType } = parsePostDispatchEvidenceEntry(entry);
    if (eventType === "review" || eventType === "review_comment" || eventType === "comment") {
      return true;
    }
  }

  let currentHead: string | null | undefined;
  for (const entry of entries) {
    const { eventType, head } = parsePostDispatchEvidenceEntry(entry);
    if (eventType !== "check_run") continue;
    if (head === "unknown") return true;
    if (currentHead === undefined) {
      try {
        currentHead = await fetchPullRequestHeadSha(repo, pr);
      } catch (error) {
        console.warn(`[pr-fix-queue] post-dispatch head check failed for ${repo}#${pr}:`, error instanceof Error ? error.message : error);
        return true;
      }
    }
    // null = GitHub unreachable / shape unknown / PR deleted: cannot prove
    // the recorded head is superseded, so treat as actionable (#1119).
    if (currentHead === null) return true;
    if (head === currentHead) return true;
  }
  return false;
}

/**
 * Build a Prisma update patch from enqueue input.
 * `issue` maps to Prisma PrFixQueueItem.issue (Int?) which stores the linked GitHub issue number.
 */
function laneLabel(lane: string | null | undefined): string {
  if (!lane) return "unknown";
  const normalized = lane.trim().toUpperCase();
  return normalized || "unknown";
}

/**
 * Build the surfacing context for a BLOCKED/PARKED item from data Dispatch
 * actually has: the item's worker-execution count (`fixAttempts`), its feedback
 * (the latest is the best available last-attempt context) and its history rows.
 * All fields are optional/fallback-safe so historical rows and old callers
 * still surface something useful. Never throws.
 *
 * Metrics truthfulness (#1218): `workerExecutions` is the dispatchable attempt
 * count and `enqueueRows` is the enqueue/evidence row count; the enqueue count
 * is deliberately NOT emitted as `totalAttempts`.
 */
export async function buildPrFixBlockedContext(
  client: PrFixQueueClient,
  item: { repo: string; pr: number; feedback?: string[] | null; fixAttempts?: number | null; staleDisposition?: boolean | null },
): Promise<import("./pr-fix-surfacing").PrFixSurfaceContext> {
  const context: import("./pr-fix-surfacing").PrFixSurfaceContext = {};

  // #1253: surface the stale-disposition flag when it is set — fresh
  // actionable evidence arrived while the item sat in a hold evidence must
  // not override. Read-only hint; never reopens anything.
  if (item.staleDisposition === true) context.staleDisposition = true;

  const feedback = Array.isArray(item.feedback) ? item.feedback : [];

  const links: string[] = [];
  let lastAttemptSummary: string | null = null;
  for (const entry of feedback) {
    if (!entry) continue;
    lastAttemptSummary = entry;
    const urls = extractUrlsFromTextSafe(entry);
    for (const u of urls) if (!links.includes(u)) links.push(u);
  }
  if (links.length > 0) context.failingRunLinks = links;
  if (lastAttemptSummary) context.lastAttemptSummary = lastAttemptSummary;

  // Worker executions are the real bound; report them explicitly, never as the
  // enqueue row count (#1218).
  if (typeof item.fixAttempts === "number") context.workerExecutions = item.fixAttempts;
  else context.workerExecutions = null;

  // Enqueue rows grouped by lane, plus the final failure signature from the
  // latest BLOCKED or PARKED tombstone note. Historical rows without a lane are
  // counted under "unknown".
  try {
    if (client.prFixHistory?.findMany) {
      const history = await client.prFixHistory.findMany({
        where: { item: { repo: item.repo, pr: item.pr } },
        orderBy: { at: "desc" },
      });

      const attemptsByLane: Record<string, number> = {};
      let enqueueCount = 0;
      for (const h of history) {
        if (h.action !== "enqueue") continue;
        enqueueCount += 1;
        const lane = laneLabel(h.lane);
        attemptsByLane[lane] = (attemptsByLane[lane] ?? 0) + 1;
      }
      context.enqueueRows = enqueueCount;
      if (Object.keys(attemptsByLane).length > 0) context.attemptsByLane = attemptsByLane;

      const terminal = history.find(
        (h) => h.action === "mark" && (h.status === "BLOCKED" || h.status === "PARKED") && h.note,
      );
      if (terminal?.note) context.finalFailureSignature = terminal.note;
    }
  } catch {
    // Failure to load history is non-fatal; we still surface with the rest.
  }

  return context;
}

function extractUrlsFromTextSafe(text: string): string[] {
  try {
    return extractUrlsFromText(text);
  } catch {
    return [];
  }
}

/**
 * A GitHub Actions run/job URL: what the pre-#1098 ingestion stored as an
 * item URL for CI failures. Never valid item identity (#1118).
 */
const ACTIONS_RUN_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\//;

function isActionsRunUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && ACTIONS_RUN_URL.test(url);
}

/** The item URL an enqueue may write: never a CI job URL (#1098, #1118). */
function itemUrlFromInput(input: EnqueuePrFixInput): string | undefined {
  return input.url && !isActionsRunUrl(input.url) ? input.url : undefined;
}

// `url` is not part of this patch (#1098): the item URL is identity (the PR
// URL) — set at first enqueue, backfilled only while empty. A CI-failure
// re-enqueue's job URL must not flip it; job links belong in feedback/
// evidence (pr-followup-ingestion), not the item URL.
function metadataPatch(input: EnqueuePrFixInput): Record<string, string | number> {
  const patch: Record<string, string | number> = {};
  for (const [key, value] of Object.entries({
    issue: input.issue ?? undefined,
    branch: input.branch ?? undefined,
    title: input.title ?? undefined,
    headSha: input.headSha ?? undefined,
    author: input.author ?? undefined,
  })) {
    if (value !== undefined && value !== null && value !== "") patch[key] = value as string | number;
  }
  return patch;
}

/**
 * Bound on automatic fix attempts before a REVIEW_FEEDBACK/CI item is handed to
 * a human instead of re-queued. Counts dispatchable attempts (`fixAttempts`),
 * not evidence keys: one review carries a key per inline comment, so counting
 * keys blocked a PR on first sight of a 6-comment review (#1103). Overridable
 * via PR_FIX_MAX_ATTEMPTS; defaults to 5.
 */
export function maxPrFixAttempts(): number {
  const n = Number(process.env.PR_FIX_MAX_ATTEMPTS);
  return Number.isInteger(n) && n > 0 ? n : 5;
}

export function externalWaitCooldownMs(): number {
  const n = Number(process.env.PR_FIX_EXTERNAL_WAIT_COOLDOWN_MS);
  return Number.isInteger(n) && n >= 60_000 && n <= 7 * 24 * 60 * 60 * 1000 ? n : 6 * 60 * 60 * 1000;
}

// Batch size for the bounded external-wait reactivation scan (#1231).
const EXTERNAL_WAIT_REACTIVATION_BATCH = 100;
// Per-sweep scan bound (#1250 review): the query already excludes legacy
// (SQL NULL) contracts at the database level, so in-memory skips only defend
// against rows whose stored JSON no longer validates — a shape writers can
// no longer produce. The scan stops after this many read rows so
// pathological garbage rows can stall discovery but never turn the sweep
// unbounded; which rows land inside the bound is decided by the fairness
// order in `reconcileExternalWaitTriggers`, not by id position.
const EXTERNAL_WAIT_REACTIVATION_SCAN_LIMIT = 500;

async function reactivateDueExternalWaits(client: PrFixQueueClient, now: Date): Promise<void> {
  let cursor: string | undefined;
  let scanned = 0;
  while (scanned < EXTERNAL_WAIT_REACTIVATION_SCAN_LIMIT) {
    // #1250 review: exclude legacy free-text waits (SQL NULL contract) in the
    // query itself — 100+ legacy rows must never occupy the batch and starve
    // valid structured waits out of discovery. Valid-but-unparseable rows
    // (if any exist) are skipped in memory and walked past deterministically
    // via the id cursor below.
    const due: any[] = await client.prFixQueueItem.findMany({
      where: { status: "WAITING_EXTERNAL", retryAt: { lte: now }, externalWait: { not: Prisma.DbNull } },
      orderBy: { id: "asc" },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      take: EXTERNAL_WAIT_REACTIVATION_BATCH,
    });
    if (due.length === 0) break;
    scanned += due.length;
    for (const row of due) {
      cursor = row.id;
      if (row.status !== "WAITING_EXTERNAL" || !row.retryAt || new Date(row.retryAt).getTime() > now.getTime()) continue;
      // A stored contract that no longer validates is NOT a bounded external
      // wait: stay held for operator action (surfaced as `legacyWait` in
      // queue listings), never silently auto-requeued. Cooldown-based
      // recheck continues for valid structured contracts.
      if (!parseStoredExternalWait(row.externalWait)) continue;
      await client.$transaction(async (tx) => {
        const { count } = await tx.prFixQueueItem.updateMany({
          where: { id: row.id, status: "WAITING_EXTERNAL", generation: row.generation, retryAt: row.retryAt },
          data: { status: "QUEUED", ...freshAttemptGeneration(), retryAt: null, dispatchedGeneration: null, dispatchedAt: null, postDispatchEvidenceKeys: [], attemptHeadSha: row.headSha ?? row.attemptHeadSha ?? null, outcome: null, decisionDetail: null, agentHandouts: [], handoutAcks: [], handoutReceipts: [], externalWait: Prisma.DbNull },
        });
        if (count === 1) await tx.prFixHistory.create({ data: { itemId: row.id, action: "mark", status: "QUEUED", lane: row.lane, note: "External-wait cooldown elapsed; retrying prerequisite check." } });
      });
    }
    if (due.length < EXTERNAL_WAIT_REACTIVATION_BATCH) break;
  }
}

// External-wait triggers with a LIVE predicate (#1253, row 12): the
// evaluator can actually verify these against the forge.
// `cooldown_recheck` recovers via `retryAt` (reactivateDueExternalWaits)
// and `service_ready` is inherently unverifiable — neither belongs here.
const LIVE_EXTERNAL_WAIT_TRIGGERS = new Set(["merged", "closed", "check_success"]);

/**
 * Bounded periodic reconciliation of structured external waits (#1253,
 * row 12): evaluate each WAITING_EXTERNAL row whose recorded recovery
 * trigger has a live predicate (`merged` / `closed` / `check_success`) and,
 * when the dependency now SATISFIES the predicate, run the same
 * generation-pinned, UNCHARGED reactivation write
 * `reactivateDueExternalWaits` performs (a resolved dependency is a recheck
 * of the prerequisite, not new work — no attempt is consumed; the cap still
 * applies to the recheck when it runs).
 *
 * Bounds: one read of at most `EXTERNAL_WAIT_REACTIVATION_SCAN_LIMIT` rows
 * (shared with `reactivateDueExternalWaits`) plus `maxEvaluations`
 * (default 20) — each evaluation is a network read through the forge, so a
 * backlog of waiting rows must never turn this pass into an unbounded
 * fan-out. "unsatisfied" and "unknown" (including any fetch failure, which
 * `evaluateExternalWaitTrigger` already resolves to "unknown") mutate
 * nothing and are never retried here — the next pass re-evaluates.
 *
 * Fairness (#1253 review): the read is NOT ordered by id from a per-process
 * cursor, which let the first `maxEvaluations` unsatisfied waits be re-read
 * every pass while later waits were never reached. Rows are ordered
 * least-recently-considered first — explicitly `nulls: "first"`, because the
 * Postgres default for ASC is NULLS LAST and would otherwise rank the newest
 * stamps first — then `id` as the deterministic tiebreak — and EVERY row the
 * pass considered — evaluated, unparseable, or non-live — is stamped in one
 * bulk write at the end of the pass, so the head of the order rotates and no
 * wait can starve behind an earlier unsatisfied or invalid row. Rows the
 * `maxEvaluations` forge-read bound cut off before the pass examined them stay
 * unstamped and therefore lead the next one: each pass advances a bounded
 * slice of the backlog instead of re-reading the same head.
 *
 * Returns counts for logging/audit. Never throws for a per-row failure
 * shape the evaluator swallows; unexpected client errors propagate to the
 * caller, which treats this pass as best-effort.
 */
export async function reconcileExternalWaitTriggers(
  client: PrFixQueueClient,
  options: { maxEvaluations?: number } = {},
): Promise<{ evaluated: number; reactivated: number }> {
  const maxEvaluations = options.maxEvaluations ?? 20;
  let evaluated = 0;
  let reactivated = 0;
  const considered: string[] = [];
  // Fair eligibility (#1253 review): least-recently-considered first, never-
// considered (NULL) rows leading. `nulls: "first"` is REQUIRED, not cosmetic:
  // Postgres treats NULL as larger than every non-null value, so the default
  // for ASC is NULLS LAST and a bare `triggerEvaluatedAt: "asc"` would order
  // the most recently stamped rows first — pinning the head and starving later
  // waits. `id` only breaks ties. No in-process cursor exists to reset between
  // passes.
  const rows: any[] = await client.prFixQueueItem.findMany({
    where: { status: "WAITING_EXTERNAL", externalWait: { not: Prisma.DbNull } },
    orderBy: [{ triggerEvaluatedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: EXTERNAL_WAIT_REACTIVATION_SCAN_LIMIT,
  });
  for (const row of rows) {
    if (evaluated >= maxEvaluations) break;
    // Reached by this pass: examined and about to be either evaluated or
    // skipped in memory. Both count as considered (the stamp rotates them out
    // of the head alike) — only rows the forge-read bound cut off before this
    // point stay unstamped, so they lead the next pass.
    considered.push(row.id);
    if (row.status !== "WAITING_EXTERNAL") continue;
    // A stored contract that no longer validates is a legacy wait: held
    // for operator action, never evaluated or auto-requeued (#1250).
    const wait = parseStoredExternalWait(row.externalWait);
    if (!wait) continue;
    if (!LIVE_EXTERNAL_WAIT_TRIGGERS.has(wait.trigger.kind)) continue;
    evaluated += 1;
    const evaluation = await evaluateExternalWaitTrigger(wait, row.repo);
    if (evaluation !== "satisfied") continue;
    const count = await client.$transaction(async (tx) => {
      const { count } = await tx.prFixQueueItem.updateMany({
        where: { id: row.id, status: "WAITING_EXTERNAL", generation: row.generation },
        data: {
          status: "QUEUED",
          ...freshAttemptGeneration(),
          retryAt: null,
          dispatchedGeneration: null,
          dispatchedAt: null,
          postDispatchEvidenceKeys: [],
          attemptHeadSha: row.headSha ?? row.attemptHeadSha ?? null,
          outcome: null,
          decisionDetail: null,
          agentHandouts: [],
          handoutAcks: [],
          handoutReceipts: [],
          externalWait: Prisma.DbNull,
          staleDisposition: false,
        },
      });
      if (count === 1) {
        await tx.prFixHistory.create({
          data: { itemId: row.id, action: "mark", status: "QUEUED", lane: row.lane, note: "External-wait dependency satisfied; rechecking prerequisite (#1253)." },
        });
      }
      return count;
    });
    if (count === 1) reactivated += 1;
  }
  // Rotate the scan head: stamp EVERY row this pass considered — including
  // rows skipped in memory (invalid/legacy contract, non-live trigger), which
  // would otherwise pin the head of the order forever and starve later waits.
  // Rows the `maxEvaluations` forge-read bound cut off before examining are
  // deliberately left unstamped so they lead the next pass (a single shared
  // stamp would re-sort them behind the same head forever). Scoped to rows
  // still WAITING_EXTERNAL so nothing that already left the state is written.
  // One bulk write per pass. Writing through Prisma Client also advances
  // `updatedAt` (@updatedAt) on those rows; that bump is inherent to the client
  // and harmless here — the write is scoped to rows still WAITING_EXTERNAL,
  // the fairness read depends on `triggerEvaluatedAt` alone, and `updatedAt`
  // stays informational (never a staleness or ordering predicate).
  if (considered.length > 0) {
    await client.prFixQueueItem.updateMany({
      where: { id: { in: considered }, status: "WAITING_EXTERNAL" },
      data: { triggerEvaluatedAt: new Date() },
    });
  }
  return { evaluated, reactivated };
}

/**
 * How long a stamped hand-out may sit unacknowledged before the reclaimer
 * treats it as abandoned (#1211). A worker that durably materialized its
 * attempt acknowledges it; a stamped hand-out with no ack past this window
 * means the executor likely died before creating its run. Overridable via
 * PR_FIX_HANDOUT_TIMEOUT_MS; defaults to 30 minutes.
 */
export const DEFAULT_PR_FIX_HANDOUT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Bound on automatic reclamations of a stale unacknowledged hand-out (#1211).
 * Each reclaim reopens the item as a fresh generation; past this cap the item
 * is routed to a human instead of being reclaimed again. Overridable via
 * PR_FIX_MAX_RECLAIMS; defaults to 3.
 */
export const DEFAULT_PR_FIX_MAX_RECLAIMS = 3;

export function prFixHandoutTimeoutMs(): number {
  const n = Number(process.env.PR_FIX_HANDOUT_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PR_FIX_HANDOUT_TIMEOUT_MS;
}

export function maxPrFixReclaims(): number {
  const n = Number(process.env.PR_FIX_MAX_RECLAIMS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PR_FIX_MAX_RECLAIMS;
}

/**
 * Acknowledgement of a PR-fix hand-out (#1211). A worker calls this after it
 * has durably materialized its attempt (e.g. created the executor run that
 * owns the work), so the reclaimer knows the stamped hand-out was not lost.
 */
export interface AckPrFixHandoutInput {
  repo: string;
  pr: number;
  generation: number;
  agentName: string;
}

export type AckPrFixHandoutResult =
  | { acknowledged: true; item: any }
  | {
      acknowledged: false;
      reason:
        | "not-found"
        | "generation-mismatch"
        | "not-queued"
        | "already-acknowledged"
        | "not-stamped"
        | "not-handed";
    };

export function parseAckPrFixHandoutInput(body: unknown): AckPrFixHandoutInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.repo)) return { error: "Missing required field: repo" };
  if (input.pr === undefined || input.pr === null || !Number.isInteger(Number(input.pr))) {
    return { error: "Missing required field: pr" };
  }
  if (
    input.generation === undefined ||
    input.generation === null ||
    typeof input.generation !== "number" ||
    !Number.isInteger(input.generation) ||
    input.generation < 1
  ) {
    return { error: "generation must be an integer >= 1" };
  }
  // agentName is required (#1211 review): the route layer derives it from the
  // authenticated bearer actor (no basic / oidc / disabled fallback). The
  // field is kept in the schema for transport-layer redundancy (the MCP
  // client forwards it) but parsed even when the bearer layer already
  // supplied it, so a caller mismatch surfaces as 400 before any DB write.
  // Type check first so a non-string value (e.g. 7) surfaces as the type
  // error, not as "Missing required field" (nonEmpty is type-agnostic).
  if (input.agentName !== undefined && input.agentName !== null && typeof input.agentName !== "string") {
    return { error: "agentName must be a string" };
  }
  if (!nonEmpty(input.agentName)) return { error: "Missing required field: agentName" };
  return {
    repo: input.repo.trim(),
    pr: Number(input.pr),
    generation: input.generation,
    agentName: (input.agentName as string).trim(),
  };
}

/**
 * Record a durable hand-out acknowledgement for the CURRENT generation
 * (#1211). A late ack for an older generation is refused
 * (`generation-mismatch`) so it can never mark the fresh generation as live.
 * Only a generation that was actually stamped/handed out can be acknowledged
 * (`not-stamped` otherwise): an unstamped item was never offered, so an ack
 * cannot pin it against reclamation. The ack is further pinned to an
 * authenticated agent — the agent must appear in `agentHandouts` at this
 * generation (`not-handed` otherwise), so a forged ack by a token that never
 * received the hand-out cannot pin a live reclaim against the worker that
 * actually has the item. The write is a compare-and-swap pinned on
 * `{ id, generation, status: "QUEUED", handoutAcks }`: a concurrent reclaim,
 * settlement, or ack that moves the row (or its ack list) in the read→write
 * gap no-ops it, and the caller gets `generation-mismatch`. A repeat ack for
 * the same `(agent, generation)` is idempotent (`already-acknowledged`, no
 * write).
 */
export async function ackPrFixHandout(
  client: PrFixQueueClient,
  rawInput: AckPrFixHandoutInput,
): Promise<AckPrFixHandoutResult> {
  // Same identity fold as every other queue read/write (#1145).
  const input: AckPrFixHandoutInput = { ...rawInput, repo: normalizeQueueRepo(rawInput.repo) };
  const existing = await client.prFixQueueItem.findUnique({
    where: { repo_pr: { repo: input.repo, pr: input.pr } },
  });
  if (!existing) return { acknowledged: false, reason: "not-found" };
  if (existing.generation !== input.generation) {
    return { acknowledged: false, reason: "generation-mismatch" };
  }
  if (existing.status !== "QUEUED") {
    return { acknowledged: false, reason: "not-queued" };
  }
  // Only a generation that was actually handed out may be acknowledged: an
  // unstamped item was never offered, so an ack cannot pin it against
  // reclamation (#1211).
  if (existing.dispatchedGeneration !== input.generation || existing.dispatchedAt == null) {
    return { acknowledged: false, reason: "not-stamped" };
  }
  // The ack must come from an agent that was handed this item at this
  // generation (#1211 review): a token that never received the hand-out
  // cannot pin a future reclaim against the worker that actually has it.
  // Entries from prior generations are inert (same envelope as
  // agentAlreadyHanded): only the SAME generation's hand-out matches.
  const handouts: string[] = Array.isArray(existing.agentHandouts) ? existing.agentHandouts : [];
  const handedThisAgent =
    input.agentName != null &&
    handouts.some((entry) => {
      const parsed = parseAgentHandoutToken(entry);
      return parsed !== null && parsed.agentName === input.agentName && parsed.generation === input.generation;
    });
  if (!handedThisAgent) {
    return { acknowledged: false, reason: "not-handed" };
  }
  const token = agentHandoutToken(input.agentName as string, input.generation);
  const acks: string[] = Array.isArray(existing.handoutAcks) ? existing.handoutAcks : [];
  if (acks.includes(token)) {
    return { acknowledged: false, reason: "already-acknowledged" };
  }

  // Compare-and-swap on the exact ack-list snapshot the idempotency check
  // read (#1211): two concurrent acks serialize — one wins the pin, the other
  // misses (returns generation-mismatch for the caller to retry) — so no
  // duplicate tokens and no lost update.
  const nextAcks = [...acks, token];
  const item = await client.$transaction(async (tx) => {
    const { count } = await tx.prFixQueueItem.updateMany({
      where: { id: existing.id, generation: input.generation, status: "QUEUED", handoutAcks: { equals: acks } },
      data: { handoutAcks: nextAcks },
    });
    if (count !== 1) return null;
    await tx.prFixHistory.create({
      data: {
        itemId: existing.id,
        action: "ack",
        status: "QUEUED",
        lane: existing.lane,
        note: `Hand-out acknowledged for generation ${input.generation} by ${input.agentName}.`,
      },
    });
    return tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
  });
  if (!item) return { acknowledged: false, reason: "generation-mismatch" };
  return { acknowledged: true, item };
}

export interface ReclaimStalePrFixHandoutsOptions {
  now?: Date;
  timeoutMs?: number;
  maxReclaims?: number;
  batchSize?: number;
  isPrMergedOrClosed?: (repo: string, pr: number) => Promise<boolean | null>;
}

export interface ReclaimStalePrFixHandoutsReport {
  examined: number;
  reclaimed: number;
  staled: number;
  /**
   * Items PARKED at the reclaim cap (#1218). Legacy callers may still read
   * `blocked` for the same count — both are incremented in the cap path so
   * old dashboards keep working, but `parked` is the truthful name going
   * forward (a parked item is bounded exhaustion, not a human decision).
   */
  parked: number;
  /** @deprecated Use `parked` (#1218). Retained for callers that still key off it. */
  blocked: number;
  skipped: number;
  unknownState: number;
  errors: Array<{ itemId: string; error: string }>;
}

/**
 * Best-effort PR-state probe for the hand-out reclaimer (#1211). Returns true
 * when the PR is merged or closed, false when it is open, and null when the
 * state cannot be determined (fetch error or unknown shape). A null defers
 * the item: a possibly-closed PR must never be reclaimed into a fresh attempt.
 */
async function defaultIsPrMergedOrClosed(repo: string, pr: number): Promise<boolean | null> {
  try {
    const state = await fetchPullRequestState(repo, pr);
    if (state.mergedAt != null) return true;
    if (state.state === "closed") return true;
    if (state.state === "open") return false;
    return null;
  } catch (error) {
    console.warn(`[pr-fix-queue] PR state check failed for ${repo}#${pr}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Reclaim stamped-but-unacknowledged PR-fix hand-outs (#1211).
 *
 * The failure mode: next-task stamps `dispatchedGeneration`/`dispatchedAt`
 * and records the agent in `agentHandouts`, but the executor dies before it
 * durably creates its run — no ack lands, and `agentAlreadyHanded` suppresses
 * re-handing the same agent, so the item is stranded. This sweep finds QUEUED
 * items whose current generation was stamped longer than the timeout ago,
 * with no acknowledgement for that generation, and:
 *
 * - merged/closed PR → STALE (nothing left to fix);
 * - unknown PR state → deferred (`unknownState`), never reclaimed;
 * - past PR_FIX_MAX_RECLAIMS → PARKED + NORMAL with outcome=`no_progress`
 *   (#1218); bounded exhaustion, not a human decision, so `needs-human` is
 *   never applied. Release requires an explicit operator requeue or a
 *   maintainer mark to QUEUED.
 * - otherwise → reopen as a fresh generation (a new work identity) and count
 *   the reclaim. The ack-list pin makes an acknowledgement landing in the
 *   read→write gap a no-op, so a live worker is never clobbered.
 *
 * No network call runs inside a `$transaction` (#1124): the PR-state probe
 * runs before every write.
 */
export async function reclaimStalePrFixHandouts(
  client: PrFixQueueClient,
  options: ReclaimStalePrFixHandoutsOptions = {},
): Promise<ReclaimStalePrFixHandoutsReport> {
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? prFixHandoutTimeoutMs();
  const maxReclaims = options.maxReclaims ?? maxPrFixReclaims();
  const batchSize = options.batchSize ?? 50;
  const probe = options.isPrMergedOrClosed ?? defaultIsPrMergedOrClosed;

  const report: ReclaimStalePrFixHandoutsReport = {
    examined: 0,
    reclaimed: 0,
    staled: 0,
    parked: 0,
    blocked: 0,
    skipped: 0,
    unknownState: 0,
    errors: [],
  };

  // Filter on the WHERE clause for the actual reclaimable population, not
  // the first 50 QUEUED rows (#1211 review): the older scan ordered by
  // updatedAt took items stale by elapsed time AFTER fetching them, so a
  // stamp that never aged enough permanently occupied the head of the
  // window and starved the rest. Paginating past unseen items lets the
  // sweep make progress against a backlog larger than batchSize.
  const dueBefore = new Date(now.getTime() - timeoutMs);
  let cursorId: string | undefined = undefined;
  // Bound the loop so a runaway mismatch (where dispatchedAt is unset) can
  // never scan the whole table; a few pages is enough for normal load and
  // surfaces a stuck tail through the unprocessed row count, not silent
  // starvation.
  const maxPages = 50;
  for (let page = 0; page < maxPages; page++) {
    const candidates = await client.prFixQueueItem.findMany({
      where: {
        status: "QUEUED",
        dispatchedAt: { lt: dueBefore },
        dispatchedGeneration: { not: null },
      },
      take: batchSize,
      orderBy: { dispatchedAt: "asc" },
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    if (candidates.length === 0) break;
    report.examined += candidates.length;

    for (const item of candidates) {
      try {
        const dispatchedAtMs = item.dispatchedAt ? new Date(item.dispatchedAt).getTime() : null;
        const stampedThisGeneration =
          item.dispatchedGeneration != null && item.dispatchedGeneration === item.generation;
        if (
          dispatchedAtMs === null ||
          !stampedThisGeneration ||
          !(dispatchedAtMs < now.getTime() - timeoutMs)
        ) {
          report.skipped++;
          continue;
        }

        // A live acknowledged attempt must never be reclaimed, even when stale
        // by wall-clock: the worker durably owns the generation. The cheap
        // `some` over `handoutAcks` covers the same generation as the item;
        // older-generation entries are inert and never match.
        const acks: string[] = Array.isArray(item.handoutAcks) ? item.handoutAcks : [];
        const acknowledgedForGeneration = acks.some((entry) => {
          const parsed = parseAgentHandoutToken(entry);
          return parsed !== null && parsed.generation === item.generation;
        });
        if (acknowledgedForGeneration) {
          report.skipped++;
          continue;
        }

        const merged = await probe(item.repo, item.pr);
        if (merged === null) {
          // GitHub could not answer: never retry a possibly-closed PR.
          report.unknownState++;
          continue;
        }
        if (merged === true) {
          // Pin the ack-list snapshot (#1211 review): an ack that lands in
          // the read→write gap below MUST no-op the terminal write, exactly
          // as the fresh-generation reclaim does. Without this pin a live
          // worker that acks a moment before the terminal write would be
          // wiped to STALE — the same loss class the reclaim already
          // guards against.
          const acksBeforeStale: string[] = Array.isArray(item.handoutAcks) ? item.handoutAcks : [];
          const { count } = await client.$transaction(async (tx) => {
            const result = await tx.prFixQueueItem.updateMany({
              where: {
                id: item.id,
                generation: item.generation,
                status: "QUEUED",
                handoutAcks: { equals: acksBeforeStale },
              },
              data: {
                status: "STALE",
                agentHandouts: [],
                handoutAcks: [],
                handoutReceipts: [],
                dispatchedGeneration: null,
                dispatchedAt: null,
                // #1249: a terminal disposition ends the attempt, so the
                // snapshot boundary dies with it — the same clear
                // markPrFixItem's STALE branch does.
                attemptEvidenceWatermark: null,
              },
            });
            if (result.count === 1) {
              await tx.prFixHistory.create({
                data: {
                  itemId: item.id,
                  action: "mark",
                  status: "STALE",
                  lane: item.lane,
                  note: `Stale unacknowledged hand-out: upstream PR is merged or closed; reaped to STALE (#1211).`,
                },
              });
            }
            return result;
          });
          if (count === 1) report.staled++;
          else report.skipped++;
          continue;
        }

        // PR is open. Past the reclaim cap, PARK the item (#1218): repeated
        // unacknowledged hand-outs are bounded no-progress exhaustion, not a
        // human decision, so it must not carry the needs-human label.
        const reclaimCount = item.handoutReclaims ?? 0;
        if (reclaimCount >= maxReclaims) {
          // Same ack-list pin (#1211 review): the terminal PARKED write
          // would otherwise wipe a freshly-acknowledged live attempt off
          // the parked state, never to be reclaimed again.
          const acksBeforeBlock: string[] = Array.isArray(item.handoutAcks) ? item.handoutAcks : [];
          const { count } = await client.$transaction(async (tx) => {
            const result = await tx.prFixQueueItem.updateMany({
              where: {
                id: item.id,
                generation: item.generation,
                status: "QUEUED",
                handoutAcks: { equals: acksBeforeBlock },
              },
              data: {
                status: "PARKED",
                lane: "NORMAL",
                outcome: "no_progress",
                decisionDetail: null,
                // #1253: audit stamp of the CURRENT disposition. Stamped
                // unconditionally at every disposition write site — a
                // same-status re-mark merely refreshes the audit timestamp,
                // which is acceptable because the fields are audit-only and
                // never freshness predicates (the ledger + watermark decide
                // freshness, #1249).
                disposedAt: now,
                disposedEvidence: null,
                agentHandouts: [],
                handoutAcks: [],
                handoutReceipts: [],
                dispatchedGeneration: null,
                dispatchedAt: null,
                // #1249: terminal park ends the attempt's evidence snapshot.
                attemptEvidenceWatermark: null,
              },
            });
            if (result.count === 1) {
              await tx.prFixHistory.create({
                data: {
                  itemId: item.id,
                  action: "mark",
                  status: "PARKED",
                  lane: "NORMAL",
                  outcome: "no_progress",
                  note: `Hand-out reclaimed ${reclaimCount} times without acknowledgement (PR_FIX_MAX_RECLAIMS=${maxReclaims}); parked (#1211).`,
                },
              });
            }
            return result;
          });
          if (count === 1) {
            report.parked++;
            // Legacy alias: the reclaim-cap path counted toward `blocked`
            // historically. Bumping both keeps older dashboards working
            // (#1218) while `parked` is the truthful name going forward.
            report.blocked++;
            // Park the GitHub-side surface outside the DB transaction
            // (#1218 review): the other cap paths call surfacePrFixParked
            // here, so the reclaim-cap transition must post the same
            // diagnostic marker so operators see every PARKED item in one
            // place. Best-effort — a missed GitHub write must not block the
            // sweep.
            try {
              await surfacePrFixParked({
                repo: item.repo,
                pr: item.pr,
                reason: item.reason,
                outcome: "no_progress",
                latestNote: `Reclaimed ${reclaimCount} times without acknowledgement; parked (#1211).`,
                context: await buildPrFixBlockedContext(client, { ...item, fixAttempts: item.fixAttempts ?? null }),
              });
            } catch (error) {
              report.errors.push({
                itemId: item.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          } else {
            report.skipped++;
          }
          continue;
        }

        // Reclaim: reopen as a fresh generation. Bump the work identity but do
        // NOT count a fix attempt — the hand-out never reached a worker. The
        // `handoutAcks` pin makes an ack landing in the read→write gap a no-op.
        const acksBeforeReclaim: string[] = Array.isArray(item.handoutAcks) ? item.handoutAcks : [];
        const { count } = await client.$transaction(async (tx) => {
          const result = await tx.prFixQueueItem.updateMany({
            where: {
              id: item.id,
              generation: item.generation,
              status: "QUEUED",
              handoutAcks: { equals: acksBeforeReclaim },
            },
            data: {
              ...freshAttemptGeneration(),
              handoutReclaims: { increment: 1 },
              agentHandouts: [],
              handoutAcks: [],
              handoutReceipts: [],
              postDispatchEvidenceKeys: [],
              dispatchedGeneration: null,
              dispatchedAt: null,
              attemptHeadSha: item.headSha ?? item.attemptHeadSha ?? null,
            },
          });
          if (result.count === 1) {
            await tx.prFixHistory.create({
              data: {
                itemId: item.id,
                action: "reclaim",
                status: "QUEUED",
                lane: "NORMAL",
                note: `Stale unacknowledged hand-out reclaimed; reopened as generation ${item.generation + 1} (#1211).`,
              },
            });
          }
          return result;
        });
        if (count === 1) report.reclaimed++;
        else report.skipped++;
      } catch (error) {
        report.errors.push({
          itemId: item.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Paginate: advance past the last row we saw. A short page means the
    // table is drained for this filter, so stop even before maxPages.
    cursorId = candidates[candidates.length - 1].id;
    if (candidates.length < batchSize) break;
  }

  return report;
}

export async function enqueuePrFixItem(client: PrFixQueueClient, rawInput: EnqueuePrFixInput) {
  // Fold the repo before any read or write: `(repo, pr)` is the ownership key
  // and must not depend on the caller's casing (#1145).
  const input: EnqueuePrFixInput = { ...rawInput, repo: normalizeQueueRepo(rawInput.repo) };
  const lane = normalizePrFixLane(input.lane);
  const type = normalizePrFixType(input.type);
  const nextStatus: PrFixStatus = lane === "NEEDS_HUMAN" ? "BLOCKED" : "QUEUED";

  let previousStatus: PrFixStatus | undefined;
  const item = await client.$transaction(async (tx) => {
    const existing = await tx.prFixQueueItem.findUnique({ where: { repo_pr: { repo: input.repo, pr: input.pr } } });
    // Deliberately the FIRST-read status: the #1134 pinned loop may re-decide
    // from fresher snapshots, and the post-transaction BLOCKED-surfacing
    // comparison keeps its pre-#1134 meaning.
    previousStatus = existing?.status;
    // One wall-clock instant per enqueue decision (#1253): every
    // disposition stamp (`disposedAt`) and reactivation stamp
    // (`recoveryAppliedAt`) this decision writes uses the same `now`, so the
    // pinned-loop re-derivations stay internally consistent instead of
    // drifting per loop iteration.
    const now = new Date();
    if (existing) {
      // buildUpdate: the per-snapshot decision + write payload. Everything the
      // write and the history row depend on is derived from ONE row snapshot,
      // so the #1134 pinned-write loop below can re-derive it from a fresh
      // read instead of replaying a stale decision.
      const buildUpdate = (snapshot: any, ledgerView: EvidenceLedgerView) => {
        // Evidence this item has already recorded must not move it back to
        // QUEUED. The sync re-reads every open PR each sweep, so an event that
        // never goes away — an undismissed CHANGES_REQUESTED review, a comment
        // — otherwise resurrects the item after every resolution and dispatches
        // a coder again 15 minutes later. Observed on misospace/pinchflat#25.
        //
        // The enqueue is still recorded in history: knowing the sync re-observed
        // the evidence is useful, and it is the status flip that causes the
        // churn. New evidence flows through normally.
        //
        // One exception (#940): a `FIXED` item whose PR head hasn't moved since
        // enqueue must be reopened, because the FIXED tombstone is untrusted —
        // a workload reported success without pushing a fix. This is the safety
        // net for the case where markPrFixItem's head-SHA guard ran with
        // missing data or before this re-detection loop kicked in.
        //
        // #1249: when the enqueue carries durable evidence fields, KNOWN means
        // the ledger holds this identity at an UNCHANGED version — not mere
        // membership in the bounded 40-entry cache. A replay of recorded
        // evidence stays inert after eviction (the design's control 8), a new
        // VERSION of a known identity is new evidence (review state change),
        // a new identity repeating an already-recorded signature is recorded
        // but not actionable on its own (control 3/7), and a non-actionable
        // version (dismissed review, cleared condition) is recorded and kept
        // sticky (control 4). Without ledger fields the pre-#1249
        // identity-only cache semantics stand.
        const evidenceKind: PrFixEvidenceKind | null = isPrFixEvidenceKind(input.evidenceKind)
          ? input.evidenceKind
          : null;
        // Condition kinds are persistent states, not one-shot observations:
        // their baseline is the durable per-condition ledger row, and a
        // re-read of the SAME (state, head) must never reopen — even at FIXED
        // with an unchanged head, where the #940 net reopens one-shot evidence
        // (design control 19: a persistent old `dirty` re-discovered after
        // eviction, dispositioned by unrelated review R, stays closed).
        const isConditionKind = evidenceKind === "merge_state" || evidenceKind === "merge_conflict";
        const cacheKnown = !!input.evidenceKey && (snapshot.evidenceKeys ?? []).includes(input.evidenceKey);
        const identityKnown = !!input.evidenceKey && (!!ledgerView?.prior || cacheKnown);
        const versionUnchanged =
          !!input.evidenceKey &&
          (ledgerView?.prior
            ? ledgerView.prior.version === (input.evidenceVersion ?? "")
            : cacheKnown);
        // Repeated text: a NEW identity whose content signature was already
        // recorded under another identity at the same commit. An already-known
        // identity repeating itself is the duplicate-version case below, not
        // this one.
        const isRepeatedText = !!ledgerView?.repeatedSignature && !ledgerView?.prior;
        const isNonActionableVersion = input.evidenceActionable === false;
        const isKnownEvidence = versionUnchanged || isRepeatedText || isNonActionableVersion;
        const headShaUnchanged =
          snapshot.status === "FIXED" &&
          !!snapshot.headSha &&
          typeof input.headSha === "string" &&
          snapshot.headSha === input.headSha;
        // #1303: the #940 net reopens on re-observed ACTIONABLE evidence only.
        // A non-actionable version of a known identity (`evidenceActionable
        // === false`, e.g. a re-read review in an APPROVED/DISMISSED/COMMENTED
        // state) at a FIXED/unchanged head falls through to the sticky
        // `isKnownEvidence` branch (control 4) — the tombstone stays closed.
        const reopenFixStale =
          identityKnown && headShaUnchanged && !isConditionKind && !isNonActionableVersion;

        // STALE/IGNORED stay sticky inline (#1000): terminal states never
        // reactivate on evidence and are operator-only, so they are kept OUT
        // of the recovery module's decision path entirely. The three
        // dispositions below (BLOCKED human hold, PARKED operational hold,
        // WAITING_EXTERNAL) DO route through `evaluateRecovery` (#1253):
        // fresh actionable evidence may reactivate an operational hold
        // (rows 8/13) and must surface as a stale disposition on the holds
        // evidence must not override (rows 9/10/11/16).
        const isTerminalStatus =
          snapshot.status === "STALE" ||
          snapshot.status === "IGNORED";
        const isDispositionedStatus =
          snapshot.status === "BLOCKED" ||
          snapshot.status === "PARKED" ||
          snapshot.status === "WAITING_EXTERNAL";

        // #1253: fresh actionable evidence = a NEW ledger transition that is
        // actionable by kind. `isKnownEvidence` already covers
        // version-unchanged replays, repeated review text, and
        // non-actionable versions; the explicit `evidenceActionable !==
        // false` guard keeps the predicate self-contained even if the
        // isKnownEvidence composition changes.
        const freshEvidence = !isKnownEvidence && input.evidenceActionable !== false;
        const recovery: RecoveryDecision | null = isDispositionedStatus
          ? evaluateRecovery({
              status: snapshot.status,
              outcome: snapshot.outcome ?? null,
              fixAttempts: snapshot.fixAttempts,
              handoutReclaims: snapshot.handoutReclaims,
              hasValidExternalWait:
                snapshot.status === "WAITING_EXTERNAL" ? !!parseStoredExternalWait(snapshot.externalWait) : false,
              freshEvidence,
              // #1253 control 8: a REACTIVATION requires durable-ledger
              // provenance — an observation the pre-#1249 cache semantics
              // call fresh but no ledger row recorded cannot mint one. The
              // HOLD + stale-flag rows keep working on the cache semantics.
              ledgerProvenance: ledgerView.records,
              now,
              disposedAt: snapshot.disposedAt ?? null,
              recoveryAppliedAt: snapshot.recoveryAppliedAt ?? null,
              maxAttempts: maxPrFixAttempts(),
              maxReclaims: maxPrFixReclaims(),
              cooldownMs: recoveryCooldownMs(),
            })
          : null;

        const nextEvidenceKeys = uniqueAppend(snapshot.evidenceKeys ?? [], input.evidenceKey, 40);

        let resolvedStatus: PrFixStatus;
        let resolvedLane: PrFixLane = lane;
        let statusNote: string | null = null;
        let resolvedOutcome: PrFixOutcome | null = null;
        let resolvedDecision: PrFixDecisionContext | null = null;
        let recoveryNote: string | null = null;
        if (isTerminalStatus) {
          resolvedStatus = snapshot.status; // sticky — never resurrect a gone PR
          // Preserve the stored lane: a sticky terminal item keeps its lane,
          // regardless of the enqueue's lane argument (#1218).
          resolvedLane = snapshot.lane ?? resolvedLane;
        } else if (recovery?.action === "reactivate") {
          // #1253 row 8/13: fresh actionable evidence reopens an operational
          // hold as a QUEUED fresh attempt. The lane is preserved from the
          // snapshot when it is NORMAL, else NORMAL — evidence must never
          // manufacture a human lane (never NEEDS_HUMAN).
          resolvedStatus = "QUEUED";
          resolvedLane = snapshot.lane === "NEEDS_HUMAN" ? "NORMAL" : (snapshot.lane ?? "NORMAL");
          recoveryNote = recovery.reason;
        } else if (recovery) {
          // #1253 hold rows (16/9/10/11/15/19-via-inline): the disposition
          // stands. `setStaleDisposition` surfaces fresh evidence without
          // reopening; a hold without the flag leaves the row untouched
          // apart from the evidence recording shared below.
          resolvedStatus = snapshot.status; // sticky
          resolvedLane = snapshot.lane ?? resolvedLane;
          if (recovery.setStaleDisposition) recoveryNote = recovery.reason;
        } else if (reopenFixStale) {
          resolvedStatus = nextStatus; // #940 recovery from a no-progress FIXED tombstone
        } else if (isKnownEvidence) {
          resolvedStatus = snapshot.status; // #25 anti-churn: repeat evidence never flips status
        } else {
          resolvedStatus = nextStatus;
        }

        // Bound the fix loop (#1001). Only a transition back to QUEUED opens a
        // new attempt — more evidence on already-QUEUED work (the rest of one
        // review's inline comments) is the same attempt and never counts
        // (#1103). Past the cap, stop re-queuing and PARK the PR (#1218): this
        // is bounded exhaustion, not a human decision, so it must not carry the
        // needs-human label. Otherwise a human CHANGES_REQUESTED that N
        // automated fixes never satisfy loops forever. This check runs AFTER
        // the recovery decision (#1253): a budget-available reactivation that
        // lands at the cap parks here with the stale-disposition flag (row 9
        // semantics — the fresh evidence that justified the reopen is still
        // unaddressed and must surface to the operator).
        const priorAttempts = snapshot.fixAttempts ?? 1;
        let capParked = false;
        if (
          resolvedStatus === "QUEUED" &&
          snapshot.status !== "QUEUED" &&
          priorAttempts >= maxPrFixAttempts()
        ) {
          resolvedStatus = "PARKED";
          resolvedLane = "NORMAL";
          resolvedOutcome = normalizePrFixOutcome(input.outcome) ?? "no_progress";
          statusNote = `Bounded at ${priorAttempts} fix attempts (PR_FIX_MAX_ATTEMPTS=${maxPrFixAttempts()}); parked instead of re-queuing (#1001).`;
          capParked = true;
        }

        if (resolvedStatus === "BLOCKED") {
          resolvedOutcome = "human_decision";
          resolvedDecision = input.decision ?? snapshot.decisionDetail ?? null;
        } else if (resolvedStatus === "PARKED") {
          resolvedOutcome =
            resolvedOutcome ??
            normalizePrFixOutcome(input.outcome) ??
            normalizePrFixOutcome(snapshot.outcome) ??
            "no_progress";
        }

        // A transition from a non-QUEUED status back to QUEUED is a fresh
        // dispatchable attempt — new work a worker should run — so the item's
        // work-generation identity must change (#1044). Staying QUEUED (e.g.
        // additional evidence on already-pending work) is the same attempt and
        // must keep the identity stable.
        const isFreshAttempt = resolvedStatus === "QUEUED" && snapshot.status !== "QUEUED";

        // Evidence that arrives AFTER this generation was handed to a worker
        // cannot reach the worker already running on it, so record it in
        // postDispatchEvidenceKeys: settlement must open a fresh attempt
        // instead of absorbing it into the in-flight one (#1119).
        // Evidence arriving before hand-out (dispatchedGeneration !==
        // generation, or never dispatched) still joins the same attempt, as
        // before.
        const dispatchedThisGeneration =
          snapshot.dispatchedGeneration != null && snapshot.dispatchedGeneration === snapshot.generation;
        const isPostDispatchNewEvidence =
          !isTerminalStatus &&
          !isKnownEvidence &&
          snapshot.status === "QUEUED" &&
          dispatchedThisGeneration;

        // #1249: a NEW identity, or a version change of a known identity, is a
        // durable ledger transition and claims the next per-item sequence from
        // the SAME snapshot this write is computed on (the pinned loop
        // re-derives it on a contention retry). Re-recording a stored
        // (identity, version) — replayed webhook, at-least-once redelivery,
        // periodic re-read — is inert here: no increment, no restamp.
        const isNewLedgerTransition =
          ledgerView.records &&
          (!ledgerView.prior || ledgerView.prior.version !== (input.evidenceVersion ?? ""));
        const assignedEvidenceSequence = (snapshot.evidenceSequence ?? 0) + 1;

        const data = {
          lane: resolvedLane,
          type,
          status: resolvedStatus,
          reason: input.reason,
          feedback: uniqueAppend(snapshot.feedback ?? [], input.feedback, 12),
          evidenceKeys: nextEvidenceKeys,
          // #1098: the item URL is identity — write-once. Backfill it only
          // while empty; never overwrite an existing URL with a re-enqueue's
          // value (e.g. a CI job URL). A stored CI job URL left by the
          // pre-#1098 ingestion counts as empty, so it heals on the next
          // enqueue instead of being frozen by the guard (#1118).
          ...((!snapshot.url || isActionsRunUrl(snapshot.url)) && itemUrlFromInput(input)
            ? { url: itemUrlFromInput(input) }
            : {}),
          // A fresh attempt gets a fresh per-attempt head baseline (#1074):
          // the head the sync observed in THIS enqueue, else the last one
          // observed (#1104). metadataPatch below keeps refreshing the mutable
          // `headSha` as before — the two columns now mean different things.
          ...(isFreshAttempt
            ? {
                ...freshAttemptGeneration(),
                fixAttempts: { increment: 1 },
                attemptHeadSha: input.headSha ?? snapshot.headSha ?? null,
              }
            : {}),
          // Post-dispatch evidence (#1119): record the key that landed on a
          // dispatched QUEUED item, encoded with the enqueue's observed head
          // (or "unknown") so a check entry can be revalidated at settle time.
          // A fresh attempt resets the list. Mutually exclusive with
          // isFreshAttempt (one requires QUEUED, the other not). Past 20
          // entries appendPostDispatchEvidenceEntry evicts the oldest
          // NON-actionable entry (review/comment entries survive eviction).
          ...(isPostDispatchNewEvidence
            ? {
                postDispatchEvidenceKeys: appendPostDispatchEvidenceEntry(
                  snapshot.postDispatchEvidenceKeys ?? [],
                  encodePostDispatchEvidenceKey(input.evidenceKey, input.headSha),
                  20,
                ),
              }
            : {}),
          // A fresh attempt resets the post-dispatch list AND the per-agent
          // hand-out records: the prior generation's records are dead either
          // way, and the skip check must match only the current identity
          // (#1119, #1133, #1211). It also clears the #1253 recovery
          // bookkeeping — the stale-disposition flag and the disposition
          // audit stamp — so ANY fresh attempt (not just a recovery
          // reactivation; e.g. the #940 reopen of a previously-flagged FIXED
          // row) starts clean.
          ...(isFreshAttempt
            ? {
                postDispatchEvidenceKeys: [],
                agentHandouts: [],
                handoutAcks: [],
                handoutReceipts: [],
                staleDisposition: false,
                disposedAt: null,
                disposedEvidence: null,
              }
            : {}),
          // Structured outcome (#1218): recorded on the same write as the
          // status. Only BLOCKED/PARKED carry one; decisionDetail is persisted
          // only for a human-decision BLOCKED.
          ...(resolvedOutcome ? { outcome: resolvedOutcome } : {}),
          ...(resolvedStatus === "BLOCKED" && resolvedDecision ? { decisionDetail: resolvedDecision } : {}),
          // #1253: a recovery reactivation sheds the disposition it was held
          // under. `retryAt`/`externalWait`/`recoveryAppliedAt`/
          // `staleDisposition` apply EVEN when the cap check above flipped
          // the row to PARKED (the later `capParked` spread re-sets
          // staleDisposition true — spread order makes it win);
          // `outcome`/`decisionDetail` only clear on an actual fresh attempt
          // so the cap park's `no_progress` outcome survives.
          ...(recovery?.action === "reactivate"
            ? {
                retryAt: null,
                externalWait: Prisma.DbNull,
                recoveryAppliedAt: now,
                staleDisposition: false,
                ...(isFreshAttempt ? { outcome: null, decisionDetail: null } : {}),
              }
            : {}),
          // #1253: a hold whose fresh evidence must be surfaced writes the
          // stale-disposition flag without touching status; a cap park (row
          // 9 semantics — the fresh evidence that forced the reopen is still
          // unaddressed) flags too.
          ...(recovery?.action === "hold" && recovery.setStaleDisposition ? { staleDisposition: true } : {}),
          ...(capParked ? { staleDisposition: true } : {}),
          // #1253: disposition stamps — written only when THIS decision
          // transitions the row INTO a disposition from a different status.
          // Idempotent sticky re-marks (the sync's duplicate enqueues onto a
          // held row) never restamp, so they cannot keep pushing a PARKED
          // item's recovery-cooldown anchor forward. Audit-only: never a
          // freshness predicate (#1249).
          ...((resolvedStatus === "PARKED" || resolvedStatus === "BLOCKED") && snapshot.status !== resolvedStatus
            ? { disposedAt: now, disposedEvidence: input.evidenceKey || null }
            : {}),
          // #1249: the ledger row itself is upserted AFTER the (pinned) item
          // write succeeds, with `assignedEvidenceSequence`; the item only
          // carries the atomic counter bump here.
          ...(isNewLedgerTransition ? { evidenceSequence: { increment: 1 } } : {}),
          ...metadataPatch(input),
        };

        return {
          data,
          statusNote,
          reopenFixStale,
          outcome: resolvedOutcome,
          isNewLedgerTransition,
          assignedEvidenceSequence,
          recoveryNote,
          // #1134: the append above is computed from THIS snapshot's key list,
          // so the write must be pinned on exactly that list. The
          // isFreshAttempt reset-to-[] is mutually exclusive with the append
          // and is deliberately NOT pinned.
          pinnedKeys: isPostDispatchNewEvidence ? (snapshot.postDispatchEvidenceKeys ?? []) : null,
          // #1249: a ledger transition claims `assignedEvidenceSequence` from
          // THIS snapshot, so the write is also pinned on the counter value it
          // was derived from — a concurrent transition landing in the gap
          // misses the pin (the atomic increment moved the counter) and the
          // re-decide loop recomputes both the decision and the sequence from
          // the fresh row instead of double-issuing or skipping a sequence.
          pinnedEvidenceSequence: isNewLedgerTransition ? (snapshot.evidenceSequence ?? 0) : null,
          // #1253: a decision computed from a NON-QUEUED snapshot (a sticky
          // hold, a recovery reactivation, FIXED tombstone handling) is also
          // pinned on the generation it decided from — a concurrent
          // requeue/settlement that bumped the generation in the read→write
          // gap misses the pin and the loop re-decides from the fresh row.
          pinnedGeneration: snapshot.status !== "QUEUED" ? (snapshot.generation ?? null) : null,
        };
      };

      // #1134: a plain `update` computed from the read at the top of this
      // branch would clobber a concurrent post-dispatch append that commits in
      // the read→write gap — one entry escapes flagging. So when the write
      // appends post-dispatch evidence, it is pinned on the exact
      // `postDispatchEvidenceKeys` snapshot it read (mirroring markPrFixItem's
      // settle-side pin): a concurrent append in the gap misses the pin, and a
      // bounded in-transaction re-decide re-reads and re-derives EVERY decision
      // (status/lane/attempts/postDispatch) from the fresh row instead of
      // dropping the entry. No network call runs in this loop, so the #1124
      // transaction-timeout hazard does not apply.
      const maxPinnedEnqueueWrites = 3;
      let snapshot = existing;
      let ledgerView = await readEvidenceLedgerView(tx, existing.id, input);
      let decided = buildUpdate(snapshot, ledgerView);
      let updated: any;
      // True when the exhausted-loop fallback below wrote the item without its
      // pins; suppresses the ledger record for that write (see there).
      let unpinnedLedgerWrite = false;
      if (
        decided.pinnedKeys !== null ||
        decided.pinnedEvidenceSequence !== null ||
        decided.pinnedGeneration !== null
      ) {
        let pinnedKeys: string[] | null = decided.pinnedKeys;
        let pinnedEvidenceSequence: number | null = decided.pinnedEvidenceSequence;
        let pinnedGeneration: number | null = decided.pinnedGeneration;
        for (let i = 0; i < maxPinnedEnqueueWrites; i += 1) {
          const { count } = await tx.prFixQueueItem.updateMany({
            where: {
              id: existing.id,
              ...(pinnedKeys !== null ? { postDispatchEvidenceKeys: { equals: pinnedKeys } } : {}),
              ...(pinnedEvidenceSequence !== null ? { evidenceSequence: pinnedEvidenceSequence } : {}),
              ...(pinnedGeneration !== null ? { generation: pinnedGeneration } : {}),
            },
            data: decided.data,
          });
          if (count === 1) {
            updated = await tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
            break;
          }
          // The pin missed: a concurrent append, ledger transition, or
          // generation bump (requeue/settlement) landed in the read→write gap
          // (or the row was deleted). Re-read in-transaction and re-decide
          // from the fresh snapshot — no decision is reused from the stale
          // read.
          const fresh = await tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
          // Row deleted mid-loop: stop re-deciding; the exhausted-loop fallback
          // below runs its plain `update`, which surfaces Prisma's P2025 exactly
          // like the pre-#1134 path did for a deleted row.
          if (!fresh) break;
          snapshot = fresh;
          // Re-read the ledger alongside the fresh row so a concurrent
          // transition that landed in the gap re-decides known/version
          // instead of replaying the stale ledger snapshot's decision.
          ledgerView = await readEvidenceLedgerView(tx, existing.id, input);
          decided = buildUpdate(fresh, ledgerView);
          // Pin the retry against the key list / counter value / generation
          // the NEW write was computed from, so a further gap write no-ops it
          // the same way.
          pinnedKeys = decided.pinnedKeys;
          pinnedEvidenceSequence = decided.pinnedEvidenceSequence;
          pinnedGeneration = decided.pinnedGeneration;
        }
        if (updated === undefined) {
          // The pin kept missing under sustained contention, or the row was
          // deleted mid-loop (then this plain `update` throws P2025, as the
          // pre-#1134 path did). Otherwise: fall back to ONE plain unpinned
          // write from the last recomputed snapshot. This degrades to the
          // pre-#1134 worst case (a concurrent entry in the final gap can
          // still be clobbered) only when the gap loses 3 writes in a row; no
          // network call runs in here, so the #1124 transaction-timeout hazard
          // does not apply. The same degradation now also applies to the
          // operator-facing staleDisposition/recoveryAppliedAt stamps a
          // concurrent decision tried to write — bounded, and self-healing on
          // the next observation.
          await tx.prFixQueueItem.update({ where: { id: existing.id }, data: decided.data });
          updated = await tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
          // #1249: the counter this write bumped belongs to a row nobody pinned,
          // so `assignedEvidenceSequence` is not a position this transaction
          // actually claimed. Recording the ledger row at it could MOVE an
          // existing identity's row backwards (a re-versioned row now restamps
          // its sequence), i.e. bury fresh evidence below a live watermark.
          // Skipping is self-healing: the next observation of this identity
          // still sees the stored version and records the transition then.
          unpinnedLedgerWrite = true;
        }
      } else {
        // No post-dispatch append: the write does not touch the key list, so it
        // stays a plain update, exactly as before #1134.
        updated = await tx.prFixQueueItem.update({ where: { id: existing.id }, data: decided.data });
      }

      // #1249: the durable ledger transition rides the SAME transaction as the
      // item write it was decided from — a rolled-back write rolls back the
      // ledger row, and a committed decision can never miss its ledger row
      // ("concurrent settlement vs enqueue cannot discard an observation").
      // Exception: the unpinned exhausted-loop fallback above, where the write
      // claims no sequence this transaction can vouch for.
      if (decided.isNewLedgerTransition && !unpinnedLedgerWrite) {
        await recordEvidenceTransition(
          tx,
          existing.id,
          input,
          decided.assignedEvidenceSequence,
          ledgerView.repeatedSignature,
        );
      }

      const historyData: Record<string, unknown> = {
        itemId: updated.id,
        action: "enqueue",
        lane: updated.lane,
        reason: input.reason,
        evidenceKey: input.evidenceKey,
      };
      if (decided.outcome) historyData.outcome = decided.outcome;
      if (decided.reopenFixStale) {
        historyData.note = `Reopened: PR head SHA unchanged since FIXED (${snapshot.headSha}); re-detected evidence on a no-progress tombstone (#940).`;
      } else if (decided.statusNote && decided.recoveryNote) {
        // #1253: a cap-flipped reactivation carries BOTH notes — the
        // recovery rationale and the cap park — composed deterministically
        // (recovery reason first) instead of one shadowing the other.
        historyData.note = `${decided.recoveryNote} ${decided.statusNote}`;
      } else if (decided.statusNote) {
        historyData.note = decided.statusNote;
      } else if (decided.recoveryNote) {
        // #1253: the recovery decision's rationale (reactivation or
        // stale-disposition surfacing) is the audit note.
        historyData.note = decided.recoveryNote;
      }
      await tx.prFixHistory.create({ data: historyData });
      return updated;
    }

    // A brand-new item's first durable observation opens the ledger at
    // sequence 1 (#1249); legacy enqueues without evidence fields stay 0.
    const createsEvidenceLedger = !!tx.prFixEvidence && carriesLedgerFields(input);
    const created = await tx.prFixQueueItem.create({
      data: {
        repo: input.repo,
        pr: input.pr,
        lane,
        type,
        status: nextStatus,
        reason: input.reason,
        feedback: [input.feedback],
        evidenceKeys: [input.evidenceKey],
        ...(createsEvidenceLedger ? { evidenceSequence: 1 } : {}),
        // #1098: the item URL is identity (the PR URL) — set it at first
        // enqueue, explicitly, so it is never left to the update patch.
        ...(itemUrlFromInput(input) ? { url: itemUrlFromInput(input) } : {}),
        // A brand-new item is a fresh attempt: capture the head the sync
        // observed now as its immutable per-attempt baseline (#1074).
        attemptHeadSha: input.headSha ?? null,
        // A brand-new NEEDS_HUMAN enqueue is a genuine human decision (#1218).
        ...(nextStatus === "BLOCKED"
          ? { outcome: "human_decision", ...(input.decision ? { decisionDetail: input.decision } : {}) }
          : {}),
        ...metadataPatch(input),
      },
    });
    if (createsEvidenceLedger) {
      await recordEvidenceTransition(tx, created.id, input, 1);
    }
    await tx.prFixHistory.create({
      data: {
        itemId: created.id,
        action: "enqueue",
        lane: created.lane,
        reason: input.reason,
        evidenceKey: input.evidenceKey,
        ...(nextStatus === "BLOCKED" ? { outcome: "human_decision" } : {}),
      },
    });
    return created;
  });

  const wasBlocked = previousStatus === "BLOCKED";
  const wasParked = previousStatus === "PARKED";
  if (item.status === "BLOCKED" && !wasBlocked) {
    const context = await buildPrFixBlockedContext(client, item);
    await surfacePrFixBlocked({
      repo: input.repo,
      pr: input.pr,
      reason: item.reason,
      latestNote: null,
      context,
      decision: item.decisionDetail ?? input.decision ?? null,
    });
  } else if (item.status === "PARKED" && !wasParked) {
    const context = await buildPrFixBlockedContext(client, item);
    await surfacePrFixParked({
      repo: input.repo,
      pr: input.pr,
      reason: item.reason,
      outcome: item.outcome ?? "no_progress",
      latestNote: null,
      context,
    });
  } else if ((wasBlocked || wasParked) && (item.status === "QUEUED" || item.status === "FIXED")) {
    await retractNeedsHuman(input.repo, input.pr, item.status === "FIXED" ? "resolved" : "requeued", "New evidence reopened this item.");
  }
  return item;
}

/**
 * Record a durable ledger transition for an observation that enqueues NO work
 * (#1276), and report whether one was recorded.
 *
 * A review that moves CHANGES_REQUESTED → APPROVED/DISMISSED/COMMENTED is a
 * real observation of the same identity: the ledger must learn that the
 * actionable baseline is gone, or the item keeps a stale actionable version
 * forever. Ingestion previously dropped every non-CHANGES_REQUESTED review, so
 * that transition was never delivered and never recorded.
 *
 * Deliberately NOT an enqueue, in every respect that matters:
 * - no item is created, and no item's status / lane / feedback / outcome /
 *   generation / fixAttempts is touched — the only item write is the atomic
 *   `evidenceSequence` counter bump that claims the ledger row's position;
 * - no `prFixHistory` row: the ledger row IS the audit record for this
 *   transition, and an `enqueue` history row would report work that was never
 *   enqueued (and re-trigger the needs-human/parked surfacing in
 *   `enqueuePrFixItem`, which this path must never do);
 * - no item → no write at all (false). An observation for a PR with no queue
 *   item has nothing to attach a ledger row to, and creating an item here would
 *   manufacture work out of a state transition.
 * - no status filter. A transition is recorded wherever the item currently
 *   sits, and that is deliberate: a settled/awaiting item carries no attempt,
 *   and every terminal disposition clears `attemptEvidenceWatermark`, so its
 *   durable read is empty and a recorded dismissal provably cannot reopen it.
 *   The row is still what makes the review's verdict durable — it is the
 *   baseline a later operator requeue (fresh attempt) and the periodic
 *   reconciliation (#1253) read, instead of a stale actionable version.
 *
 * Replay inertness is the same invariant the enqueue path holds (control 8): a
 * stored (identity, version) pair is not a transition, so there is no counter
 * bump, no restamp, and no write of any kind — the periodic re-read of a
 * dismissed review cannot inflate the counter forever. Only a VERSION change
 * records, and it rides the same transaction as the counter bump that claims its
 * sequence, pinned on the exact counter value the claim was derived from: a
 * concurrent transition landing in the read→write gap misses the pin, and the
 * bounded in-transaction loop re-reads and re-derives instead of double-issuing
 * a sequence. A ledger row is never written for a sequence the write did not
 * claim — the pin gives up (false) rather than writing an unclaimed one.
 */
export async function recordPrFixEvidenceBaseline(
  client: PrFixQueueClient,
  rawInput: EvidenceObservation & { repo: string; pr: number },
): Promise<boolean> {
  // Same identity fold as enqueuePrFixItem (#1145): (repo, pr) is the ownership
  // key and must not depend on the caller's casing.
  const input = { ...rawInput, repo: normalizeQueueRepo(rawInput.repo) };
  // Fail closed exactly like the enqueue path: without a complete evidence
  // block there is no way to tell a re-read from a transition, and a client
  // without the ledger surface has nowhere to record.
  if (!carriesLedgerFields(input) || !client.prFixEvidence) return false;

  // Non-transactional pre-check (#1276 review): a sync sweep re-observes every
  // review on every open PR, and almost all of them are replays of a stored
  // version or have no item at all. Answering those without opening a
  // transaction keeps the record-only path's cost proportional to real
  // transitions. Purely an optimization — the transaction below re-reads and
  // re-checks, so a lost race still lands on the in-transaction decision.
  const precheck = await client.prFixQueueItem.findUnique({
    where: { repo_pr: { repo: input.repo, pr: input.pr } },
  });
  if (!precheck) return false;
  const precheckLedger = await readEvidenceLedgerView(client, precheck.id, input);
  if (precheckLedger.prior && precheckLedger.prior.version === (input.evidenceVersion ?? "")) {
    return false;
  }

  // #1134/#1249 pin budget, shared with the enqueue path: three in-transaction
  // retries are enough to ride out a concurrent transition, and giving up is
  // safe because nothing was written.
  const maxPinnedBaselineWrites = 3;

  return client.$transaction(async (tx) => {
    if (!tx.prFixEvidence) return false;
    let snapshot = await tx.prFixQueueItem.findUnique({
      where: { repo_pr: { repo: input.repo, pr: input.pr } },
    });
    // No item, no write — and no item is ever created for a record-only
    // observation.
    if (!snapshot) return false;

    let ledgerView = await readEvidenceLedgerView(tx, snapshot.id, input);
    if (!ledgerView.records) return false;

    for (let attempt = 0; attempt < maxPinnedBaselineWrites; attempt += 1) {
      // Replay of a stored (identity, version): inert. Re-read every attempt so
      // a transition that landed in a previous attempt's gap is seen here.
      if (ledgerView.prior && ledgerView.prior.version === (input.evidenceVersion ?? "")) {
        return false;
      }
      const claimedSequence = (snapshot.evidenceSequence ?? 0) + 1;
      const { count } = await tx.prFixQueueItem.updateMany({
        where: { id: snapshot.id, evidenceSequence: snapshot.evidenceSequence ?? 0 },
        data: { evidenceSequence: { increment: 1 } },
      });
      if (count === 1) {
        await recordEvidenceTransition(tx, snapshot.id, input, claimedSequence, ledgerView.repeatedSignature);
        return true;
      }
      // The pin missed (concurrent transition in the read→write gap, or the row
      // was deleted). Re-read in-transaction and re-derive; nothing has been
      // written by the missed `updateMany`, so there is nothing to unwind.
      const fresh = await tx.prFixQueueItem.findUnique({ where: { id: snapshot.id } });
      if (!fresh) return false;
      snapshot = fresh;
      ledgerView = await readEvidenceLedgerView(tx, snapshot.id, input);
    }
    // Sustained contention: give up rather than write a ledger row for a
    // sequence no item write claimed. The next sweep re-observes and records it.
    return false;
  });
}

/**
 * Drop the needs-human label and fold the BLOCKED marker comment whenever an
 * item leaves BLOCKED. Only requeue used to do this, so an item settled FIXED
 * by a mark kept `needs-human` on an approved PR (#1105). Never throws.
 */
async function retractNeedsHuman(repo: string, pr: number, outcome: PrFixUnblockOutcome, note?: string | null) {
  await surfacePrFixUnblocked(repo, pr, outcome, note ?? undefined).catch((error) => {
    console.error(`pr-fix-queue needs-human cleanup error for ${repo}#${pr}:`, error);
  });
}

export async function createLinkedPrFixItem(
  client: PrFixQueueClient,
  rawInput: CreateLinkedPrFixInput,
): Promise<{ item: any; created: boolean }> {
  // Same identity fold as enqueuePrFixItem (#1145).
  const input: CreateLinkedPrFixInput = { ...rawInput, repo: normalizeQueueRepo(rawInput.repo) };
  try {
    const item = await client.$transaction(async (tx) => {
      const item = await tx.prFixQueueItem.create({
        data: {
          repo: input.repo,
          pr: input.pr,
          issue: input.issue,
          lane: input.lane,
          // The caller picks the lane's type (#1327): a conflicted linked PR
          // materializes as REBASE, everything else stays the ordinary fix
          // lane (OTHER).
          type: normalizePrFixType(input.type),
          status: "QUEUED",
          reason: input.reason,
          feedback: input.feedback,
          evidenceKeys: [input.evidenceKey],
          ...(input.url ? { url: input.url } : {}),
          ...(input.title ? { title: input.title } : {}),
          headSha: input.headSha ?? null,
          attemptHeadSha: input.headSha ?? null,
        },
      });
      await tx.prFixHistory.create({
        data: {
          itemId: item.id,
          action: "enqueue",
          lane: item.lane,
          reason: input.reason,
          evidenceKey: input.evidenceKey,
          note: "Materialized from linked PR health scan.",
        },
      });
      return item;
    });
    return { item, created: true };
  } catch (error) {
    // The unique (repo, pr) constraint is the ownership boundary. If another
    // enqueue won, return its row without mutating or reopening it. A
    // transaction-level P2002 may also come from history, so only treat it as
    // the ownership race when the unique-key winner can be read back.
    if ((error as { code?: string })?.code !== "P2002") throw error;
    const item = await client.prFixQueueItem.findUnique({
      where: { repo_pr: { repo: input.repo, pr: input.pr } },
    });
    if (!item) throw error;
    return { item, created: false };
  }
}

export async function listQueuedPrFixItems(client: PrFixQueueClient, options: { lane?: string | null; includeBlocked?: boolean; prioritizeByType?: boolean } = {}) {
  const lane = options.lane ? normalizePrFixLane(options.lane) : undefined;
  const now = new Date();
  await reactivateDueExternalWaits(client, now);
  const status = options.includeBlocked ? { in: ["QUEUED", "BLOCKED", "PARKED", "WAITING_EXTERNAL"] } : "QUEUED";

  const items = await client.prFixQueueItem.findMany({
    where: { status, ...(lane ? { lane } : {}) },
  });

  // Sort by type priority first, then by queuedAt
  if (options.prioritizeByType !== false) {
    items.sort((a, b) => {
      const aPriority = PR_FIX_TYPE_PRIORITY[normalizePrFixType(a.type)] ?? 3;
      const bPriority = PR_FIX_TYPE_PRIORITY[normalizePrFixType(b.type)] ?? 3;
      if (aPriority !== bPriority) return aPriority - bPriority;
      // Within same type, oldest first
      return new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime();
    });
  } else {
    items.sort((a, b) => new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime());
  }

  if (options.includeBlocked && items.some((item) => item.status === "WAITING_EXTERNAL") && client.prFixHistory.findMany) {
    const waits = await client.prFixHistory.findMany({
      where: { itemId: { in: items.filter((item) => item.status === "WAITING_EXTERNAL").map((item) => item.id) }, status: "WAITING_EXTERNAL", action: "mark" },
      orderBy: { at: "desc" },
    });
    const latestNotes = new Map<string, string | null>();
    for (const row of waits) if (!latestNotes.has(row.itemId)) latestNotes.set(row.itemId, row.note ?? null);
    for (const item of items) if (item.status === "WAITING_EXTERNAL") item.latestNote = latestNotes.get(item.id) ?? null;
  }

  // #1250: surface the structured-wait contract (and its absence) on every
  // listed WAITING_EXTERNAL item. `externalWait` carries the parsed bounded
  // contract; `legacyWait` flags pre-contract free-text waits for operator
  // action — surfaced read-only, never auto-downgraded.
  for (const item of items) {
    if (item.status !== "WAITING_EXTERNAL") continue;
    item.externalWait = parseStoredExternalWait(item.externalWait);
    item.legacyWait = item.externalWait === null;
  }

  return items;
}

/**
 * #1327: the mechanical rebase lane is concurrency 1 with no fan-out — the
 * issue scopes the lane to a bounded local worker, not a fleet. Hand-out is
 * gated on this check: a REBASE candidate waits while ANY QUEUED row whose
 * DISPATCHED lane (`attemptType`, falling back to `type` for rows stamped
 * before the column existed) is REBASE carries a live hand-out record —
 * including the candidate itself. The self case matters: re-handing an
 * already-live REBASE to a second worker would put two `--force-with-lease`
 * pushes on one branch.
 *
 * "Live" means a non-empty `agentHandouts` list within the lane's hand-out
 * timeout (`PR_FIX_HANDOUT_TIMEOUT_MS`, same bound the reclaim sweep uses),
 * anchored on `dispatchedAt` — the attempt's start, stamped at hand-out.
 * `updatedAt` is deliberately NOT the anchor: re-observation enqueues refresh
 * it, which would keep a dead hand-out blocking the lane forever. The timeout
 * is what keeps the gate from inheriting the queue's oldest stranding mode:
 * an ACKNOWLEDGED hand-out is deliberately never reclaimed (#1211 — a live
 * worker owns its generation), so an acked-then-crashed rebase would
 * otherwise block EVERY rebase dispatch forever. A legitimately long rebase
 * past the timeout may transiently share the lane — accepted best-effort
 * semantics.
 *
 * Keying on `attemptType` (not the row's mutable `type`) matters: enqueue
 * overwrites `type` on every re-observation, so a mid-attempt flip must
 * neither free the lane from a live rebase (REBASE -> other) nor let an
 * in-flight ordinary fix attempt block it (other -> REBASE).
 *
 * Admission is SERIALIZED at the database boundary: next-task issues every
 * REBASE hand-out inside `withRebaseLaneAdmission`, which holds a
 * transaction-scoped advisory lock across this read AND the hand-out write.
 * A competing poll therefore never passes this check before the winner's
 * hand-out commits — concurrency 1 is enforced, not preflight-advisory.
 * The lock is MANDATORY and the admission fails CLOSED: when the lock
 * cannot be taken the hand-out is deferred (the next poll retries it)
 * rather than issued through an unlocked check-then-write. So the only
 * remaining best-effort window is the hand-out TIMEOUT above (a live
 * hand-out older than the timeout is not counted), not an admission path.
 */
export async function hasInFlightRebaseHandout(
  client: PrFixQueueClient,
  options: { now?: Date } = {},
): Promise<boolean> {
  const now = (options.now ?? new Date()).getTime();
  const staleBefore = now - prFixHandoutTimeoutMs();
  const rows = await client.prFixQueueItem.findMany({
    where: { status: "QUEUED", OR: [{ type: "REBASE" }, { attemptType: "REBASE" }] },
  });
  return rows.some((row: { attemptType?: unknown; type?: unknown; agentHandouts?: unknown; dispatchedAt?: unknown }) => {
    if ((row.attemptType ?? row.type) !== "REBASE") return false;
    if (!Array.isArray(row.agentHandouts) || row.agentHandouts.length === 0) return false;
    // A hand-out with no stamped start is anomalous: next-task stamps
    // `dispatchedAt` BEFORE pushing the hand-out record, and the only gap
    // left is a stamp write that throws while the later push succeeds. Such
    // a row is invisible to the reclaim sweep too (`dispatchedAt: { lt }`
    // never matches NULL), so counting it live would re-open the
    // forever-block door the timeout exists to close. Skip it instead: the
    // worst case is the transient concurrency-2 window the lane already
    // accepts best-effort, and the next dispatch re-stamps the row properly.
    if (!row.dispatchedAt) return false;
    return new Date(row.dispatchedAt as string | number | Date).getTime() >= staleBefore;
  });
}

/**
 * Verify that the PR head SHA at fix-time differs from the per-attempt
 * baseline head. Returns one of:
 *
 * - `"passed"` — current head differs from the baseline head. The fix is
 *   real.
 * - `"no-record"` — the caller has no baseline to compare against (legacy
 *   rows, or a fresh attempt that was captured without a head record).
 *   Guard cannot run; we accept.
 * - `"head-unchanged"` — baseline equals current head. Workload reported
 *   success but pushed nothing. Caller must refuse the FIXED.
 * - `"head-unavailable"` — GitHub fetch failed or returned no headSha.
 *   Guard could not run; we accept (better than stranding).
 *
 * #1074: the baseline passed in is the immutable per-attempt
 * `attemptHeadSha` (falling back to the mutable `headSha`), captured when
 * the attempt became dispatchable — NOT the raw enqueue-time `headSha`,
 * which every re-observation overwrites and which let a worker pushing to
 * exactly the recorded SHA defeat the guard by comparison against itself.
 *
 * The `enqueuePrFixItem` path keeps both columns up to date; the
 * `tasks/report` settlement path runs through this function via
 * `markPrFixItem`, so the same guard fires regardless of who called the
 * transition.
 *
 * Best-effort by design: it does not throw. The caller decides what to do
 * with `"head-unchanged"` (refuse the FIXED before any write lands).
 */
export async function assertPrHeadMovedForFix(
  client: PrFixQueueClient,
  repo: string,
  pr: number,
  recordedHeadSha: string | null | undefined,
  note: string | null,
): Promise<"passed" | "no-record" | "head-unchanged" | "head-unavailable"> {
  // Empty record → guard cannot run. This is the legacy path: rows enqueued
  // before #940, plus any enqueue that did not pass headSha (e.g. a future
  // fixture). Don't refuse on this — the FIXED tombstone stays meaningful.
  if (!recordedHeadSha || typeof recordedHeadSha !== "string") {
    return "no-record";
  }

  let currentHeadSha: string | null;
  try {
    currentHeadSha = await fetchPullRequestHeadSha(repo, pr);
  } catch (error) {
    // GitHub unreachable or returned an error. Accept the transition rather
    // than refuse — the bridge reconcile pass will catch a stale FIXED on
    // its next sweep. Log for ops.
    console.warn(`[pr-fix-queue] head SHA check failed for ${repo}#${pr}:`, error instanceof Error ? error.message : error);
    return "head-unavailable";
  }

  if (currentHeadSha === null) {
    // GitHub returned 200 but no head.sha (unknown shape). Same as above.
    return "head-unavailable";
  }

  if (currentHeadSha === recordedHeadSha) {
    // PR head didn't move. Workload reported success without pushing anything.
    return "head-unchanged";
  }

  return "passed";
}

/**
 * Result of `markPrFixItem` (#1074). A mark either mutated the row
 * (`mutated: true`, with the fresh row) or was skipped without any write
 * (`mutated: false`): `not-found` when no item matches, `generation-mismatch`
 * when an `expectedGeneration` was supplied and the row's generation no
 * longer matches (the attempt was re-issued between read and write).
 */
export type MarkPrFixResult =
  | { mutated: true; item: any }
  | { mutated: false; reason: "generation-mismatch" | "not-found" };

export async function markPrFixItem(
  client: PrFixQueueClient,
  rawInput: MarkPrFixInput,
): Promise<MarkPrFixResult> {
  // Fold the repo so the repo_pr lookup and every pinned write agree on the
  // same identity regardless of the caller's casing (#1145).
  const input: MarkPrFixInput = { ...rawInput, repo: normalizeQueueRepo(rawInput.repo) };
  const nextStatus = normalizePrFixStatus(input.status) as PrFixStatus | null;
  if (!nextStatus) throw new Error("Invalid status");
  if (nextStatus === "WAITING_EXTERNAL" && (input.expectedGeneration === undefined || input.expectedGeneration === null)) {
    throw new Error("generation is required for WAITING_EXTERNAL");
  }

  const expectedGeneration =
    input.expectedGeneration !== undefined && input.expectedGeneration !== null
      ? input.expectedGeneration
      : undefined;

  // Load the row BEFORE any write: the #940/#1074 guard and the
  // generation-conditional writes both decide on this snapshot, and every
  // write below revalidates at commit time.
  const existing = await client.prFixQueueItem.findUnique({ where: { repo_pr: { repo: input.repo, pr: input.pr } } });
  if (!existing) return { mutated: false, reason: "not-found" };

  // BLOCKED is reserved for a genuine human decision (#1218): lane NEEDS_HUMAN,
  // outcome human_decision, surfaced with the needs-human label + marker. PARKED
  // is bounded exhaustion or an operational failure: lane NORMAL, no
  // needs-human label. The bridge's ACTIONABLE_LANES filter skips BLOCKED.
  const data: Record<string, unknown> = { status: nextStatus };
  // The ONE place an item's status becomes WAITING_EXTERNAL (the write is the
  // pinned updateMany further down, fed by `data`): the external-wait contract
  // is validated here and nowhere else, so every route that waits (mark,
  // worker report) shares one fail-closed downgrade. Pinned by
  // "WAITING_EXTERNAL has a single status writer (#1276 review)" in
  // src/lib/pr-fix-evidence-requirements.test.ts, which fails if any other
  // production module assigns this status directly.
  if (nextStatus === "WAITING_EXTERNAL") {
    // Idempotent duplicate for the same generation: never extend the
    // cooldown, never overwrite the recorded contract or note (#1231).
    if (existing.status === "WAITING_EXTERNAL" && existing.generation === expectedGeneration) {
      return { mutated: true, item: existing };
    }
    if (existing.status !== "QUEUED") return { mutated: false, reason: "generation-mismatch" };

    // #1250: a NEW wait must name a concrete, independently verifiable
    // dependency. "We have not pushed a patch" is not one. A dependency-less
    // or malformed wait fails closed to a PARKED/`invalid_wait` disposition —
    // an operational hold an operator must requeue, never a human BLOCKED
    // decision and never a six-hour fake wait. The downgrade is
    // generation-pinned below so it cannot clobber a newer attempt.
    const parsedWait = parseExternalWaitInput(input.externalWait);
    if (!parsedWait.ok) {
      const downgradeNote = `Fail-closed park: external wait without a verifiable dependency (${parsedWait.reason}); operator requeue required (#1250).${input.note ? ` ${input.note}` : ""}`;
      const downgraded = await client.$transaction(async (tx) => {
        const { count } = await tx.prFixQueueItem.updateMany({
          where: { id: existing.id, status: "QUEUED", generation: expectedGeneration },
          data: {
            status: "PARKED",
            lane: "NORMAL",
            outcome: "invalid_wait",
            decisionDetail: null,
            retryAt: null,
            // #1253: disposition audit stamp (fail-closed park). Stamped
            // unconditionally at every disposition write site — see the
            // enqueue-side note.
            disposedAt: new Date(),
            disposedEvidence: null,
            // A park is a terminal disposition: drop the attempt's evidence
            // snapshot like every other sticky PARKED settle, so a later
            // maintainer-tier mark never reopens on the parked attempt's
            // cache or a stale watermark (#1249/#1250 boundary).
            attemptEvidenceWatermark: null,
            postDispatchEvidenceKeys: [],
            // #1250 review: a nullable JSON column must receive SQL NULL
            // (Prisma.DbNull), not a JSON null document — plain `null` on a
            // Json field is rejected by the Prisma runtime for updateMany.
            externalWait: Prisma.DbNull,
          },
        });
        if (count !== 1) return null;
        await tx.prFixHistory.create({
          data: { itemId: existing.id, action: "mark", status: "PARKED", lane: existing.lane, outcome: "invalid_wait", note: downgradeNote },
        });
        return tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
      });
      if (downgraded) {
        // Mirror the shared PARKED tail: surface the fail-closed park on the
        // PR so operators see why the item stopped (#1250).
        const context = await buildPrFixBlockedContext(client, downgraded);
        await surfacePrFixParked({
          repo: input.repo,
          pr: input.pr,
          reason: downgraded.reason,
          outcome: "invalid_wait",
          latestNote: input.note ?? null,
          context,
        });
        return { mutated: true, item: downgraded };
      }
      const latest = await client.prFixQueueItem.findUnique({ where: { id: existing.id } });
      if (latest?.status === "WAITING_EXTERNAL" && latest.generation === expectedGeneration) return { mutated: true, item: latest };
      return { mutated: false, reason: "generation-mismatch" };
    }
    data.retryAt = new Date(Date.now() + externalWaitCooldownMs());
    data.externalWait = parsedWait.wait;
    data.outcome = null;
    data.decisionDetail = null;
    data.postDispatchEvidenceKeys = [];
    // #1253: disposition audit stamp (the write site below is the single
    // WAITING_EXTERNAL status writer). Audit-only, never a freshness
    // predicate (#1249).
    data.disposedAt = new Date();
    data.disposedEvidence = null;
    // A wait is not a hand-out: drop the previous attempt's evidence snapshot
    // so durable freshness never keys off a superseded boundary (#1249).
    data.attemptEvidenceWatermark = null;
    data.dispatchedGeneration = null;
    data.dispatchedAt = null;
    data.agentHandouts = [];
    data.handoutReceipts = [];
    data.handoutAcks = [];
  }

  // #1218 review: a recorded human decision (BLOCKED) and a recorded operator
  // PARKED are sticky to worker settlements — the commit-time status filter
  // below refuses a worker-tier BLOCKED/PARKED mark on a row that already
  // records BLOCKED/PARKED/FIXED, so a same-generation second mark (or a
  // read→write gap that flipped the row) cannot erase the decision.
  // Reclassification by an operator is a separate, explicitly-authenticated
  // path (`allowStickyReclassify` honored only when `actorTier === "maintainer"`);
  // worker callers cannot bypass the pin.
  const isOperatorReclassify =
    input.actorTier === "maintainer" && input.allowStickyReclassify === true;
  // #1218 review (follow-up): the pin covers every terminal outcome a worker
  // token may submit — FIXED and STALE as well as BLOCKED/PARKED. A recorded
  // BLOCKED/PARKED settlement never bumps the generation, so a same-generation
  // worker FIXED (happy path, refused-head rollback, evidence reopen/force) or
  // STALE mark could otherwise release or erase the recorded decision.
  // BLOCKED/PARKED keep the explicit opt-in contract from the previous
  // review: even a maintainer must pass allowStickyReclassify to overwrite a
  // recorded BLOCKED/PARKED classification. FIXED/STALE are pinned for every
  // non-maintainer caller; maintainer-tier transitions (operator resolution
  // of a blocked item, internal reconciliation) stay unpinned.
  // #1340: the pin is relaxed in exactly one direction — a non-operator
  // (worker-tier, or maintainer without reclassify opt-in) BLOCKED mark may
  // land on a row that records PARKED, escalating a bounded no-progress park
  // into a genuine human decision (a run that parks for no progress and later
  // ends NeedsHuman reports `blocked`; refusing the escalation would strand
  // the needs-human state). BLOCKED stays sticky against every other mark —
  // a recorded BLOCKED/FIXED row still rejects worker BLOCKED — and
  // de-escalation (BLOCKED → PARKED/QUEUED) remains operator-only via
  // `allowStickyReclassify`. PARKED marks stay QUEUED-only: a park never
  // overwrites any recorded classification.
  const stickySettlementStatusFilter: Record<string, unknown> =
    (nextStatus === "BLOCKED" || nextStatus === "PARKED") && !isOperatorReclassify
      ? { status: nextStatus === "BLOCKED" ? { in: ["QUEUED", "PARKED"] } : "QUEUED" }
      : (nextStatus === "FIXED" || nextStatus === "STALE") && input.actorTier !== "maintainer"
        ? { status: "QUEUED" }
        : {};

  if (nextStatus === "WAITING_EXTERNAL") {
    const result = await client.$transaction(async (tx) => {
      const { count } = await tx.prFixQueueItem.updateMany({
        where: { id: existing.id, status: "QUEUED", generation: expectedGeneration },
        data,
      });
      if (count !== 1) return null;
      await tx.prFixHistory.create({ data: { itemId: existing.id, action: "mark", status: "WAITING_EXTERNAL", lane: existing.lane, note: input.note ?? null } });
      return tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
    });
    if (result) return { mutated: true, item: result };
    const latest = await client.prFixQueueItem.findUnique({ where: { id: existing.id } });
    if (latest?.status === "WAITING_EXTERNAL" && latest.generation === expectedGeneration) return { mutated: true, item: latest };
    return { mutated: false, reason: "generation-mismatch" };
  }

  // Reopen a settlement as a fresh attempt on post-dispatch evidence (#1119):
  // the guarded write, the cap give-up, and the history row, all inside one
  // tiny transaction the caller passes in. Pinned on the row's id, its
  // expected generation (#1074), AND the exact post-dispatch evidence
  // snapshot the actionability decision was made on — evidence recorded
  // between the actionability read and this write no-ops the reopen instead
  // of being silently cleared (#1124 review). Returns the fresh row, or null
  // when the pin misses; the caller then feeds the miss into the bounded
  // re-decision loop below. `noteSuffix` is appended to the note when the
  // reopen is taken from the settle-gap retry.
  const writeReopen = async (tx: any, row: any, noteSuffix = ""): Promise<any | null> => {
    const reopenCapped = (row.fixAttempts ?? 1) >= maxPrFixAttempts();
    const reopenData: Record<string, unknown> = reopenCapped
      ? {
          status: "PARKED",
          lane: "NORMAL",
          outcome: "no_progress",
          decisionDetail: null,
          // #1253: disposition audit stamp (capped give-up park).
          disposedAt: new Date(),
          disposedEvidence: null,
          postDispatchEvidenceKeys: [],
          agentHandouts: [],
          handoutAcks: [],
          handoutReceipts: [],
          attemptEvidenceWatermark: null,
        }
      : {
          status: "QUEUED",
          lane: "NORMAL",
          ...freshAttemptGeneration(),
          fixAttempts: { increment: 1 },
          attemptHeadSha: row.headSha ?? row.attemptHeadSha ?? null,
          outcome: null,
          decisionDetail: null,
          postDispatchEvidenceKeys: [],
          // Fresh attempt: per-agent hand-out records for the consumed
          // generation must not suppress its re-dispatch (#1133), and the
          // prior generation's acknowledgements are dead (#1211).
          agentHandouts: [],
          handoutAcks: [],
          handoutReceipts: [],
        };
    const { count } = await tx.prFixQueueItem.updateMany({
      where: {
        id: row.id,
        ...(expectedGeneration !== undefined ? { generation: expectedGeneration } : {}),
        ...stickySettlementStatusFilter,
        postDispatchEvidenceKeys: { equals: row.postDispatchEvidenceKeys ?? [] },
      },
      data: reopenData,
    });
    if (count !== 1) return null;
    await tx.prFixHistory.create({
      data: {
        itemId: row.id,
        action: "mark",
        status: reopenData.status,
        lane: reopenData.lane,
        outcome: reopenCapped ? "no_progress" : null,
        note:
          (reopenCapped
            ? `New evidence arrived after this attempt was handed out, but bounded at ${row.fixAttempts ?? 1} fix attempts (PR_FIX_MAX_ATTEMPTS=${maxPrFixAttempts()}); parked (#1119).`
            : `New evidence arrived after this attempt was handed out; reopened as a fresh attempt at the current head (#1119).`) + noteSuffix,
      },
    });
    return tx.prFixQueueItem.findUnique({ where: { id: row.id } });
  };

  const surfaceReopen = async (before: any, reopened: any) => {
    const reopenCapped = (before.fixAttempts ?? 1) >= maxPrFixAttempts();
    if (reopenCapped && before.status !== "BLOCKED" && before.status !== "PARKED") {
      const context = await buildPrFixBlockedContext(client, reopened);
      await surfacePrFixParked({
        repo: input.repo,
        pr: input.pr,
        reason: reopened.reason,
        outcome: "no_progress",
        latestNote: input.note ?? null,
        context,
      });
    } else if (!reopenCapped) {
      // Leaving (a would-be) settlement back to a live QUEUED attempt: make sure a
      // needs-human marker is not left behind and surface the new attempt (#1119).
      await retractNeedsHuman(input.repo, input.pr, "requeued", input.note);
    }
  };

  // Only FIXED settlements reopen on fresh post-dispatch evidence (#1218):
  // human-decision BLOCKED and operational PARKED are sticky — a fresh
  // post-dispatch entry on a sticky settlement stays recorded on the row for
  // operator visibility, and only an explicit operator requeue (or a
  // maintainer mark to QUEUED) releases it. A capped FIXED still gives up
  // (PARKED), matching the other fresh-attempt caps; BLOCKED/PARKED skip the
  // cap path entirely. The head fetch inside the actionability check always
  // runs OUTSIDE any transaction: Prisma's ~5s interactive-transaction
  // timeout must never have to span a GitHub round-trip (#1124 review).
  const settlesAttempt = nextStatus === "FIXED" || nextStatus === "BLOCKED" || nextStatus === "PARKED";
  const reopenEligible = nextStatus === "FIXED";
  // #1249: the durable ledger backstops the bounded 20-entry cache. Actionable
  // transitions recorded AFTER this attempt's snapshot watermark reopen even
  // if the cache evicted them (or the hand-out raced the enqueue): a review
  // first discovered after the worker wrote FIXED is fresh even when its
  // forge-side submitted_at predates the settlement, while a replay never
  // minted a transition and stays inert forever. Without a watermark (legacy
  // rows, lost best-effort stamps) the pre-#1249 cache-only decision stands —
  // the durable set can never introduce a false reopen for an unbounded
  // attempt, only remove false silences.
  const durablePostDispatchEntries = reopenEligible
    ? await listDurablePostDispatchEntries(client, existing)
    : [];
  const settleEvidenceEntries = Array.from(
    new Set([...(existing.postDispatchEvidenceKeys ?? []), ...durablePostDispatchEntries]),
  );
  const reopenOnPostDispatch =
    reopenEligible &&
    (await hasActionablePostDispatchEvidence(settleEvidenceEntries, input.repo, input.pr));
  // The initial reopen attempt can miss its keys/generation pin when evidence
  // is recorded between the check above and the write. That is not a
  // generation-mismatch: fall into the bounded re-decision loop below rather
  // than returning no-mutation (#1124 review).
  let reopenPinnedMissed = false;
  if (reopenOnPostDispatch) {
    const reopened = await client.$transaction(async (tx) => writeReopen(tx, existing));
    if (reopened) {
      await surfaceReopen(existing, reopened);
      return { mutated: true, item: reopened };
    }
    reopenPinnedMissed = true;
  }

  if (nextStatus === "BLOCKED") {
    data.lane = "NEEDS_HUMAN";
    data.outcome = "human_decision";
    // #1340: a BLOCKED mark without a structured decision still records a
    // decision context — the needs-human surface and the operator need a
    // question and evidence to act on, so synthesize them from the mark's
    // diagnostic instead of leaving the payload empty.
    // The synthesized evidence is bounded like every other evidence field;
    // a structured `input.decision` passes through unchanged (validated
    // upstream).
    const synthesizedEvidence =
      (input.note ?? "").trim() ||
      existing.reason ||
      "The worker reported a human decision without a diagnostic.";
    data.decisionDetail =
      input.decision ??
      {
        question: "The worker ended this PR-fix attempt needing a human decision; review the diagnostic and decide how to proceed.",
        evidence: synthesizedEvidence.slice(0, MAX_EVIDENCE_LENGTH),
      };
    // #1253: disposition audit stamp (human-decision BLOCKED).
    data.disposedAt = new Date();
    data.disposedEvidence = null;
  } else if (nextStatus === "PARKED") {
    data.lane = "NORMAL";
    data.outcome = resolvePrFixOutcome("PARKED", input.outcome);
    data.decisionDetail = null;
    // #1253: disposition audit stamp (operational park).
    data.disposedAt = new Date();
    data.disposedEvidence = null;
  } else if (nextStatus === "QUEUED") {
    data.lane = "NORMAL";
    // A mark back to QUEUED releases a BLOCKED/PARKED item: clear the outcome
    // and human-decision payload (#1218). A WAITING_EXTERNAL item leaving its
    // wait also sheds the consumed external-wait contract (#1250).
    data.outcome = null;
    data.decisionDetail = null;
    data.externalWait = Prisma.DbNull;
    // #1253: an operator release (maintainer mark to QUEUED) clears the
    // recovery bookkeeping along with everything else the hold recorded.
    data.staleDisposition = false;
    data.disposedAt = null;
    data.disposedEvidence = null;
    data.recoveryAppliedAt = null;
    // Marking a non-QUEUED item back to QUEUED creates a fresh dispatchable
    // attempt (same semantics as requeuePrFixItem) — bump the generation
    // alongside the status flip so the work identity changes (#1044).
    if (existing.status !== "QUEUED") {
      Object.assign(data, freshAttemptGeneration(), { fixAttempts: { increment: 1 } });
      // Baseline the fresh attempt NOW, from the caller's head or the last
      // observed one. Leaving it null let the guard fall back to the mutable
      // headSha, which the next sync overwrites with the worker's own push —
      // refusing a real fix as "pushed nothing" (#1074, #1104).
      data.attemptHeadSha = input.attemptHeadSha ?? existing.headSha ?? null;
      // A fresh attempt must not carry post-dispatch evidence recorded for a
      // prior generation (#1119), nor per-agent hand-out records whose skip
      // match must not survive the identity change (#1133).
      data.postDispatchEvidenceKeys = [];
      data.agentHandouts = [];
      data.handoutReceipts = [];
      data.handoutAcks = [];
    }
    // QUEUED → QUEUED: leave the key list untouched — the entries still refer
    // to the current generation and must survive the mark.
  } else if (nextStatus === "STALE" || nextStatus === "IGNORED") {
    // Terminal: the recorded entries are moot; clear them (#1119). The
    // #1253 recovery bookkeeping dies with the item's active life too.
    data.postDispatchEvidenceKeys = [];
    data.outcome = null;
    data.decisionDetail = null;
    data.staleDisposition = false;
    data.disposedAt = null;
    data.disposedEvidence = null;
    data.recoveryAppliedAt = null;
  } else {
    // FIXED (and any other status): a settled item carries no BLOCKED/PARKED
    // classification, and the #1253 recovery bookkeeping of any prior hold
    // dies with the settlement (a later #940/new-evidence reopen mints a
    // fresh attempt that must not inherit a stale flag or stamp).
    data.outcome = null;
    data.decisionDetail = null;
    data.staleDisposition = false;
    data.disposedAt = null;
    data.disposedEvidence = null;
    data.recoveryAppliedAt = null;
  }

  // #1249: every disposition that ENDS the attempt retires its evidence
  // snapshot. A watermark that outlives the attempt it bounded makes the next
  // hand-out's settlement reopen on transitions recorded before it — evidence
  // this attempt already spent. The QUEUED→QUEUED mark keeps both lists (same
  // attempt, entries still refer to the live generation); a mark that creates a
  // fresh attempt already nulled the watermark via `freshAttemptGeneration`.
  if (nextStatus !== "QUEUED") {
    data.attemptEvidenceWatermark = null;
  }

  // No-progress guard (#940, rebuilt in #1074): run it BEFORE any write,
  // against the immutable per-attempt baseline, so a refused FIXED never
  // transiently exists. Compare `attemptHeadSha` (this attempt's baseline)
  // with a fallback to the mutable `headSha` for legacy rows.
  // #1121: an explicit already-addressed settlement bypasses the guard — the
  // worker asserts the feedback was already handled, so no push is expected.
  if (nextStatus === "FIXED" && existing.status !== "FIXED" && !input.alreadyAddressed) {
    const baseline = existing.attemptHeadSha ?? existing.headSha;
    const headShaGuard = await assertPrHeadMovedForFix(client, input.repo, input.pr, baseline, input.note ?? null);
    if (headShaGuard === "head-unchanged") {
      // Refuse the tombstone: go straight to QUEUED as a fresh dispatchable
      // attempt — bump the generation in the same update so the identity a
      // worker already consumed is not silently reused (#1044) — and audit
      // why we rejected. No FIXED row is ever written.
      //
      // The refused run was a spent attempt, so it counts toward the cap;
      // past it, PARK the PR instead of re-running a worker that keeps pushing
      // nothing (#1103, #1218). The retry keeps the refused baseline: the head
      // is unchanged, so it is still the newest observed (#1104).
      const refusalCapped = (existing.fixAttempts ?? 1) >= maxPrFixAttempts();
      const refusalData: Record<string, unknown> = refusalCapped
        ? {
            status: "PARKED",
            lane: "NORMAL",
            outcome: "no_progress",
            decisionDetail: null,
            // #1253: disposition audit stamp (refused-FIXED cap park).
            disposedAt: new Date(),
            disposedEvidence: null,
            postDispatchEvidenceKeys: [],
            agentHandouts: [],
            handoutAcks: [],
            handoutReceipts: [],
            attemptEvidenceWatermark: null,
          }
        : {
            status: "QUEUED",
            lane: "NORMAL",
            ...freshAttemptGeneration(),
            fixAttempts: { increment: 1 },
            attemptHeadSha: input.attemptHeadSha ?? baseline ?? null,
            outcome: null,
            decisionDetail: null,
            // The generation bump invalidates any recorded entries and proves
            // no stale post-dispatch list on the fresh attempt (#1119).
            postDispatchEvidenceKeys: [],
            // Same for the per-agent hand-out records and their
            // acknowledgements (#1133, #1211).
            agentHandouts: [],
            handoutAcks: [],
            handoutReceipts: [],
          };
      const refusal = await client.$transaction(async (tx) => {
        const { count } = await tx.prFixQueueItem.updateMany({
          where: {
            id: existing.id,
            ...(expectedGeneration !== undefined ? { generation: expectedGeneration } : {}),
            ...stickySettlementStatusFilter,
          },
          data: refusalData,
        });
        if (count !== 1) return null;
        const refusedNote = `Refused FIXED: PR head unchanged since attempt baseline (recorded=${baseline ?? "null"}). Workload reported success but pushed nothing (#940, #1074).`;
        await tx.prFixHistory.create({
          data: {
            itemId: existing.id,
            action: "mark",
            status: refusalData.status,
            lane: refusalData.lane,
            outcome: refusalCapped ? "no_progress" : null,
            note: refusalCapped
              ? `${refusedNote} Bounded at ${existing.fixAttempts ?? 1} fix attempts (PR_FIX_MAX_ATTEMPTS=${maxPrFixAttempts()}); parked instead of re-queuing (#1103).`
              : refusedNote,
          },
        });
        return tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
      });
      if (!refusal) return { mutated: false, reason: "generation-mismatch" };
      if (refusalCapped && existing.status !== "BLOCKED" && existing.status !== "PARKED") {
        const context = await buildPrFixBlockedContext(client, refusal);
        await surfacePrFixParked({
          repo: input.repo,
          pr: input.pr,
          reason: refusal.reason,
          outcome: "no_progress",
          latestNote: input.note ?? null,
          context,
        });
      } else if (!refusalCapped && (existing.status === "BLOCKED" || existing.status === "PARKED")) {
        await retractNeedsHuman(input.repo, input.pr, "requeued", input.note);
      }
      return { mutated: true, item: refusal };
    }
  }

  // Shared tail for every successful mark write — settlement and non-settle
  // marks alike.
  const finishMarked = async (row: any): Promise<MarkPrFixResult> => {
    // Only surface a terminal notification when THIS mark is what first puts
    // the item into BLOCKED/PARKED (from a different status).
    if (nextStatus === "BLOCKED" && existing.status !== "BLOCKED") {
      const context = await buildPrFixBlockedContext(client, row);
      await surfacePrFixBlocked({
        repo: input.repo,
        pr: input.pr,
        reason: row.reason,
        latestNote: input.note ?? null,
        context,
        decision: row.decisionDetail ?? input.decision ?? null,
      });
    } else if (nextStatus === "PARKED" && existing.status !== "PARKED") {
      const context = await buildPrFixBlockedContext(client, row);
      await surfacePrFixParked({
        repo: input.repo,
        pr: input.pr,
        reason: row.reason,
        outcome: row.outcome ?? resolvePrFixOutcome("PARKED", input.outcome) ?? "no_progress",
        latestNote: input.note ?? null,
        context,
        // A BLOCKED item that parks is no longer awaiting a human decision
        // (#1218): retract the needs-human label it carried as BLOCKED.
        removeNeedsHumanLabel: existing.status === "BLOCKED",
      });
    } else if (
      (existing.status === "BLOCKED" || existing.status === "PARKED") &&
      (nextStatus === "QUEUED" || nextStatus === "FIXED")
    ) {
      await retractNeedsHuman(input.repo, input.pr, nextStatus === "FIXED" ? "resolved" : "requeued", input.note);
    }
    return { mutated: true, item: row };
  };

  // Fast path: one tiny transaction holding ONLY the guarded settlement
  // write, its history row, and the post-write read — no network call may
  // run in here (#1124 review).
  // #1074: with an expected generation, the status write is conditional on
  // the row still being at that generation — commit-time revalidation. A
  // concurrent re-issue (new evidence, requeue) moves the generation and
  // makes this write a no-op; the history row is skipped too.
  // #1119: for a settlement the write additionally requires the
  // post-dispatch evidence list to be empty — evidence landing in the
  // read→write gap no-ops the settlement (count !== 1) instead of being
  // silently absorbed into it. The keys-clear is deliberately NOT in
  // `data`: it would let a stale write clobber a concurrently recorded
  // entry. Unqualified marks take the same guarded updateMany path (no
  // generation clause) so the settle-gap guard applies to them too.
  // #1218 review: a worker-tier terminal settlement (FIXED/BLOCKED/PARKED/
  // STALE) additionally requires `status: "QUEUED"` at the row's pinned
  // page — a same-generation second mark cannot release or downgrade a
  // recorded human decision or parked classification, and a read→write-gap
  // that flipped the row also no-ops the write. Operator reclassification
  // explicitly opts in via `allowStickyReclassify` to bypass the pin.
  if (!reopenPinnedMissed) {
    const settledRow = await client.$transaction(async (tx) => {
      const settleWhere: Record<string, unknown> = {
        id: existing.id,
        ...(expectedGeneration !== undefined ? { generation: expectedGeneration } : {}),
        ...(settlesAttempt ? { postDispatchEvidenceKeys: { equals: [] } } : {}),
        ...stickySettlementStatusFilter,
      };
      const { count } = await tx.prFixQueueItem.updateMany({ where: settleWhere, data });
      if (count !== 1) return null;
      const row = await tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
      await tx.prFixHistory.create({
        data: {
          itemId: row.id,
          action: "mark",
          status: nextStatus,
          lane: row.lane,
          outcome: row.outcome ?? resolvePrFixOutcome(nextStatus, input.outcome),
          note: input.alreadyAddressed ? alreadyAddressedHistoryNote(input) : input.note ?? undefined,
        },
      });
      return row;
    });
    if (settledRow) return finishMarked(settledRow);
    // Rare miss on a non-settle mark: the row was deleted, or its generation
    // moved between the decision read and the write. Re-read to distinguish —
    // a gone row is not-found (mirrors the forced tail's labeling a few lines
    // below); a surviving row is a generation-mismatch.
    if (!settlesAttempt) {
      const remaining = await client.prFixQueueItem.findUnique({ where: { id: existing.id } });
      return { mutated: false, reason: remaining ? "generation-mismatch" : "not-found" };
    }
  }

  // The guarded write no-oped (or the initial reopen missed its pin): the row
  // moved between the decision read and the write. Bounded re-decision loop
  // (#1124 review): re-read and re-check actionability OUTSIDE any
  // transaction — the head fetch inside hasActionablePostDispatchEvidence
  // must never run while a transaction holds a pool connection — then
  // attempt a keys-pinned reopen or settle write in a tiny transaction. A
  // pinned write that misses means evidence landed AGAIN during the head
  // fetch; loop (bounded) and retry against the fresh row.
  const maxSettleRedecisions = 3;
  let lastFresh = existing;
  for (let i = 0; i < maxSettleRedecisions; i++) {
    const fresh = await client.prFixQueueItem.findUnique({ where: { id: existing.id } });
    if (!fresh) return { mutated: false, reason: "not-found" };
    if (expectedGeneration !== undefined && fresh.generation !== expectedGeneration) {
      // A genuine stale token: the attempt was re-issued (new evidence,
      // requeue) and owns the row now — skipping is correct, not a strand.
      return { mutated: false, reason: "generation-mismatch" };
    }
    lastFresh = fresh;
    const freshCacheKeys: string[] = fresh.postDispatchEvidenceKeys ?? [];
    // #1249: re-run the SAME cache ∪ durable decision the initial pass made —
    // a transition recorded in the gap after the first durable read (and
    // possibly evicted from the 20-entry cache) must reopen here too, not be
    // absorbed by the clear below.
    const freshDurableEntries = reopenEligible ? await listDurablePostDispatchEntries(client, fresh) : [];
    const freshEntries = Array.from(new Set([...freshCacheKeys, ...freshDurableEntries]));
    // #1218 sticky settlement: a BLOCKED/PARKED settle must absorb the keys
    // (cleared below) rather than reopen. Only FIXED settlements can be
    // auto-released by fresh evidence; the head fetch is skipped for the
    // sticky pair so a never-released row never costs a GitHub round-trip.
    if (reopenEligible && (await hasActionablePostDispatchEvidence(freshEntries, input.repo, input.pr))) {
      const reopened = await client.$transaction(async (tx) =>
        writeReopen(tx, fresh, " Post-dispatch evidence landed while this settlement was in flight."),
      );
      if (reopened) {
        await surfaceReopen(fresh, reopened);
        return { mutated: true, item: reopened };
      }
      continue;
    }
    // The recorded entries no longer apply (intermediate head): settle
    // normally, clear them, and say so in the history (#1119). The write is
    // pinned to the exact keys snapshot this no-reopen decision was made on,
    // so an entry landing during the head fetch above no-ops the write
    // instead of being cleared and absorbed. #1218 review: also pin
    // `status: QUEUED` for a worker-tier terminal settle so a row that
    // already flipped into a recorded settlement during the gap cannot be
    // overwritten by a stale settle.
    const clearedRow = await client.$transaction(async (tx) => {
      const { count } = await tx.prFixQueueItem.updateMany({
        where: {
          id: fresh.id,
          ...(expectedGeneration !== undefined ? { generation: expectedGeneration } : {}),
          postDispatchEvidenceKeys: { equals: freshCacheKeys },
          ...stickySettlementStatusFilter,
        },
        data: { ...data, postDispatchEvidenceKeys: [] },
      });
      if (count !== 1) return null;
      const row = await tx.prFixQueueItem.findUnique({ where: { id: fresh.id } });
      await tx.prFixHistory.create({
        data: {
          itemId: row.id,
          action: "mark",
          status: nextStatus,
          lane: row.lane,
          outcome: row.outcome ?? resolvePrFixOutcome(nextStatus, input.outcome),
          note: [
            input.alreadyAddressed ? alreadyAddressedHistoryNote(input) : input.note,
            "Recorded post-dispatch evidence no longer applies (intermediate head); cleared (#1119).",
          ]
            .filter(Boolean)
            .join(" "),
        },
      });
      return row;
    });
    if (clearedRow) return finishMarked(clearedRow);
  }

  // The loop exhausted: the pinned writes kept losing the race to evidence
  // that keeps landing. Only FIXED settlements can be force-released by
  // racing evidence — BLOCKED/PARKED are sticky (#1218), so for them we
  // drop straight to the unguarded settle (clearing keys + honoring the
  // caller's status). For FIXED, never return no-mutation merely because
  // of the racing evidence — the item would stay QUEUED at the generation
  // the worker already consumed, next-task would keep handing the spent
  // generation first to the deduping worker, and the lane would starve
  // (#1124 review). Force a fresh attempt (or, past the cap, a human
  // hand-off): pinned on id (+ the generation when the token defines one)
  // WITHOUT the keys pin, so racing evidence cannot block it.
  if (!reopenEligible) {
    // Sticky-settlement force: clear keys without status flip. The settlement
    // data already encodes lane/outcome/decisionDetail for the requested
    // status; writing the cleared-keys update is what the gap-reopen loop's
    // "no-reopen" branch would have done if it had won the keys pin.
    // #1218 review: also pin `status: QUEUED` for a worker-tier terminal
    // force so a row that already recorded a settlement during the gap
    // cannot be overwritten.
    const stickyRow = await client.$transaction(async (tx) => {
      const { count } = await tx.prFixQueueItem.updateMany({
        where: {
          id: existing.id,
          ...(expectedGeneration !== undefined ? { generation: expectedGeneration } : {}),
          ...stickySettlementStatusFilter,
        },
        data: { ...data, postDispatchEvidenceKeys: [] },
      });
      if (count !== 1) return null;
      const row = await tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
      await tx.prFixHistory.create({
        data: {
          itemId: row.id,
          action: "mark",
          status: nextStatus,
          lane: row.lane,
          outcome: row.outcome ?? resolvePrFixOutcome(nextStatus, input.outcome),
          note: input.alreadyAddressed ? alreadyAddressedHistoryNote(input) : input.note ?? undefined,
        },
      });
      return row;
    });
    if (!stickyRow) {
      const remaining = await client.prFixQueueItem.findUnique({ where: { id: existing.id } });
      return { mutated: false, reason: remaining ? "generation-mismatch" : "not-found" };
    }
    return finishMarked(stickyRow);
  }
  const forceCapped = (lastFresh.fixAttempts ?? 1) >= maxPrFixAttempts();
  const forceData: Record<string, unknown> = forceCapped
    ? {
        status: "PARKED",
        lane: "NORMAL",
        outcome: "no_progress",
        decisionDetail: null,
        // #1253: disposition audit stamp (racing-evidence cap park).
        disposedAt: new Date(),
        disposedEvidence: null,
        postDispatchEvidenceKeys: [],
        agentHandouts: [],
        handoutAcks: [],
        handoutReceipts: [],
        attemptEvidenceWatermark: null,
      }
    : {
        status: "QUEUED",
        lane: "NORMAL",
        ...freshAttemptGeneration(),
        fixAttempts: { increment: 1 },
        attemptHeadSha: lastFresh.headSha ?? lastFresh.attemptHeadSha ?? null,
        outcome: null,
        decisionDetail: null,
        postDispatchEvidenceKeys: [],
        // Fresh attempt: per-agent hand-out records for the consumed
        // generation must not suppress its re-dispatch (#1133), and the
        // prior generation's acknowledgements are dead (#1211).
        agentHandouts: [],
        handoutAcks: [],
        handoutReceipts: [],
      };
  const forced = await client.$transaction(async (tx) => {
    const { count } = await tx.prFixQueueItem.updateMany({
      where: {
        id: existing.id,
        ...(expectedGeneration !== undefined ? { generation: expectedGeneration } : {}),
        ...stickySettlementStatusFilter,
      },
      data: forceData,
    });
    if (count !== 1) return null;
    await tx.prFixHistory.create({
      data: {
        itemId: existing.id,
        action: "mark",
        status: forceData.status,
        lane: forceData.lane,
        outcome: forceCapped ? "no_progress" : null,
        // Preserve the caller's note alongside the canned forced-fallback text
        // (same join style as the stale-clear settle branch).
        note: [
          input.note,
          forceCapped
            ? `Post-dispatch evidence kept landing while this settlement was in flight, but bounded at ${lastFresh.fixAttempts ?? 1} fix attempts (PR_FIX_MAX_ATTEMPTS=${maxPrFixAttempts()}); parked (#1218).`
            : `Post-dispatch evidence kept landing while this settlement was in flight; forced a fresh attempt so the racing evidence is not absorbed (#1218).`,
        ]
          .filter(Boolean)
          .join(" "),
      },
    });
    return tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
  });
  if (!forced) {
    // The row is gone or its generation moved even against the unkeyed pin:
    // a concurrent re-issue (or delete) owns the item now — the
    // stale-token skip applies.
    const remaining = await client.prFixQueueItem.findUnique({ where: { id: existing.id } });
    return { mutated: false, reason: remaining ? "generation-mismatch" : "not-found" };
  }
  await surfaceReopen(lastFresh, forced);
  return { mutated: true, item: forced };
}

/**
 * Mark queued pr-fix items as stale when the upstream PR is merged or closed.
 *
 * This is a deterministic cleanup that catches the failure mode where
 * pr-followup/sync enqueues items without checking the upstream PR's state,
 * leaving merged/closed PRs in the worker queue. The data source is whatever
 * caller passes in — the issues/reconcile route already builds a
 * `mergedOrClosedPrsByRepo` map per tracked repo, so we just consume it.
 *
 * Returns counts for logging/audit. No model judgment.
 */
export async function reconcileStalePrFixItems(
  client: PrFixQueueClient,
  mergedOrClosedPrsByRepo: Map<string, Set<number>>,
  prStateByRepo: Map<string, Map<number, "merged" | "closed">>,
): Promise<{ checked: number; markedStale: number; errored: number }> {
  let checked = 0;
  let markedStale = 0;
  let errored = 0;

  for (const [repo, prNumbers] of mergedOrClosedPrsByRepo) {
    if (prNumbers.size === 0) continue;
    const staleCandidates = await client.prFixQueueItem.findMany({
      where: {
        // The queue stores the folded repo identity (#1145), so this lookup
        // must fold the caller's key too (#1372): callers pass the cached
        // repo casing ("Org/Repo" from repo.fullName / repoFullNames), which
        // matches no row and silently skips the reap. The prStateByRepo
        // lookup below keeps the caller's original key — both input maps are
        // keyed identically per caller.
        repo: normalizeQueueRepo(repo),
        pr: { in: Array.from(prNumbers) },
        status: { in: ["QUEUED", "BLOCKED", "PARKED", "WAITING_EXTERNAL"] },
      },
    });
    checked += staleCandidates.length;
    for (const item of staleCandidates) {
      try {
        const state = prStateByRepo.get(repo)?.get(item.pr) ?? "merged";
        // #1253: the terminal reap write is generation-AND-status pinned — a
        // concurrent requeue/settlement that bumped the generation or moved
        // the status in the read→write gap wins, and this reap no-ops
        // (count 0, no history row) instead of clobbering it.
        const count = await client.$transaction(async (tx) => {
          const result = await tx.prFixQueueItem.updateMany({
            where: { id: item.id, status: item.status, generation: item.generation },
            data: { status: "STALE", attemptEvidenceWatermark: null, staleDisposition: false },
          });
          if (result.count === 1) {
            await tx.prFixHistory.create({
              data: {
                itemId: item.id,
                action: "mark",
                status: "STALE",
                lane: item.lane,
                note: `Upstream PR state=${state} at reconcile time`,
              },
            });
          }
          return result.count;
        });
        if (count === 1) markedStale++;
      } catch (err) {
        errored++;
      }
    }
  }

  return { checked, markedStale, errored };
}

/**
 * Whether a repo is archived, for the archived-repo guards (#1106). Fails open
 * (false) when GitHub can't answer: refusing or reaping on a lookup failure
 * would strand work that is fine.
 */
export async function isPrFixRepoArchived(repo: string): Promise<boolean> {
  try {
    return (await fetchRepositoryMetadata(repo)).archived === true;
  } catch (error) {
    console.warn(`[pr-fix-queue] archived check failed for ${repo}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Mark QUEUED/BLOCKED pr-fix items STALE when their repo is archived (#1106).
 * Nothing can push to an archived repo, so a dispatched worker can only fail;
 * observed on misospace/llmkube-images#436. Works from the items themselves,
 * not the tracked-repo list, so a repo dropped from tracking still gets
 * reaped. One lookup per distinct repo with active items.
 */
export async function reconcileArchivedRepoPrFixItems(
  client: PrFixQueueClient,
  isArchived: (repo: string) => Promise<boolean> = isPrFixRepoArchived,
): Promise<{ checked: number; markedStale: number; errored: number }> {
  let checked = 0;
  let markedStale = 0;
  let errored = 0;

  const active = await client.prFixQueueItem.findMany({ where: { status: { in: ["QUEUED", "BLOCKED", "PARKED", "WAITING_EXTERNAL"] } } });
  const byRepo = new Map<string, any[]>();
  for (const item of active) byRepo.set(item.repo, [...(byRepo.get(item.repo) ?? []), item]);

  for (const [repo, items] of byRepo) {
    checked += items.length;
    if (!(await isArchived(repo))) continue;
    for (const item of items) {
      try {
        // #1253: generation-AND-status pinned terminal reap — same fencing as
        // reconcileStalePrFixItems above; a concurrent requeue wins.
        const count = await client.$transaction(async (tx) => {
          const result = await tx.prFixQueueItem.updateMany({
            where: { id: item.id, status: item.status, generation: item.generation },
            data: { status: "STALE", attemptEvidenceWatermark: null, staleDisposition: false },
          });
          if (result.count === 1) {
            await tx.prFixHistory.create({
              data: {
                itemId: item.id,
                action: "mark",
                status: "STALE",
                lane: item.lane,
                note: "Upstream repo archived at reconcile time (#1106)",
              },
            });
          }
          return result.count;
        });
        if (count === 1) markedStale++;
      } catch (err) {
        errored++;
      }
    }
  }

  return { checked, markedStale, errored };
}

/**
 * Patch that bumps a PrFixQueueItem's `generation` — Dispatch-owned work
 * identity (#1044), exposed to workers via next-task as
 * `followup-pr.prFixItem.generation`. Merge it into the same Prisma update
 * that flips the item back to QUEUED so the bump is atomic with the state
 * transition: Prisma computes `increment` server-side, so concurrent
 * transitions cannot lose a bump the way a read-then-write `generation + 1`
 * would.
 *
 * When to bump: only when a non-QUEUED item becomes dispatchable again as a
 * NEW attempt — requeue from BLOCKED/FIXED, genuinely new evidence reopening a
 * resolved item, the #940 no-progress FIXED recovery, and markPrFixItem's
 * refused-FIXED rollback. Never bump for ordinary reads, repeated sync of
 * known evidence, or updates that stay within the same active attempt —
 * repeated reads of one pending unit of work must return the same identity.
 */
export function freshAttemptGeneration(): {
  generation: { increment: number };
  attemptEvidenceWatermark: null;
  attemptType: null;
} {
  // A fresh attempt has no hand-out yet, so it has no evidence snapshot: the
  // watermark resets alongside the post-dispatch list and dies only with the
  // generation it bounded (#1249). The durable ledger COUNTER is not reset —
  // ledger positions are per-item history, and a stale-low watermark must
  // never survive into a new attempt to make known evidence read as new.
  //
  // #1327 review: the DISPATCHED lane resets with the attempt too. A
  // non-null `attemptType` means "this generation was handed out as that
  // lane"; letting it survive a generation bump would make next-task's
  // concurrency gate read a dead attempt as the live lane — masking a fresh
  // REBASE attempt (bypassing the gate and its serialization, a fan-out
  // door) or gating an ordinary fresh attempt behind the rebase lane. The
  // lane is stamped by the hand-out itself; a fresh attempt has none.
  return { generation: { increment: 1 }, attemptEvidenceWatermark: null, attemptType: null };
}

/**
 * A per-agent hand-out record (#1133): `<agentName>@<generation>`. next-task
 * records one when it ships a task token; `agentAlreadyHanded` then skips
 * the item for that agent until the generation moves. Parsing splits on the
 * LAST `@` so an agent name containing `@` survives, and a non-integer
 * generation makes the entry inert (fail-open toward re-handing, never
 * toward an indefinite skip).
 */
export function agentHandoutToken(agentName: string, generation: number): string {
  return `${agentName}@${generation}`;
}

export function parseAgentHandoutToken(entry: unknown): { agentName: string; generation: number } | null {
  if (typeof entry !== "string") return null;
  const idx = entry.lastIndexOf("@");
  if (idx <= 0) return null;
  const generation = Number(entry.slice(idx + 1));
  if (!Number.isInteger(generation) || generation < 1) return null;
  return { agentName: entry.slice(0, idx), generation };
}

// ── Per-hand-out receipts (#1256 review) ───────────────────────────────────
//
// `agentHandouts` answers "was this generation already handed to agent X",
// which is all ordinary dispatch needs. Capacity-exhausted settlement needs
// more: it must authorize the EXACT hand-out attempt a worker was issued, so
// that (a) an unrelated agent that merely knows the (id, generation) token can
// never release the current hand-out, and (b) a stale token from a PREVIOUS
// hand-out of the SAME agent at the SAME generation (release/reclaim keep the
// generation) cannot release the live one. Generation alone cannot express
// either — the receipt carries a fresh opaque token per hand-out.
//
// Receipt entry format: `<token>@<agentName>@<generation>`. The token is
// Dispatch-minted hex (never contains "@"), so the token boundary is the
// FIRST "@"; the agent name may contain "@", so its boundary with the
// generation stays the LAST "@" (same rule as `agentHandoutToken`).
//
// Invariant (enforced at every write site below): a receipt exists exactly
// while the matching `agentHandouts` entry exists — issuance pushes both in
// one conditional write, every site that clears `agentHandouts` clears
// `handoutReceipts` in the same data object. A released/reclaimed/
// superseded hand-out therefore has no live receipt, and every NEW hand-out
// rotates in a fresh token.

/** Fresh opaque per-hand-out token. Opaque to everyone but the matcher. */
export function newHandoutToken(): string {
  return `hnd_${randomBytes(12).toString("hex")}`;
}

/** Encoding of a persisted hand-out owner receipt. */
export function handoutReceipt(token: string, agentName: string, generation: number): string {
  return `${token}@${agentName}@${generation}`;
}

export function parseHandoutReceipt(
  entry: unknown,
): { token: string; agentName: string; generation: number } | null {
  if (typeof entry !== "string") return null;
  const first = entry.indexOf("@");
  const last = entry.lastIndexOf("@");
  // Token and agent name must both be non-empty; token shape is Dispatch's.
  if (first <= 0 || last <= first) return null;
  const token = entry.slice(0, first);
  if (!/^hnd_[0-9a-f]{8,}$/.test(token)) return null;
  const generation = Number(entry.slice(last + 1));
  if (!Number.isInteger(generation) || generation < 1) return null;
  return { token, agentName: entry.slice(first + 1, last), generation };
}

/**
 * The receipt in `entries` matching the exact (agent, generation, token)
 * triple, or null. All three must match: the agent binds the source owner,
 * the token binds the exact hand-out issuance, the generation is defense in
 * depth against a cleared-then-reissued entry.
 */
export function findHandoutReceipt(
  entries: readonly unknown[],
  owner: { agentName: string; generation: number; token: string },
): string | null {
  for (const entry of entries) {
    const parsed = parseHandoutReceipt(entry);
    if (
      parsed &&
      parsed.agentName === owner.agentName &&
      parsed.generation === owner.generation &&
      parsed.token === owner.token
    ) {
      return entry as string;
    }
  }
  return null;
}

/**
 * Whether this item was already handed to `agentName` at its CURRENT
 * generation (#1133). Entries for older generations and malformed entries
 * never match — the skip must only ever suppress a re-hand of the exact
 * work identity the agent already received.
 */
export function agentAlreadyHanded(
  item: { agentHandouts?: unknown; generation?: unknown },
  agentName: string,
): boolean {
  const entries = Array.isArray(item.agentHandouts) ? item.agentHandouts : [];
  const generation = typeof item.generation === "number" ? item.generation : null;
  if (generation === null) return false;
  return entries.some((entry) => {
    const parsed = parseAgentHandoutToken(entry);
    return parsed !== null && parsed.agentName === agentName && parsed.generation === generation;
  });
}

/**
 * Release the reporting agent's hand-out records from a settled pr-fix item
 * (#1340). When a report settles the attempt (a `blocked` report that marks
 * the row BLOCKED or PARKED) or finds the row already settled, the attempt
 * is over: the per-agent hand-out, ack, and receipt entries for the settled
 * generation must not survive, or the live receipt would keep pinning the
 * settled item as if it were still dispatched.
 *
 * The release is a compare-and-swap, not a blind write from a stale
 * snapshot: it re-reads the row, filters the agent's entries out of the
 * arrays it just read, and commits with those exact arrays pinned in the
 * where clause (mirroring the #1256 capacity release). A concurrent
 * hand-out, ack, or sweep that lands in the read→write gap fails the pin,
 * so the release retries once against a fresh read and then gives up
 * silently. A lost race leaves the agent's entries inert on the settled
 * row — they only gate dispatch while the item is QUEUED at that
 * generation, and the next generation change clears them.
 *
 * Fencing (#1340 review, mirroring #1256): the release is authorized ONLY by
 * the exact live receipt — the report must echo the issued `handoutToken`
 * and the (agent, generation, token) triple must all match. A rotated/
 * reclaimed/released token has no authority over the current issuance, so a
 * stale same-agent report can never remove a newer live hand-out; a
 * mismatch — or a report with no token at all — releases nothing (fail
 * closed). Courier echoes the token on every `followup-pr` report since
 * misospace/courier#516 (courier PR #523), so a live settlement always
 * carries it; the token-less shape stays accepted by the route for legacy
 * work ids, whose hand-outs predate receipts and settle via the #1074
 * skip path rather than a release.
 *
 * Best-effort throughout: the settlement (or the skip decision) is already
 * made, so a failure here only logs and never fails the report.
 */
export async function releaseAgentHandout(
  client: PrFixQueueClient,
  itemId: string,
  agentName: string | undefined,
  generation: number,
  handoutToken?: string | null,
): Promise<void> {
  const agent = agentName?.trim();
  if (!agent) return;
  const token = handoutToken?.trim();
  // Exact-issuance fence (#1256 rule): without the echoed token, nothing is
  // authorized — fail closed, on every path, settled row or not.
  if (!token) return;
  try {
    for (let pass = 0; pass < 2; pass++) {
      const fresh = await client.prFixQueueItem.findUnique({ where: { id: itemId } });
      if (!fresh || fresh.generation !== generation) return;
      const receipts: string[] = Array.isArray(fresh.handoutReceipts) ? fresh.handoutReceipts : [];
      const handouts: string[] = Array.isArray(fresh.agentHandouts) ? fresh.agentHandouts : [];
      const acks: string[] = Array.isArray(fresh.handoutAcks) ? fresh.handoutAcks : [];
      const isOwnToken = (entry: unknown): boolean => {
        const parsed = parseAgentHandoutToken(entry);
        return parsed !== null && parsed.agentName === agent && parsed.generation === generation;
      };
      // Exact-issuance fence (#1256 rule): the presented receipt must be this
      // agent's live receipt at this generation. A mismatched, rotated, or
      // already released receipt authorizes nothing.
      const owned = findHandoutReceipt(receipts, { agentName: agent, generation, token });
      if (!owned) return;
      const remainingReceipts = receipts.filter((entry) => entry !== owned);
      const remainingHandouts = handouts.filter((entry) => !isOwnToken(entry));
      const remainingAcks = acks.filter((entry) => !isOwnToken(entry));
      // Nothing for this agent at this generation (or a malformed row) — no
      // write.
      if (
        remainingReceipts.length === receipts.length &&
        remainingHandouts.length === handouts.length &&
        remainingAcks.length === acks.length
      ) {
        return;
      }
      const { count } = await client.prFixQueueItem.updateMany({
        where: {
          id: itemId,
          generation,
          handoutReceipts: { equals: receipts },
          agentHandouts: { equals: handouts },
          handoutAcks: { equals: acks },
        },
        data: {
          handoutReceipts: remainingReceipts,
          agentHandouts: remainingHandouts,
          handoutAcks: remainingAcks,
          ...(remainingHandouts.length === 0
            ? {
                dispatchedGeneration: null,
                dispatchedAt: null,
                attemptEvidenceWatermark: null,
              }
            : {}),
        },
      });
      if (count === 1) return;
      // The pin lost a race; loop once more against a fresh read.
    }
  } catch (error) {
    console.error(`pr-fix-queue handout release failed for ${itemId}:`, error);
  }
}

export function toAgentQueuePrFixItem(item: any) {
 const fixType = normalizePrFixType(item.type);
 return {
   type: "pr-review-fix",
   fixType,
   // #1327 review: the persisted DISPATCHED lane (`attemptType`), the same
   // value settlement and the rebase concurrency gate key on. Listed so a
   // consumer (and next-task's gate) sees the lane a live attempt actually
   // runs, even after the mutable `type` is rewritten by a re-observation.
   attemptType: item.attemptType == null ? null : normalizePrFixType(item.attemptType),
    id: item.id,
    repo: item.repo,
    pr: item.pr,
    issue: item.issue,
    branch: item.branch,
    url: item.url,
    title: item.title,
    lane: item.lane,
    status: item.status,
    outcome: item.outcome ?? null,
    reason: item.reason,
    feedback: item.feedback ?? [],
    evidenceKeys: item.evidenceKeys ?? [],
    headSha: item.headSha,
    // Immutable per-attempt baseline for the current generation (#1074);
    // exposed additively so consumers can distinguish it from headSha.
    attemptHeadSha: item.attemptHeadSha,
    author: item.author,
    generation: item.generation,
    // Per-agent hand-out records for the current generation (#1133); the
    // next-task route reads these to skip items this agent already has.
    agentHandouts: item.agentHandouts ?? [],
    // #1253: fresh actionable evidence arrived while the item sat in a
    // disposition evidence must not override — operator-visible on queue
    // listings, cleared on reactivation or operator requeue.
    staleDisposition: item.staleDisposition ?? false,
    queuedAt: item.queuedAt,
    updatedAt: item.updatedAt,
    rankingReason: `queued PR review-fix item (${fixType})`,
  };
}

/**
 * Return a BLOCKED pr-fix item to QUEUED with its attempt counter reset, so
 * the loop works it again without needing a hand-pushed commit to retrigger.
 *
 * Accepts `FIXED` items too — the FIXED tombstone is untrusted when the PR
 * head didn't move, and the previously-recommended `mark_pr_fix status=blocked
 * → requeue_pr_fix` two-call recovery required lying about the state. A single
 * honest requeue is preferable (#940).
 *
 * Refuses if the upstream PR is already merged or closed — consistent with
 * `classify_pr_lifecycle` treating those as nothing-left-to-fix. The caller
 * passes `isPrMergedOrClosed` (computed upstream) so this stays a pure db op.
 */
export async function requeuePrFixItem(client: PrFixQueueClient, rawInput: RequeuePrFixInput) {
  const input: RequeuePrFixInput = { ...rawInput, repo: normalizeQueueRepo(rawInput.repo) };
  if (input.isPrMergedOrClosed) {
    throw new Error("Cannot requeue: upstream PR is merged or closed");
  }
  if (input.isRepoArchived) {
    throw new Error("Cannot requeue: repository is archived");
  }

  const item = await client.$transaction(async (tx) => {
    const existing = await tx.prFixQueueItem.findUnique({ where: { repo_pr: { repo: input.repo, pr: input.pr } } });
    if (!existing) return null;
    // Requeue acts on BLOCKED (a human decision), PARKED (bounded exhaustion
    // or an operational failure, #1218) and FIXED (recovery from a no-progress
    // tombstone, #940). STALE is rejected because the upstream PR is gone.
    if (existing.status !== "BLOCKED" && existing.status !== "PARKED" && existing.status !== "FIXED") {
      throw new Error(`Cannot requeue: item is ${existing.status}, not BLOCKED, PARKED, or FIXED`);
    }
    const reopenedFrom = existing.status;
    const updated = await tx.prFixQueueItem.update({
      where: { id: existing.id },
      // Requeue hands the PR back to the worker loop as a fresh attempt —
      // bump the generation in the same update so consumers see a new work
      // identity rather than one they may already have deduplicated (#1044).
      // It is an operator reset, so the attempt count starts over (#1103).
      // Baseline the attempt from the last observed head: a null baseline
      // made the guard fall back to the mutable headSha, which the next sync
      // overwrites with the worker's own push (#1074, #1104).
      data: {
        status: "QUEUED",
        lane: "NORMAL",
        // The operator release clears the BLOCKED/PARKED classification (#1218).
        outcome: null,
        decisionDetail: null,
        // #1253: the operator reset also clears the recovery bookkeeping —
        // the stale-disposition flag, the disposition audit stamp, and the
        // reactivation cooldown.
        staleDisposition: false,
        disposedAt: null,
        disposedEvidence: null,
        recoveryAppliedAt: null,
        ...freshAttemptGeneration(),
        fixAttempts: 1,
        attemptHeadSha: existing.headSha ?? null,
        // A fresh operator requeue must not carry post-dispatch evidence
        // recorded for a prior attempt (#1119), nor hand-out records that
        // would suppress the item's re-dispatch (#1133). The operator reset
        // also clears the stale-hand-out reclaim budget (#1211) — unlike an
        // automatic reclaim, which deliberately counts toward it.
        postDispatchEvidenceKeys: [],
        agentHandouts: [],
        handoutAcks: [],
        handoutReceipts: [],
        handoutReclaims: 0,
      },
    });
    await tx.prFixHistory.create({
      data: {
        itemId: updated.id,
        action: "requeue",
        status: "QUEUED",
        lane: "NORMAL",
        note:
          (input.note ? `${input.note} (reopened from ${reopenedFrom})` : `operator requeue from ${reopenedFrom}`) +
          (reopenedFrom === "FIXED" ? " — #940 recovery" : reopenedFrom === "PARKED" ? " — operator release of a parked item" : ""),
      },
    });
    return updated;
  });
  if (item) {
    // Best-effort cleanup: drop the needs-human label and fold the existing marker
    // comment into a concise requeued/active notice. Never blocks the requeue.
    await surfacePrFixRequeued(input.repo, input.pr, input.note ?? undefined).catch((error) => {
      console.error(`pr-fix-queue requeue cleanup error for ${input.repo}#${input.pr}:`, error);
    });
  }
  return item;
}

export function parseRequeuePrFixInput(body: unknown): RequeuePrFixInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.repo)) return { error: "Missing required field: repo" };
  if (input.pr === undefined || input.pr === null || !Number.isInteger(Number(input.pr))) return { error: "Missing required field: pr" };
  return {
    repo: input.repo.trim(),
    pr: Number(input.pr),
    note: typeof input.note === "string" ? input.note : null,
    isPrMergedOrClosed: input.isPrMergedOrClosed === true,
  };
}

/**
 * Outcome shape used by `tasks/report`. Mirrors the `tasks/report` route's
 * permitted outcomes so the resolution logic does not have to inspect a raw
 * union from a foreign file.
 */
export type AgentReportOutcome =
  | "pr_opened"
  | "pr_updated"
  | "issue_updated"
  | "issue_closed"
  | "no_changes_needed"
  | "blocked"
  | "failed"
  | "already_addressed"
  | "waiting-external"
  // #1143: an issue close, not a PR-fix settlement; never touches the queue.
  | "already_done"
  | "handed-off"
  | "capacity-exhausted";

/**
 * The (id, generation) attempt token `next-task` issues on a followup-pr
 * task and the worker echoes back in `tasks/report` as `prFixItem` (#1074).
 */
export interface PrFixReportAttempt {
  itemId: string;
  generation: number;
  /**
   * #1256: the per-hand-out receipt token next-task issued with this
   * hand-out. REQUIRED by `capacity-exhausted` settlement (exact source-
   * attempt fencing); ignored by every other outcome, so legacy reports and
   * token-less hand-outs settle exactly as before.
   */
  handoutToken?: string | null;
}

export interface ResolvePrFixFromAgentReportInput {
  repoFullName?: string | null;
  pullRequestNumber?: number | null;
  pullRequestUrl?: string | null;
  outcome: AgentReportOutcome;
  summary?: string | null;
  error?: string | null;
  // #1121 evidence string (commit SHAs/paths) carried by an `already_addressed` report.
  evidence?: string | null;
  // #1218: for a `blocked` report, the structured reason. `human_decision`
  // marks BLOCKED with the decision payload; anything else (or a bare
  // give-up) marks PARKED — a bare give-up is NOT a human decision.
  blockReason?: string | null;
  decision?: PrFixDecisionContext | null;
  // #1250: structured external-wait contract carried by a `waiting-external`
  // report. Without a valid contract the attempt fails closed to
  // PARKED/`invalid_wait` instead of a cooldown wait.
  externalWait?: unknown;
  // #1256: opaque worker-declared capacity identifier, required (with an
  // attempt token) by the `capacity-exhausted` outcome.
  capacity?: string | null;
  // #1256: reporting agent — recorded on the capacity-handoff history row and,
  // for `capacity-exhausted`, part of the exact-owner CAS (the presented
  // handoutToken must belong to THIS agent's live receipt).
  agentName?: string | null;
  client?: PrFixQueueClient;
  // #1074: required for queue settlement. When present, the report settles
  // exactly the item + generation the token identifies; when absent (legacy
  // report), the queue is never touched.
  attempt?: PrFixReportAttempt | null;
}

export interface ResolvePrFixFromAgentReportResult {
  matched: boolean;
  action: "none" | "blocked" | "parked" | "fixed" | "deferred" | "requeued" | "skipped";
  itemId?: number | null;
  reason: string;
  // Echoes the attempt generation the report carried (null when the report
  // was legacy / token-less), for audit and idempotency-replay visibility.
  attemptGeneration?: number | null;
}

/**
 * Resolve a queued pr-fix item when an agent reports back through
 * `tasks/report`. Without this, non-bridge agents (anything driven through
 * MCP tools or the generic harness loop in AGENTS.md, e.g. pi/opencode) get
 * the pr-fix item served first, do the work, report — and the PrFixQueueItem
 * stays QUEUED, so the next poll serves it again ahead of issue work.
 *
 * Attempt-token settlement (#1074): a report carries the `prFixItem`
 * (id, generation) token that `next-task` issued. Settlement is only
 * authorized by that token:
 * - Token present → settle exactly that item + generation. A missing item,
 *   a repo/PR that doesn't match the token's item, a stale generation
 *   (the attempt was re-issued: new evidence, requeue), or an already
 *   settled status all skip without mutation. Every status write below is
 *   generation-conditional, so a concurrent re-issue between the check and
 *   the write still lands as a no-op (commit-time revalidation).
 * - Token absent (legacy report) → the queue is NEVER mutated: the report
 *   matches the item (so the response is informative) but takes no action
 *   and makes no GitHub calls. A pre-token worker can no longer settle an
 *   item it was never issued.
 *
 * Within an authorized settlement, behaviour matches the bridge's own
 * marking:
 * - No matching item or no PR coordinates → no-op (issue-work reports pass
 *   through untouched).
 * - Outcome `handed-off` → no settlement, queue mutation, or PR state lookup.
 *   The report records a terminal worker handoff; independent sync owns follow-up.
 * - Outcome `blocked` → mark BLOCKED immediately. Doesn't need PR state; the
 *   agent hit a wall.
 * - Outcome `failed` → settle the consumed generation (#1133): reopen a
 *   fresh attempt (counted toward PR_FIX_MAX_ATTEMPTS, #1107), or BLOCKED +
 *   NEEDS_HUMAN past the cap. The bridge reconcile pass that used to own
 *   this decision is retired; leaving the item QUEUED at a generation the
 *   worker already consumed starves the lane behind the deduping worker.
 * - Anything else (pr_opened/pr_updated/issue_closed/issue_updated/
 *   no_changes_needed) is "done"-like. Verify PR merge state before marking
 *   FIXED so a red PR isn't marked fixed off unverified success — that is
 *   exactly the failure mode the bridge deliberately avoids. If the PR is
 *   not mergeable/merged/closed (e.g. CONFLICTING or unknown), do NOT mark
 *   FIXED; leave the item for the bridge's reconcile pass to settle.
 * - Idempotent: a repeat report for an already-resolved item is a no-op.
 */
export async function resolvePrFixFromAgentReport(
  input: ResolvePrFixFromAgentReportInput,
): Promise<ResolvePrFixFromAgentReportResult> {
  // #1143: `already_done` resolves a GitHub issue through the close policy; it
  // is never a PR-fix settlement and must not mutate the PR-fix queue.
  if (input.outcome === "already_done") {
    return {
      matched: false,
      action: "none",
      reason: "already_done is an issue close, not a pr-fix settlement",
    };
  }

  const repo = input.repoFullName ? normalizeQueueRepo(input.repoFullName) : undefined;
  const pr =
    typeof input.pullRequestNumber === "number" && Number.isInteger(input.pullRequestNumber)
      ? input.pullRequestNumber
      : null;

  if (!repo || pr === null || pr === undefined) {
    return { matched: false, action: "none", reason: "no pr coordinates in report" };
  }

  const client = input.client ?? prisma;
  const attempt = input.attempt ?? null;

  // Hand-off ends this worker's task but leaves PR ingestion and queue state to
  // the independent pr-followup sync owner.
  if (input.outcome === "handed-off") {
    return {
      matched: false,
      action: "none",
      reason: "task handed off; pr-followup sync retains ownership",
      attemptGeneration: attempt?.generation ?? null,
    };
  }

  let existing: any;
  if (attempt) {
    // The token is the settlement authority: load the item the token names
    // and cross-check the report's repo/PR against it (not the other way
    // around).
    existing = await client.prFixQueueItem.findUnique({
      where: { id: attempt.itemId },
    });
    if (!existing) {
      return {
        matched: false,
        action: "none",
        reason: "attempt item not found",
        attemptGeneration: attempt.generation,
      };
    }
    if (existing.repo !== repo || existing.pr !== pr) {
      return {
        matched: true,
        action: "skipped",
        itemId: existing.id ?? null,
        reason: `attempt item does not match reported repo/PR (item is ${existing.repo}#${existing.pr})`,
        attemptGeneration: attempt.generation,
      };
    }
    if (existing.generation !== attempt.generation) {
      // The attempt was re-issued (new evidence, requeue, refused-FIXED
      // rollback) after this worker was dispatched. Its report is stale:
      // settling it would clobber the newer attempt's state.
      return {
        matched: true,
        action: "skipped",
        itemId: existing.id ?? null,
        reason: `stale attempt generation: report issued for generation ${attempt.generation}, item is at generation ${existing.generation}`,
        attemptGeneration: attempt.generation,
      };
    }
  } else {
    existing = await client.prFixQueueItem.findUnique({
      where: { repo_pr: { repo, pr } },
    });
    if (!existing) {
      return { matched: false, action: "none", reason: "no matching pr-fix queue item" };
    }
    // #1074: legacy report (no attempt token). Match, but never settle —
    // no mutation, no GitHub round-trips.
    return {
      matched: true,
      action: "skipped",
      itemId: existing.id ?? null,
      reason: "legacy report without prFixItem attempt token; queue settlement requires an attempt token (#1074)",
    };
  }

  const currentStatus = normalizePrFixStatus(existing.status) as PrFixStatus | null;
  if (
    input.outcome === "waiting-external" &&
    currentStatus === "WAITING_EXTERNAL" &&
    attempt?.generation === existing.generation
  ) {
    return { matched: true, action: "deferred", itemId: existing.id ?? null, reason: "external wait already recorded for this generation", attemptGeneration: attempt.generation };
  }
  if (!currentStatus || currentStatus !== "QUEUED") {
    // Already settled (FIXED / BLOCKED / STALE). Idempotent — nothing to do.
    // #1340: the row is terminal, so the reporting agent's hand-out records
    // must not linger on it either — release them even though the
    // settlement itself is a no-op (the CAS no-ops if the generation moved).
    if (input.outcome === "blocked" && attempt) {
      await releaseAgentHandout(
        client as PrFixQueueClient,
        existing.id,
        input.agentName?.trim(),
        attempt.generation,
        attempt.handoutToken,
      );
    }
    return {
      matched: true,
      action: "skipped",
      itemId: existing.id ?? null,
      reason: `pr-fix item already ${existing.status}`,
      attemptGeneration: attempt?.generation ?? null,
    };
  }

  const expectedGeneration = attempt?.generation ?? undefined;

  // #1256: explicit capacity exhaustion on a handed PR-fix attempt.
  //
  // Semantics (deliberately NOT a WAITING_EXTERNAL park): the item STAYS
  // QUEUED at the same generation with the same fixAttempts count, branch, and
  // PR identity — the attempt token is consumed (hand-out stamps cleared so
  // any compatible worker can take it) but no repair budget is spent, and no
  // global wait hides the item from workers whose capacity is unrelated. The
  // suppression is scoped to the exhausted capacity via a CapacityHandoff
  // cooldown row that next-task applies when the requester declares a
  // capacity (workers declaring none skip conservatively until expiry).
  //
  // Fencing (#1256 review): the release is authorized by the EXACT source
  // attempt — the reporting agent plus the per-hand-out receipt token
  // next-task issued with the hand-out (`prFixItem.handoutToken`). An
  // unrelated agent that merely knows (id, generation), and the same agent
  // presenting a token from a PREVIOUS hand-out of the same generation
  // (release keeps the generation), are both refused with zero mutation. The
  // write pins the full hand-out state (receipts/hand-outs/acks) and removes
  // ONLY the reporting agent's receipt, hand-out entry, and own ack; other
  // agents' live hand-outs and acknowledgements at the same generation are
  // preserved, and the dispatch stamps survive while any other hand-out is
  // still live. A generation race (fresh attempt re-issued meanwhile) or a
  // human hold (BLOCKED/PARKED/NEEDS_HUMAN — the non-QUEUED gate above)
  // lands as count=0 → skipped with zero mutation.
  if (input.outcome === "capacity-exhausted") {
    const capacity = input.capacity?.trim();
    const handoutToken = attempt?.handoutToken?.trim();
    const reportingAgent = input.agentName?.trim();
    if (expectedGeneration === undefined || !capacity) {
      return { matched: true, action: "skipped", itemId: existing.id ?? null, reason: "capacity-exhausted requires a capacity identifier and prFixItem attempt token" };
    }
    if (!handoutToken || !reportingAgent) {
      return { matched: true, action: "skipped", itemId: existing.id ?? null, reason: "capacity-exhausted requires the issued prFixItem handoutToken receipt (exact source-attempt fencing)" };
    }
    const cooldownUntil = new Date(Date.now() + capacityCooldownMs());
    const queueClient = client as PrFixQueueClient;
    const result = await queueClient.$transaction(async (tx) => {
      // Read the live hand-out set and pin it below. The CAS still pins the
      // ISSUED hand-out stamp (dispatchedGeneration = the generation
      // next-task stamped): exactly one concurrent report can consume the
      // stamps, so two racing duplicates cannot both mint a cooldown.
      const live = await tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
      if (!live) return "stale" as const;
      if (
        live.status !== "QUEUED" ||
        live.generation !== expectedGeneration ||
        live.dispatchedGeneration !== expectedGeneration
      ) {
        const prior = await tx.capacityHandoff?.findMany?.({
          where: { kind: "pr_fix", repoFullName: repo, prNumber: pr, generation: expectedGeneration, agentName: reportingAgent, note: { contains: `receipt=${handoutReceipt(handoutToken, reportingAgent, expectedGeneration)};` } },
        }) ?? [];
        return prior.length ? "replayed" as const : "stale" as const;
      }
      const receipts: string[] = Array.isArray(live.handoutReceipts) ? live.handoutReceipts : [];
      const handouts: string[] = Array.isArray(live.agentHandouts) ? live.agentHandouts : [];
      const acks: string[] = Array.isArray(live.handoutAcks) ? live.handoutAcks : [];
      // Exact source-owner authorization: agent + generation + issued token
      // must all match a live receipt. An unknown or rotated token (the
      // hand-out was already released, reclaimed, or re-issued to this same
      // agent at this same generation) has no authority over the current one.
      const owned = findHandoutReceipt(receipts, {
        agentName: reportingAgent,
        generation: expectedGeneration,
        token: handoutToken,
      });
      if (!owned) {
        const prior = await tx.capacityHandoff?.findMany?.({
          where: { kind: "pr_fix", repoFullName: repo, prNumber: pr, generation: expectedGeneration, agentName: reportingAgent, note: { contains: `receipt=${handoutReceipt(handoutToken, reportingAgent, expectedGeneration)};` } },
        }) ?? [];
        return prior.length ? "replayed" as const : "unauthorized" as const;
      }
      const remainingReceipts = receipts.filter((r) => r !== owned);
      const ownEntry = agentHandoutToken(reportingAgent, expectedGeneration);
      const remainingHandouts = handouts.filter((h) => h !== ownEntry);
      const remainingAcks = acks.filter((a) => a !== ownEntry);
      // The dispatch stamps survive while ANY other agent's hand-out at this
      // generation is still live (#1119: clearing them would reclassify
      // mid-run evidence as pre-dispatch for the surviving workers). Only the
      // report that consumes the last live hand-out resets the stamps and the
      // post-dispatch evidence list, making the generation freshly
      // dispatchable.
      // Legacy hand-outs may predate receipt tokens; handouts remain the
      // authoritative liveness set until all agents at this generation settle.
      const lastHandout = remainingHandouts.length === 0;
      const { count } = await tx.prFixQueueItem.updateMany({
        where: {
          id: live.id,
          status: "QUEUED",
          generation: expectedGeneration,
          dispatchedGeneration: expectedGeneration,
          // Receipt/hand-out/ack pins: a concurrent hand-out, ack, or reclaim
          // landing in the read→write gap makes this a no-op.
          handoutReceipts: { equals: receipts },
          agentHandouts: { equals: handouts },
          handoutAcks: { equals: acks },
        },
        data: {
          handoutReceipts: remainingReceipts,
          agentHandouts: remainingHandouts,
          handoutAcks: remainingAcks,
          ...(lastHandout
            ? {
                postDispatchEvidenceKeys: [],
                dispatchedGeneration: null,
                dispatchedAt: null,
                // #1249: with the last live hand-out gone, the released
                // generation has no issued snapshot left to bound — drop the
                // watermark so the next hand-out stamps a fresh one and no
                // transition between release and re-dispatch is hidden behind
                // a stale boundary.
                attemptEvidenceWatermark: null,
              }
            : {}),
        },
      });
      if (count !== 1) return "stale" as const;
      await tx.prFixHistory.create({ data: { itemId: existing.id, action: "capacity_handoff", status: "QUEUED", lane: existing.lane, reason: capacity, note: `Capacity exhausted: ${capacity}; attempt generation ${expectedGeneration} released by ${reportingAgent} without consuming retry budget; item stays QUEUED and discoverable to compatible capacities.${remainingReceipts.length > 0 ? ` ${remainingReceipts.length} other live hand-out(s) at this generation preserved (dispatch stamps retained).` : ""}` } });
      if (tx.capacityHandoff) {
        await tx.capacityHandoff.create({ data: { kind: "pr_fix", capacity, repoFullName: repo, prNumber: pr, issueNumber: existing.issue ?? null, agentName: reportingAgent, generation: expectedGeneration, cooldownUntil, note: `PR-fix attempt generation ${expectedGeneration} handed off by capacity report; receipt=${handoutReceipt(handoutToken, reportingAgent, expectedGeneration)};` } });
      }
      return true;
    });
    return {
      matched: true,
      action: result === true || result === "replayed" ? "deferred" : "skipped",
      itemId: existing.id ?? null,
      reason:
        result === true
          ? `capacity ${capacity} exhausted; attempt released with a capacity-scoped cooldown until ${cooldownUntil.toISOString()}`
          : result === "unauthorized"
            ? `capacity handoff refused: no live hand-out receipt for ${reportingAgent} at generation ${expectedGeneration} matches the presented handoutToken (already released, reclaimed, or rotated by a newer hand-out); the queue was not modified`
            : "capacity handoff lost a status/generation race",
      attemptGeneration: expectedGeneration,
    };
  }

  if (input.outcome === "waiting-external") {
    if (expectedGeneration === undefined) {
      return { matched: true, action: "skipped", itemId: existing.id ?? null, reason: "waiting-external requires a prFixItem attempt token" };
    }
    const marked = await markPrFixItem(client as PrFixQueueClient, {
      repo, pr, status: "WAITING_EXTERNAL", note: sanitizeForStorage(input.summary?.trim() || input.error || "", 500) || null, expectedGeneration, externalWait: input.externalWait,
    });
    if (marked.mutated) {
      // #1250 review: report the truthful outcome. A wait without a
      // verifiable dependency was downgraded fail-closed to PARKED by
      // markPrFixItem — the report did NOT record a wait.
      const parked = (marked.item as { status?: string; outcome?: string } | null)?.status === "PARKED";
      return {
        matched: true,
        action: parked ? "parked" : "deferred",
        itemId: existing.id ?? null,
        reason: parked
          ? `fail-closed park: external wait without a verifiable dependency parked the item as PARKED/invalid_wait; operator requeue required (#1250)`
          : "worker is waiting for an external prerequisite",
        attemptGeneration: attempt?.generation ?? null,
      };
    }
    return {
      matched: true,
      action: "skipped",
      itemId: existing.id ?? null,
      reason: `wait transition skipped: ${marked.reason}`,
      attemptGeneration: attempt?.generation ?? null,
    };
  }

  if (input.outcome === "blocked") {
    // #1218: a `blocked` report is a genuine human decision only when it
    // carries a `human_decision` blockReason. A bare give-up (or any other
    // outcome) is bounded no-progress exhaustion → PARKED, never labeled
    // needs-human.
    const resolved = normalizePrFixOutcome(input.blockReason) ?? "no_progress";
    const isHumanDecision = resolved === "human_decision";
    const markResult = await markPrFixItem(client as PrFixQueueClient, {
      repo,
      pr,
      status: isHumanDecision ? "BLOCKED" : "PARKED",
      note: input.summary ?? null,
      expectedGeneration,
      ...(isHumanDecision
        ? { outcome: "human_decision", ...(input.decision ? { decision: input.decision } : {}) }
        : { outcome: resolved }),
    });
    if (!markResult.mutated) {
      // #1340: the mark did not land (row re-issued, already settled, or
      // gone), but if it is terminal the reporting agent's hand-out records
      // must not linger on it either. The release CAS no-ops when the row's
      // generation has moved, so a re-issued attempt is never touched.
      await releaseAgentHandout(
        client as PrFixQueueClient,
        existing.id,
        (input.agentName ?? undefined)?.trim(),
        attempt?.generation ?? existing.generation,
        attempt?.handoutToken,
      );
      return {
        matched: true,
        action: "skipped",
        itemId: existing.id ?? null,
        reason: `settlement skipped: ${markResult.reason}`,
        attemptGeneration: attempt?.generation ?? null,
      };
    }
    // #1340: the attempt is over — release the reporting agent's hand-out
    // records at the settled generation so a stale receipt does not keep
    // pinning the settled item. Best-effort: the settlement already committed,
    // so a failure here only logs and never fails the report.
    await releaseAgentHandout(
      client as PrFixQueueClient,
      existing.id,
      (input.agentName ?? undefined)?.trim(),
      attempt?.generation ?? existing.generation,
      attempt?.handoutToken,
    );
    return {
      matched: true,
      action: isHumanDecision ? "blocked" : "parked",
      itemId: existing.id ?? null,
      reason: isHumanDecision ? "agent reported blocked (human decision)" : `agent reported blocked; parked (${resolved})`,
      attemptGeneration: attempt?.generation ?? null,
    };
  }

  if (input.outcome === "failed") {
    // A failed report must not leave the item QUEUED at the generation this
    // worker already consumed (#1133): the bridge reconcile pass that used
    // to own that cleanup is retired, so a consumed generation would sit
    // QUEUED forever and starve the lane behind the deduping worker.
    // Settle the failure into a fresh dispatchable attempt — counted toward
    // PR_FIX_MAX_ATTEMPTS (#1107) — or, past the cap, hand the PR to a
    // human. No PR-state check: a fresh attempt absorbs late evidence by
    // construction (the bump makes it new work).
    //
    // The fresh attempt's per-attempt baseline must be derived from a row
    // read at settlement time, NOT from the caller's pre-read snapshot: a
    // same-generation enqueue (new evidence) updates the mutable headSha
    // without moving status or generation, so the snapshot's head can be
    // stale even though the generation/status pins all still match — and
    // baselining from it would let the #940 guard mistake pre-attempt head
    // movement for worker progress (#1074/#1104). Each pass therefore
    // re-reads the row, derives the baseline from it, and pins the write to
    // the head snapshot that decision was made on; a miss (the head moved
    // again between the re-read and the write) retries on a newer snapshot.
    // Every fresh-attempt pass keeps that pin — settling with a stale
    // baseline defeats the #940 guard no matter how rare the race — so if
    // every pass loses, the report returns the bounded skip below. That
    // skip does not starve the lane (#1133): the per-agent hand-out records
    // make next-task skip the consumed generation for THIS agent while the
    // item stays available to other agents and to any generation-moving
    // transition. The status+generation pins still reject concurrent
    // settles at the same generation (neither BLOCKED nor FIXED bumps).
    const maxFailedRedecisions = 3;
    let settled: { row: any; capped: boolean; rebaseTerminal: boolean } | null = null;
    for (let pass = 0; pass < maxFailedRedecisions && !settled; pass++) {
      const fresh = await client.prFixQueueItem.findUnique({ where: { id: existing.id } });
      if (!fresh) break;
      if (fresh.status !== "QUEUED") break;
      if (expectedGeneration !== undefined && fresh.generation !== expectedGeneration) break;
      // #1327: the mechanical rebase lane is ONE attempt per DIRTY episode.
      // A failed REBASE never reopens a fresh attempt (the generic
      // PR_FIX_MAX_ATTEMPTS ladder is for code-fix generations; retrying a
      // rebase on the same head is exactly the cheap-retry churn this lane
      // exists to remove). The bound keys on `attemptType` — the lane the
      // attempt was DISPATCHED as — because enqueue overwrites the row's
      // `type` on every re-observation, mid-attempt included: a lane flip
      // during a live attempt must neither smuggle a rebase report back onto
      // the ladder nor terminal-park an ordinary fix attempt. A new DIRTY
      // episode is fresh evidence at a new head, which reactivates the park
      // through the #1253 recovery path (cooldown-gated), not the #940
      // FIXED-tombstone net.
      const rebaseTerminal = normalizePrFixType(fresh.attemptType ?? fresh.type) === "REBASE";
      const capped = rebaseTerminal || (fresh.fixAttempts ?? 1) >= maxPrFixAttempts();
      const data: Record<string, unknown> = capped
        ? {
            status: "PARKED",
            lane: "NORMAL",
            outcome: "no_progress",
            decisionDetail: null,
            // #1253: disposition audit stamp (failed-report cap park).
            disposedAt: new Date(),
            disposedEvidence: null,
            postDispatchEvidenceKeys: [],
            agentHandouts: [],
            handoutAcks: [],
            handoutReceipts: [],
          }
        : {
            status: "QUEUED",
            lane: "NORMAL",
            ...freshAttemptGeneration(),
            fixAttempts: { increment: 1 },
            attemptHeadSha: fresh.headSha ?? fresh.attemptHeadSha ?? null,
            // The fresh attempt's dispatched lane is stamped at its own
            // hand-out (#1327); the consumed attempt's stamp must not leak.
            attemptType: null,
            outcome: null,
            decisionDetail: null,
            postDispatchEvidenceKeys: [],
            // Fresh attempt: the consumed generation's hand-out records must
            // not suppress the item's re-dispatch (#1133), and its
            // acknowledgements are dead (#1211).
            agentHandouts: [],
            handoutAcks: [],
            handoutReceipts: [],
          };
      // The head-snapshot pin guards the fresh-attempt branch's baseline on
      // EVERY pass; the capped BLOCKED branch carries no baseline, so it
      // pins on id + status + generation only.
      const row = await (client as PrFixQueueClient).$transaction(async (tx) => {
        const { count } = await tx.prFixQueueItem.updateMany({
          where: {
            id: existing.id,
            status: "QUEUED",
            ...(expectedGeneration !== undefined ? { generation: expectedGeneration } : {}),
            ...(!capped ? { headSha: fresh.headSha ?? null } : {}),
          },
          data,
        });
        if (count !== 1) return null;
        const freshRow = await tx.prFixQueueItem.findUnique({ where: { id: existing.id } });
        await tx.prFixHistory.create({
          data: {
            itemId: existing.id,
            action: "mark",
            status: data.status,
            lane: data.lane,
            outcome: capped ? "no_progress" : null,
            note: [
              input.summary ?? null,
              capped
                ? rebaseTerminal
                  ? "Agent reported failed; the mechanical rebase lane gets one attempt per DIRTY episode (#1327) — parked instead of re-queuing."
                  : `Agent reported failed; bounded at ${fresh.fixAttempts ?? 1} fix attempts (PR_FIX_MAX_ATTEMPTS=${maxPrFixAttempts()}), parked instead of re-queuing (#1133).`
                : `Agent reported failed; reopened as a fresh attempt so the consumed generation cannot strand the queue (#1133).`,
            ]
              .filter(Boolean)
              .join(" "),
          },
        });
        return freshRow;
      });
      if (row) settled = { row, capped, rebaseTerminal };
    }
    if (!settled) {
      // The row is gone, its generation moved (the attempt was re-issued),
      // it was already settled at the same generation, or every pass's
      // head-snapshot pin lost the race: nothing to do. The per-agent
      // hand-out records keep the skipped consumed generation from
      // starving this agent's lane (#1133).
      return {
        matched: true,
        action: "skipped",
        itemId: existing.id ?? null,
        reason: "failed settlement skipped: item no longer QUEUED at the reported generation",
        attemptGeneration: attempt?.generation ?? null,
      };
    }
    if (settled.capped && existing.status !== "BLOCKED" && existing.status !== "PARKED") {
      const context = await buildPrFixBlockedContext(client, settled.row);
      await surfacePrFixParked({
        repo,
        pr,
        reason: settled.row.reason,
        outcome: "no_progress",
        latestNote: input.summary ?? null,
        context,
      });
    }
    return {
      matched: true,
      action: settled.capped ? "parked" : "requeued",
      itemId: existing.id ?? null,
      reason: settled.capped
        ? settled.rebaseTerminal
          ? "agent reported failed; the rebase lane is one attempt per DIRTY episode, parked"
          : "agent reported failed; past the fix-attempt cap, parked"
        : "agent reported failed; reopened as a fresh attempt at the next generation",
      attemptGeneration: attempt?.generation ?? null,
    };
  }

  // "Done"-like outcomes. Gate on PR merge state so we don't mark FIXED
  // off an unverified success — the same check the bridge applies.
  try {
    const mergeState = await fetchPullRequestMergeState(repo, pr);
    if (mergeState.mergeable !== true) {
      // Either CONFLICTING, BLOCKED, unknown (null), or explicitly false.
      // Leave queued so the bridge reconcile pass can re-verify on a later
      // tick rather than us putting a tombstone on a red PR.
      return {
        matched: true,
        action: "deferred",
        itemId: existing.id ?? null,
        reason: `pr not mergeable (mergeable_state=${mergeState.mergeableState ?? "unknown"})`,
        attemptGeneration: attempt?.generation ?? null,
      };
    }
  } catch (error) {
    // If we can't reach GitHub, defer rather than guess — the bridge will
    // re-verify on the next reconcile pass.
    console.error(`pr-fix-queue resolve: pr merge state check failed for ${repo}#${pr}:`, error);
    return {
      matched: true,
      action: "deferred",
      itemId: existing.id ?? null,
      reason: "pr merge state check failed; leaving for bridge reconcile",
      attemptGeneration: attempt?.generation ?? null,
    };
  }

  const alreadyAddressed = input.outcome === "already_addressed";
  // The FIXED baseline is the item's immutable per-attempt `attemptHeadSha`
  // (fallback: mutable `headSha`), re-read inside markPrFixItem BEFORE any
  // write, so a refused FIXED never transiently exists (#1074).
  const markResult = await markPrFixItem(client as PrFixQueueClient, {
    repo,
    pr,
    status: "FIXED",
    note: input.summary ?? null,
    expectedGeneration,
    ...(alreadyAddressed ? { alreadyAddressed: true } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
  });
  if (!markResult.mutated) {
    return {
      matched: true,
      action: "skipped",
      itemId: existing.id ?? null,
      reason: `settlement skipped: ${markResult.reason}`,
      attemptGeneration: attempt?.generation ?? null,
    };
  }
  return {
    matched: true,
    action: "fixed",
    itemId: existing.id ?? null,
    reason: alreadyAddressed
      ? `already_addressed: settled without the head-moved guard${input.evidence ? " (evidence recorded)" : ""}`
      : "pr merge state verified",
    attemptGeneration: attempt?.generation ?? null,
  };
}
