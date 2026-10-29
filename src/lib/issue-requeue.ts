// ─── Fenced attempt requeue (#1491) ──────────────────────────────────────────
//
// Courier's explicit operator retry (#97) requeues ONE attempt of work whose
// run has already terminated. The wire contract is pinned cross-repo by
// Courier's connector fixtures (misospace/courier `internal/source/dispatch/
// retry_test.go`): two routes, a success shape, and a closed coded-409
// refusal vocabulary. `404` is RESERVED for route absence — an unadopted
// deployment — because Courier reads any 404 on these routes as permanent
// version skew and latches `unsupported-source` for the process. A per-item
// condition therefore NEVER answers 404.
//
// The fence is the receipt the run was ISSUED (PR-fix hand-out token, issue
// claim token), validated against the durable ISSUANCE history: a terminal
// report has already released the live receipt (`handoutReceipts` entry gone,
// `Lease` row deleted), so live state can never authorize the retry and the
// ledger written at issuance is the only proof. An unverifiable fence is
// refused — the server never accepts an unfenced requeue, because one would
// mutate whatever attempt currently owns the work.
//
// Refusal vocabulary (exactly these codes, `409 {"reason": "<code>"}`):
//   stale-generation — the fence names an attempt the server no longer
//     records as current; the current owner is NEVER touched.
//   superseded      — the work already moved on without this key (moot for
//     Courier: settles without releasing the request barrier).
//   item-closed     — the upstream item is closed and can never be requeued.
//   human-hold      — an explicit human hold this retry may not lift.
// Idempotency: a committed key replays the original committed result with no
// further mutation; a key reused with a different payload is refused the way
// `AgentReportDedupe` refuses it (bounded uncoded 409 — Courier keeps such a
// refusal transient, which is correct for a caller-side key fault).

import { createHash } from "node:crypto";
import { AGENT_PREFIX, getAgentFromLabels } from "@/types";
import { withIssueMutationGuard, fencedWriteTimeoutForCalls } from "@/lib/issue-mutation-guard";
import { supersedeOwnershipReleaseIntent } from "@/lib/ownership-reconciliation";
import {
  releaseIssueClaim,
  fencedClaimClient,
  releaseIssueClaimWorstCaseCalls,
} from "@/lib/issue-claim";
import {
  lookupIssueHandoffSettlement,
  recordIssueHandoffSettlement,
  settlementExpiresAt,
  settlementRowMatchesFamily,
  ATTEMPT_REQUEUE_SETTLEMENT_OPERATION,
} from "@/lib/issue-handoff-settlement";
import {
  freshAttemptGeneration,
  normalizeQueueRepo,
  nonEmpty,
  parseAgentHandoutToken,
  parseHandoutReceipt,
  type PrFixQueueClient,
} from "@/lib/pr-fix-queue";
import { Prisma } from "@prisma/client";

export type AttemptRequeueRefusal =
  | "stale-generation"
  | "superseded"
  | "item-closed"
  | "human-hold";

/** The pinned closed vocabulary; drift breaks Courier's classifier. */
export const ATTEMPT_REQUEUE_REFUSALS: readonly AttemptRequeueRefusal[] = [
  "stale-generation",
  "superseded",
  "item-closed",
  "human-hold",
];

/**
 * Bound for the run-scoped idempotency key. Courier's client caps keys at
 * 512 bytes (`maxRetryIdempotencyKeyLength`), so the server MUST accept up
 * to that bound — a pinned-capable key rejected over a shorter local cap
 * would strand every retry as a permanent 400. (The #1262 settlement key
 * keeps its own 200-char bound; these routes carry the wider pinned one.)
 */
export const MAX_RETRY_IDEMPOTENCY_KEY_LENGTH = 512;

/** Bound for the untrusted operator note (Courier truncates to 300 BYTES). */
export const MAX_RETRY_NOTE_BYTES = 300;

/** Bound for a presented receipt token (hnd_/claim_ tokens are far smaller). */
export const MAX_RETRY_FENCE_TOKEN_LENGTH = 1024;

/** Bound for an agent name (same as the CI-park family). */
export const MAX_RETRY_AGENT_NAME_LENGTH = 200;

/** Validate + normalize a run-scoped idempotency key. Null when invalid. */
export function normalizeRetryKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_RETRY_IDEMPOTENCY_KEY_LENGTH) return null;
  return trimmed;
}

/**
 * Validate + normalize the optional operator note. The note is UNTRUSTED
 * audit text: bounded, stored, never interpreted. Length is measured in
 * UTF-8 BYTES — Courier truncates on a rune boundary at 300 bytes, and a
 * char-count cap would let multi-byte notes exceed the pinned bound.
 */
export function normalizeRetryNote(
  raw: unknown,
): { ok: true; note: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, note: null };
  if (typeof raw !== "string") {
    return { ok: false, error: "note must be a string" };
  }
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, note: null };
  if (Buffer.byteLength(trimmed, "utf8") > MAX_RETRY_NOTE_BYTES) {
    return { ok: false, error: `note must be at most ${MAX_RETRY_NOTE_BYTES} bytes` };
  }
  return { ok: true, note: trimmed };
}

/** Deterministic key-sorted JSON for scalars/nested objects/arrays. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Fingerprint of the exact committed payload. A key whose replay carries a
 * different fingerprint is refused the way `AgentReportDedupe` refuses it —
 * first payload wins, and a reused key can never rewrite history.
 */
export function requeuePayloadHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** The AgentReportDedupe-shaped key-conflict refusal (uncoded 409). */
export function requeueKeyConflictMessage(surface: string): string {
  return `idempotencyKey already used for a different ${surface} payload`;
}

// ─── Durable issuance ledger ─────────────────────────────────────────────────

export type AttemptIssuanceSurface = "issue" | "pr-fix";

