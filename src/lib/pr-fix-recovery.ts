/**
 * Evidence-driven recovery decisions for dispositioned PR-fix items (#1253).
 *
 * This module is THE single transition decision for reactivating a
 * non-QUEUED item on fresh actionable evidence. It is pure: no Prisma, no
 * network, no clock reads — every input (including `now`) is supplied by the
 * caller, so the enqueue path can re-derive the same decision from a fresh
 * row snapshot inside the #1134 pinned-write loop.
 *
 * It implements the state-transition rows of
 * docs/pr-fix-recovery-policy.md that concern dispositions evidence must
 * NOT silently override (rows 8-16). `FIXED` is deliberately OUT of scope:
 * rows 5-7 reopen through the enqueue paths' existing #940 net and
 * new-evidence reopen, and that behavior is unchanged by #1253. STALE and
 * IGNORED are accepted for completeness (they must hold — row 19) but the
 * enqueue path keeps them sticky inline and does not route them here.
 *
 * Design rows implemented here:
 * - row 8  — PARKED/no_progress, budget available: reactivates on fresh
 *   actionable evidence after `PR_FIX_RECOVERY_COOLDOWN_MS`, charged
 *   (counts as a fresh attempt; the caller increments).
 * - row 9  — PARKED budget-exhausted: holds, flags the stale disposition;
 *   prevents livelock (the park was CREATED by the cap — auto-reopening
 *   would only re-park). Operator requeue resets the budget.
 * - row 10 — PARKED/infra_failure (fail-closed): holds, flags on fresh
 *   evidence. Infra recovery is not PR evidence.
 * - row 11 — PARKED/security_failure (fail-closed): holds, flags on fresh
 *   evidence. Operator only.
 * - row 12 — WAITING_EXTERNAL with a recorded recovery trigger is NOT
 *   decided here: trigger-fired rechecks are uncharged and live in
 *   `reconcileExternalWaitTriggers` (pr-fix-queue.ts). This module only
 *   handles row 13.
 * - row 13 — WAITING_EXTERNAL (structured contract): reactivates on fresh
 *   actionable feedback, charged, independent of any cooldown — fresh
 *   feedback is new work, not a dependency resolution.
 * - row 16 — BLOCKED/human_decision: holds; fresh evidence is surfaced as
 *   a stale disposition, never a reopen.
 * - row 19 — STALE/IGNORED: terminal; hold, never flag, operator-only.
 *
 * Negative controls honored (design doc):
 * - control 6/7 — a budget-available park reopens (consuming an attempt,
 *   bounded by the cap); a cap-exhausted park never reopens and never
 *   bumps a generation.
 * - control 13 — no amount of automatic evidence overrides a human hold.
 * - duplicate / non-actionable evidence (`freshEvidence = false`) holds
 *   everywhere and never flags: replays are inert (controls 1/2/8).
 * - legacy/unparseable external waits hold without flagging (fail-closed
 *   per #1250: flagged for operators, never auto-downgraded or
 *   auto-requeued in bulk).
 *
 * The `staleDisposition` flag the hold rows set only SURFACES evidence to
 * operators; it never reopens anything by itself and is cleared on the
 * next reactivation or operator requeue.
 */

/** Dispositioned statuses the recovery decision consumes. */
export type RecoveryStatus = "BLOCKED" | "PARKED" | "WAITING_EXTERNAL" | "STALE" | "IGNORED";

/**
 * Remaining reactivation budget of a PARKED row (#1253):
 * - `fail-closed` — infra/security/invalid_wait park; PR evidence must
 *   never reopen it. The three fail-closed outcomes are `infra_failure`
 *   and `security_failure` (operator-investigated operational failures)
 *   and `invalid_wait` (the #1250 fail-closed downgrade of a
 *   dependency-less external wait: "PARKED, not reactivatable by
 *   evidence... operator requeue required", negative control 16).
 * - `exhausted`   — the park was created by the attempt/reclaim cap.
 * - `available`   — an operational park with budget left (e.g. a bare
 *   `blocked`-report park that did not consume the cap).
 * Non-PARKED statuses read as `available` (the class is only meaningful
 * for PARKED; the function stays PARKED-shaped by contract).
 */
export type ParkBudgetClass = "exhausted" | "available" | "fail-closed";

/** The single recovery decision an enqueue pass applies to a snapshot. */
export interface RecoveryDecision {
  action: "reactivate" | "hold";
  /** Reactivation opens a fresh attempt and consumes retry budget. */
  charged: boolean;
  /** Set `staleDisposition: true` on the (still-held) row. */
  setStaleDisposition: boolean;
  /** Clear `retryAt` on reactivation (a stale recheck deadline is dead). */
  clearRetryAt: boolean;
  /** Clear the structured external-wait contract on reactivation. */
  clearExternalWait: boolean;
  /** Clear `outcome`/`decisionDetail` on reactivation. */
  clearOutcome: boolean;
  /** Operator- and history-facing rationale (written to PrFixHistory). */
  reason: string;
}

