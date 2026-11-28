import { fetchPullRequestHeadSha } from "../github-prs";
import { normalizePrFixType } from "@/types";
import { sanitizeForStorage } from "../groomer/sanitize";
import {
  isMechanicalRebaseInstruction,
  rebaseEpisodeIdentity,
  scopedRebaseSemanticConflict,
  semanticConflictFromRefusal,
} from "../pr-fix-rebase";
import { REBASE_MODEL_EXECUTOR_CAPABILITY } from "../rebase-intake";
import { resolveIngestionClaimant } from "../pr-fix-ownership";
import { type PrFixQueueClient } from "./client";
import { uniqueAppend } from "./shared";
import { linkedIssueEscalationClassified, linkedIssueEscalationClassifiedForModelPhase, preserveEscalationLane, releaseLaneFromParentClass, storedEscalatedParentClass, type LinkedIssueEscalationClassification } from "./escalation-lane";
import { maxPrFixStagnation } from "./external-wait";
import { findHandoutReceipt, freshAttemptGeneration } from "./handout";
import { rebaseExecutorAgentNames, rebaseExecutorClaimantExclusion, rebaseModelWorkerPoolDeclared } from "./lane-admission";

/**
 * #1675: durable semantic-conflict episode accounting and the bounded
 * REBASE→fix transfer (parent #1540). This module is the SINGLE WRITER of the
 * episode record (`rebaseEpisodeId` / `rebaseEpisodeTransferred` /
 * `rebaseEpisodeTransferredAt` / `rebaseEpisodeGeneration`) and the only path
 * that converts a mechanical-rebase attempt into one authorized ordinary
 * fix-pr attempt.
 *
 * The contract, end to end:
 *
 * 1. CONSUME — the deterministic rebase executor stops without publishing and
 *    reports `blocked` with `blockReason "human_decision"` (the safe hold it
 *    must still take when Dispatch cannot transfer) plus the STRUCTURED
 *    `rebaseRefusal` payload: `kind`, bounded conflicting file paths and a
 *    bounded explanation. The refusal's claimed PR/base/head are EVIDENCE the
 *    operator can audit — never identity inputs: the episode identity is
 *    derived below from Dispatch's own authoritative row state.
 * 2. IDENTITY — `rebaseEpisodeIdentity(repo, pr, branch, headSha)` is a pure
 *    function of authoritative PR/base/head/ref state (base repo, PR number,
 *    head ref, head sha). Not poll timestamps, not human text, so the identity
 *    is stable across repeats, restarts and resyncs and changes exactly when
 *    the conflict episode changes (a new head is a new episode).
 * 3. SETTLE — the transfer is authorized only by the EXACT live hand-out
 *    receipt (agent + generation + issued token, #1256/#1340 fence) at a
 *    generation still dispatched to this agent as REBASE, and the settlement
 *    (receipt consumption, hand-out record release, generation bump) and the
 *    episode record land in ONE compare-and-swap write. A stale or rotated
 *    token, a stale generation, or a lost race authorizes nothing.
 * 4. PRECONDITIONS — before any write, the transfer re-verifies the exact PR
 *    identity/head it is transferring: the PR's REMOTE head must still equal
 *    the attempt's baseline (`attemptHeadSha`). A changed head, an
 *    unverifiable head (infra/GitHub failure), a non-REBASE dispatched lane,
 *    or an episode already transferred all STOP the transfer (fail closed to
 *    the ordinary blocked treatment — the pre-#1675 safe hold). Another agent
 *    still holding a live hand-out at this generation (a concurrent writer)
 *    refuses the transfer with NO mutation at all: that writer's settlement
 *    owns the row.
 * 5. BUDGET — the transfer never resets attempt budgets. The consumed rebase
 *    attempt is a no-progress attempt (the head is verified unchanged, so it
 *   cannot have advanced), so it consumes one unit of the #1543
 *    consecutive-stagnation budget; a budget exhausted at the transfer PARKS
 *    the row (bounded exhaustion) instead of minting another repair attempt.
 *    The transferred fix attempt runs under the same ordinary budget ladder.
 * 6. ONE WAY — the transfer is one-way. The enqueue-side gate (enqueue.ts)
 *    reads the episode record: a repeat observation of the SAME conflict
 *    (resync, restart, lost-ack re-dispatch, duplicate report) keeps the row
 *    on the fix lane and never rewrites it back onto REBASE; only a NEW
 *    episode (new head) re-opens the mechanical lane.
 * 7. OWNERSHIP (#1615/#1569) — the transferred row is an ordinary fix
 *    attempt, so it must never carry a rebase-executor pool claimant: the
 *    hand-out gate deterministically refuses that pair and a recorded
 *    claimant is immutable to the issuance-side backfill — the exact
 *    structurally unroutable class #1615 exists for. The transfer
 *    re-resolves the repair claimant under the SAME non-REBASE exclusion the
 *    backfill uses and commits the transition (or an honest unresolved
 *    state, recoverable through the standard #1569 operator paths with zero
 *    attempt burn) in the same pinned CAS write; a failed authoritative
 *    read declines the whole transfer to the ordinary safe hold.
 * 8. PHASES (#1676) — an accepted episode has two repair stages ahead of any
 *    human, and a deterministic refusal alone never skips the first:
 *      a. MODEL REPAIR — when the deployment declares a model-rebase worker
 *         (`DISPATCH_REBASE_MODEL_AGENTS`) AND the linked parent verifies
 *         NOT_ESCALATED, the FIRST refusal settles the mechanical receipt and
 *         persists the bounded context on the row (`semanticConflict` + the
 *         episode id) as a fresh REBASE attempt. The row is now MODEL-REQUIRED,
 *         so only a poll granted `rebase-model-executor:1` inside the
 *         model-worker pool can pick it up (#1674's hand-out gates) and it
 *         receives the model wall plus this context.
 *      b. ORDINARY FIX-PR FALLBACK — a refusal that arrives while the CURRENT
 *         episode already carries the persisted context proves a
 *         model-authorized attempt ran and could not resolve it (the mechanical
 *         refusal is not that proof), so it transfers to one ordinary fix
 *         attempt under the existing attempt budgets. A deployment with no
 *         model worker declared, or a parent the model path may not touch
 *         (ESCALATED, or UNKNOWN fail-closed), takes this fallback on the FIRST
 *         refusal — the pre-#1676 shape — and the exclusive lane survives it,
 *         so a deterministic failure never becomes a frontier bypass.
 *    Both markers are episode-scoped: the persisted context counts only while it
 *    matches the row's current head knowledge (`scopedRebaseSemanticConflict`),
 *    and the model-phase write clears `rebaseEpisodeTransferred` because the
 *    episode it names has NOT transferred. A NEW episode (new head) therefore
 *    re-decides instead of inheriting the old phase or a stale context.
 *
 * Failure classification: ONLY an explicit, well-formed, in-bounds
 * `kind: "nonmechanical_conflict"` refusal on a verifiable, exclusively-owned,
 * unchanged-head REBASE attempt may transfer. Authentication failures,
 * deletion, infra failures and ambiguous workspaces reach this module as
 * ordinary `blocked`/`failed` reports without the refusal (or with a
 * different kind) and keep their ordinary distinct treatment — none of them
 * can manufacture a transfer.
 */