export interface AttemptIssuanceClient {
  attemptIssuance?: {
    create: (args: any) => Promise<any>;
    findUnique: (args: any) => Promise<any>;
  };
}

/**
 * Record a minted receipt at the moment the live issuance write landed.
 * Best-effort BY DESIGN: the live receipt is what dispatch runs on; losing
 * the ledger row only means a later fenced retry cannot prove issuance and
 * is refused closed (the unfenced operator reset stays available). Never
 * blocks or fails the issuance itself.
 */
export async function recordAttemptIssuanceBestEffort(
  client: AttemptIssuanceClient,
  params: {
    surface: AttemptIssuanceSurface;
    attemptId: string;
    agentName: string;
    token: string;
    generation?: number | null;
  },
): Promise<void> {
  if (!client.attemptIssuance) return;
  try {
    await client.attemptIssuance.create({
      data: {
        surface: params.surface,
        attemptId: params.attemptId,
        agentName: params.agentName,
        token: params.token,
        generation: params.generation ?? null,
      },
    });
  } catch (error) {
    // Duplicate token (P2002) is a mint collision that cannot happen for
    // random tokens; anything else is a store failure. Both degrade to
    // "this issuance cannot be fenced by a later retry" — logged, never
    // propagated into the issuance path.
    console.error(`attempt-issuance record failed (${params.surface} ${params.attemptId}):`, error);
  }
}

/**
 * Prove that `token` was ISSUED to (surface, attemptId, agentName) —
 * optionally pinned to an exact generation. Returns false only when
 * absence is ESTABLISHED. A read failure THROWS: the fence caller must fail
 * closed with a retryable 5xx, never treat an unverifiable ledger as absent
 * proof (and never, in the other direction, as issuance).
 *
 * An ABSENT ledger surface throws for the same reason: an absent ledger is
 * not an empty ledger, so it establishes nothing about the issuance. It must
 * never answer `false` — that would report "never issued" for a ledger that
 * was never consulted (the issue route's 503-vs-409 posture: a ledger that
 * cannot be read is retryable, a ledger that proves nothing is a refusal).
 */
export async function proveAttemptIssuance(
  client: AttemptIssuanceClient,
  params: {
    surface: AttemptIssuanceSurface;
    attemptId: string;
    agentName: string;
    token: string;
    generation?: number | null;
  },
): Promise<boolean> {
  if (!client.attemptIssuance) {
    throw new Error("attempt issuance ledger surface unavailable");
  }
  const row = await client.attemptIssuance.findUnique({ where: { token: params.token } });
  if (!row) return false;
  if (row.surface !== params.surface) return false;
  if (row.attemptId !== params.attemptId) return false;
  if (row.agentName !== params.agentName) return false;
  if (params.generation !== undefined && params.generation !== null) {
    if (row.generation !== params.generation) return false;
  }
  return true;
}

// ─── Fenced attempt-requeue (#1491) ──────────────────────────────────────────
//
// `POST /api/pr-fix-queue/attempt-requeue` reactivates exactly ONE
// queue-backed attempt. It is NOT the operator reset above: the caller fences
// on the hand-out receipt ISSUED for the named generation, and a committed
// idempotency key replays from the settlement ledger. The transition stops
// the named generation from owning the work, releases the attempt-scoped
// holds this explicit retry is authorized to lift (the BLOCKED/PARKED
// disposition, the stale-disposition flag, an external wait), and re-offers
// the item under a FRESH generation — without advancing `fixAttempts`,
// without clearing the reclaim budget, without consuming the queue's single
// CI repair opportunity (that reservation lives in the cireserve/cirepair
// columns, cleared with the attempt state by `freshAttemptGeneration`, so a
// requeued attempt starts with its own opportunity rather than spending one),
// and without resolving or closing anything.
//
// The fence validates against the durable ISSUANCE history: a terminal
// report has already released the live receipt, so the `AttemptIssuance` row
// written at hand-out mint is the ONLY proof that authorizes the retry — a
// live receipt (a run that has not terminated yet) is never enough on its
// own. An unverifiable fence is refused `stale-generation`: the server
// never accepts an unfenced requeue.
//
// State → refusal mapping (pinned vocabulary, `409 {"reason": …}`; 404 is
// reserved for route absence and never answers a per-item condition):
//   STALE status            → `item-closed`   (upstream PR merged/closed;
//                              reconcileStalePrFixItems marks it, and it can
//                              never be requeued)
//   NEEDS_HUMAN lane        → `human-hold`    (an explicit human decision
//                              class; only the unfenced operator reset may
//                              lift it, and that reset also resets budgets —
//                              a fenced retry may not overrule a human)
//   IGNORED status          → `superseded`    (already addressed; the work
//                              moved on)
//   FIXED status            → `superseded`    (the fix landed; the work moved
//                              on — a retry must never revert a resolved
//                              item to `QUEUED`)
//   generation advanced AND a settlement exists for the fenced generation
//                           under a different key → `superseded` (moved on
//                           WITHOUT THIS KEY; Courier settles the request
//                           moot and never touches the current owner)
//   generation advanced otherwise → `stale-generation`
//   fence not provably issued for (item, agent, generation) → `stale-generation`

export interface AttemptRequeuePrFixInput {
  repo: string;
  pr: number;
  generation: number;
  agentName: string;
  fenceToken: string;
  idempotencyKey: string;
  note: string | null;
}

export type AttemptRequeuePrFixResult =
  | { ok: true; replayed: boolean; itemId: string; generation: number }
  | { ok: false; refusal: AttemptRequeueRefusal }
  /** The key committed a different payload — the `AgentReportDedupe`
   *  refusal shape: a bounded uncoded 409, transient for Courier. */
  | { ok: false; keyConflict: true }
  /** The settlement ledger could not be read — fail closed with a
   *  retryable 5xx rather than re-apply or invent a settlement. */
  | { ok: false; unavailable: true };

