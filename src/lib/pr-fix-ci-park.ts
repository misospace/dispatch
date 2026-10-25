/**
 * CI park-and-resume lifecycle for the PR-fix queue (misospace/courier#495,
 * server side of misospace/dispatch#1415).
 *
 * Courier reports a repair opportunity in three generation-fenced, idempotent
 * steps while one of its PR-fix runs sits parked on pending CI:
 *
 * - `cipark`: announce the deferral ("CI is red on this head; keep the queued
 *   hand-out quiet"). The item's `ciParkState` becomes "active"; suppression
 *   is per-item and applies to ANY polling agent — the notice's agentName is
 *   transport identity only.
 * - `cireserve`: book the ONE repair opportunity per deferral with a fence
 *   token exactly the caller presented (the server pins it and echoes it
 *   back; Courier's grant asserts `grant.FenceToken == presented`).
 * - `cirepair`: settle the fenced opportunity — "repushed" moves the parked
 *   head and closes only this reservation (the deferral stays active so CI
 *   re-observes the new head), "exhausted"/"unsupported" hand stewardship
 *   back to Dispatch ("settled"; the queued hand-out resumes).
 *
 * A fence-less `cirepair` with `result: "unsupported"` is Courier's fallback
 * release for a deferral whose reservation never opened; it works by
 * park-key match on the same generation and produces "released".
 *
 * Exactly-once replay: every accepted transition commits one
 * `PrFixCIParkLedger` row keyed (item, kind, idempotencyKey) inside one
 * transaction — replay read → conditional item update (the CAS is the
 * linearization point) → ledger witness, ONLY after the CAS committed. A
 * lost CAS therefore writes nothing at all: a refused transition leaves no
 * witness, so a same-key retry re-answers the refusal instead of replaying
 * it as a success (a pre-CAS witness would commit with the 409 and poison
 * every later retry — review finding on this PR). Concurrent same-key
 * commits still collapse: the loser's CAS counts zero (the winner's state
 * move breaks its guard) and its re-read finds the winner's witness; the
 * residual interleave where both CASes match is settled by the witness
 * itself — the P2002 loser throws out of the transaction (rolling its
 * no-op CAS write back, so a replay never churns state) and answers the
 * winner's replay. When the client has no ledger
 * surface (legacy/test clients), the same machinery falls back to state-only
 * writes: a repeated same-key commit is then a same-value idempotent
 * re-apply (safe by construction — the state itself is the replay witness),
 * never a double-apply.
 *
 * The wire shapes and coded refusals are pinned cross-repo by
 * misospace/courier internal/source/dispatch/cipark_test.go: bodies carry
 * {repo, generation, agentName, head?, idempotencyKey, fenceToken?, result?}
 * and no route may add, require, or honor a `pr`, `prFixId`, or
 * `handoutToken` key. Check order below is part of that contract.
 */

import type { PrFixQueueClient } from "./pr-fix-queue";
import { agentHandoutToken, nonEmpty, normalizeQueueRepo } from "./pr-fix-queue";

// ── Validation constants (client mirrors: misospace/courier cipark.go) ─────

/** Trimmed 7..64 hexadecimal commit SHA spelling (byte-for-byte identity). */
const CI_HEAD_PATTERN = /^[0-9a-fA-F]{7,64}$/;

/** Bounded idempotency key: dedupes retried reports of ONE transition. */
const MAX_CI_IDEMPOTENCY_KEY = 512;

/** Bounded fence token a reservation presents and an outcome presents back. */
const MAX_CI_FENCE_TOKEN = 1024;

/** Same agent-name bound the other identity-scoped routes enforce. */
const MAX_CI_AGENT_NAME = 200;

export const CI_REPAIR_RESULTS = ["repushed", "exhausted", "unsupported"] as const;
export type CIRepairResult = (typeof CI_REPAIR_RESULTS)[number];

/** Coded refusal vocabulary pinned by cipark_test.go — exact strings. */
export type CIRefusalCode =
  | "fence-held"
  | "fence-gone"
  | "opportunity-missing"
  | "head-superseded"
  | "fence-settled";

/** Extra reason the routes map to the mark family's legacy mismatch literal. */
export type CIParkCallReason = CIRefusalCode | "generation-mismatch";