export const DEFAULT_PR_FIX_RECOVERY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const MIN_RECOVERY_COOLDOWN_MS = 60_000;
const MAX_RECOVERY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cooldown between evidence-driven reactivations of an operational hold
 * (#1253), matching the `externalWaitCooldownMs` env convention: integer
 * milliseconds, clamped 1 minute..7 days, default 6 hours (the same default
 * as the external-wait cooldown).
 */
export function recoveryCooldownMs(): number {
  const n = Number(process.env.PR_FIX_RECOVERY_COOLDOWN_MS);
  return Number.isInteger(n) && n >= MIN_RECOVERY_COOLDOWN_MS && n <= MAX_RECOVERY_COOLDOWN_MS
    ? n
    : DEFAULT_PR_FIX_RECOVERY_COOLDOWN_MS;
}

const FAIL_CLOSED_PARK_OUTCOMES = new Set(["infra_failure", "security_failure", "invalid_wait"]);

/**
 * Classify a PARKED row's remaining reactivation budget (#1253). The
 * outcome decides fail-closed BEFORE the caps: an infra/security park and
 * the #1250 `invalid_wait` downgrade park are never evidence-reactivatable
 * regardless of budget. Budget-exhausted means `fixAttempts >= maxAttempts`
 * OR `handoutReclaims >= maxReclaims` — the same caps that CREATE
 * no_progress parks.
 */
export function classifyParkedBudget(
  item: { status: string; outcome?: string | null; fixAttempts?: number | null; handoutReclaims?: number | null },
  maxAttempts: number,
  maxReclaims: number,
): ParkBudgetClass {
  if (item.status !== "PARKED") return "available";
  if (FAIL_CLOSED_PARK_OUTCOMES.has(item.outcome ?? "")) return "fail-closed";
  const attempts = item.fixAttempts ?? 0;
  const reclaims = item.handoutReclaims ?? 0;
  if (attempts >= maxAttempts || reclaims >= maxReclaims) return "exhausted";
  return "available";
}

export interface RecoveryEvaluationInput {
  status: RecoveryStatus;
  outcome?: string | null;
  fixAttempts?: number | null;
  handoutReclaims?: number | null;
  /** A parsed, valid structured external-wait contract exists (only meaningful for WAITING_EXTERNAL). */
  hasValidExternalWait: boolean;
  /**
   * Caller-computed freshness: the observation is a NEW actionable ledger
   * transition (`!isKnownEvidence && input.evidenceActionable !== false` in
   * enqueue terms). The durable ledger + watermark (#1249) decide this —
   * never timestamps on this row.
   */
  freshEvidence: boolean;
  /**
   * Whether the observation carries durable-ledger provenance (#1249):
   * `ledgerView.records` in enqueue terms — the caller actually recorded a
   * ledger row for this observation. A REACTIVATION decision requires it
   * (control 8: an evicted replay must never mint a reactivation without a
   * durable transition); the HOLD + stale-flag rows keep working on the
   * pre-#1249 cache semantics so a legacy caller can still surface evidence
   * — it just cannot mint a reactivation without a ledger record.
   */
  ledgerProvenance: boolean;
  now: Date;
  /** Audit stamp of when the CURRENT disposition was recorded. */
  disposedAt?: Date | string | null;
  /** Cooldown timestamp of the LAST reactivation, when one happened. */
  recoveryAppliedAt?: Date | string | null;
  maxAttempts: number;
  maxReclaims: number;
  cooldownMs: number;
}

const HOLD = (reason: string, setStaleDisposition = false): RecoveryDecision => ({
  action: "hold",
  charged: false,
  setStaleDisposition,
  clearRetryAt: false,
  clearExternalWait: false,
  clearOutcome: false,
  reason,
});

const REACTIVATE = (reason: string): RecoveryDecision => ({
  action: "reactivate",
  charged: true,
  setStaleDisposition: false,
  clearRetryAt: true,
  clearExternalWait: true,
  clearOutcome: true,
  reason,
});

const ms = (value: Date | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Decide whether a dispositioned item reactivates on the observation the
 * caller is enqueueing. See the module header for the row-by-row contract.
 *
 * Cooldown anchor (row 8): the LATEST of `recoveryAppliedAt` and
 * `disposedAt` that exists (epoch-0 when neither does). The max matters
 * across cycles: a reactivation stamps `recoveryAppliedAt` and a later
 * re-park writes a fresh `disposedAt` while the old `recoveryAppliedAt`
 * survives — anchoring on the older timestamp would let the survived stamp
 * short-circuit the fresh park's cooldown and reopen in a tight loop.
 * Anchoring on the latest hold timestamp means every new disposition
 * re-arms the cooldown. A row that was never reactivated and carries no
 * disposition stamp has no recorded hold time — there is nothing to pace —
 * so it is eligible immediately: legacy rows (pre-#1253) must not be
 * stranded forever by a missing stamp, and budget/attempt caps still bound
 * the resulting cycle. Duplicate sticky re-marks (which do not restamp)
 * cannot keep deferring a due reactivation.
 *
 * Reactivation additionally requires `ledgerProvenance` (control 8): an
 * observation without a durable ledger record cannot mint a reactivation —
 * it downgrades to an unflagged hold (unknown provenance, the evidence is
 * unverified), while HOLD + stale-flag rows keep surfacing evidence on the
 * pre-#1249 cache semantics.
 */
export function evaluateRecovery(input: RecoveryEvaluationInput): RecoveryDecision {
  const decision = decideRecovery(input);
  if (decision.action === "reactivate" && !input.ledgerProvenance) {
    return HOLD(
      "Fresh actionable evidence arrived but carries no durable ledger provenance; the disposition holds until a ledger transition records the observation (#1253, control 8).",
    );
  }
  return decision;
}

function decideRecovery(input: RecoveryEvaluationInput): RecoveryDecision {
  const { status, freshEvidence } = input;

  // Rows 19: terminal states are inert to evidence. Operator-only.
  if (status === "STALE" || status === "IGNORED") {
    return HOLD(`terminal ${status} item never reactivates on evidence; operator mark to QUEUED only (#1253, row 19)`);
  }

  // Row 16: a human decision is never overridden. Newer evidence is only
  // surfaced, via the stale-disposition flag.
  if (status === "BLOCKED") {
    if (!freshEvidence) return HOLD("duplicate evidence on a BLOCKED (human-decision) hold is inert (#1253, row 16)");
    return HOLD(
      "Fresh actionable evidence arrived while BLOCKED (human hold); surfaced as a stale disposition, not reopened (#1253).",
      true,
    );
  }

  // Row 13 with the #1250 fail-closed carve-out: a WAITING_EXTERNAL row
  // without a valid structured contract is a legacy wait — hold, no flag
  // (operators see it via the `legacyWait` surfacing, never a bulk action).
  if (status === "WAITING_EXTERNAL") {
    if (!input.hasValidExternalWait) {
      return HOLD("legacy external wait without a structured contract holds for operator action; never auto-requeued (#1250, #1253)");
    }
    if (!freshEvidence) return HOLD("duplicate evidence during a structured external wait is inert (#1253, row 15)");
    return REACTIVATE(
      "Reactivated on fresh actionable feedback during the external wait; the dependency is re-checked on the fresh attempt (#1253).",
    );
  }

  // status === "PARKED": rows 8-11, keyed on budget class.
  const budget = classifyParkedBudget(input, input.maxAttempts, input.maxReclaims);
  if (budget === "fail-closed") {
    const kind = input.outcome ?? "infra_failure";
    if (!freshEvidence) return HOLD(`duplicate evidence on a fail-closed ${kind} park is inert (#1253, rows 10/11)`);
    return HOLD(
      `Fresh actionable evidence arrived while PARKED (${kind}, fail-closed); surfaced as a stale disposition, not reopened (#1253).`,
      true,
    );
  }
  if (budget === "exhausted") {
    if (!freshEvidence) return HOLD("duplicate evidence on a budget-exhausted PARKED hold is inert (#1253, row 9)");
    return HOLD(
      "Fresh actionable evidence arrived while PARKED (budget exhausted); surfaced as a stale disposition, not reopened — operator requeue resets the budget (#1253).",
      true,
    );
  }
  // Budget available (row 8).
  if (!freshEvidence) return HOLD("duplicate evidence on a budget-available PARKED hold is inert (#1253, row 8)");
  // Cooldown anchor: the LATEST hold timestamp that exists — a re-park's
  // fresh `disposedAt` re-arms the cooldown even though `recoveryAppliedAt`
  // survives from the previous reactivation cycle (see the JSDoc).
  const anchors = [ms(input.recoveryAppliedAt), ms(input.disposedAt)].filter(
    (t): t is number => t !== null,
  );
  const anchor = anchors.length > 0 ? Math.max(...anchors) : 0;
  if (input.now.getTime() - anchor < input.cooldownMs) {
    return HOLD(
      "Fresh actionable evidence arrived while PARKED (budget available) but the recovery cooldown has not elapsed (#1253, row 8).",
    );
  }
  return REACTIVATE(
    "Reactivated on fresh actionable evidence after the recovery cooldown (#1253).",
  );
}