export function parseAttemptRequeueInput(
  body: unknown,
): AttemptRequeuePrFixInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.repo)) return { error: "Missing required field: repo" };
  if (input.pr === undefined || input.pr === null || !Number.isInteger(Number(input.pr))) {
    return { error: "Missing required field: pr" };
  }
  if (input.generation === undefined || input.generation === null || !Number.isInteger(Number(input.generation)) || Number(input.generation) < 1) {
    return { error: "generation must integer >= 1" };
  }
  if (!nonEmpty(input.agentName) || input.agentName.length > MAX_RETRY_AGENT_NAME_LENGTH) {
    return { error: `agentName must be a non-empty string of at most ${MAX_RETRY_AGENT_NAME_LENGTH} characters` };
  }
  if (!nonEmpty(input.fenceToken) || input.fenceToken.length > MAX_RETRY_FENCE_TOKEN_LENGTH) {
    return { error: `fenceToken must be a non-empty string of at most ${MAX_RETRY_FENCE_TOKEN_LENGTH} characters (the issued hand-out receipt)` };
  }
  const idempotencyKey = normalizeRetryKey(input.idempotencyKey);
  if (idempotencyKey === null) {
    return { error: `idempotencyKey must be a non-empty string of at most ${MAX_RETRY_IDEMPOTENCY_KEY_LENGTH} characters` };
  }
  const note = normalizeRetryNote(input.note);
  if (!note.ok) return { error: note.error };
  return {
    repo: input.repo.trim(),
    pr: Number(input.pr),
    generation: Number(input.generation),
    agentName: input.agentName.trim(),
    fenceToken: input.fenceToken.trim(),
    idempotencyKey,
    note: note.note,
  };
}

type AttemptRequeueSettlementRead =
  | { state: "replay"; generation: number }
  | { state: "conflict" }
  | { state: "absent" }
  | { state: "error" };

async function readAttemptRequeueSettlement(
  client: PrFixQueueClient,
  itemId: string,
  input: AttemptRequeuePrFixInput,
  payloadHash: string,
): Promise<AttemptRequeueSettlementRead> {
  if (!client.prFixRequeueSettlement) return { state: "error" };
  let row: any;
  try {
    row = await client.prFixRequeueSettlement.findUnique({
      where: {
        agentName_itemId_settlementKey: {
          agentName: input.agentName,
          itemId,
          settlementKey: input.idempotencyKey,
        },
      },
    });
  } catch {
    // A failed read establishes nothing: never fall through to re-apply.
    return { state: "error" };
  }
  if (!row) return { state: "absent" };
  const now = Date.now();
  if (new Date(row.expiresAt).getTime() <= now) {
    try {
      await client.prFixRequeueSettlement.deleteMany({
        where: { id: row.id, expiresAt: { lte: new Date(now) } },
      });
    } catch {
      // Prune failure only delays dead-row removal.
    }
    return { state: "absent" };
  }
  if (row.payloadHash !== payloadHash) return { state: "conflict" };
  return { state: "replay", generation: Number(row.requeuedGeneration) };
}

type AttemptRequeueClassification =
  | { kind: "proceed"; item: any }
  | { kind: "refusal"; refusal: AttemptRequeueRefusal };

async function classifyAttemptRequeueItem(
  client: PrFixQueueClient,
  item: any,
  input: AttemptRequeuePrFixInput,
): Promise<AttemptRequeueClassification> {
  if (!item) return { kind: "refusal", refusal: "stale-generation" };
  if (item.status === "STALE") return { kind: "refusal", refusal: "item-closed" };
  if (item.lane === "NEEDS_HUMAN") return { kind: "refusal", refusal: "human-hold" };
  if (item.status === "IGNORED") return { kind: "refusal", refusal: "superseded" };
  // A `FIXED` item already resolved: the work moved on without this key, so
  // the retry is moot. Refusing keeps a landed fix from being reverted to
  // `QUEUED` by a fenced retry of a stale attempt — only the evidence-driven
  // reopen paths (#940 new-evidence) or the operator reset may revive it.
  if (item.status === "FIXED") return { kind: "refusal", refusal: "superseded" };
  if (item.generation !== input.generation) {
    // Generation moved. Was the fenced generation requeued under a
    // DIFFERENT key? Then the work moved on WITHOUT THIS KEY — moot for
    // the request (`superseded`), not merely a stale fence. The same-key
    // case replayed earlier, so any committed row here is another key's.
    if (client.prFixRequeueSettlement?.findFirst) {
      try {
        const moved = await client.prFixRequeueSettlement.findFirst({
          where: { itemId: item.id, generation: input.generation },
        });
        if (moved) return { kind: "refusal", refusal: "superseded" };
      } catch {
        // A failed ledger read cannot establish "not moved"; a stale
        // fence is the honest answer either way — the transition would
        // refuse on the CAS regardless. Fail closed on the safer refusal.
        return { kind: "refusal", refusal: "stale-generation" };
      }
    }
    return { kind: "refusal", refusal: "stale-generation" };
  }
  return { kind: "proceed", item };
}

/**
 * Whether the FENCED generation currently carries a live owner that is NOT
 * the presented token — i.e. the issuance was released and re-issued (the
 * capacity-exhausted settlement and the unacknowledged reclaim both keep the
 * generation and rotate the token, so the item stays QUEUED at the same
 * generation), or a second agent was handed the same generation. The current
 * owner of that generation is NEVER touched by a retry of the presented token,
 * so this is a hard refusal.
 *
 * The PRESENTED attempt is identified by the EXACT (agent, generation, token)
 * triple: its own live receipt is not "another owner" — it is the fenced
 * attempt itself, which the transition is allowed to stop. Any OTHER live
 * receipt at the fenced generation IS another owner — including one that
 * COEXISTS with the presented receipt (two live hand-outs at one generation)
 * and including one that carries the presented TOKEN under a DIFFERENT agent
 * (a receipt is one entry per live hand-out, so that row names another
 * owner): the transition clears the whole hand-out state, so it would erase
 * that owner. The `agentHandouts` entries are consulted as well: a hand-out
 * recorded without a receipt (legacy rows) is still a current owner, and the
 * transition would clear it too.
 */