// ── Input shapes (the pinned wire bodies; no `pr` travels anywhere) ─────────
//
// The notice binds to the queue row through the handout the deferral actually
// suspends: every lifecycle report originates from a LIVE run born of
// Dispatch's next-task handout `<agentName>@<generation>` on exactly one row,
// and the connector's agent works serially — so `agentHandouts.has(marker)`
// names that row exactly (generation alone cannot: counts are per-item and
// collide across a repo's rows). The marker survives every park/reserve/
// outcome write, so one binding serves the whole lifecycle; resolution misses
// (never handed, fresh-attempt bump cleared the marker, row deleted) and
// marker collisions fail closed — the caller answers `opportunity-missing`.

export interface CIParkInput {
  repo: string;
  generation: number;
  agentName: string;
  head: string;
  idempotencyKey: string;
}

export interface CIReserveInput extends CIParkInput {
  fenceToken: string;
}

export interface CIRepairInput {
  repo: string;
  generation: number;
  agentName: string;
  idempotencyKey: string;
  result: CIRepairResult;
  /** Fenced path. Absent on the fence-less `unsupported` release. */
  fenceToken?: string | null;
  /** Required with result "repushed"; forbidden otherwise (enforced below). */
  head?: string | null;
}

// ── Results ─────────────────────────────────────────────────────────────────

/**
 * Mutation outcome of one lifecycle call. `ok: false` with reason
 * "generation-mismatch" is the legacy fence: the route answers the mark
 * family's exact body literal. Every other refusal reason is a coded 409
 * body `{"reason": code}` pinned by cipark_test.go. A replayed call answers
 * exactly like a fresh success (204, or the reserved fence echo for
 * reserve) without state churn.
 */
export type CIParkCallResult =
  | { ok: true; replayed?: boolean; fenceToken?: string; item?: any }
  | { ok: false; reason: CIParkCallReason };

type LedgerKind = "park" | "reserve" | "outcome" | "release";

// ── Parsing (mirrors parseMarkPrFixInput / parseAckPrFixHandoutInput) ────────

function parseCIGeneration(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return null;
  return value;
}

function parseCIBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
): { value: string } | { error: string } {
  // Type check first so a non-string value surfaces as the type error, not
  // as "Missing required field" (nonEmpty is type-agnostic).
  if (value !== undefined && value !== null && typeof value !== "string") {
    return { error: `${field} must be a string` };
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return { error: `Missing required field: ${field}` };
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    return { error: `${field} must be at most ${maxLength} characters` };
  }
  return { value: trimmed };
}

function parseCIAgentName(value: unknown): { value: string } | { error: string } {
  if (value !== undefined && value !== null && typeof value !== "string") {
    return { error: "agentName must be a string" };
  }
  if (!nonEmpty(value)) return { error: "Missing required field: agentName" };
  const trimmed = (value as string).trim();
  if (trimmed.length > MAX_CI_AGENT_NAME) {
    return { error: `agentName must be at most ${MAX_CI_AGENT_NAME} characters` };
  }
  return { value: trimmed };
}

function parseCIHead(
  input: Record<string, unknown>,
  required: boolean,
): { value: string | null } | { error: string } {
  if (input.head === undefined || input.head === null) {
    return required ? { error: "Missing required field: head" } : { value: null };
  }
  if (typeof input.head !== "string") return { error: "head must be a string" };
  const trimmed = input.head.trim();
  if (!CI_HEAD_PATTERN.test(trimmed)) return { error: "Invalid head" };
  return { value: trimmed };
}

function parseCIFenceToken(
  input: Record<string, unknown>,
  required: boolean,
): { value: string | null } | { error: string } {
  if (input.fenceToken === undefined || input.fenceToken === null) {
    return required ? { error: "Missing required field: fenceToken" } : { value: null };
  }
  if (typeof input.fenceToken !== "string") return { error: "fenceToken must be a string" };
  const trimmed = input.fenceToken.trim();
  if (trimmed.length === 0) return { error: "Missing required field: fenceToken" };
  if (trimmed.length > MAX_CI_FENCE_TOKEN) {
    return { error: `fenceToken must be at most ${MAX_CI_FENCE_TOKEN} characters` };
  }
  return { value: trimmed };
}

