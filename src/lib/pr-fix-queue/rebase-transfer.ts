import { fetchPullRequestHeadSha } from "../github-prs";
import { normalizePrFixType } from "@/types";
import { sanitizeForStorage } from "../groomer/sanitize";
import { type PrFixQueueClient } from "./client";
import { uniqueAppend } from "./shared";
import { linkedIssueEscalationClassified, preserveEscalationLane, releaseLaneFromParentClass } from "./escalation-lane";
import { maxPrFixStagnation } from "./external-wait";
import { findHandoutReceipt, freshAttemptGeneration } from "./handout";

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
 * The stable conflict-episode identity: a pure function of the AUTHORITATIVE
 * PR/base/head/ref state Dispatch itself holds. `branch` is the head ref,
 * `headSha` the conflicting head. Null branches/heads fold to a literal
 * "unknown" segment so a partially-observed episode still derives ONE
 * deterministic identity, and both sides of the comparison (the transfer
 * writer and the enqueue-side gate) fold the same way. Poll timestamps and
 * worker text are deliberately absent: a resync ten seconds later and a
 * restart tomorrow derive the SAME identity for the SAME conflict, and a new
 * push (new head) derives a DIFFERENT one.
 */
export function rebaseEpisodeIdentity(
  repo: string,
  pr: number,
  branch: string | null | undefined,
  headSha: string | null | undefined,
): string {
  const ref = (branch ?? "").trim() || "unknown";
  const head = (headSha ?? "").trim() || "unknown";
  return `rebase-episode:${repo}#${pr}:${ref}:${head}`;
}

/** How the transfer attempt ended; the caller decides the ordinary fallback. */
export type RebaseTransferResult =
  | { action: "transferred"; item: Record<string, unknown>; reason: string }
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
 * The write itself is one pinned `updateMany` (status + generation + dispatch
 * stamps + exact hand-out arrays + dispatched lane + episode flag) so a
 * concurrent hand-out, ack, reclaim, requeue or settlement landing in the
 * read→write gap no-ops the whole transfer. The episode record, the fresh
 * fix attempt and the hand-out-record release commit atomically.
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
    // Budget (#1543): the consumed rebase attempt provably made NO progress
    // (the head is verified unchanged), so it consumes one unit of the
    // consecutive-stagnation budget. An exhausted budget parks the row
    // instead of minting the authorized repair attempt — bounded exhaustion,
    // never a fresh attempt and never a budget reset.
    const nextStagnation = (row.stagnationCount ?? 0) + 1;
    const capped = nextStagnation >= maxPrFixStagnation();
    const historyNote = capped
      ? `Agent reported a non-mechanical (semantic) conflict from the mechanical rebase attempt; the consecutive-stagnation budget is exhausted at ${nextStagnation} (PR_FIX_MAX_STAGNATION=${maxPrFixStagnation()}), so the REBASE→fix transfer is declined and the row parks instead (#1675, #1543). Receipt settled: ${owned}. Episode: ${episodeId}.`
      : `Agent reported a non-mechanical (semantic) conflict from the mechanical rebase attempt; the exact rebase receipt/generation (${input.generation}) is settled and ONE ordinary fix attempt is authorized with the bounded refusal evidence (#1675). Episode: ${episodeId}. Conflicting files: ${input.refusal.conflictingFiles.length ? input.refusal.conflictingFiles.join(", ") : "none reported"}.`;
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
        where: {
          id: row.id,
          status: "QUEUED",
          generation: input.generation,
          dispatchedGeneration: input.generation,
          attemptType: row.attemptType ?? null,
          handoutReceipts: { equals: receipts },
          agentHandouts: { equals: handouts },
          handoutAcks: { equals: acks },
        },
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

    // The transfer write: settle the exact receipt (the arrays are pinned and
    // cleared), release the consumed rebase hand-out, and open the ONE
    // authorized ordinary fix attempt — plus the episode record — atomically.
    const feedbackLines = buildTransferFeedback(input.refusal, episodeId);
    let feedback: string[] = Array.isArray(row.feedback) ? [...row.feedback] : [];
    for (const line of feedbackLines) {
      feedback = uniqueAppend(feedback, line, 12);
    }
    const transferData: Record<string, unknown> = {
      status: "QUEUED",
      // The transferred lane is an ordinary conflict-fix attempt (not REBASE):
      // this is also what makes `clearResolvedConflictItems` treat the row as
      // a conflicts item with its normal success path.
      type: "MERGE_CONFLICT",
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
    };
    const { count } = await client.prFixQueueItem.updateMany({
      where: {
        id: row.id,
        status: "QUEUED",
        generation: input.generation,
        dispatchedGeneration: input.generation,
        attemptType: row.attemptType ?? null,
        handoutReceipts: { equals: receipts },
        agentHandouts: { equals: handouts },
        handoutAcks: { equals: acks },
      },
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
function buildTransferFeedback(refusal: RebaseRefusalContext, episodeId: string): string[] {
  const lines = [
    `The mechanical rebase lane refused this conflict as NON-MECHANICAL and this is the single authorized repair attempt for conflict episode ${episodeId} (#1675).`,
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