/** The only refusal `kind` that authorizes a transfer. */
export const NONMECHANICAL_CONFLICT_KIND = "nonmechanical_conflict";

/**
 * Bounded refusal payload. Every field is evidence, not authority: a
 * malformed or oversized value fails closed (the route 400s; a value that
 * passes the route but carries no transfer-eligible kind settles ordinarily).
 */
export interface RebaseRefusalContext {
  kind: string;
  /** Conflicting file paths, bounded count and length. */
  conflictingFiles: string[];
  /** Bounded worker explanation of WHY the conflict is not mechanical. */
  explanation: string | null;
  /** Bounded base ref the executor rebased onto (evidence, not identity). */
  baseRef: string | null;
  /** Bounded remote head the executor verified before stopping (evidence). */
  expectedRemoteHead: string | null;
}

/** Bounds on the refusal evidence. An oversized value is a malformed report. */
const MAX_CONFLICTING_FILES = 20;
const MAX_FILE_PATH_LENGTH = 200;
const MAX_EXPLANATION_LENGTH = 1000;
const MAX_REF_LENGTH = 200;
const MAX_HEAD_LENGTH = 100;
const MAX_KIND_LENGTH = 64;

/**
 * A conflicting-file entry is structured evidence (a path), not free text: any
 * control character — NUL (U+0000) included, which Postgres rejects outright
 * in text and jsonb (dispatch#1126) — is a malformed value and fails closed
 * here, so the route 400s instead of the report write throwing in storage.
 * C0 controls and DEL; \t/\n/\r at a path's edges are already removed by the
 * trim below, and inside a path they are malformed too.
 */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

/**
 * Parse the structured nonmechanical-conflict refusal. Shape validation ONLY
 * (the route 400s on a `false`); the `kind` check that decides eligibility
 * lives in `isTransferEligibleRefusal` so an unknown kind can still be
 * recorded as ordinary blocked evidence instead of being rejected outright.
 */