/** Shared base fields of the three bodies; unknown/extra fields are ignored. */
function parseCIBaseFields(
  body: unknown,
): { repo: string; generation: number; agentName: string; idempotencyKey: string } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  if (!nonEmpty(input.repo)) return { error: "Missing required field: repo" };
  const generation = parseCIGeneration(input.generation);
  if (generation === null) return { error: "generation must be an integer >= 1" };
  const agentName = parseCIAgentName(input.agentName);
  if ("error" in agentName) return agentName;
  const idempotencyKey = parseCIBoundedString(input.idempotencyKey, "idempotencyKey", MAX_CI_IDEMPOTENCY_KEY);
  if ("error" in idempotencyKey) return idempotencyKey;
  return {
    repo: input.repo.trim(),
    generation,
    agentName: agentName.value,
    idempotencyKey: idempotencyKey.value,
  };
}

export function parseCIParkInput(body: unknown): CIParkInput | { error: string } {
  const base = parseCIBaseFields(body);
  if ("error" in base) return base;
  const input = body as Record<string, unknown>;
  const head = parseCIHead(input, true);
  if ("error" in head) return head;
  return { ...base, head: head.value as string };
}

export function parseCIReserveInput(body: unknown): CIReserveInput | { error: string } {
  const base = parseCIBaseFields(body);
  if ("error" in base) return base;
  const input = body as Record<string, unknown>;
  const head = parseCIHead(input, true);
  if ("error" in head) return head;
  const fenceToken = parseCIFenceToken(input, true);
  if ("error" in fenceToken) return fenceToken;
  return { ...base, head: head.value as string, fenceToken: fenceToken.value as string };
}

export function parseCIRepairInput(body: unknown): CIRepairInput | { error: string } {
  const base = parseCIBaseFields(body);
  if ("error" in base) return base;
  const input = body as Record<string, unknown>;
  if (input.result === undefined || input.result === null) return { error: "Missing required field: result" };
  if (typeof input.result !== "string" || !CI_REPAIR_RESULTS.includes(input.result as CIRepairResult)) {
    return { error: "Invalid result" };
  }
  const result = input.result as CIRepairResult;
  // head is required with "repushed" and forbidden otherwise — a retried
  // transition must never smuggle a head identity a no-repush outcome did
  // not have (#495: "exhausted outcome carries head" is a wire violation).
  const head = parseCIHead(input, result === "repushed");
  if ("error" in head) return head;
  if (head.value !== null && result !== "repushed") {
    return { error: "head is only allowed on a repushed outcome" };
  }
  // Fence: required for repushed/exhausted; optional for unsupported (fenced
  // settlement vs fence-less release). A fence-less repushed/exhausted call
  // is refused so the fence can never be bypassed by re-sending the body.
  const fenceToken = parseCIFenceToken(input, result !== "unsupported");
  if ("error" in fenceToken) return fenceToken;
  return {
    ...base,
    result,
    ...(result === "repushed" ? { head: head.value as string } : { head: null }),
    ...(fenceToken.value !== null ? { fenceToken: fenceToken.value as string } : {}),
  };
}

// ── Ledger surface (exactly-once vs legacy state-only fallback) ─────────────

function ciParkLedger(client: PrFixQueueClient) {
  return client.prFixCIParkLedger ?? null;
}

/** Prisma's unique-violation code (the brief's pinned detection). */
function isP2002(error: unknown): boolean {
  return (error as { code?: string } | null | undefined)?.code === "P2002";
}

async function findLedgerRow(
  client: PrFixQueueClient,
  itemId: string,
  kind: LedgerKind,
  key: string,
): Promise<any | null> {
  const ledger = ciParkLedger(client);
  if (!ledger) return null;
  return (await ledger.findUnique({
    where: { itemId_kind_key: { itemId, kind, key } },
  })) ?? null;
}

/**
 * Thrown INSIDE a `$transaction` when the witness create collides (P2002)
 * with a same-key commit that won after this call's CAS matched. Throwing is
 * the rollback: it discards this transaction's CAS write — a replay must not
 * churn state — and the caller's outer handler answers the winner's replay.
 */
class CIParkWitnessRaced extends Error {
  constructor() {
    super("ci-park ledger witness raced");
  }
}

/**
 * Commit the ledger witness for a transition whose CAS ALREADY matched,
 * INSIDE the caller's transaction — never before the CAS, so a refused (or
 * rolled-back) transition leaves no witness a later retry could replay as a
 * success. A P2002 here means a concurrent same-key commit matched past this
 * call's guard: throw out to roll the write back (see CIParkWitnessRaced).
 */
