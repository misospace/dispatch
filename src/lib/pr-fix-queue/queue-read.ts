import { normalizePrFixLane, normalizePrFixType, PR_FIX_TYPE_PRIORITY } from "@/types";
import { fetchPullRequestHeadSha } from "../github-prs";
import { parseStoredExternalWait } from "../pr-fix-external-wait";
import { claimantIsHumanOwned, prFixOwnershipEvidence } from "../pr-fix-ownership";
import { type PrFixQueueClient } from "./client";
import { prFixWorkerAgentIdentitySet } from "./handout-ownership";
import { reactivateDueExternalWaits } from "./external-wait";

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

  // #1615: derived HUMAN-OWNED classification, surfaced additively on every
  // listed row. A claimant established by a label or PR authorship that is
  // outside the declared PR-fix worker identity space (`DISPATCH_PR_FIX_AGENTS`)
  // is the operator/UI queue's "claimed by human" signal: the item belongs
  // to that human and the hand-out gate refuses it, so it must be visible as
  // human-owned instead of park-looping through offers no connector accepts.
  // Inert while the identity space is undeclared (empty set → always false).
  //
  // #1623: `claimantAmbiguous` surfaces the other unresolved provenance the
  // gate refuses unconditionally — sources that conflicted (e.g. several
  // distinct `agent/*` labels on the cached issue). A QUEUED row with this
  // flag never gets a hand-out, so it must display as blocked-with-reason
  // instead of looking like work any poller could pick up.
  const workerAgents = prFixWorkerAgentIdentitySet();
  for (const item of items) {
    const evidence = prFixOwnershipEvidence(item);
    item.humanOwned = claimantIsHumanOwned(evidence, workerAgents);
    item.claimantAmbiguous = evidence.provenance === "ambiguous";
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
 * "Live" follows the queue's actual ownership semantics, NOT a clock: a
 * non-empty `agentHandouts` list on a still-QUEUED row gates the lane until
 * the record is explicitly cleared — settlement (mark/release/terminal
 * dispositions clear the hand-outs or move the row out of QUEUED), or the
 * reclaim sweep, which is the ONLY path that ages a hand-out out
 * (`PR_FIX_HANDOUT_TIMEOUT_MS` bounds the sweep's staleness population, not
 * this gate): a stale UNACKNOWLEDGED hand-out is reclaimed with a generation
 * bump that clears the hand-out state, at which point the lane is free. An
 * ACKNOWLEDGED hand-out is deliberately never reclaimed (#1211 — the worker
 * durably owns its generation) and gates until it settles; an
 * acked-then-crashed rebase therefore holds the lane until the worker
 * reports or an operator requeues. That is deliberate fail-safe behavior: a
 * visibly stuck lane is recoverable, a silently shared lane is two
 * `--force-with-lease` pushes on one branch. The previous time-boxed gate
 * freed the lane under a still-live hand-out once the timeout passed — a
 * concurrency-2 window the queue's ownership model does not license.
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
 * remaining best-effort window is the anomalous no-`dispatchedAt` hand-out
 * below, not an admission path.
 */
export async function hasInFlightRebaseHandout(
  client: PrFixQueueClient,
): Promise<boolean> {
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
    // never matches NULL), so counting it live would block the lane with no
    // recovery path at all. Skip it instead: the worst case is the transient
    // concurrency-2 window the lane already accepts best-effort.
    return Boolean(row.dispatchedAt);
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