export function parseRebaseRefusal(
  raw: unknown,
): { ok: true; refusal: RebaseRefusalContext } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: false, reason: "rebaseRefusal is absent" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "rebaseRefusal must be an object" };
  }
  const rawRefusal = raw as Record<string, unknown>;
  const kind = typeof rawRefusal.kind === "string" ? rawRefusal.kind.trim() : "";
  if (!kind || kind.length > MAX_KIND_LENGTH) {
    return { ok: false, reason: `rebaseRefusal.kind must be a non-empty string of at most ${MAX_KIND_LENGTH} characters` };
  }
  let conflictingFiles: string[] = [];
  if (rawRefusal.conflictingFiles !== undefined && rawRefusal.conflictingFiles !== null) {
    if (!Array.isArray(rawRefusal.conflictingFiles)) {
      return { ok: false, reason: "rebaseRefusal.conflictingFiles must be an array of strings" };
    }
    const files = rawRefusal.conflictingFiles;
    if (files.length > MAX_CONFLICTING_FILES) {
      return { ok: false, reason: `rebaseRefusal.conflictingFiles exceeds the size limit (${MAX_CONFLICTING_FILES} entries)` };
    }
    for (const file of files) {
      if (typeof file !== "string" || file.trim().length === 0 || file.trim().length > MAX_FILE_PATH_LENGTH) {
        return { ok: false, reason: `rebaseRefusal.conflictingFiles entries must be non-empty strings of at most ${MAX_FILE_PATH_LENGTH} characters` };
      }
      if (CONTROL_CHARACTER_PATTERN.test(file.trim())) {
        return { ok: false, reason: "rebaseRefusal.conflictingFiles entries must not contain control characters" };
      }
    }
    conflictingFiles = files.map((file) => (file as string).trim());
  }
  const boundedString = (value: unknown, max: number, field: string): { ok: true; value: string | null } | { ok: false; reason: string } => {
    if (value === undefined || value === null) return { ok: true, value: null };
    if (typeof value !== "string" || value.trim().length > max) {
      return { ok: false, reason: `${field} must be a string of at most ${max} characters` };
    }
    return { ok: true, value: value.trim() || null };
  };
  const explanation = boundedString(rawRefusal.explanation, MAX_EXPLANATION_LENGTH, "rebaseRefusal.explanation");
  if (!explanation.ok) return explanation;
  const baseRef = boundedString(rawRefusal.baseRef, MAX_REF_LENGTH, "rebaseRefusal.baseRef");
  if (!baseRef.ok) return baseRef;
  const expectedRemoteHead = boundedString(rawRefusal.expectedRemoteHead, MAX_HEAD_LENGTH, "rebaseRefusal.expectedRemoteHead");
  if (!expectedRemoteHead.ok) return expectedRemoteHead;
  return {
    ok: true,
    refusal: {
      kind,
      conflictingFiles,
      explanation: explanation.value ? sanitizeForStorage(explanation.value, MAX_EXPLANATION_LENGTH) : null,
      baseRef: baseRef.value,
      expectedRemoteHead: expectedRemoteHead.value,
    },
  };
}

/** Whether this parsed refusal authorizes the transfer (kind gate). */
export function isTransferEligibleRefusal(refusal: RebaseRefusalContext | null | undefined): boolean {
  return refusal?.kind === NONMECHANICAL_CONFLICT_KIND;
}

/**
 * The episode identity lives with the conflict-context helpers (#1327/#1676) so
 * the writer, the enqueue-side no-bounce gate, and the dispatch-side context
 * scoping all derive it from one implementation.
 */
export { rebaseEpisodeIdentity } from "../pr-fix-rebase";

/**
 * The parent classification the MODEL-repair phase may accept (#1676). The same
 * folding the #1674 hand-out gate uses — a row already stored ESCALATED is
 * frontier by its own authority — and only a positive NOT_ESCALATED answers.
 * This is the WITHHOLD side of the decision: ESCALATED and UNKNOWN route the
 * episode to the ordinary fallback (which enforces lane exclusivity at its own
 * hand-out and never demotes the exclusive lane); the authoritative locked read
 * stays at issuance, where the model wall is actually shipped.
 *
 * It uses the STRICT read, so an absent parent row is UNKNOWN and the phase
 * declines: the marker this write commits is durable, and the locked issuance
 * read that releases it already treats absence as UNKNOWN. Committing the phase
 * on the lenient read would strand the row between two deferrals.
 */
async function modelRepairParentClass(
  client: Pick<PrFixQueueClient, "issue">,
  row: { repo: string; issue: number | null; lane: unknown },
): Promise<LinkedIssueEscalationClassification> {
  return storedEscalatedParentClass(row.lane) ?? linkedIssueEscalationClassifiedForModelPhase(client, row.repo, row.issue);
}

/** How the transfer attempt ended; the caller decides the ordinary fallback. */
export type RebaseTransferResult =
  | { action: "transferred"; item: Record<string, unknown>; reason: string }
  // #1676: the episode was accepted onto the MODEL-repair phase — the exact
  // mechanical receipt is settled, the bounded context is persisted, and the
  // row stays a fresh REBASE attempt only a model-authorized poll may take.
  | { action: "model_repair"; item: Record<string, unknown>; reason: string }
  | { action: "parked"; item: Record<string, unknown>; reason: string }
  // The report must NOT mutate the row (a concurrent writer owns it, or the
  // exact CAS lost a race) — a plain skip, not a settlement.
  | { action: "skipped"; reason: string }
  // The transfer is refused; the caller falls back to the ordinary blocked
  // treatment (the pre-#1675 safe hold) for a genuine unresolved case.
  | { action: "declined"; reason: string };

export interface TransferRebaseEpisodeInput {
  itemId: string;
  /** The settled rebase attempt generation (#1074 attempt token). */
  generation: number;
  /** The reporting agent — part of the exact-receipt fence. */
  agentName?: string | null;
  /** The issued per-hand-out receipt token echoed by the worker (#1256). */
  handoutToken?: string | null;
  /** The parsed, in-bounds refusal evidence. */
  refusal: RebaseRefusalContext;
}

