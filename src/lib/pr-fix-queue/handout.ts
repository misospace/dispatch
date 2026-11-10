import { randomBytes } from "node:crypto";
import { normalizePrFixType } from "@/types";
import { prFixOwnershipEvidence } from "../pr-fix-ownership";
import { type PrFixQueueClient } from "./client";
import { prFixAckLivenessMs, prFixHandoutTimeoutMs } from "./shared";

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
  ciParkState: null;
  ciParkHead: null;
  ciParkKey: null;
  ciParkFence: null;
  ciParkAt: null;
  attemptType: null;
} {
  // A fresh attempt has no hand-out yet, so it has no evidence snapshot: the
  // watermark resets alongside the post-dispatch list and dies only with the
  // generation it bounded (#1249). The durable ledger COUNTER is not reset —
  // ledger positions are per-item history, and a stale-low watermark must
  // never survive into a new attempt to make known evidence read as new.
  //
  // #495 leash: every generation bump also clears the CI park deferral
  // columns in the same write, so a deferral can never strand an item across
  // attempts — a requeued, externally-woken, or reclaimed item is dispatchable
  // again and a crashed Courier cycle leaves no suppression behind. No TTL and
  // no new env var: this sole generation-bump helper is the expiry.
  //
  // #1327 review: the DISPATCHED lane resets with the attempt too. A
  // non-null `attemptType` means "this generation was handed out as that
  // lane"; letting it survive a generation bump would make next-task's
  // concurrency gate read a dead attempt as the live lane — masking a fresh
  // REBASE attempt (bypassing the gate and its serialization, a fan-out
  // door) or gating an ordinary fresh attempt behind the rebase lane. The
  // lane is stamped by the hand-out itself; a fresh attempt has none.
  return {
    generation: { increment: 1 },
    attemptEvidenceWatermark: null,
    ciParkState: null,
    ciParkHead: null,
    ciParkKey: null,
    ciParkFence: null,
    ciParkAt: null,
    attemptType: null,
  };
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
      // #1419: the ack timestamps are handoutAcks' parallel array — filtered
      // by the same index so a released ack's timestamp dies with it.
      const ackTimes: string[] = Array.isArray(fresh.handoutAckTimes) ? fresh.handoutAckTimes : [];
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
      const remainingAckTimes = ackTimes.filter((_, index) => !isOwnToken(acks[index]));
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
          handoutAckTimes: remainingAckTimes,
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

/**
 * Wall-clock idle reason for a QUEUED PR-fix item's current generation
 * (#1419): why the stamped hand-out has not been handed out again or settled.
 * Derived from row fields only (no DB reads, no liveness probes): a stamped
 * generation older than the unacknowledged hand-out timeout reports whether
 * it is still waiting on an acknowledgement or already acked and awaiting
 * dead-owner recovery. Null whenever the item is not in that stuck shape.
 */
function deriveIdleReason(item: any): string | null {
  if (item.status !== "QUEUED") return null;
  if (item.dispatchedGeneration == null || item.dispatchedGeneration !== item.generation) return null;
  if (item.dispatchedAt == null) return null;
  const dispatchedMs = new Date(item.dispatchedAt).getTime();
  if (Number.isNaN(dispatchedMs)) return null;
  const acks: string[] = Array.isArray(item.handoutAcks) ? item.handoutAcks : [];
  const acked = acks.some((entry) => {
    const parsed = parseAgentHandoutToken(entry);
    return parsed !== null && parsed.generation === item.generation;
  });
  // Two different clocks, matching the two recovery ladders (#1419): an
  // unacked hand-out is stale past PR_FIX_HANDOUT_TIMEOUT_MS; an acked one
  // only counts as stuck past PR_FIX_ACK_LIVENESS_MS (dated by the parallel
  // ack timestamp, or the dispatch stamp for legacy acks) — a fresh ack on
  // an old dispatch is a healthy long run, not a stuck generation.
  if (!acked) {
    if (!(dispatchedMs < Date.now() - prFixHandoutTimeoutMs())) return null;
    return "stale-unacknowledged-handout";
  }
  const ackTimes: string[] = Array.isArray(item.handoutAckTimes) ? item.handoutAckTimes : [];
  let ackMs: number | null = null;
  acks.forEach((entry, index) => {
    const parsed = parseAgentHandoutToken(entry);
    if (parsed === null || parsed.generation !== item.generation) return;
    const t = Date.parse(ackTimes[index] ?? "");
    if (!Number.isNaN(t) && (ackMs === null || t > ackMs)) ackMs = t;
  });
  const effectiveAckMs = ackMs ?? dispatchedMs; // legacy ack: dispatch-stamp lower bound
  if (!(effectiveAckMs < Date.now() - prFixAckLivenessMs())) return null;
  return "stale-acknowledged-handout";
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
    // #1569: ORIGINAL CLAIMANT evidence — the identity that owned the work
    // at ingestion, its provenance, and the derived versioned evidence
    // block. Additive for queue consumers (agent queue listings and the
    // PR-fix queued listing); the hand-out payload ships the same evidence
    // object only to a poll granted the `pr-ownership-evidence:1`
    // capability. `author` above stays the distinct PR-pusher identity.
    claimant: item.claimant ?? null,
    claimantSource: item.claimantSource ?? null,
    ownership: prFixOwnershipEvidence(item),
    generation: item.generation,
    // Per-agent hand-out records for the current generation (#1133); the
    // next-task route reads these to skip items this agent already has.
    agentHandouts: item.agentHandouts ?? [],
    // #1419 exposure: the current hand-out stamp and its acks, plus a
    // wall-clock idle reason so operators and pollers can see WHY a QUEUED
    // item is not being handed out. Wall-clock only — never a liveness
    // decision; the reclaim ladder's probes decide that.
    dispatchedAt: item.dispatchedAt ?? null,
    dispatchedGeneration: item.dispatchedGeneration ?? null,
    handoutAcks: item.handoutAcks ?? [],
    idleReason: deriveIdleReason(item),
    // #1253: fresh actionable evidence arrived while the item sat in a
    // disposition evidence must not override — operator-visible on queue
    // listings, cleared on reactivation or operator requeue.
    staleDisposition: item.staleDisposition ?? false,
    // #495: CI park deferral lifecycle ("active" suppresses the hand-out for
    // any polling agent; null/released/settled dispatch normally). Carried so
    // the next-task route can honor the deferral before any write.
    ciParkState: item.ciParkState ?? null,
    queuedAt: item.queuedAt,
    updatedAt: item.updatedAt,
    rankingReason: `queued PR review-fix item (${fixType})`,
  };
}