function fencedGenerationHasOtherOwner(
  item: { handoutReceipts?: unknown; agentHandouts?: unknown } | null | undefined,
  input: AttemptRequeuePrFixInput,
): boolean {
  if (!item) return false;
  const receipts: unknown[] = Array.isArray(item.handoutReceipts) ? item.handoutReceipts : [];
  const otherReceipt = receipts.some((entry) => {
    const parsed = parseHandoutReceipt(entry);
    if (parsed === null) return false;
    if (parsed.generation !== input.generation) return false;
    // The presented attempt is the exact (agent, generation, token) triple:
    // a receipt that carries the presented TOKEN under a DIFFERENT agent is
    // another owner's receipt (one entry per live hand-out), so the
    // transition — which clears the whole hand-out state — would erase it.
    return parsed.agentName !== input.agentName || parsed.token !== input.fenceToken;
  });
  if (otherReceipt) return true;
  const handouts: unknown[] = Array.isArray(item.agentHandouts) ? item.agentHandouts : [];
  return handouts.some((entry) => {
    const parsed = parseAgentHandoutToken(entry);
    if (parsed === null) return false;
    if (parsed.generation !== input.generation) return false;
    return parsed.agentName !== input.agentName;
  });
}

class AttemptRequeueCasLost extends Error {
  constructor(readonly refusal: AttemptRequeueRefusal | null) {
    super("attempt-requeue CAS lost");
  }
}
class AttemptRequeueSettlementRaced extends Error {}