/**
 * Execute the bounded REBASE→fix transfer for one settled rebase attempt.
 *
 * Preconditions (all fail closed, checked against a fresh row read inside the
 * CAS loop):
 * - the row is QUEUED at the reported generation with the hand-out stamp
 *   still live (dispatchedGeneration == generation);
 * - the DISPATCHED lane (`attemptType ?? type`, #1327) is REBASE — a report
 *   from an ordinary fix attempt never transfers;
 * - the episode was not already transferred for THIS identity (a duplicate
 *   report is a skip, not a second transfer);
 * - the presented receipt matches the agent's LIVE hand-out receipt exactly
 *   (stale/rotated token → declined);
 * - NO other live hand-out exists at this generation (concurrent writer →
 *   skipped with zero mutation);
 * - the PR's remote head still equals the attempt baseline — a changed or
 *   unverifiable head stops the transfer (declined, never silently
 *   transferred);
 * - the #1543 consecutive-stagnation budget still has room — an exhausted
 *   budget parks instead of minting the repair attempt.
 *
 * The write itself is one pinned `updateMany` pinning the FULL decision-input
 * set (status + generation + dispatch stamps + exact hand-out arrays +
 * dispatched lane + episode inputs + post-dispatch evidence list + the
 * identity columns the enqueue metadata patch refreshes + the claimant pair),
 * so a concurrent hand-out, ack, reclaim, requeue, re-observation, or
 * settlement landing in the read→write gap no-ops the whole transfer. The
 * episode record, the fresh fix attempt and the hand-out-record release
 * commit atomically. On a lost race the re-read must find the verified
 * identity unchanged — a moved headSha/branch/issue/author STOPS the transfer
 * (declined) rather than re-deciding a stale refusal onto the newer
 * observation.
 */