async function commitWitness(
  tx: PrFixQueueClient,
  itemId: string,
  data: { kind: LedgerKind; key: string; fence?: string | null; result?: string | null; head?: string | null; agent?: string | null },
): Promise<void> {
  const ledger = ciParkLedger(tx);
  if (!ledger) return;
  try {
    await ledger.create({
      data: {
        itemId,
        kind: data.kind,
        key: data.key,
        ...(data.fence !== undefined ? { fence: data.fence } : {}),
        ...(data.result !== undefined ? { result: data.result } : {}),
        ...(data.head !== undefined ? { head: data.head } : {}),
        ...(data.agent !== undefined ? { agent: data.agent } : {}),
      },
    });
  } catch (error) {
    if (isP2002(error)) throw new CIParkWitnessRaced();
    throw error;
  }
}

/**
 * Bookkeeping-only ledger ensure (the re-present path): create the row for a
 * NEW replay identity whose state transition is a no-op (one booking per
 * deferral, however many keys re-present it); an existing row — or the P2002
 * a loser gets — is already the witness; leave everything alone.
 */
async function ensureLedgerRow(
  tx: PrFixQueueClient,
  itemId: string,
  data: { kind: LedgerKind; key: string; fence?: string | null; agent?: string | null },
): Promise<void> {
  const ledger = ciParkLedger(tx);
  if (!ledger) return;
  try {
    await ledger.create({
      data: {
        itemId,
        kind: data.kind,
        key: data.key,
        ...(data.fence !== undefined ? { fence: data.fence } : {}),
        ...(data.agent !== undefined ? { agent: data.agent } : {}),
      },
    });
  } catch (error) {
    if (isP2002(error)) return;
    throw error;
  }
}

// ── Item resolution: the handout marker the deferral suspends ───────────────

/**
 * Resolve the queue row a lifecycle call acts on.
 *
 * Bodies pin ONLY {repo, generation, agentName, ...} (no pr/prFixId/
 * handoutToken), so the notice binds to the row through the handout the
 * deferral actually suspends: `agentHandouts` contains the element
 * `agentHandoutToken(agentName, generation)`. That marker is written by
 * next-task's hand-out and survives every park/reserve/outcome write, and
 * the connector's agent works serially — so exactly one row in the repo
 * carries it at notice time. The helper is REUSED (never inlined) so the
 * handout format can never drift between Dispatch's writer and this binder.
 *
 * Consequence for replays: a generation-bumped row has its `agentHandouts`
 * cleared by `freshAttemptGeneration` (the sole generation-bump helper), so a
 * post-bump replayed key misses the marker and answers
 * `opportunity-missing` rather than replaying its 204. Courier classifies the
 * coded refusal as `ErrStaleWork` — stale-and-moot, which its durable-intent
 * layer treats as safe (no re-application, no budget spent) — while the
 * normal replay path (unchallenged row, marker intact) keeps the pinned
 * replay-first semantics from the fixture.
 *
 * Failure modes, all failing closed to `opportunity-missing` at the caller:
 * zero matches (never handed, marker cleared, wrong repo or wrong agent name)
 * and — impossible in the serial-worker flow, an inconsistent identity if it
 * ever appears — two or more rows carrying the same marker at once.
 */
async function resolveCIParkItem(
  client: PrFixQueueClient,
  repo: string,
  agentName: string,
  generation: number,
): Promise<any | null> {
  const rows = (await client.prFixQueueItem.findMany({
    where: { repo, agentHandouts: { has: agentHandoutToken(agentName, generation) } },
  })) as any[];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  // Handout-marker binding is EXACT in the serial-worker flow: one live hand
  // of one generation to one agent touches one row. A collision means the
  // server's handout records are inconsistent with the notice's identity, and
  // filing closed (refusing instead of guessing which row the notice means)
  // is correct — Courier's retry is moot for an identity it cannot name.
  if (rows.length === 1) return rows[0];
  return null;
}

// ── Generation fence (the mark family's literal, mapped by the routes) ──────

function generationMismatch(item: any, generation: number): CIParkCallResult | null {
  if (item.generation !== generation) {
    return { ok: false, reason: "generation-mismatch" };
  }
  return null;
}

/** The committed-state re-derive cipark's CAS-loss path uses (see below). */
function parkReplayByState(fresh: any, key: string): boolean {
  const state: string | null = fresh?.ciParkState ?? null;
  return fresh?.ciParkKey === key || state === "settled" || state === "released";
}

// ── CIPARK ──────────────────────────────────────────────────────────────────