export async function attemptRequeuePrFixItem(
  client: PrFixQueueClient,
  rawInput: AttemptRequeuePrFixInput,
): Promise<AttemptRequeuePrFixResult> {
  const input: AttemptRequeuePrFixInput = { ...rawInput, repo: normalizeQueueRepo(rawInput.repo) };
  // Both durable surfaces are mandatory for a fenced requeue: without the
  // settlement the committed key is unprovable (double-apply on retry), and
  // without the issuance ledger the fence cannot outlive the terminal
  // release. Fail closed with a retryable 5xx instead of degrading.
  if (!client.prFixRequeueSettlement || !client.attemptIssuance) {
    return { ok: false, unavailable: true };
  }
  const payloadHash = requeuePayloadHash({
    repo: input.repo,
    pr: input.pr,
    generation: input.generation,
    agentName: input.agentName,
    fenceToken: input.fenceToken,
    note: input.note,
  });

  const item = await client.prFixQueueItem.findUnique({
    where: { repo_pr: { repo: input.repo, pr: input.pr } },
  });
  if (!item) {
    // The fence names an attempt the server does not record at all.
    // NEVER a 404: that verdict belongs to route absence alone.
    return { ok: false, refusal: "stale-generation" };
  }

  // Replay read outside the transaction: a committed key answers the
  // original result with zero mutation — no fence or state re-check, the
  // committed proof (payload-equal, fence included) is the authorization.
  const replay = await readAttemptRequeueSettlement(client, item.id, input, payloadHash);
  if (replay.state === "error") return { ok: false, unavailable: true };
  if (replay.state === "conflict") return { ok: false, keyConflict: true };
  if (replay.state === "replay") {
    return { ok: true, replayed: true, itemId: item.id, generation: replay.generation };
  }

  // Fence: the issuance Dispatch RECORDED for this (item, agent, generation).
  //
  // #1491 pins the authority: the fence is validated against the RECORDED
  // issuance, never against live state alone. A live hand-out receipt proves
  // the presented token is still HELD, not that it was ever ISSUED for this
  // attempt — and the retry arrives AFTER the terminal report released the
  // receipt, so only the durable `AttemptIssuance` ledger (written at
  // hand-out mint) can answer "was this token issued for exactly this
  // attempt?". A live receipt therefore never authorizes the retry by
  // itself: an unprovable fence is refused (`stale-generation`).
  //
  // The live receipts stay a GUARD, never an authorization: a live owner at
  // the fenced generation that is NOT the presented token means the named
  // issuance was RELEASED AND RE-ISSUED (capacity-exhausted settlement and
  // unacknowledged reclaim both keep the generation and rotate the token —
  // the item stays QUEUED at the same generation). A stale token then
  // authorizes NOTHING: bumping the generation would stop the CURRENT live
  // hand-out, violating the pinned "the current owner is NEVER touched" rule.
  // The same holds when the presented receipt coexists with ANOTHER live
  // receipt at that generation: the transition clears the whole hand-out
  // state, so it would erase that other owner.
  if (fencedGenerationHasOtherOwner(item, input)) {
    // The fenced generation is owned by a DIFFERENT live hand-out: the named
    // issuance was released and re-issued. The current owner is NEVER
    // touched. The ledger cannot change this verdict (it proves the
    // PRESENTED token — exactly the stale one), so it is not read.
    return { ok: false, refusal: "stale-generation" };
  }
  // Durable issuance proof — MANDATORY on every path, live receipt
  // included: the retry is authorized by the RECORDED issuance, and the
  // server never accepts an unfenced requeue. A failed ledger read
  // establishes nothing: refuse retryably (503), mutate nothing — never
  // treated as proof, never treated as absence.
  let issued: boolean;
  try {
    issued = await proveAttemptIssuance(client, {
      surface: "pr-fix",
      attemptId: item.id,
      agentName: input.agentName,
      token: input.fenceToken,
      generation: input.generation,
    });
  } catch {
    return { ok: false, unavailable: true };
  }
  if (!issued) return { ok: false, refusal: "stale-generation" };

  const classified = await classifyAttemptRequeueItem(client, item, input);
  if (classified.kind === "refusal") return { ok: false, refusal: classified.refusal };

  const settledAt = new Date();
  const requeuedGeneration = input.generation + 1;
  try {
    await client.$transaction(async (tx) => {
      // Re-read + re-classify inside the transaction (exactly-once): a
      // classification that flipped since the outside read refuses here.
      const fresh = await tx.prFixQueueItem.findUnique({ where: { id: item.id } });
      const inner = await classifyAttemptRequeueItem(tx, fresh, input);
      if (inner.kind === "refusal") throw new AttemptRequeueCasLost(inner.refusal);
      // Re-apply the owner guard against the INSIDE read: a hand-out that
      // landed at the fenced generation after the outside read (a different
      // agent may be handed the item at the same generation) makes the
      // presented token stale — that owner is NEVER touched by this retry.
      if (fencedGenerationHasOtherOwner(fresh, input)) {
        throw new AttemptRequeueCasLost("stale-generation");
      }
      // First write wins: the settlement commits BEFORE the state CAS in
      // this same transaction, so any miss rolls the proof back with it
      // and a committed proof always names an applied transition.
      try {
        await tx.prFixRequeueSettlement!.create({
          data: {
            itemId: fresh.id,
            repo: input.repo,
            pr: input.pr,
            generation: input.generation,
            agentName: input.agentName,
            fenceToken: input.fenceToken,
            settlementKey: input.idempotencyKey,
            payloadHash,
            requeuedGeneration,
            settledAt,
            expiresAt: settlementExpiresAt(settledAt),
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          // A same-key twin committed (or is committing) — its result is
          // the answer. Postgres blocks this insert until the racing
          // transaction resolves, so P2002 here means the twin COMMITTED.
          throw new AttemptRequeueSettlementRaced();
        }
        throw error;
      }
      // The attempt-scoped release + fresh-attempt transition. Budgets the
      // operator reset owns stay untouched: `fixAttempts` (never advanced —
      // a retry must not consume the bounded attempt chain),
      // `handoutReclaims`, and `recoveryAppliedAt` (the single recovery
      // stays spent-or-available exactly as the dead attempt left it).
      const { count } = await tx.prFixQueueItem.updateMany({
        where: {
          id: fresh.id,
          generation: input.generation,
          status: { notIn: ["STALE", "IGNORED", "FIXED"] },
          lane: { not: "NEEDS_HUMAN" },
          // Pin the hand-out state: a concurrent hand-out (or release) that
          // landed between the inside read and this write changes the arrays,
          // so the CAS matches no row and the retry mutates nothing. Without
          // the pin a same-generation hand-out would be silently erased by
          // this transition — the current owner MUST never be touched.
          handoutReceipts: { equals: fresh.handoutReceipts },
          agentHandouts: { equals: fresh.agentHandouts },
        },
        data: {
          status: "QUEUED",
          outcome: null,
          decisionDetail: null,
          staleDisposition: false,
          disposedAt: null,
          disposedEvidence: null,
          ...freshAttemptGeneration(),
          attemptHeadSha: fresh.headSha ?? fresh.attemptHeadSha ?? null,
          postDispatchEvidenceKeys: [],
          agentHandouts: [],
          handoutAcks: [],
          handoutAckTimes: [],
          handoutReceipts: [],
          dispatchedGeneration: null,
          dispatchedAt: null,
          retryAt: null,
          externalWaitBy: null,
          externalWait: Prisma.DbNull,
        },
      });
      if (count !== 1) throw new AttemptRequeueCasLost(null);
      await tx.prFixHistory.create({
        data: {
          itemId: fresh.id,
          action: "attempt-requeue",
          status: "QUEUED",
          lane: fresh.lane,
          note:
            `fenced attempt-requeue generation=${input.generation} -> ${requeuedGeneration} agent=${input.agentName}` +
            (input.note ? `: ${input.note}` : ""),
        },
      });
    });
    return { ok: true, replayed: false, itemId: item.id, generation: requeuedGeneration };
  } catch (error) {
    if (error instanceof AttemptRequeueCasLost) {
      if (error.refusal) return { ok: false, refusal: error.refusal };
      // The CAS miss itself explains nothing; re-classify against fresh
      // state. Anything still "proceed" (a concurrent same-generation
      // mutation not visible to the classifier) is a churning race —
      // retryable, no settlement committed.
      const fresh = await client.prFixQueueItem.findUnique({ where: { id: item.id } });
      const reclass = await classifyAttemptRequeueItem(client, fresh, input);
      if (reclass.kind === "refusal") return { ok: false, refusal: reclass.refusal };
      // A concurrent hand-out at the fenced generation is a CURRENT OWNER:
      // the retry must never touch it — that is a per-item refusal, not a
      // churning race.
      if (fresh && fencedGenerationHasOtherOwner(fresh, input)) {
        return { ok: false, refusal: "stale-generation" };
      }
      return { ok: false, unavailable: true };
    }
    if (error instanceof AttemptRequeueSettlementRaced) {
      const raced = await readAttemptRequeueSettlement(client, item.id, input, payloadHash);
      if (raced.state === "replay") {
        return { ok: true, replayed: true, itemId: item.id, generation: raced.generation };
      }
      if (raced.state === "conflict") return { ok: false, keyConflict: true };
      return { ok: false, unavailable: true };
    }
    throw error;
  }
}


// ─── Issue (implement work) fenced requeue (#1491) ───────────────────────────
//
// `POST /api/issues/requeue` releases the fenced claim for ONE issue attempt
// and returns the issue to offerable — without consuming anything (no budget,
// no repair opportunity) and without resolving it. The fence is the claim
// receipt the run was ISSUED; because the terminal report already released
// the live claim (`Lease` row deleted), the durable `AttemptIssuance` row
// written at claim-token mint is the ONLY proof that authorizes the retry —
// the `Lease` row is the guard against touching a newer claim incarnation
// (its token differs), never a substitute for the recorded issuance. An
// unverifiable fence is refused `stale-generation` and the current owner is
// NEVER touched.
//
// State → refusal mapping (same pinned vocabulary; never a 404):
//   issue state closed        → `item-closed`   (closed upstream)
//   live `status/done` label  → `superseded`    (resolved — the work moved on
//                              without this key)
//   live `status/blocked`     → `human-hold`    (fail-closed on ANY live
//                              blocked label, exactly the capacity-handoff
//                              human-hold rule)
//   another agent owns it     → `superseded`
//   lease carries a NEWER claim token → `stale-generation`
//   lease carries a RETIRED (null) claim token → `stale-generation` (the
//                              reconciler's Phase A retired the epoch fence;
//                              the row survives, the fence does not)
//   fence not provably issued → `stale-generation`
//   issuance ledger absent or unreadable → 503 (retryable — never a refusal)
//
// The release itself IS the shared claim release (`releaseIssueClaim`, the
// path unclaim / capacity-handoff / the reconciler share) under the per-issue
// mutation anchor and the fenced remote write, and the durable settlement is
// the shared #1262 ledger (`IssueHandoffSettlement`, first write wins,
// committed in the SAME transaction as the lease consumption so a miss rolls
// the proof back with it) — never a parallel mechanism.

/** The settlement row the transaction found for the key is not this caller's proof. */
class IssueRequeueSettlementForeign extends Error {}
/** The lease CAS missed inside the settlement transaction. */
class IssueRequeueSettlementCasLost extends Error {}

export interface IssueRequeueInput {
  client: any;
  issueId: string;
  repoFullName: string;
  issueNumber: number;
  agentName: string;
  claimToken: string;
  idempotencyKey: string;
  note: string | null;
  actor: string;
  now?: Date;
}

export type IssueRequeueResult =
  | { ok: true; replayed: boolean; attemptId: string | null }
  | { ok: false; refusal: AttemptRequeueRefusal }
  | { ok: false; keyConflict: string }
  | { ok: false; unavailable: true }
  | { ok: false; badRequest: string };

export function parseIssueRequeueInput(body: unknown): Omit<IssueRequeueInput, "client" | "actor"> | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.issueId)) return { error: "Missing required field: issueId" };
  if (!nonEmpty(input.repoFullName)) return { error: "Missing required field: repoFullName" };
  if (input.issueNumber === undefined || input.issueNumber === null || !Number.isInteger(Number(input.issueNumber))) {
    return { error: "Missing required field: issueNumber" };
  }
  if (!nonEmpty(input.agentName) || input.agentName.length > MAX_RETRY_AGENT_NAME_LENGTH) {
    return { error: `agentName must be a non-empty string of at most ${MAX_RETRY_AGENT_NAME_LENGTH} characters` };
  }
  if (!nonEmpty(input.claimToken) || input.claimToken.length > MAX_RETRY_FENCE_TOKEN_LENGTH) {
    return { error: `claimToken must be a non-empty string of at most ${MAX_RETRY_FENCE_TOKEN_LENGTH} characters (the issued claim receipt)` };
  }
  const idempotencyKey = normalizeRetryKey(input.idempotencyKey);
  if (idempotencyKey === null) {
    return { error: `idempotencyKey must be a non-empty string of at most ${MAX_RETRY_IDEMPOTENCY_KEY_LENGTH} characters` };
  }
  const note = normalizeRetryNote(input.note);
  if (!note.ok) return { error: note.error };
  return {
    issueId: input.issueId.trim(),
    repoFullName: input.repoFullName.trim(),
    issueNumber: Number(input.issueNumber),
    agentName: input.agentName.trim(),
    claimToken: input.claimToken.trim(),
    idempotencyKey,
    note: note.note,
  };
}