export async function transferRebaseEpisodeToFix(
  client: PrFixQueueClient,
  input: TransferRebaseEpisodeInput,
): Promise<RebaseTransferResult> {
  const agent = input.agentName?.trim();
  const token = input.handoutToken?.trim();
  // The exact receipt is the settlement authority (#1256 rule). Without it,
  // nothing is authorized — fail closed to the ordinary blocked treatment.
  if (!agent || !token) {
    return { action: "declined", reason: "transfer requires the issued prFixItem.handoutToken receipt and the reporting agent (exact source-attempt fencing)" };
  }
  const maxPasses = 2;
  // #1675 re-review: the identity tuple the PREVIOUS pass's verified read was
  // computed from. A CAS loss whose re-read finds a moved identity declines
  // the whole transfer (below) — a stale refusal is never re-based onto a
  // newer observation; only non-identity races (hand-out arrays, acks,
  // post-dispatch appends) are re-decided.
  let lastVerifiedIdentity: {
    headSha: string | null;
    branch: string | null;
    issue: number | null;
    author: string | null;
  } | null = null;
  for (let pass = 0; pass < maxPasses; pass++) {
    const row = await client.prFixQueueItem.findUnique({ where: { id: input.itemId } });
    if (!row) {
      return { action: "skipped", reason: "rebase transfer skipped: item no longer exists" };
    }
    if (row.status !== "QUEUED" || row.generation !== input.generation || row.dispatchedGeneration !== input.generation) {
      return {
        action: "skipped",
        reason: `rebase transfer skipped: item is ${row.status} at generation ${row.generation} (dispatched ${row.dispatchedGeneration ?? "never"}), not QUEUED and dispatched at the reported generation ${input.generation}`,
      };
    }
    if (lastVerifiedIdentity) {
      const moved: string[] = [];
      if ((row.headSha ?? null) !== lastVerifiedIdentity.headSha) moved.push("headSha");
      if ((row.branch ?? null) !== lastVerifiedIdentity.branch) moved.push("branch");
      if ((row.issue ?? null) !== lastVerifiedIdentity.issue) moved.push("issue");
      if ((row.author ?? null) !== lastVerifiedIdentity.author) moved.push("author");
      if (moved.length > 0) {
        return {
          action: "declined",
          reason: `transfer refused: the row's authoritative identity moved since the verified read (${moved.join(", ")}); a newer observation supersedes what this refusal described, and a stale refusal is never re-based onto a new identity — the ordinary blocked treatment settles the report`,
        };
      }
    }
    // Only a REBASE-dispatched attempt may transfer (#1327): the dispatched
    // lane is authoritative because the row's mutable `type` can be rewritten
    // by a re-observation mid-attempt.
    if (normalizePrFixType(row.attemptType ?? row.type) !== "REBASE") {
      return { action: "declined", reason: "the reported attempt was not dispatched as a REBASE attempt; ordinary blocked treatment applies" };
    }
    // Duplicate report / restart idempotence: the SAME episode already
    // transferred (this report or a twin settled earlier) never transfers
    // twice. The generation/status gate above already makes a stale replay
    // skip; this also catches a same-generation duplicate that raced past it.
    const baseline = row.attemptHeadSha ?? row.headSha ?? null;
    const episodeId = rebaseEpisodeIdentity(row.repo, row.pr, row.branch ?? null, baseline);
    if (row.rebaseEpisodeTransferred === true && row.rebaseEpisodeId === episodeId) {
      return { action: "skipped", reason: `rebase transfer skipped: episode ${episodeId} is already transferred (duplicate report is inert)` };
    }
    // One-writer publication fence: another agent still holding a live
    // hand-out at this generation means someone else may be actively
    // rebasing. Transferring would create a second writer on the branch, so
    // refuse with ZERO mutation — that writer's own settlement owns the row.
    const receipts: string[] = Array.isArray(row.handoutReceipts) ? row.handoutReceipts : [];
    const handouts: string[] = Array.isArray(row.agentHandouts) ? row.agentHandouts : [];
    const acks: string[] = Array.isArray(row.handoutAcks) ? row.handoutAcks : [];
    const owned = findHandoutReceipt(receipts, { agentName: agent, generation: input.generation, token });
    if (!owned) {
      return {
        action: "declined",
        reason: "transfer refused: no live hand-out receipt for the reporting agent matches the presented handoutToken (stale, rotated, released, or reclaimed); fail closed",
      };
    }
    if (receipts.length > 1) {
      return {
        action: "skipped",
        reason: `rebase transfer skipped: ${receipts.length - 1} other live hand-out(s) at this generation (concurrent writer); the row is left to the other writer's settlement`,
      };
    }
    // Exact PR identity/head precondition: the REMOTE head must still be the
    // head this rebase attempt was baselined on. A moved head means the
    // episode changed (or the report is stale) and the refusal no longer
    // describes the PR; an unverifiable head (infra/GitHub failure) is NOT a
    // semantic conflict. Both stop the transfer — the ordinary blocked
    // treatment (the pre-#1675 safe hold) settles the report instead.
    let remoteHead: string | null = null;
    try {
      remoteHead = await fetchPullRequestHeadSha(row.repo, row.pr);
    } catch (error) {
      return {
        action: "declined",
        reason: `transfer refused: PR head verification failed (${error instanceof Error ? error.name : typeof error}); infra failure is not a semantic conflict`,
      };
    }
    const remote = (remoteHead ?? "").trim().toLowerCase();
    const expected = (baseline ?? "").trim().toLowerCase();
    if (!remote || !expected || remote !== expected) {
      return {
        action: "declined",
        reason: `transfer refused: the PR remote head (${remote || "unknown"}) no longer matches the rebase attempt baseline (${expected || "unknown"}); a changed remote head must stop, never silently transfer`,
      };
    }
    // #1676 phase routing. The persisted context, scoped to THIS episode, is the
    // only proof that a model-authorized attempt already ran: a deterministic
    // refusal never sets it, so the first accepted refusal of an episode goes to
    // the model phase whenever the deployment declares a model-rebase worker and
    // the parent is not frontier-classified. Every other combination (no pool
    // declared, ESCALATED, UNKNOWN, or a refusal whose episode already carries
    // the context) lands on the ordinary fix-pr path below.
    const modelPhasePending = scopedRebaseSemanticConflict(row) !== null;
    const transportContext = semanticConflictFromRefusal({
      baseRef: input.refusal.baseRef,
      conflictingFiles: input.refusal.conflictingFiles,
      explanation: input.refusal.explanation,
    });
    const modelRepair =
      !modelPhasePending &&
      transportContext !== null &&
      rebaseModelWorkerPoolDeclared() &&
      (await modelRepairParentClass(client, row)) === "NOT_ESCALATED";
    // Ownership transition invariant (#1615/#1569, #1675 review): the
    // transferred row is now an ORDINARY fix attempt, and the #1615 gate
    // deterministically refuses a rebase-executor pool member as the claimant
    // of a non-REBASE row — fix connectors decline the lane-mismatched
    // identity, and the row cannot self-heal, because the issuance-side
    // backfill never re-resolves a RECORDED claimant. That is exactly the
    // structurally unroutable failure class #1615 names, so a transfer must
    // never leave a pool-member claimant on the row. The repair claimant is
    // re-resolved from the authoritative records under the SAME non-REBASE
    // exclusion the issuance-side backfill uses. A resolvable owner
    // transitions in the same CAS write — pinned on the observed claimant
    // pair, so a concurrent operator stamp never silently loses to the
    // transfer. When nothing resolves, the row records the honest failure
    // state and enters the standard #1569 unresolved recovery (issuance-side
    // lazy backfill / operator stamp): a zero-attempt recoverable hold, never
    // poison. And a failed authoritative read (`unavailable`) cannot safely
    // re-decide ownership at all: the WHOLE transfer declines — the ordinary
    // blocked safe hold leaves the row intact for a later retry, and an infra
    // failure never mints either an unroutable transfer or a semantic verdict.
    const rawClaimant = typeof row.claimant === "string" ? row.claimant : null;
    const priorClaimant = (rawClaimant ?? "").trim();
    const priorClaimantSource = row.claimantSource ?? null;
    let claimantTransition: {
      data: Record<string, unknown>;
      note: string;
    } | null = null;
    // A model-phase row stays REBASE, so a rebase-executor claimant is legal on
    // it (#1615 excludes that pool from NON-REBASE claimant evidence only).
    if (
      !modelRepair &&
      priorClaimant !== "" &&
      rebaseExecutorAgentNames().has(priorClaimant.toLowerCase())
    ) {
      const resolution = await resolveIngestionClaimant(
        client,
        row.repo,
        row.issue ?? null,
        row.author,
        new Date(),
        rebaseExecutorClaimantExclusion("OTHER"),
      );
      if (resolution.state === "unavailable") {
        return {
          action: "declined",
          reason: `transfer refused: the transferred attempt's ownership could not be re-established — the recorded claimant (${priorClaimant}) is a rebase-executor pool member and cannot own ordinary fix work (#1615), and the authoritative claimant records are unreadable; infra failure mints no transfer, the ordinary blocked safe hold settles the report for a later retry`,
        };
      }
      claimantTransition =
        resolution.state === "resolved"
          ? {
              data: { claimant: resolution.claimant, claimantSource: resolution.source },
              note: ` Claimant transition: ${priorClaimant} (provenance "${priorClaimantSource ?? "none"}") -> ${resolution.claimant} (provenance "${resolution.source}"): a rebase-executor claimant cannot own an ordinary fix attempt (#1615).`,
            }
          : {
              data: { claimant: null, claimantSource: resolution.state },
              note: ` Claimant transition: ${priorClaimant} (provenance "${priorClaimantSource ?? "none"}") -> unresolved (${resolution.state}): no non-rebase claimant resolved from the authoritative records; the row follows the standard #1569 unresolved recovery (issuance-side backfill / operator stamp) with zero attempt burn (#1615).`,
            };
    }
    // #1675 re-review: the CAS pins the FULL decision-input set, not just the
    // generation/dispatch/hand-out state. The enqueue-side metadataPatch
    // refreshes headSha/branch/issue/author and appends post-dispatch evidence
    // on a QUEUED row WITHOUT touching the generation or the hand-out arrays,
    // so a newer observation could otherwise slip into the read→write gap and
    // the transfer would commit a decision derived from the superseded
    // identity observation and clear post-dispatch evidence it never saw.
    // Every column this pass's decision read is pinned; a lost race re-reads,
    // and an identity that MOVED since this verified read STOPS (top of the
    // loop) instead of silently re-basing the stale refusal onto the new
    // identity.
    const decisionIdentity = {
      headSha: row.headSha ?? null,
      branch: row.branch ?? null,
      issue: row.issue ?? null,
      author: row.author ?? null,
    };
    lastVerifiedIdentity = decisionIdentity;
    const casWhere = {
      id: row.id,
      status: "QUEUED",
      generation: input.generation,
      dispatchedGeneration: input.generation,
      attemptType: row.attemptType ?? null,
      handoutReceipts: { equals: receipts },
      agentHandouts: { equals: handouts },
      handoutAcks: { equals: acks },
      postDispatchEvidenceKeys: {
        equals: Array.isArray(row.postDispatchEvidenceKeys) ? row.postDispatchEvidenceKeys : [],
      },
      headSha: decisionIdentity.headSha,
      attemptHeadSha: row.attemptHeadSha ?? null,
      branch: decisionIdentity.branch,
      issue: decisionIdentity.issue,
      author: decisionIdentity.author,
      // The claimant pair is decision input too (the #1615 transition above
      // read it): an operator stamp or a lazy backfill landing in the gap
      // loses THIS write and survives to be re-decided on the fresh read.
      claimant: row.claimant ?? null,
      claimantSource: row.claimantSource ?? null,
    };
    // Budget (#1543): the consumed rebase attempt provably made NO progress
    // (the head is verified unchanged), so it consumes one unit of the
    // consecutive-stagnation budget. An exhausted budget parks the row
    // instead of minting the authorized repair attempt — bounded exhaustion,
    // never a fresh attempt and never a budget reset.
    const nextStagnation = (row.stagnationCount ?? 0) + 1;
    const capped = nextStagnation >= maxPrFixStagnation();
    const filesReported = input.refusal.conflictingFiles.length
      ? input.refusal.conflictingFiles.join(", ")
      : "none reported";
    const historyNote = capped
      ? `Agent reported a non-mechanical (semantic) conflict from the mechanical rebase attempt; the consecutive-stagnation budget is exhausted at ${nextStagnation} (PR_FIX_MAX_STAGNATION=${maxPrFixStagnation()}), so the REBASE hand-off is declined and the row parks instead (#1675, #1676, #1543). Receipt settled: ${owned}. Episode: ${episodeId}.`
      : modelRepair
        ? `Agent reported a non-mechanical (semantic) conflict from the mechanical rebase attempt; the exact rebase receipt/generation (${input.generation}) is settled and the bounded conflict context is persisted, so the episode is now MODEL-REQUIRED and offered only to a poll granted ${REBASE_MODEL_EXECUTOR_CAPABILITY}:1 whose agent is in DISPATCH_REBASE_MODEL_AGENTS (#1676). Episode: ${episodeId}. Conflicting files: ${filesReported}.`
        : `Agent reported a non-mechanical (semantic) conflict from the mechanical rebase attempt; the exact rebase receipt/generation (${input.generation}) is settled and ONE ordinary fix attempt is authorized with the bounded refusal evidence (#1675). ${modelPhasePending ? "The authorized model-assisted rebase attempt also refused this episode (or the model phase is no longer reachable), so the ordinary fix-pr fallback applies (#1676)." : "No model-rebase worker is authorized for this episode on this deployment, so it goes directly to the ordinary fix-pr fallback (#1676)."} Episode: ${episodeId}. Conflicting files: ${filesReported}.${claimantTransition?.note ?? ""}`;
    const cappedData: Record<string, unknown> = {
      status: "PARKED",
      // #1503: a bounded-exhaustion park never demotes the exclusive lane.
      lane: preserveEscalationLane(row.lane),
      outcome: "no_progress",
      stagnationCount: nextStagnation,
      decisionDetail: null,
      disposedAt: new Date(),
      disposedEvidence: null,
      postDispatchEvidenceKeys: [],
      agentHandouts: [],
      externalWaitBy: null,
      handoutAcks: [],
      handoutAckTimes: [],
      handoutReceipts: [],
      attemptEvidenceWatermark: null,
    };
    if (capped) {
      const { count } = await client.prFixQueueItem.updateMany({
        where: casWhere,
        data: cappedData,
      });
      if (count !== 1) {
        // Lost the race; one more pass against a fresh read, then skip.
        continue;
      }
      const parkedRow = await client.prFixQueueItem.findUnique({ where: { id: row.id } });
      await client.prFixHistory.create({
        data: { itemId: row.id, action: "rebase_transfer", status: "PARKED", outcome: "no_progress", note: historyNote },
      });
      return {
        action: "parked",
        item: (parkedRow ?? row) as Record<string, unknown>,
        reason: `rebase transfer declined by the stagnation budget (exhausted at ${nextStagnation}); parked instead of authorizing a repair attempt (#1675)`,
      };
    }

    // #1676 MODEL-REPAIR phase: settle the exact mechanical receipt, persist the
    // bounded context, and keep the row on the REBASE lane so the #1674 gates
    // offer it only to a model-authorized poll. `rebaseEpisodeTransferred` is
    // cleared with the id it names: this episode awaits the model phase, it is
    // not transferred, and a stale flag would make the dedup gate above swallow
    // the model worker's own refusal (and strand its live receipt on the row).
    if (modelRepair) {
      const { count } = await client.prFixQueueItem.updateMany({
        where: casWhere,
        data: {
          status: "QUEUED",
          type: "REBASE",
          // The same lane rule the transfer release applies: never demote an
          // exclusive lane, and an explicit human hold resets as it does there.
          lane: preserveEscalationLane(row.lane),
          semanticConflict: transportContext,
          rebaseEpisodeId: episodeId,
          rebaseEpisodeTransferred: false,
          rebaseEpisodeTransferredAt: null,
          rebaseEpisodeGeneration: input.generation,
          ...freshAttemptGeneration(),
          // #1543: the consumed mechanical attempt made no progress, so it
          // counts; the model attempt that follows is bounded by the same cap.
          stagnationCount: nextStagnation,
          outcome: null,
          decisionDetail: null,
          // The fresh attempt's baseline is the verified, unchanged remote head.
          attemptHeadSha: remoteHead,
          // `headSha` rides the same verified value: the dispatch-side context
          // scoping keys on the freshest head knowledge, and the episode id this
          // write stores was derived from exactly this head.
          headSha: remoteHead,
          postDispatchEvidenceKeys: [],
          agentHandouts: [],
          externalWaitBy: null,
          handoutAcks: [],
          handoutAckTimes: [],
          handoutReceipts: [],
        },
      });
      if (count !== 1) {
        continue;
      }
      const modelRow = await client.prFixQueueItem.findUnique({ where: { id: row.id } });
      await client.prFixHistory.create({
        data: { itemId: row.id, action: "rebase_model_repair", status: "QUEUED", note: historyNote },
      });
      return {
        action: "model_repair",
        item: (modelRow ?? row) as Record<string, unknown>,
        reason: `rebase episode ${episodeId} accepted for model-assisted repair: rebase attempt generation ${input.generation} settled, the bounded conflict context is persisted, and the row is held for a model-authorized REBASE poll at generation ${input.generation + 1} (#1676)`,
      };
    }

    // The transfer write: settle the exact receipt (the arrays are pinned and
    // cleared), release the consumed rebase hand-out, and open the ONE
    // authorized ordinary fix attempt — plus the episode record — atomically.
    const feedbackLines = buildTransferFeedback(input.refusal, episodeId, modelPhasePending);
    // The mechanical-only instruction wall (#1327) is the REBASE lane's worker
    // contract, not evidence: a transferred row is an ordinary model-assisted
    // repair attempt (#1675), and carrying the wall would hand its worker
    // contradictory mechanical-only and repair instructions. Other retained
    // feedback (ordinary observations, e.g. review evidence) is kept.
    const retainedFeedback: string[] = Array.isArray(row.feedback) ? [...row.feedback] : [];
    let feedback: string[] = retainedFeedback.filter((line) => !isMechanicalRebaseInstruction(line));
    for (const line of feedbackLines) {
      feedback = uniqueAppend(feedback, line, 12);
    }
    const transferData: Record<string, unknown> = {
      status: "QUEUED",
      // The transferred lane is an ORDINARY model-assisted repair attempt
      // (#1675), not a mechanical-only conflict row: the worker contract
      // defines MERGE_CONFLICT as carrying the same mechanical-only walls as
      // REBASE, so a MERGE_CONFLICT-typed repair row would dispatch with
      // contradictory instructions. OTHER is the ordinary requested-changes
      // lane; the bounded refusal evidence in the feedback carries the repair
      // context. The episode record below is what keeps
      // `clearResolvedConflictItems` treating the row as a conflicts item
      // with its normal success path — the row's conflicts-item identity
      // moves from its (now ordinary) type to the transferred-episode marker.
      type: "OTHER",
      // #1503: the transferred attempt keeps the exclusive lane for a
      // frontier parent — a mechanical exception must never become an
      // implicit bypass of escalation exclusivity.
      lane: releaseLaneFromParentClass(
        await linkedIssueEscalationClassified(client, row.repo, row.issue ?? null),
        row.lane,
      ),
      reason: "Ordinary fix attempt for a non-mechanical conflict reported by the mechanical rebase lane (#1675)",
      feedback,
      // freshAttemptGeneration() is the shared fresh-attempt field set
      // (generation bump + snapshot/lane/park resets), so the fresh attempt's
      // identity semantics cannot drift from the other fresh-attempt writers.
      ...freshAttemptGeneration(),
      fixAttempts: { increment: 1 },
      // #1543: no budget reset — the consumed rebase attempt counts.
      stagnationCount: nextStagnation,
      // The fresh attempt's baseline is the verified, unchanged remote head.
      attemptHeadSha: remoteHead,
      outcome: null,
      decisionDetail: null,
      postDispatchEvidenceKeys: [],
      agentHandouts: [],
      externalWaitBy: null,
      handoutAcks: [],
      handoutAckTimes: [],
      handoutReceipts: [],
      // The episode record: the one-way marker the enqueue gate reads.
      rebaseEpisodeId: episodeId,
      rebaseEpisodeTransferred: true,
      rebaseEpisodeTransferredAt: new Date(),
      rebaseEpisodeGeneration: input.generation,
      // The #1615 ownership transition: a pool-member claimant is replaced by
      // the re-resolved repair owner (or an honest unresolved state) in the
      // SAME atomic write, so the transferred generation can never exist as a
      // row the ownership gate structurally refuses.
      ...(claimantTransition ? claimantTransition.data : {}),
    };
    const { count } = await client.prFixQueueItem.updateMany({
      where: casWhere,
      data: transferData,
    });
    if (count !== 1) {
      // A concurrent hand-out, ack, reclaim, requeue or settlement landed in
      // the read→write gap: re-decide against a fresh read once, then skip.
      continue;
    }
    const transferredRow = await client.prFixQueueItem.findUnique({ where: { id: row.id } });
    await client.prFixHistory.create({
      data: { itemId: row.id, action: "rebase_transfer", status: "QUEUED", note: historyNote },
    });
    return {
      action: "transferred",
      item: (transferredRow ?? row) as Record<string, unknown>,
      reason: `rebase episode ${episodeId} transferred: rebase attempt generation ${input.generation} settled, one ordinary fix attempt authorized at generation ${input.generation + 1} (#1675)`,
    };
  }
  return {
    action: "skipped",
    reason: "rebase transfer skipped: every compare-and-swap pass lost a race with concurrent queue activity; the row is left untouched",
  };
}