/**
 * Announce the deferral: {ciParkState "active", ciParkHead, ciParkKey,
 * ciParkAt} — and nothing else. `ciParkFence` is deliberately untouched: a
 * re-park while a reservation is open must not undo a fence the reservation
 * still owns (the fixture's re-park semantics overwrite head/key/at only).
 */
export async function ciParkPrFixItem(
  client: PrFixQueueClient,
  rawInput: CIParkInput,
): Promise<CIParkCallResult> {
  const input: CIParkInput = { ...rawInput, repo: normalizeQueueRepo(rawInput.repo) };
  const item = await resolveCIParkItem(client, input.repo, input.agentName, input.generation);
  if (!item) return { ok: false, reason: "opportunity-missing" };

  // A committed park replays as a plain success WITHOUT state churn — even
  // when a reservation or a state change landed meanwhile (the replay read
  // does not consult the fence). Pre-checks for the generation fence and the
  // QUEUED pin run only after.
  if (await findLedgerRow(client, item.id, "park", input.idempotencyKey)) {
    return { ok: true, replayed: true, item };
  }

  const mismatch = generationMismatch(item, input.generation);
  if (mismatch) return mismatch;
  if (item.status !== "QUEUED") return { ok: false, reason: "opportunity-missing" };

  try {
    return await client.$transaction(async (tx) => {
      // Authoritative replay inside the transaction: another same-key commit
      // landing in the read→write gap wins; skip the state write.
      if (await findLedgerRow(tx, item.id, "park", input.idempotencyKey)) {
        return { ok: true, replayed: true, item };
      }
      const { count } = await tx.prFixQueueItem.updateMany({
        where: { id: item.id, generation: input.generation, status: "QUEUED" },
        data: {
          ciParkState: "active",
          ciParkHead: input.head,
          ciParkKey: input.idempotencyKey,
          ciParkAt: new Date(),
        },
      });
      if (count === 1) {
        await commitWitness(tx, item.id, {
          kind: "park",
          key: input.idempotencyKey,
          head: input.head,
          agent: input.agentName,
        });
        return { ok: true, item };
      }
      // The pin lost the race: the row's identity (status or generation)
      // moved between the read and this write. NOTHING has been written by
      // this call (the witness rides the committed CAS), so every answer
      // below leaves the retry semantics intact. Re-derive once — a twin's
      // same-key commit or a deferral that already moved past the park (its
      // lifecycle evidence replays by state) is committed enough; anything
      // else is this notice pointing at dead work.
      const fresh = await tx.prFixQueueItem.findUnique({ where: { id: item.id } });
      if (!fresh) return { ok: false, reason: "opportunity-missing" };
      if (parkReplayByState(fresh, input.idempotencyKey)) return { ok: true, replayed: true, item: fresh };
      return { ok: false, reason: "opportunity-missing" };
    });
  } catch (error) {
    // A same-key twin committed between our matched CAS and the witness:
    // the transaction rolled our write back; answer its replay.
    if (error instanceof CIParkWitnessRaced) {
      return { ok: true, replayed: true, item };
    }
    throw error;
  }
}

// ── CIRESERVE ───────────────────────────────────────────────────────────────

/**
 * Book the one repair opportunity. Refusal order is the pinned one: replay →
 * generation fence → no established park ("opportunity-missing") → the fence
 * check (equal token re-presents the grant; a different token is
 * "fence-held") → "head-superseded" when the presented head does not equal
 * the parked CI head → grant. The grant's response echoes EXACTLY the
 * presented token: Courier's grant assertion
 * `grant.FenceToken == presented` must hold.
 *
 * Closed/merged PR refusal at reserve time is CONNECTOR-owned, not server
 * state: Courier's `ReserveCIRepair` re-reads the live pull request state
 * BEFORE the POST and refuses with `source.ErrStaleWork` without ever
 * calling this route (pinned by `cipark_test.go`: closed/merged fixtures
 * expect no reserve request at all). The pinned 409 vocabulary therefore
 * carries no closed/merged code, and the server has no fresher signal — its
 * PR cache can lag. Dispatch's own server-side enforcement of the same rule
 * is the merged/closed reap (`reconcileStalePrFixItems`, issues/reconcile),
 * which settles queue items to STALE out from under any deferral; the next
 * fresh attempt then clears the deferral columns via `freshAttemptGeneration`.
 */