export async function requeueIssueAttempt(input: IssueRequeueInput): Promise<IssueRequeueResult> {
  const client = input.client;
  const now = input.now ?? new Date();
  const { agentName, issueId, claimToken } = input;
  const agentLabel = `${AGENT_PREFIX}${agentName}`;
  const payloadHash = requeuePayloadHash({
    issueId: input.issueId,
    // The identity gate below is case-INSENSITIVE on the repo half (GitHub
    // repo names are), so the fingerprint must be too: a retry that spells
    // the same repo differently is the SAME attempt and must replay, not
    // collide as a foreign payload.
    repoFullName: input.repoFullName.toLowerCase(),
    issueNumber: input.issueNumber,
    agentName: input.agentName,
    claimToken: input.claimToken,
    note: input.note,
  });

  const guarded = await withIssueMutationGuard(
    { issueId, operation: "attempt-requeue", agentName, claimToken },
    async (_tx, { runFencedRemoteWrite }): Promise<{ complete: boolean; value: IssueRequeueResult }> => {
      const issue = await client.issue.findUnique({ where: { id: issueId }, include: { repository: true } });
      if (!issue) {
        // The server records no such attempt. NEVER 404 — that verdict is
        // reserved for route absence (permanently version-skew evidence for
        // Courier); this is simply a fence for work it does not record.
        return { complete: true, value: { ok: false, refusal: "stale-generation" } };
      }
      // Identity gate mirrors capacity-handoff (#1129): the canonical GitHub
      // repo comes from the loaded DB record. The comparison is
      // case-INSENSITIVE on the repo half (GitHub repo names are
      // case-insensitive; a case-drifted body value must not 400 forever),
      // and the canonical casing is what the release and audit see.
      if ((issue.repository?.fullName ?? "").toLowerCase() !== input.repoFullName.toLowerCase() || issue.number !== input.issueNumber) {
        return {
          complete: true,
          value: {
            ok: false,
            badRequest: `issueId does not match repoFullName/issueNumber; expected ${issue.repository?.fullName}#${issue.number}`,
          },
        };
      }

      // ── Durable replay BEFORE any fence re-derivation ─────────────────────
      // A committed key answers its original result verbatim: zero mutation.
      // The recorded payload (claim token + fingerprint) is the authorization;
      // re-deriving live fences around a committed settlement could only
      // contradict the pinned contract ("replays the original committed
      // result with no further mutation").
      const lookup = await lookupIssueHandoffSettlement(client, { agentName, issueId, settlementKey: input.idempotencyKey }, now);
      if (lookup.state === "error") return { complete: true, value: { ok: false, unavailable: true } };
      if (lookup.state === "found") {
        // Replay is authorized ONLY by the exact committed payload: same
        // claim token AND the same fingerprint, from the SAME settlement
        // family. A row without a fingerprint (the capacity-handoff family
        // pre-#1491) or a row tagged for another family is a foreign payload
        // for this key — refused as a key conflict, never replayed as a
        // requeue success the other family never committed.
        if (
          lookup.record.claimToken !== claimToken ||
          lookup.record.payloadHash !== payloadHash ||
          !settlementRowMatchesFamily(lookup.record, ATTEMPT_REQUEUE_SETTLEMENT_OPERATION)
        ) {
          return { complete: true, value: { ok: false, keyConflict: requeueKeyConflictMessage("issue requeue") } };
        }
        return { complete: true, value: { ok: true, replayed: true, attemptId: lookup.record.attemptId ?? null } };
      }

      // ── Per-item state gates (fail closed, current owner never touched) ───
      if (issue.state === "closed") return { complete: true, value: { ok: false, refusal: "item-closed" } };
      const labels: string[] = Array.isArray(issue.labels) ? issue.labels : [];
      if (labels.includes("status/done")) return { complete: true, value: { ok: false, refusal: "superseded" } };
      if (labels.includes("status/blocked")) return { complete: true, value: { ok: false, refusal: "human-hold" } };
      const currentAgent = getAgentFromLabels(labels);
      if (currentAgent && currentAgent !== agentLabel) {
        return { complete: true, value: { ok: false, refusal: "superseded" } };
      }

      // ── Fence: the recorded issuance, with the lease as the owner guard ──
      let lease: any = null;
      try {
        lease = await client.lease.findUnique({ where: { agentName_issueId: { agentName, issueId } } });
      } catch {
        return { complete: true, value: { ok: false, unavailable: true } };
      }
      if (lease && lease.claimToken !== claimToken) {
        // The lease row is NOT this attempt's fence:
        //   - a DIFFERENT token → a NEWER claim incarnation owns this work
        //     (its row is never touched);
        //   - a NULL token → the fence was RETIRED (the reconciler's Phase A
        //     clears `claimToken` when it releases the epoch, and a pre-#1256
        //     row never carried one) — the presented attempt holds nothing.
        // Either way the row is not ours, so the retry refuses BEFORE any
        // remote write: the truthiness form (`lease.claimToken && …`) let a
        // token-less row fall through to the release, which then could not
        // consume the row (the lease CAS matches on the presented token) — a
        // mutation followed by a 503 that repeated forever. The sibling
        // fenced paths already refuse a token-less lease
        // (`issue-capacity-handoff.ts`, `worker-ownership.ts`).
        return { complete: true, value: { ok: false, refusal: "stale-generation" } };
      }
      // Durable issuance proof — MANDATORY (#1491 pins the authority: the
      // fence is validated against the issuance Dispatch RECORDED for this
      // claim, never against live state alone). The lease row names the
      // CURRENT claim incarnation — it is the guard against touching another
      // owner, not proof that the PRESENTED token was ever issued: a terminal
      // report already released the live claim, and the durable ledger is
      // what survives that release. Absence is a closed refusal; a failed
      // ledger read is a retryable 503 — never treated as absent, never
      // treated as issuance.
      let issued: boolean;
      try {
        issued = await proveAttemptIssuance(client, {
          surface: "issue",
          attemptId: issueId,
          agentName,
          token: claimToken,
        });
      } catch {
        return { complete: true, value: { ok: false, unavailable: true } };
      }
      if (!issued) return { complete: true, value: { ok: false, refusal: "stale-generation" } };

      // §8.7 exemption (mirrors unclaim): an explicit fenced release supersedes
      // a pending reconciler release intent (audited) instead of racing it.
      await supersedeOwnershipReleaseIntent({
        issueId,
        actor: input.actor,
        reason: `explicit attempt-requeue by ${input.actor}`,
      });

      // ── The shared claim release, fenced (#1254/#1361/#1367) ──────────────
      let released;
      try {
        released = await runFencedRemoteWrite(
          (tx: any) =>
            releaseIssueClaim({
              prisma: fencedClaimClient(tx),
              issue,
              // Canonical casing from the loaded record (m5): the identity
              // gate above matched case-insensitively, so the remote label
              // write uses the DB's canonical repo name.
              repoFullName: issue.repository?.fullName ?? input.repoFullName,
              issueNumber: input.issueNumber,
              agentName,
              // #1491: the terminal report (or the reconciler / stale-work
              // sweep) that released this claim usually removed the `agent/*`
              // label ALREADY — that absent label is the state this route
              // exists for, not a caller error. `allowMissingAgent` makes the
              // release an idempotent repair (DELETE 404 = already gone)
              // instead of throwing `Issue is not assigned to`.
              options: { actor: input.actor, allowMissingAgent: true },
            }),
          { timeoutMs: fencedWriteTimeoutForCalls(releaseIssueClaimWorstCaseCalls(labels)) },
        );
      } catch (error) {
        // Remote release failed: nothing was settled and the lease stays
        // intact. COMPLETE (not retained): `attempt-requeue` has no resume
        // branch by design — every retry re-derives the whole transition
        // idempotently (the shared release tolerates the absent label, the
        // settlement is first-write-wins, the lease consumption is a CAS),
        // so retaining a demoted guard here would wedge the issue (#1367
        // posture). A leaked throw deletes the row via the guard's
        // delete-on-throw list.
        console.error(`attempt-requeue: claim release failed for ${issueId}:`, error);
        return { complete: true, value: { ok: false, unavailable: true } };
      }
      if (released.status === "guard-lost") {
        // The guard was re-owned before the remote write: NOTHING happened.
        // Retryable — the current owner (whoever it is now) is untouched.
        return { complete: true, value: { ok: false, unavailable: true } };
      }
      const releaseValue = released.value as {
        released?: boolean;
        labels: string[];
        status: string | null;
        statusNote: string | null;
      };
      if (releaseValue.released === false) {
        // The shared release SKIPPED: another agent owns the claim (the
        // release refuses to remove a newer owner's label). Nothing was
        // released, so nothing may be settled and the lease stays — a skip
        // is never a successful retry. The route's own label gate above
        // reads the same snapshot, so this is the defensive second line.
        return { complete: true, value: { ok: false, refusal: "superseded" } };
      }

      // ── Durable settlement AND lease consumption in ONE transaction ──────
      // #1262 discipline, mirrored from the pr-fix surface above: the
      // settlement commits BEFORE the lease CAS inside the SAME transaction,
      // so a CAS miss (or a crash between the two writes) rolls the proof
      // back with it. Without the shared transaction a stranded proof could
      // outlive an unconsumed lease: the replay branch (and the guard-busy
      // replay) answer the committed settlement verbatim and never re-derive
      // the lease, so the issue would stay leased while every later retry
      // reported success.
      const attemptId: string | null = lease?.id ?? null;
      try {
        await client.$transaction(async (tx: any) => {
          const recorded = await recordIssueHandoffSettlement(tx, {
            agentName,
            issueId,
            claimToken,
            settlementKey: input.idempotencyKey,
            capacity: null,
            labels: releaseValue.labels,
            status: releaseValue.status,
            statusNote: releaseValue.statusNote,
            cooldownUntil: null,
            settledAt: now,
            operation: ATTEMPT_REQUEUE_SETTLEMENT_OPERATION,
            payloadHash,
            attemptId,
          });
          if (
            !recorded ||
            recorded.claimToken !== claimToken ||
            recorded.payloadHash !== payloadHash ||
            !settlementRowMatchesFamily(recorded, ATTEMPT_REQUEUE_SETTLEMENT_OPERATION)
          ) {
            // First-write-wins: a row that won the key first is returned
            // instead of ours. The proof this release consumes must be OURS —
            // the same claim incarnation AND the same committed payload
            // fingerprint. A row under the same claim token but a DIFFERENT
            // payload (a concurrent retry with another note) is a foreign
            // payload for this key, not our proof: consuming the lease on it
            // would acknowledge a result this caller never committed. The
            // throw rolls the (no-op) write back with the transaction.
            throw new IssueRequeueSettlementForeign();
          }
          if (lease?.id) {
            const { count } = await tx.lease.deleteMany({
              where: { id: lease.id, agentName, issueId, claimToken },
            });
            if (count !== 1) {
              // CAS miss: the lease moved under us. Throwing rolls the
              // settlement back with the transaction — no proof may outlive
              // an unconsumed lease (the previous best-effort retraction
              // could itself fail and strand exactly such a proof).
              throw new IssueRequeueSettlementCasLost();
            }
          }
        });
      } catch (error) {
        if (error instanceof IssueRequeueSettlementForeign) {
          return { complete: true, value: { ok: false, keyConflict: requeueKeyConflictMessage("issue requeue") } };
        }
        // The transaction failed after the remote release (a ledger write
        // error or the lease CAS miss). COMPLETE: the retry re-runs the whole
        // transition idempotently (the absent label is a repair, the
        // settlement is first-write-wins, the lease consumption is a CAS) —
        // a retained, unresumable guard would wedge the issue (#1367
        // posture). Nothing durable was committed by this attempt.
        console.error(`attempt-requeue: settlement/lease transaction failed for ${issueId}:`, error);
        return { complete: true, value: { ok: false, unavailable: true } };
      }

      // Retire active AgentWork rows (visibility bookkeeping, never fatal).
      try {
        const activeWork = await client.agentWork.findMany({
          where: { agentName, issueId, state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] } },
          select: { id: true },
        });
        for (const work of activeWork) {
          await client.agentWork.update({
            where: { id: work.id },
            data: { state: "RELEASED", leaseExpiresAt: now },
          });
          await client.agentWorkHistory.create({
            data: {
              workId: work.id,
              action: "attempt_requeue",
              state: "RELEASED",
              summary:
                `Issue requeued as a fresh offer by fenced attempt-requeue` +
                (input.note ? `: ${input.note}` : ""),
            },
          });
        }
      } catch (error) {
        console.error(`attempt-requeue: AgentWork release failed for ${issueId}:`, error);
      }

      return { complete: true, value: { ok: true, replayed: false, attemptId } };
    },
  );

  if (guarded.status === "busy") {
    // The anchor is held by another writer. A committed settlement still
    // answers definitively (post-release crash would otherwise hide a
    // durable success behind a busy 503); everything else is retryable.
    const lookup = await lookupIssueHandoffSettlement(client, { agentName, issueId, settlementKey: input.idempotencyKey }, now);
    if (
      lookup.state === "found" &&
      lookup.record.claimToken === claimToken &&
      lookup.record.payloadHash === payloadHash &&
      settlementRowMatchesFamily(lookup.record, ATTEMPT_REQUEUE_SETTLEMENT_OPERATION)
    ) {
      return { ok: true, replayed: true, attemptId: lookup.record.attemptId ?? null };
    }
    return { ok: false, unavailable: true };
  }
  return guarded.value;
}
