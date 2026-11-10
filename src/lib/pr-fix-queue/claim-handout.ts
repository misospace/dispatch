import { surfacePrFixParked } from "../pr-fix-surfacing";
import { fetchPullRequestState } from "../github-prs";
import { type PrFixQueueClient } from "./client";
import { maxPrFixReclaims, normalizeQueueRepo, nowIso, prFixAckLivenessMs, prFixHandoutTimeoutMs } from "./shared";
import { type AckPrFixHandoutInput, type AckPrFixHandoutResult } from "./inputs";
import { preserveEscalationLane } from "./escalation-lane";
import { buildPrFixBlockedContext } from "./evidence";
import { agentHandoutToken, freshAttemptGeneration, parseAgentHandoutToken } from "./handout";

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
  // Parallel ack timestamps (#1419): each ack records when it landed so the
  // reclaimer can require an acked owner to re-evidence liveness instead of
  // staying authoritative forever. Appended in the SAME atomic write as the
  // ack token, so the two arrays can never drift out of index alignment —
  // including on a legacy row whose acks predate #1419 and carry no
  // timestamps: the existing list is padded to the ack list's length first,
  // so entry i of handoutAckTimes always corresponds to handoutAcks[i].
  const priorAckTimes = Array.isArray(existing.handoutAckTimes) ? existing.handoutAckTimes : [];
  const alignedPriorAckTimes = [...priorAckTimes];
  while (alignedPriorAckTimes.length < acks.length) alignedPriorAckTimes.push("");
  const nextAckTimes = [...alignedPriorAckTimes, nowIso()];
  const item = await client.$transaction(async (tx) => {
    const { count } = await tx.prFixQueueItem.updateMany({
      where: {
        id: existing.id,
        generation: input.generation,
        status: "QUEUED",
        handoutAcks: { equals: acks },
        handoutAckTimes: { equals: Array.isArray(existing.handoutAckTimes) ? existing.handoutAckTimes : [] },
      },
      data: { handoutAcks: nextAcks, handoutAckTimes: nextAckTimes },
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
  /**
   * Liveness window for ACKNOWLEDGED hand-outs (#1419): an acked generation
   * stays authoritative only while its owner re-evidences liveness. Defaults
   * to prFixAckLivenessMs().
   */
  ackLivenessMs?: number;
  /**
   * Injectable liveness probes for tests. Defaults read the `agentRun`
   * ledger: any recent run row by the agent (heartbeat, report, or legacy
   * ingestion) proves the worker process is alive, and an open AgentRun
   * associated with the (item, generation) attempt proves the attempt is
   * still executing. Both fail CLOSED — a probe error is treated as live
   * evidence, never as permission to reclaim.
   */
  agentHasRecentActivity?: (agentName: string, since: Date) => Promise<boolean>;
  itemHasOpenRun?: (itemId: string, generation: number) => Promise<boolean>;
}

/**
 * Default agent-liveness probe (#1419): true when the agent produced ANY
 * AgentRun row (heartbeat, tasks/report, or legacy run ingestion) after
 * `since`. Workers heartbeat per task cycle and every attempt reports
 * through AgentRun, so a live worker nearly always leaves fresh rows; a
 * worker whose process died leaves none. Errors resolve TRUE (live) so an
 * unreadable ledger can never authorize a reclaim.
 */
async function defaultAgentHasRecentActivity(
  client: PrFixQueueClient,
  agentName: string,
  since: Date,
): Promise<boolean> {
  // An absent surface (legacy/test client without the agentRun delegate)
  // resolves live — the fail-closed rule, not a silent TypeError.
  if (typeof (client as any).agentRun?.findFirst !== "function") return true;
  try {
    const row = await (client as any).agentRun.findFirst({
      where: { agentName, createdAt: { gt: since } },
      select: { id: true },
    });
    return row != null;
  } catch (error) {
    console.warn(
      `[pr-fix-queue] agent liveness probe failed for ${agentName}; treating agent as live:`,
      error instanceof Error ? error.message : error,
    );
    return true;
  }
}

/**
 * Default attempt-liveness probe (#1419): true when an AgentRun row is
 * associated with this (item, generation) and has not finished — a durably
 * recorded run that is still executing. Errors resolve TRUE (live), same
 * fail-closed rule as the agent probe.
 */
async function defaultItemHasOpenRun(
  client: PrFixQueueClient,
  itemId: string,
  generation: number,
): Promise<boolean> {
  if (typeof (client as any).agentRun?.findFirst !== "function") return true;
  try {
    const row = await (client as any).agentRun.findFirst({
      where: { prFixQueueItemId: itemId, prFixGeneration: generation, finishedAt: null },
      select: { id: true },
    });
    return row != null;
  } catch (error) {
    console.warn(
      `[pr-fix-queue] attempt liveness probe failed for item ${itemId} generation ${generation}; treating attempt as live:`,
      error instanceof Error ? error.message : error,
    );
    return true;
  }
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
 * Reclaim stamped-but-unacknowledged PR-fix hand-outs (#1211), and recover
 * ACKNOWLEDGED hand-outs whose owning agent is provably dead (#1419).
 *
 * The #1211 failure mode: next-task stamps `dispatchedGeneration`/`dispatchedAt`
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
 * The #1419 extension: a durable ack previously pinned a generation against
 * reclamation FOREVER, so a worker that acked and then crashed stranded the
 * item in a single-agent lane indefinitely. Now an ack is separated from
 * enduring liveness: an acked generation is recoverable through the SAME
 * three-way flow above only when EVERY acking agent of the current generation
 * is dead — its ack timestamp (parallel `handoutAckTimes` array) is older than
 * `PR_FIX_ACK_LIVENESS_MS` (default 24h), the agent produced no recent
 * AgentRun activity, and no open AgentRun is associated with this
 * (item, generation). Any live evidence or probe failure fails CLOSED and
 * the generation stays protected. A legacy ack without a timestamp is dated
 * by the dispatch stamp (the ack-time lower bound), so already-stranded
 * rows stay recoverable; the agent-activity probe is the operative liveness
 * guard (attempt-scoped runs are only recorded at report time today), so a
 * live worker that keeps heartbeating is never reclaimed.
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
  const ackLivenessMs = options.ackLivenessMs ?? prFixAckLivenessMs();
  const agentLive =
    options.agentHasRecentActivity ??
    ((agentName: string, since: Date) => defaultAgentHasRecentActivity(client, agentName, since));
  const attemptOpen =
    options.itemHasOpenRun ??
    ((itemId: string, generation: number) => defaultItemHasOpenRun(client, itemId, generation));

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

        // An acknowledged hand-out is no longer authoritative FOREVER (#1419):
        // the durable ack is separated from enduring liveness. A generation
        // acked by agent(s) is reclaimable only when EVERY acking agent is
        // dead — its ack is older than the ack-liveness window, the agent
        // produced no recent AgentRun activity, and no open AgentRun is
        // associated with this (item, generation). Any live evidence or
        // probe error fails CLOSED and keeps the skip; the item-level probe
        // runs once and protects every acking agent at once.
        const acks: string[] = Array.isArray(item.handoutAcks) ? item.handoutAcks : [];
        const ackTimes: string[] = Array.isArray(item.handoutAckTimes) ? item.handoutAckTimes : [];
        const ackedEntries = acks
          .map((entry, index) => ({ entry, index }))
          .filter(({ entry }) => {
            const parsed = parseAgentHandoutToken(entry);
            return parsed !== null && parsed.generation === item.generation;
          });
        // True when the flow below is reached via the #1419 acked-dead path
        // rather than the original #1211 unacknowledged path (notes differ).
        const ackedDead = ackedEntries.length > 0;
        if (ackedDead) {
          let anyLive = false;
          try {
            if (await attemptOpen(item.id, item.generation)) anyLive = true;
          } catch {
            // Fail-closed at the call site, not only inside the default
            // probes: an injected probe that throws is live evidence, never
            // permission to reclaim (#1419 review).
            anyLive = true;
          }
          if (!anyLive) {
            for (const { entry, index } of ackedEntries) {
              const parsed = parseAgentHandoutToken(entry);
              const agentName = parsed?.agentName ?? "";
              // Ack age: the parallel timestamp. A legacy ack that predates
              // #1419 has none, so it is dated by the dispatch stamp — an
              // ack cannot predate the hand-out that produced it, so
              // `dispatchedAt` is the ack-time lower bound; this keeps the
              // already-stranded legacy rows this issue targets recoverable
              // instead of failing closed forever. A row with neither a
              // timestamp nor a stamp cannot be dated at all and stays
              // protected. (The stampedThisGeneration check above already
              // required dispatchedAtMs, so it is non-null here.)
              const rawAckMs = Date.parse(ackTimes[index] ?? "");
              const ackTimeMs = Number.isNaN(rawAckMs) ? (dispatchedAtMs as number) : rawAckMs;
              if (!agentName || now.getTime() - ackTimeMs <= ackLivenessMs) {
                anyLive = true;
                break;
              }
              try {
                if (await agentLive(agentName, new Date(now.getTime() - ackLivenessMs))) {
                  anyLive = true;
                  break;
                }
              } catch {
                anyLive = true;
                break;
              }
            }
          }
          if (anyLive) {
            report.skipped++;
            continue;
          }
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
          const ackTimesBeforeStale: string[] = Array.isArray(item.handoutAckTimes) ? item.handoutAckTimes : [];
          const { count } = await client.$transaction(async (tx) => {
            const result = await tx.prFixQueueItem.updateMany({
              where: {
                id: item.id,
                generation: item.generation,
                status: "QUEUED",
                handoutAcks: { equals: acksBeforeStale },
                handoutAckTimes: { equals: ackTimesBeforeStale },
              },
              data: {
                status: "STALE",
                agentHandouts: [],
                externalWaitBy: null, // #1430: the wait this generation recorded died with these hand-out records
                handoutAcks: [],
                handoutAckTimes: [],
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
                  note: ackedDead
                    ? `Stale acknowledged hand-out: upstream PR is merged or closed; reaped to STALE (#1419).`
                    : `Stale unacknowledged hand-out: upstream PR is merged or closed; reaped to STALE (#1211).`,
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
          const ackTimesBeforeBlock: string[] = Array.isArray(item.handoutAckTimes) ? item.handoutAckTimes : [];
          const { count } = await client.$transaction(async (tx) => {
            const result = await tx.prFixQueueItem.updateMany({
              where: {
                id: item.id,
                generation: item.generation,
                status: "QUEUED",
                handoutAcks: { equals: acksBeforeBlock },
                handoutAckTimes: { equals: ackTimesBeforeBlock },
              },
              data: {
                status: "PARKED",
                // #1503: a park is bounded exhaustion, not a human decision,
                // and never a frontier demotion — keep the exclusive lane.
                lane: preserveEscalationLane(item.lane),
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
                externalWaitBy: null, // #1430: the wait this generation recorded died with these hand-out records
                handoutAcks: [],
                handoutAckTimes: [],
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
                  lane: preserveEscalationLane(item.lane),
                  outcome: "no_progress",
                  note: ackedDead
                    ? `Dead acknowledged hand-out reclaimed ${reclaimCount} times (PR_FIX_MAX_RECLAIMS=${maxReclaims}); parked (#1419).`
                    : `Hand-out reclaimed ${reclaimCount} times without acknowledgement (PR_FIX_MAX_RECLAIMS=${maxReclaims}); parked (#1211).`,
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
                latestNote: ackedDead
                  ? `Dead acknowledged hand-out reclaimed ${reclaimCount} times; parked (#1419).`
                  : `Reclaimed ${reclaimCount} times without acknowledgement; parked (#1211).`,
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
        const ackTimesBeforeReclaim: string[] = Array.isArray(item.handoutAckTimes) ? item.handoutAckTimes : [];
        const { count } = await client.$transaction(async (tx) => {
          const result = await tx.prFixQueueItem.updateMany({
            where: {
              id: item.id,
              generation: item.generation,
              status: "QUEUED",
              handoutAcks: { equals: acksBeforeReclaim },
              handoutAckTimes: { equals: ackTimesBeforeReclaim },
            },
            data: {
              ...freshAttemptGeneration(),
              handoutReclaims: { increment: 1 },
              agentHandouts: [],
              externalWaitBy: null, // #1430: the wait this generation recorded died with these hand-out records
              handoutAcks: [],
              handoutAckTimes: [],
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
                // The reclaim write does not touch `lane` — the row keeps its
                // lane (#1503: an ESCALATED fresh generation stays exclusive) —
                // so the audit row echoes the row's lane, not a literal.
                lane: item.lane,
                note: ackedDead
              ? `Stale acknowledged hand-out recovered: acking agent showed no liveness evidence; reopened as generation ${item.generation + 1} (#1419).`
              : `Stale unacknowledged hand-out reclaimed; reopened as generation ${item.generation + 1} (#1211).`,
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
