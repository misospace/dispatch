import { Prisma } from "@prisma/client";
import { normalizePrFixStatus, PrFixStatus } from "@/types";
import { surfacePrFixBlocked, surfacePrFixParked } from "../pr-fix-surfacing";
import { parseExternalWaitInput } from "../pr-fix-external-wait";
import { type PrFixQueueClient } from "./client";
import { MAX_EVIDENCE_LENGTH, normalizeQueueRepo, resolvePrFixOutcome } from "./shared";
import { alreadyAddressedHistoryNote, type MarkPrFixInput } from "./inputs";
import { linkedIssueEscalationClassified, preserveEscalationLane, releaseLaneFromParentClass } from "./escalation-lane";
import { buildPrFixBlockedContext, hasActionablePostDispatchEvidence, listDurablePostDispatchEntries } from "./evidence";
import { attemptHeadAdvanced, externalWaitCooldownMs, maxPrFixStagnation } from "./external-wait";
import { retractNeedsHuman } from "./enqueue";
import { assertPrHeadMovedForFix } from "./queue-read";
import { freshAttemptGeneration, parseAgentHandoutToken } from "./handout";

/**
 * Result of `markPrFixItem` (#1074). A mark either mutated the row
 * (`mutated: true`, with the fresh row) or was skipped without any write
 * (`mutated: false`): `not-found` when no item matches, `generation-mismatch`
 * when an `expectedGeneration` was supplied and the row's generation no
 * longer matches (the attempt was re-issued between read and write), and
 * `not-handed` when a `handoutScopedAgent` was supplied and the row's
 * `agentHandouts` do not carry that agent's marker at the settled generation
 * (#1428) — a caller-binding refusal, deliberately distinct from the row's
 * outcome vocabulary so a worker can tell "you may not settle this" from
 * "the settlement was refused".
 */
