import { normalizePrFixOutcome, normalizePrFixStatus, normalizePrFixType, PrFixDecisionContext, PrFixStatus } from "@/types";
import { surfacePrFixParked } from "../pr-fix-surfacing";
import { prisma } from "@/lib/prisma";
import { fetchPullRequestMergeState } from "../github-prs";
import { capacityCooldownMs } from "../capacity-handoff";
import { sanitizeForStorage } from "../groomer/sanitize";
import { type PrFixQueueClient } from "./client";
import { normalizeQueueRepo } from "./shared";
import { preserveEscalationLane } from "./escalation-lane";
import { buildPrFixBlockedContext } from "./evidence";
import { attemptHeadAdvanced, maxPrFixStagnation } from "./external-wait";
import { markPrFixItem } from "./settlement";
import { agentHandoutToken, findHandoutReceipt, freshAttemptGeneration, handoutReceipt, releaseAgentHandout } from "./handout";

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
 *   fresh attempt (fixAttempts stays attempt-chain telemetry; the stop is the
 *   consecutive-stagnation budget, #1543), or BLOCKED +
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
      const ackTimes: string[] = Array.isArray(live.handoutAckTimes) ? live.handoutAckTimes : [];
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
      // Keep the parallel ack-timestamp array index-aligned with the filtered
      // ack list (#1419): the released agent's ack timestamp dies with its
      // ack token, so the surviving agents' timestamps keep mapping to their
      // own acks and the reclaimer never reads a stale age for a live ack.
      const remainingAckTimes = ackTimes.filter((_, index) => acks[index] !== ownEntry);
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
          handoutAckTimes: remainingAckTimes,
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
    // Settle the failure into a fresh dispatchable attempt — fixAttempts
    // stays attempt-chain telemetry and the stop is the consecutive-stagnation
    // budget (#1543), so an exhausted budget parks. No PR-state check: a
    // fresh attempt absorbs late evidence by
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
      // stagnation ladder is for code-fix generations; retrying a
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
      // #1543: a failed report proves progress only when the observed head
      // advanced past the consumed attempt's baseline; otherwise it consumes
      // one unit of the consecutive-stagnation budget, and an exhausted
      // budget parks instead of re-queueing.
      const failedStagnation = attemptHeadAdvanced(fresh.headSha, fresh.attemptHeadSha ?? fresh.headSha)
        ? 0
        : (fresh.stagnationCount ?? 0) + 1;
      const capped = rebaseTerminal || failedStagnation >= maxPrFixStagnation();
      const data: Record<string, unknown> = capped
        ? {
            status: "PARKED",
            // #1503: a terminal park never demotes the exclusive lane.
            lane: preserveEscalationLane(fresh.lane),
            outcome: "no_progress",
            // #1543: record the exhausted stagnation count.
            stagnationCount: failedStagnation,
            decisionDetail: null,
            // #1253: disposition audit stamp (failed-report cap park).
            disposedAt: new Date(),
            disposedEvidence: null,
            postDispatchEvidenceKeys: [],
            agentHandouts: [],
            externalWaitBy: null, // #1430: the wait this generation recorded died with these hand-out records
            handoutAcks: [],
            handoutAckTimes: [],
            handoutReceipts: [],
          }
        : {
            status: "QUEUED",
            // #1503: the failed-report fresh attempt keeps the exclusive lane.
            lane: preserveEscalationLane(fresh.lane),
            ...freshAttemptGeneration(),
            fixAttempts: { increment: 1 },
            // #1543: reset after proven head advancement, accumulate otherwise.
            stagnationCount: failedStagnation,
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
            externalWaitBy: null, // #1430: the wait this generation recorded died with these hand-out records
            handoutAcks: [],
            handoutAckTimes: [],
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
                  : `Agent reported failed; the stagnation budget is exhausted at ${failedStagnation} consecutive attempts with no head advancement (PR_FIX_MAX_STAGNATION=${maxPrFixStagnation()}), parked instead of re-queuing (#1133, #1543).`
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