export async function ciReservePrFixItem(
  client: PrFixQueueClient,
  rawInput: CIReserveInput,
): Promise<CIParkCallResult> {
  const input: CIReserveInput = { ...rawInput, repo: normalizeQueueRepo(rawInput.repo) };
  const item = await resolveCIParkItem(client, input.repo, input.agentName, input.generation);
  if (!item) return { ok: false, reason: "opportunity-missing" };

  // Replay FIRST: a committed booking replays its grant without re-booking,
  // echoing the COMMITTED fence from its ledger row (falling back to the
  // presented token for a legacy-ledger row so the grant pin
  // `grant.FenceToken == presented` can never echo null).
  const replayRow = await findLedgerRow(client, item.id, "reserve", input.idempotencyKey);
  if (replayRow) return { ok: true, replayed: true, fenceToken: replayRow.fence ?? input.fenceToken, item };

  const mismatch = generationMismatch(item, input.generation);
  if (mismatch) return mismatch;

  const state: string | null = item.ciParkState ?? null;
  if (state !== "active" || !item.ciParkKey) return { ok: false, reason: "opportunity-missing" };

  if (item.ciParkFence != null) {
    if (item.ciParkFence === input.fenceToken) {
      // Re-presenting the pinned fence stays ONE booking: just make sure the
      // replay identity exists (a new key gets its own ledger row for its own
      // replays) and echo the fence. The state write here is a no-op.
      await client.$transaction(async (tx) => {
        await ensureLedgerRow(tx, item.id, {
          kind: "reserve",
          key: input.idempotencyKey,
          fence: item.ciParkFence,
          agent: input.agentName,
        });
      });
      return { ok: true, fenceToken: item.ciParkFence, item };
    }
    return { ok: false, reason: "fence-held" };
  }

  if (input.head !== item.ciParkHead) return { ok: false, reason: "head-superseded" };

  /** One CAS-then-witness grant attempt; returns the CAS count. */
  const grant = async (tx: PrFixQueueClient) => {
    const { count } = await tx.prFixQueueItem.updateMany({
      // #1415: the head identity rides the CAS both here and on the retry
      // below — a concurrent re-park that re-binds the deferral between the
      // outer head check and this write must not book a fence onto the
      // replaced deferral.
      where: { id: item.id, generation: input.generation, ciParkState: "active", ciParkFence: null, ciParkHead: input.head },
      data: { ciParkFence: input.fenceToken },
    });
    if (count === 1) {
      await commitWitness(tx, item.id, {
        kind: "reserve",
        key: input.idempotencyKey,
        fence: input.fenceToken,
        agent: input.agentName,
      });
    }
    return count;
  };

  try {
    return await client.$transaction(async (tx) => {
      // Replay again under the transaction — a same-key commit landing in the
      // gap replays its committed fence.
      const replay = await findLedgerRow(tx, item.id, "reserve", input.idempotencyKey);
      if (replay) return { ok: true, replayed: true, fenceToken: replay.fence ?? input.fenceToken, item };

      const first = await grant(tx);
      if (first === 1) return { ok: true, fenceToken: input.fenceToken, item };

      // The CAS lost a race. NOTHING has been written by this call (the
      // witness rides the committed CAS), so every refusal below stays
      // re-answerable by a same-key retry. Re-read once and re-derive from
      // the current state: a deferral no longer active (settled or released,
      // or the row vanished) is stale opportunity; the marker head superseded
      // by a re-park is a replaced deferral (head-superseded FIRST — the
      // re-derive must map the re-bound head before the generic fence
      // answers); a fence held under a different token is the competitor's;
      // an open vacancy with a matching head allows exactly one retry;
      // anything unresolved conservatively reads as held.
      const twin = await findLedgerRow(tx, item.id, "reserve", input.idempotencyKey);
      if (twin) return { ok: true, replayed: true, fenceToken: twin.fence ?? input.fenceToken, item };
      const fresh = await tx.prFixQueueItem.findUnique({ where: { id: item.id } });
      if (!fresh || fresh.ciParkState !== "active" || fresh.generation !== input.generation) {
        if (fresh?.ciParkState === "settled" || fresh?.ciParkState === "released") {
          return { ok: false, reason: "opportunity-missing" };
        }
        if (!fresh || fresh.generation !== input.generation) {
          return { ok: false, reason: "opportunity-missing" };
        }
        return { ok: false, reason: "fence-held" };
      }
      if (fresh.ciParkHead !== input.head) {
        // #1415: the re-park interleave — the deferral was re-bound to a new
        // head between the outer head check and the CAS; this reservation
        // still means the OLD head.
        return { ok: false, reason: "head-superseded" };
      }
      if (fresh.ciParkFence != null && fresh.ciParkFence !== input.fenceToken) {
        return { ok: false, reason: "fence-held" };
      }
      const second = await grant(tx);
      if (second === 1) return { ok: true, fenceToken: input.fenceToken, item };
      const lateTwin = await findLedgerRow(tx, item.id, "reserve", input.idempotencyKey);
      if (lateTwin) return { ok: true, replayed: true, fenceToken: lateTwin.fence ?? input.fenceToken, item };
      return { ok: false, reason: "fence-held" };
    });
  } catch (error) {
    // A same-key twin committed between our matched CAS and the witness: the
    // transaction rolled our write back; answer the committed fence.
    if (error instanceof CIParkWitnessRaced) {
      const row = await findLedgerRow(client, item.id, "reserve", input.idempotencyKey);
      return { ok: true, replayed: true, fenceToken: row?.fence ?? input.fenceToken, item };
    }
    throw error;
  }
}