/**
 * The instruction wall appended to the transferred attempt's feedback: the fix
 * worker receives the mechanical-failure context (#1540) and the bounded
 * refusal evidence. Bounded like every other feedback entry (uniqueAppend
 * caps the list; each line is bounded here).
 */
function buildTransferFeedback(refusal: RebaseRefusalContext, episodeId: string, modelAttempted: boolean): string[] {
  const lines = [
    modelAttempted
      ? `The authorized model-assisted rebase attempt refused this conflict episode ${episodeId}; this is the single authorized ordinary repair attempt for it (#1676, #1675).`
      : `The mechanical rebase lane refused this conflict as NON-MECHANICAL and this is the single authorized repair attempt for conflict episode ${episodeId} (#1675).`,
    `Bounded refusal evidence — conflicting files: ${
      refusal.conflictingFiles.length ? refusal.conflictingFiles.join(", ") : "none reported"
    }.`,
  ];
  if (refusal.explanation) {
    lines.push(`Mechanical rebase executor explanation (bounded): ${refusal.explanation}`);
  }
  lines.push(
    "Repair the conflict on the existing PR branch — never merge, never open a new PR — and follow the ordinary PR-repair preparation, validation and publication rules. Attempt budgets still apply; a second semantic refusal settles ordinarily (no further transfer).",
  );
  return lines;
}
