import { Prisma } from "@prisma/client";
import { evaluateExternalWaitTrigger, parseStoredExternalWait } from "../pr-fix-external-wait";
import { type PrFixQueueClient } from "./client";
import { freshAttemptGeneration } from "./handout";

/**
 * Consecutive-stagnation budget (#1543): bounds how many attempts in a row
 * may end WITHOUT authoritative progress before the item parks instead of
 * re-queueing. Progress is proven only from durable source state — the
 * observed PR head advancing past the attempt's baseline — never from worker
 * or model assertion. Replaces the retired lifetime `PR_FIX_MAX_ATTEMPTS`
 * cap (#1001), which parked healthy head-advancing loops at an arbitrary
 * round count. Overridable via PR_FIX_MAX_STAGNATION; defaults to 5.
 */
export function maxPrFixStagnation(): number {
  const n = Number(process.env.PR_FIX_MAX_STAGNATION);
  return Number.isInteger(n) && n > 0 ? n : 5;
}

/**
 * Authoritative progress predicate (#1543): the attempt made progress when
 * the observed PR head advanced past the attempt's baseline. Both heads must
 * be known (non-empty after trim/lowercase normalization, and never the
 * literal "unknown" placeholder) and must differ; an unknown head can never
 * prove progress (fail-closed: it consumes stagnation budget instead).
 */
export function attemptHeadAdvanced(observedHead?: string | null, baselineHead?: string | null): boolean {
  const observed = String(observedHead ?? "").trim().toLowerCase();
  const baseline = String(baselineHead ?? "").trim().toLowerCase();
  if (!observed || !baseline) return false;
  if (observed === "unknown" || baseline === "unknown") return false;
  return observed !== baseline;
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

export async function reactivateDueExternalWaits(client: PrFixQueueClient, now: Date): Promise<void> {
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
          data: { status: "QUEUED", ...freshAttemptGeneration(), retryAt: null, dispatchedGeneration: null, dispatchedAt: null, postDispatchEvidenceKeys: [], attemptHeadSha: row.headSha ?? row.attemptHeadSha ?? null, outcome: null, decisionDetail: null, agentHandouts: [], handoutAcks: [], handoutAckTimes: [], handoutReceipts: [], externalWaitBy: null, externalWait: Prisma.DbNull },
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
          externalWaitBy: null, // #1430: the wait this generation recorded died with these hand-out records
          handoutAcks: [],
          handoutAckTimes: [],
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