// ── CIREPAIR ────────────────────────────────────────────────────────────────

/**
 * Settle the fenced outcome or the fence-less release.
 *
 * Fenced path, pinned order: replay → generation fence → "fence-settled" (a
 * deferral that already handed stewardship back) → "fence-gone" (a fence
 * that is not the presented one, or no fence at all) → commit. "repushed"
 * keeps the deferral active with the NEW parked head and clears the fence;
 * "exhausted"/"unsupported" settle the deferral (ciParkState "settled",
 * fence and parked head cleared).
 *
 * Fence-less path (result "unsupported"; the parser forbids the other
 * results without a fence): the release works by park-KEY match on the same
 * generation. A live reservation refuses the release ("fence-held")
 * regardless of key match; a key that did not park the CURRENT deferral is
 * stale ("opportunity-missing").
 */
export async function ciRepairPrFixItem(
  client: PrFixQueueClient,
  rawInput: CIRepairInput,
): Promise<CIParkCallResult> {
  const input: CIRepairInput = { ...rawInput, repo: normalizeQueueRepo(rawInput.repo) };
  const item = await resolveCIParkItem(client, input.repo, input.agentName, input.generation);
  if (!item) return { ok: false, reason: "opportunity-missing" };

  if (input.fenceToken != null) {
    // Replay FIRST, exactly like the fixture: a committed outcome replays
    // its acceptance (204) and never the mutation — even after settlement.
    const replayRow = await findLedgerRow(client, item.id, "outcome", input.idempotencyKey);
    if (replayRow) return { ok: true, replayed: true, item };

    const mismatch = generationMismatch(item, input.generation);
    if (mismatch) return mismatch;

    // fence-settled BEFORE fence-gone: settlement on the row is the more
    // specific identity evidence (fixture order).
    if (item.ciParkState === "settled") return { ok: false, reason: "fence-settled" };
    if (item.ciParkState !== "active" || item.ciParkFence == null || item.ciParkFence !== input.fenceToken) {
      return { ok: false, reason: "fence-gone" };
    }

    try {
      return await client.$transaction(async (tx) => {
        const replay = await findLedgerRow(tx, item.id, "outcome", input.idempotencyKey);
        if (replay) return { ok: true, replayed: true, item };

        const { count } = await tx.prFixQueueItem.updateMany({
          where: { id: item.id, generation: input.generation, ciParkState: "active", ciParkFence: input.fenceToken as string },
          data:
            input.result === "repushed"
              ? { ciParkHead: input.head as string, ciParkFence: null }
              : { ciParkState: "settled", ciParkFence: null, ciParkHead: null },
        });
        if (count === 1) {
          await commitWitness(tx, item.id, {
            kind: "outcome",
            key: input.idempotencyKey,
            fence: input.fenceToken,
            result: input.result,
            head: input.head ?? null,
            agent: input.agentName,
          });
          return { ok: true, item };
        }
        // Race: NOTHING has been written by this call (the witness rides the
        // committed CAS), so a refused outcome re-answers identically on a
        // same-key retry. Re-read once — a same-key twin's committed outcome
        // replays; a settlement that landed after ours (any twin's outcome)
        // reads as settled — the settled ordering check stands.
        const twin = await findLedgerRow(tx, item.id, "outcome", input.idempotencyKey);
        if (twin) return { ok: true, replayed: true, item };
        const fresh = await tx.prFixQueueItem.findUnique({ where: { id: item.id } });
        if (fresh?.ciParkState === "settled") return { ok: false, reason: "fence-settled" };
        return { ok: false, reason: "fence-gone" };
      });
    } catch (error) {
      // A same-key twin committed between our matched CAS and the witness:
      // the transaction rolled our write back; answer its replay.
      if (error instanceof CIParkWitnessRaced) {
        return { ok: true, replayed: true, item };
      }
      throw error;
    }
  }

  // Fence-less release path (result is "unsupported"; the parser refuses
  // repushed/exhausted without a fenceToken).
  const replayRow = await findLedgerRow(client, item.id, "release", input.idempotencyKey);
  if (replayRow) return { ok: true, replayed: true, item };

  const mismatch = generationMismatch(item, input.generation);
  if (mismatch) return mismatch;

  const state: string | null = item.ciParkState ?? null;
  if (state === "active" && item.ciParkFence != null) {
    // A live reservation owns the deferral; the fence-less release cannot
    // overrule it regardless of key match.
    return { ok: false, reason: "fence-held" };
  }
  if (state === "active") {
    if (item.ciParkKey !== input.idempotencyKey) {
      // A key that did not park THIS deferral is stale notice work.
      return { ok: false, reason: "opportunity-missing" };
    }
    try {
      return await client.$transaction(async (tx) => {
        const replay = await findLedgerRow(tx, item.id, "release", input.idempotencyKey);
        if (replay) return { ok: true, replayed: true, item };

        const release = async (cas: PrFixQueueClient) => {
          const { count } = await cas.prFixQueueItem.updateMany({
            // #1415: the vacancy rides the CAS — a reservation opening in the
            // outer-read→write gap must never be wiped by this release write.
            where: { id: item.id, generation: input.generation, ciParkState: "active", ciParkFence: null, ciParkKey: input.idempotencyKey },
            data: { ciParkState: "released", ciParkFence: null },
          });
          return count;
        };
        const witness = () =>
          commitWitness(tx, item.id, {
            kind: "release",
            key: input.idempotencyKey,
            result: "unsupported",
            agent: input.agentName,
          });
        if ((await release(tx)) === 1) {
          await witness();
          return { ok: true, item };
        }
        // Race: NOTHING has been written by this call (the witness rides the
        // committed CAS), so a refused release re-answers identically on a
        // same-key retry. Re-read once — a twin's same-key commit replays by
        // witness (or by state, the no-ledger fallback); a reservation that
        // opened in the gap holds the deferral this release meant to vacate
        // (fence-held, before anything else — the reservation owns the
        // opportunity now); still-live vacancies allow exactly one retry;
        // else stale.
        const twin = await findLedgerRow(tx, item.id, "release", input.idempotencyKey);
        if (twin) return { ok: true, replayed: true, item };
        const fresh = await tx.prFixQueueItem.findUnique({ where: { id: item.id } });
        if (
          fresh?.ciParkState === "active" &&
          fresh?.generation === input.generation &&
          fresh?.ciParkFence != null
        ) {
          // #1415: the interleave — an unfenced release must not overrule a
          // live reservation for the deferral it was meant to release.
          return { ok: false, reason: "fence-held" };
        }
        if (fresh?.ciParkState === "released" && fresh?.ciParkKey === input.idempotencyKey) {
          return { ok: true, replayed: true, item: fresh };
        }
        if (
          fresh?.ciParkState === "active" &&
          fresh?.ciParkFence == null &&
          fresh?.ciParkKey === input.idempotencyKey &&
          fresh?.generation === input.generation &&
          (await release(tx)) === 1
        ) {
          await witness();
          return { ok: true, item: fresh };
        }
        const lateTwin = await findLedgerRow(tx, item.id, "release", input.idempotencyKey);
        if (lateTwin) return { ok: true, replayed: true, item };
        return { ok: false, reason: "opportunity-missing" };
      });
    } catch (error) {
      // A same-key twin committed between our matched CAS and the witness:
      // the transaction rolled our write back; answer its replay.
      if (error instanceof CIParkWitnessRaced) {
        return { ok: true, replayed: true, item };
      }
      throw error;
    }
  }
  // The deferral is not active: only the SAME key's own release commit may
  // replay-by-state (the no-ledger fallback), and only as "released".
  if (item.ciParkKey === input.idempotencyKey && state === "released") {
    return { ok: true, replayed: true, item };
  }
  return { ok: false, reason: "opportunity-missing" };
}