export type MarkPrFixResult =
  | { mutated: true; item: any }
  | { mutated: false; reason: "generation-mismatch" | "not-found" | "not-handed" };

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

  // #1430: a WAITING_EXTERNAL transition clears agentHandouts, so its
  // same-generation idempotent replay can only be scoped by the waiter
  // identity recorded atomically with that transition.
  const scopedReplayAllowed = (row: { externalWaitBy?: unknown }): boolean =>
    !input.handoutScopedAgent ||
    (typeof row.externalWaitBy === "string" && row.externalWaitBy
      ? row.externalWaitBy
      : null) === input.handoutScopedAgent;

  // Idempotent WAITING_EXTERNAL duplicate for the same generation: never
  // extend the cooldown, never overwrite the recorded contract or note
  // (#1231). Checked BEFORE the #1428 hand-out binding below on purpose: the
  // wait itself cleared `agentHandouts`; #1430 therefore binds this replay
  // to the waiter identity recorded by the original transition.
  if (nextStatus === "WAITING_EXTERNAL" && existing.status === "WAITING_EXTERNAL" && existing.generation === expectedGeneration) {
    if (!scopedReplayAllowed(existing)) {
      return { mutated: false, reason: "not-handed" };
    }
    return { mutated: true, item: existing };
  }

  // Hand-out binding (#1428): a worker-tier settlement (the route supplies the
  // bound token's agent as `handoutScopedAgent`) may settle only the attempt
  // it was actually handed — the row's `agentHandouts` must carry this agent's
  // `<agentName>@<generation>` marker at the settled generation, the same
  // envelope `ackPrFixHandout` pins on. Without it the caller is crossing the
  // agent boundary on the queue (any bound credential could tombstone another
  // agent's attempt as FIXED/BLOCKED/...), so refuse with `not-handed` — no
  // mutation, no history row, and a code outside the outcome vocabulary.
  // Entries from other generations are inert (fail toward `not-handed`, never
  // toward settling a spent hand-out). Maintainer/operator paths and the
  // internal report settlement never set this field and stay unconstrained.
  if (input.handoutScopedAgent) {
    const handouts: string[] = Array.isArray(existing.agentHandouts) ? existing.agentHandouts : [];
    const scopedGeneration = expectedGeneration ?? existing.generation;
    const handedThisAgent = handouts.some((entry) => {
      const parsed = parseAgentHandoutToken(entry);
      return parsed !== null && parsed.agentName === input.handoutScopedAgent && parsed.generation === scopedGeneration;
    });
    if (!handedThisAgent) {
      return { mutated: false, reason: "not-handed" };
    }
  }

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
    // The same-generation idempotent duplicate (#1231) was already answered
    // above, before the #1428 hand-out binding.
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
            // #1503: an operational park never demotes the exclusive lane.
            lane: preserveEscalationLane(existing.lane),
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
      if (latest?.status === "WAITING_EXTERNAL" && latest.generation === expectedGeneration) {
        // #1430: the concurrent wait that beat this attempt belongs to its
        // starter; a scoped caller that is not the recorded waiter does not
        // get that row back either.
        return scopedReplayAllowed(latest) ? { mutated: true, item: latest } : { mutated: false, reason: "not-handed" };
      }
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
    data.handoutAckTimes = [];
    // #1430: record who started this wait, atomically with the transition.
    // A scoped worker records its bound identity so its own same-generation
    // retry keeps the #1231 idempotent answer; an unscoped (maintainer/
    // operator/internal) wait records null and grants no worker-scope replay.
    data.externalWaitBy = input.handoutScopedAgent ?? null;
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
    if (latest?.status === "WAITING_EXTERNAL" && latest.generation === expectedGeneration) {
      // #1430: a scoped caller that lost the QUEUED→WAITING_EXTERNAL write to
      // another agent's concurrent wait at the same generation must not read
      // that agent's wait back; only the recorded waiter keeps the #1231
      // idempotent answer here (own retry winning the race twice is fine).
      return scopedReplayAllowed(latest) ? { mutated: true, item: latest } : { mutated: false, reason: "not-handed" };
    }
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
  // #1543: the stagnation classification shared by the reopen write and its
  // surfacing decision, so both always agree on the same row snapshot. The
  // consumed attempt made progress only when the observed head advanced past
  // its baseline (`attemptHeadSha`, legacy `headSha` fallback).
  const reopenStagnation = (row: any): number =>
    attemptHeadAdvanced(row.headSha, row.attemptHeadSha ?? row.headSha)
      ? 0
      : (row.stagnationCount ?? 0) + 1;
  const writeReopen = async (tx: any, row: any, noteSuffix = ""): Promise<any | null> => {
        const nextStagnation = reopenStagnation(row);
        const reopenCapped = nextStagnation >= maxPrFixStagnation();
        // #1503 review: a fresh-attempt reopen re-derives the linked issue too —
        // an operator reclassify (BLOCKED → FIXED) can settle a row whose lane
        // column reads NEEDS_HUMAN, and the reopen must not re-enter the loop
        // (or park) on the shared lane with a frontier parent. Mirrors the
        // release/requeue rule; the DB read is in-tx like requeuePrFixItem's.
        const reopenLane = releaseLaneFromParentClass(
          await linkedIssueEscalationClassified(tx, row.repo, row.issue),
          row.lane,
        );
        const reopenData: Record<string, unknown> = reopenCapped
          ? {
              status: "PARKED",
              // #1503: capped give-up park keeps the exclusive lane.
              lane: reopenLane,
              outcome: "no_progress",
              // #1543: record the exhausted stagnation count.
              stagnationCount: nextStagnation,
          decisionDetail: null,
          // #1253: disposition audit stamp (capped give-up park).
          disposedAt: new Date(),
          disposedEvidence: null,
          postDispatchEvidenceKeys: [],
          agentHandouts: [],
          externalWaitBy: null, // #1430: the wait this generation recorded died with these hand-out records
          handoutAcks: [],
          handoutAckTimes: [],
          handoutReceipts: [],
          attemptEvidenceWatermark: null,
        }
      : {
          status: "QUEUED",
          // #1503: the post-dispatch-evidence reopen keeps the exclusive lane.
          lane: reopenLane,
          ...freshAttemptGeneration(),
          fixAttempts: { increment: 1 },
          // #1543: reset after proven head advancement, accumulate otherwise.
          stagnationCount: nextStagnation,
          attemptHeadSha: row.headSha ?? row.attemptHeadSha ?? null,
          outcome: null,
          decisionDetail: null,
          postDispatchEvidenceKeys: [],
          // Fresh attempt: per-agent hand-out records for the consumed
          // generation must not suppress its re-dispatch (#1133), and the
          // prior generation's acknowledgements are dead (#1211).
          agentHandouts: [],
          externalWaitBy: null, // #1430: the wait this generation recorded died with these hand-out records
          handoutAcks: [],
          handoutAckTimes: [],
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
            ? `New evidence arrived after this attempt was handed out, but the stagnation budget is exhausted at ${nextStagnation} consecutive attempts with no head advancement (PR_FIX_MAX_STAGNATION=${maxPrFixStagnation()}); parked (#1119, #1543).`
            : `New evidence arrived after this attempt was handed out; reopened as a fresh attempt at the current head (#1119).`) + noteSuffix,
      },
    });
    return tx.prFixQueueItem.findUnique({ where: { id: row.id } });
  };

  const surfaceReopen = async (before: any, reopened: any) => {
    const reopenCapped = reopenStagnation(before) >= maxPrFixStagnation();
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
    // #1503: an operational park never demotes the exclusive lane.
    data.lane = preserveEscalationLane(existing.lane);
    data.outcome = resolvePrFixOutcome("PARKED", input.outcome);
    data.decisionDetail = null;
    // #1253: disposition audit stamp (operational park).
    data.disposedAt = new Date();
    data.disposedEvidence = null;
  } else if (nextStatus === "QUEUED") {
    // #1503 review: releasing a hold back to the dispatchable loop re-derives
    // the authoritative classification from the linked issue, mirroring
    // requeuePrFixItem. A NEEDS_HUMAN hold replaced the lane column, so
    // preserveEscalationLane(existing.lane) alone cannot see a frontier
    // parent: without the re-derivation a BLOCKED frontier row released back
    // to QUEUED re-entered the shared queue as NORMAL.
    data.lane = releaseLaneFromParentClass(
      await linkedIssueEscalationClassified(client, existing.repo, existing.issue),
      existing.lane,
    );
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
      // An operator release is an explicit override: the consecutive-stagnation
      // budget resets with the fresh attempt (#1543), like requeuePrFixItem.
      Object.assign(data, freshAttemptGeneration(), { fixAttempts: { increment: 1 }, stagnationCount: 0 });
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
      data.handoutAckTimes = [];
      // #1430: the recorded waiter belongs to the dead attempt's wait; a
      // fresh attempt never inherits it.
      data.externalWaitBy = null;
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
      // #1543: the head is unchanged by definition on this path, so the
      // refused attempt never proves progress — it always consumes one unit
      // of stagnation budget; past the consecutive-stagnation cap, PARK the
      // PR instead of re-running a worker that keeps pushing nothing (#1103,
      // #1218). The retry keeps the refused baseline: the head is unchanged,
      // so it is still the newest observed (#1104).
      const refusalStagnation = (existing.stagnationCount ?? 0) + 1;
      const refusalCapped = refusalStagnation >= maxPrFixStagnation();
      // #1503 review: the refused-FIXED release re-derives the parent too —
      // an operator reclassify (BLOCKED → FIXED) can reach this tail with the
      // row held at NEEDS_HUMAN, and the release must not silently demote a
      // frontier parent to the shared lane.
      const refusalLane = releaseLaneFromParentClass(
        await linkedIssueEscalationClassified(client, existing.repo, existing.issue),
        existing.lane,
      );
        const refusalData: Record<string, unknown> = refusalCapped
          ? {
              status: "PARKED",
              // #1503: the refused-attempt cap park keeps the exclusive lane.
              lane: refusalLane,
            outcome: "no_progress",
            // #1543: record the exhausted stagnation count.
            stagnationCount: refusalStagnation,
            decisionDetail: null,
            // #1253: disposition audit stamp (refused-FIXED cap park).
            disposedAt: new Date(),
            disposedEvidence: null,
            postDispatchEvidenceKeys: [],
            agentHandouts: [],
            externalWaitBy: null, // #1430: the wait this generation recorded died with these hand-out records
            handoutAcks: [],
            handoutAckTimes: [],
            handoutReceipts: [],
            attemptEvidenceWatermark: null,
          }
        : {
            status: "QUEUED",
            // #1503: the refused-FIXED retry attempt keeps the exclusive lane.
            lane: refusalLane,
            ...freshAttemptGeneration(),
            fixAttempts: { increment: 1 },
            // #1543: the head never advanced, so this consumes stagnation.
            stagnationCount: refusalStagnation,
            attemptHeadSha: input.attemptHeadSha ?? baseline ?? null,
            outcome: null,
            decisionDetail: null,
            // The generation bump invalidates any recorded entries and proves
            // no stale post-dispatch list on the fresh attempt (#1119).
            postDispatchEvidenceKeys: [],
            // Same for the per-agent hand-out records and their
            // acknowledgements (#1133, #1211).
            agentHandouts: [],
            externalWaitBy: null, // #1430: the wait this generation recorded died with these hand-out records
            handoutAcks: [],
            handoutAckTimes: [],
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
              ? `${refusedNote} Stagnation budget exhausted at ${refusalStagnation} consecutive attempts with no head advancement (PR_FIX_MAX_STAGNATION=${maxPrFixStagnation()}); parked instead of re-queuing (#1103, #1543).`
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
  // #1543: the consumed attempt made progress only when the observed head
  // advanced past its baseline; otherwise this forced fallback consumes one
  // unit of stagnation budget, and an exhausted budget parks instead.
  const forceStagnation = attemptHeadAdvanced(lastFresh.headSha, lastFresh.attemptHeadSha ?? lastFresh.headSha)
    ? 0
    : (lastFresh.stagnationCount ?? 0) + 1;
  const forceCapped = forceStagnation >= maxPrFixStagnation();
  const forceData: Record<string, unknown> = forceCapped
    ? {
        status: "PARKED",
        // #1503: a cap park never demotes the exclusive lane.
        lane: preserveEscalationLane(lastFresh.lane),
        outcome: "no_progress",
        // #1543: record the exhausted stagnation count.
        stagnationCount: forceStagnation,
        decisionDetail: null,
        // #1253: disposition audit stamp (racing-evidence cap park).
        disposedAt: new Date(),
        disposedEvidence: null,
        postDispatchEvidenceKeys: [],
        agentHandouts: [],
        externalWaitBy: null, // #1430: the wait this generation recorded died with these hand-out records
        handoutAcks: [],
        handoutAckTimes: [],
        handoutReceipts: [],
        attemptEvidenceWatermark: null,
          }
        : {
            status: "QUEUED",
            // #1503: the forced-fallback retry attempt keeps the exclusive lane.
            lane: preserveEscalationLane(lastFresh.lane),
            ...freshAttemptGeneration(),
        fixAttempts: { increment: 1 },
        // #1543: reset after proven head advancement, accumulate otherwise.
        stagnationCount: forceStagnation,
        attemptHeadSha: lastFresh.headSha ?? lastFresh.attemptHeadSha ?? null,
        outcome: null,
        decisionDetail: null,
        postDispatchEvidenceKeys: [],
        // Fresh attempt: per-agent hand-out records for the consumed
        // generation must not suppress its re-dispatch (#1133), and the
        // prior generation's acknowledgements are dead (#1211).
        agentHandouts: [],
        externalWaitBy: null, // #1430: the wait this generation recorded died with these hand-out records
        handoutAcks: [],
        handoutAckTimes: [],
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
            ? `Post-dispatch evidence kept landing while this settlement was in flight, but the stagnation budget is exhausted at ${forceStagnation} consecutive attempts with no head advancement (PR_FIX_MAX_STAGNATION=${maxPrFixStagnation()}); parked (#1218, #1543).`
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
