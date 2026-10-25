/**
 * Portable observability alert catalogue + pure evaluator (#1255).
 *
 * The executable form of the §6 alert catalogue of docs/observability.md.
 * Definitions are data — backend-neutral, with no PromQL, no scrape syntax and
 * no dashboard coupling — and `evaluateObservabilityAlerts` is a pure function
 * over an `ObservabilitySnapshot` (#1252) plus an optional carry-over state,
 * so a rule run of any backend (or none: this evaluator IS a consumer) can be
 * replayed deterministically against fixtures.
 *
 * Semantics locked by the design:
 * - `for` durations are honoured via the `prior` map: the evaluator is
 *   stateless, persistence is the caller's responsibility (Prometheus keeps
 *   its own `for` state; a script can thread the returned `since` values).
 * - Disabled rows never fire. A6 is the only disabled row: its aggregate
 *   ("assigned without execution") is nonzero under healthy churn (§8.7), so
 *   it must not alert; the age-tied evidence
 *   (`assignmentObservation.agedPastThreshold`) is still reported.
 * - Absent series is not zero: a never-successful sync is A2 firing, and the
 *   fresh-sync guard then suppresses A4 (A2-suppresses-A4, §8.3).
 * - Windowed gauges are as-of-scrape counts and are evaluated DIRECTLY —
 *   never via rate()/increase()/delta() (§4.1).
 * - Healthy idle is never a page (§6 "Normal inactivity must NOT alert").
 */
import type { ObservabilitySnapshot } from "@/lib/observability-signals";

// ─── Alert definitions (docs/observability.md §6) ───────────────────────────

export type ObservabilityAlertSeverity = "critical" | "warning" | "info";

export type ObservabilityAlertStateKind =
  | "firing"
  | "pending"
  | "ok"
  | "disabled"
  | "not_evaluable";

export interface ObservabilityAlertDefinition {
  id: string;
  title: string;
  /** Wiring contract: false rows document a known gap and must never fire. */
  enabled: boolean;
  severity: ObservabilityAlertSeverity;
  /** Minimum time the predicate must hold before firing; 0 for disabled rows. */
  forMs: number;
  /** One-line reason the alert is actionable (§6 "Why actionable"). */
  why: string;
  /** One-line operator response (§6 "Recovery / operator action"). */
  operatorAction: string;
}

export const OBSERVABILITY_ALERTS: readonly ObservabilityAlertDefinition[] = [
  {
    id: "A1",
    title: "Scheduler job overdue",
    enabled: true,
    severity: "critical",
    forMs: 10 * 60 * 1000,
    why: "Every queue is fed by these jobs; a stopped timer starves the loop silently.",
    operatorAction:
      "Inspect logs; restart/verify DISPATCH_SCHEDULER_ENABLED; a persistent stop is a real fault.",
  },
  {
    id: "A2",
    title: "No successful sync",
    enabled: true,
    severity: "critical",
    forMs: 5 * 60 * 1000,
    why: "Supply is stale or has never flowed; issues will not enter the queue.",
    operatorAction: "Check IssueSyncRun errors and GitHub reachability.",
  },
  {
    id: "A3",
    title: "Health/DB down",
    enabled: true,
    severity: "critical",
    forMs: 2 * 60 * 1000,
    why: "The service cannot serve work.",
    operatorAction:
      "Check DB connectivity; /api/health returns 503. Observed by the backend as a failed scrape (up == 0): a snapshot that exists implies health, so the evaluator only fires this from an explicit healthUp:false probe.",
  },
  {
    id: "A4",
    title: "Eligible work not handed out",
    enabled: true,
    severity: "warning",
    forMs: 30 * 60 * 1000,
    why: "Work exists, nothing is executing, nothing was picked up or reported, and the pipeline is healthy and fresh — supply is not reaching workers.",
    operatorAction:
      "Check worker availability/credentials; confirm next-task returns work; admission withholding routes to A10 instead.",
  },
  {
    id: "A5",
    title: "Stale ownership",
    enabled: true,
    severity: "warning",
    forMs: 15 * 60 * 1000,
    why: "Ownership is lost; the issue may be stuck in-progress.",
    operatorAction:
      "The stale sweep releases it; if it persists, inspect the sweep job (A1).",
  },
  {
    id: "A6",
    title: "Assigned without execution",
    enabled: false,
    severity: "info",
    forMs: 0,
    why: "Pinned future gap: firing on the aggregate would misreport healthy churn (§8.7); per-item age evidence exists only for audit-visible assignments.",
    operatorAction:
      "Verify the worker polls its lane; check admission withholding. Never wire the aggregate into an evaluator.",
  },
  {
    id: "A7",
    title: "Unacknowledged hand-outs (overdue)",
    enabled: true,
    severity: "warning",
    forMs: 35 * 60 * 1000,
    why: "A worker may have died before materializing its run; the item is stranded past the configured hand-out timeout.",
    operatorAction: "Reclaim sweep (pr-fix-sweep, default-disabled) or operator requeue.",
  },
  {
    id: "A8",
    title: "PR-fix head-of-line",
    enabled: true,
    severity: "warning",
    forMs: 30 * 60 * 1000,
    why: "Work is queued but not draining.",
    operatorAction: "Check worker concurrency, lane routing, and fixAttempts saturation.",
  },
  {
    id: "A9",
    title: "Human decisions piling up",
    enabled: true,
    severity: "info",
    forMs: 60 * 60 * 1000,
    why: "A person must decide; PARKED is excluded so this is real.",
    operatorAction: "Review the BLOCKED item's decision context and act.",
  },
  {
    id: "A10",
    title: "Admission withholding",
    enabled: true,
    severity: "warning",
    forMs: 60 * 60 * 1000,
    why: "The admission gate is starving the queue on missing/stale grooming.",
    operatorAction:
      "Fix the grooming pipeline; or a per-issue operator admission override.",
  },
  {
    id: "A11",
    title: "Grooming backoff",
    enabled: true,
    severity: "warning",
    forMs: 30 * 60 * 1000,
    why: "Upstream GitHub reads are failing; issues cannot be groomed.",
    operatorAction: "Check GitHub reachability/rate limits.",
  },
  {
    id: "A12",
    title: "Audit failures",
    enabled: true,
    severity: "warning",
    forMs: 5 * 60 * 1000,
    why: "Mutations are failing (labels/claims). The as-of-scrape 15-minute windowed gauge is evaluated DIRECTLY: a delta() over the rolling count could read zero when an old failure expires as a new one arrives (§4.1).",
    operatorAction:
      "Inspect AuditLog.errorMessage for the action; do not label by error string.",
  },
  {
    id: "A13",
    title: "Upstream evidence unavailable",
    enabled: true,
    severity: "warning",
    forMs: 15 * 60 * 1000,
    why: "Admission/settlement decisions lack current evidence; the forge could not be read.",
    operatorAction:
      "Check GitHub reachability/rate limits; treat unknown as unknown, never healthy.",
  },
];

export const OBSERVABILITY_ALERTS_BY_ID: ReadonlyMap<string, ObservabilityAlertDefinition> =
  new Map(OBSERVABILITY_ALERTS.map((a) => [a.id, a]));

// ─── Evaluation ──────────────────────────────────────────────────────────────

export interface ObservabilityAlertThresholds {
  /** A8: oldest queued PR-fix item age past which the head of line alerts. */
  headOfLineWarningSeconds: number;
  /** A9: oldest BLOCKED (human-decision) age past which piling-up alerts. */
  humanDecisionWarningSeconds: number;
  /** A13: per-repo sync staleness past which upstream evidence is unavailable. */
  repoStaleSyncSeconds: number;
}

export interface EvaluateObservabilityAlertsOptions {
  /** Evaluation time; defaults to the snapshot's own generatedAt. */
  now?: Date;
  /**
   * Carry-over state: alert id → ISO timestamp of when the predicate was
   * first observed holding. Thread the `since` values of a previous result
   * to make `for` durations meaningful across evaluations.
   *
   * Known divergence from series-scoped rule engines: the map is keyed by
   * alert id, so a dimensioned predicate (A1 is per scheduler job in
   * Prometheus) collapses to "any dimension qualifies" — one overdue job
   * satisfies the whole row's `for`. A consumer wanting per-dimension
   * persistence should key its own carry-over per dimension and evaluate per
   * dimension; this evaluator reports the row-level truth only.
   */
  prior?: Record<string, string>;
  thresholds?: Partial<ObservabilityAlertThresholds>;
  /**
   * Liveness probe result for A3. A snapshot can only exist when Dispatch
   * answered with a healthy database, so the default is true; pass false to
   * replay a failed-probe fixture.
   */
  healthUp?: boolean;
}

export interface ObservabilityAlertState {
  id: string;
  title: string;
  severity: ObservabilityAlertSeverity;
  enabled: boolean;
  forMs: number;
  state: ObservabilityAlertStateKind;
  /**
   * Whether the raw predicate holds at this evaluation — false also when the
   * row is not evaluable (there is no raw value to report).
   */
  predicateHolds: boolean;
  /** ISO timestamp the predicate has held since (pending/firing), else null. */
  since: string | null;
}

function sumValues(map: Record<string, number> | undefined): number {
  if (!map) return 0;
  let total = 0;
  for (const value of Object.values(map)) total += value;
  return total;
}

/** Raw §6 predicate per alert, over snapshot gauges only. */
function predicate(
  id: string,
  snapshot: ObservabilitySnapshot,
  thresholds: ObservabilityAlertThresholds,
  healthUp: boolean,
): { holds: boolean; evaluable: boolean } {
  const sync = snapshot.pipeline.sync;
  const syncIntervalSeconds = snapshot.config.syncIntervalMs / 1000;
  const freshSyncWindowSeconds = syncIntervalSeconds * 2;
  const schedulerHealthy =
    snapshot.pipeline.scheduler.enabled && snapshot.pipeline.scheduler.overdueJobs === 0;
  const syncFresh =
    sync.everSucceeded &&
    sync.secondsSinceLastSuccess !== null &&
    syncIntervalSeconds > 0 &&
    sync.secondsSinceLastSuccess <= freshSyncWindowSeconds;

  switch (id) {
    case "A1":
      if (!snapshot.pipeline.scheduler.enabled) return { holds: false, evaluable: false };
      return { holds: snapshot.pipeline.scheduler.jobs.some((j) => j.overdue === 1), evaluable: true };
    case "A2": {
      // Absent series (never a completed sync) IS the firing case — never
      // coerced to "ok" (§6 A2). Both guards are operator opt-outs, not
      // faults: an unarmed scheduler, or a disabled sync job, means the
      // pipeline should not have run and the row is not evaluable (a default
      // deployment has the scheduler off while the sync interval stays at its
      // default, so `syncIntervalMs` alone is the wrong guard).
      if (!snapshot.pipeline.scheduler.enabled) {
        return { holds: false, evaluable: false };
      }
      if (snapshot.config.syncIntervalMs === 0 && !sync.everSucceeded) {
        return { holds: false, evaluable: false };
      }
      if (!sync.everSucceeded) return { holds: true, evaluable: true };
      if (syncIntervalSeconds === 0) return { holds: false, evaluable: false };
      return {
        holds: sync.secondsSinceLastSuccess !== null && sync.secondsSinceLastSuccess > freshSyncWindowSeconds,
        evaluable: true,
      };
    }
    case "A3":
      return { holds: !healthUp, evaluable: true };
    case "A4": {
      // Guards make the row not-evaluable rather than silently false:
      // an unarmed scheduler (or an unevaluable fresh-sync guard) means the
      // conjunction cannot be decided (mirrors signals.ts eligibleWorkNotHandedOut).
      if (!snapshot.pipeline.scheduler.enabled) return { holds: false, evaluable: false };
      if (syncIntervalSeconds === 0 && sync.everSucceeded) {
        return { holds: false, evaluable: false };
      }
      return {
        holds:
          snapshot.workSupply.openClaimable > 0 &&
          snapshot.execution.executionActive === 0 &&
          (snapshot.execution.pickupsInWindow["1800"] ?? 0) === 0 &&
          (snapshot.execution.reportedInWindow["1800"] ?? 0) === 0 &&
          schedulerHealthy &&
          syncFresh,
        evaluable: true,
      };
    }
    case "A5":
      return {
        holds:
          snapshot.execution.expiredLeases > 0 ||
          (snapshot.execution.agentWorkByState["STALE"] ?? 0) > 0,
        evaluable: true,
      };
    case "A6":
      // Never fires on the aggregate (§8.7). The predicate reported here is
      // the age-tied EVIDENCE (known-age assignments past threshold), which is
      // surfaced for humans but can never arm the alert.
      return { holds: snapshot.assignmentObservation.agedPastThreshold > 0, evaluable: true };
    case "A7":
      return { holds: snapshot.prFix.handouts.overdueUnacked > 0, evaluable: true };
    case "A8":
      return {
        holds:
          snapshot.prFix.oldestQueuedAgeSeconds !== null &&
          snapshot.prFix.oldestQueuedAgeSeconds > thresholds.headOfLineWarningSeconds,
        evaluable: true,
      };
    case "A9":
      return {
        holds:
          snapshot.prFix.settlement.humanDecisionsBlocked > 0 &&
          snapshot.prFix.settlement.oldestHumanDecisionAgeSeconds !== null &&
          snapshot.prFix.settlement.oldestHumanDecisionAgeSeconds >
            thresholds.humanDecisionWarningSeconds,
        evaluable: true,
      };
    case "A10":
      if (snapshot.admission.notAdmitted === null) {
        return { holds: false, evaluable: false };
      }
      return {
        holds:
          (snapshot.admission.notAdmitted.byReason["grooming_unknown"] ?? 0) > 0 ||
          (snapshot.admission.notAdmitted.byReason["grooming_stale"] ?? 0) > 0,
        evaluable: true,
      };
    case "A11":
      return { holds: snapshot.grooming.backoff > 0, evaluable: true };
    case "A12":
      // Direct evaluation of the as-of-scrape windowed gauge (§4.1) — the
      // count is recomputed by Dispatch at scrape time, so "> 0 now" is the
      // entire predicate. rate()/increase()/delta() would be unsound here.
      return {
        holds: sumValues(snapshot.failures.auditFailuresInWindowByAction["900"]) > 0,
        evaluable: true,
      };
    case "A13": {
      const repoStale =
        snapshot.pipeline.maxRepoStaleSyncSeconds !== null &&
        snapshot.pipeline.maxRepoStaleSyncSeconds > thresholds.repoStaleSyncSeconds;
      return { holds: repoStale || snapshot.grooming.backoff > 0, evaluable: true };
    }
    default:
      return { holds: false, evaluable: false };
  }
}

/**
 * Evaluate the full catalogue against one snapshot. Pure: same inputs give
 * the same states, so fixtures replay deterministically and the function is
 * safe to run from any backend, cron, or test.
 */
export function evaluateObservabilityAlerts(
  snapshot: ObservabilitySnapshot,
  options: EvaluateObservabilityAlertsOptions = {},
): ObservabilityAlertState[] {
  const now = options.now ?? new Date(snapshot.generatedAt);
  const thresholds: ObservabilityAlertThresholds = {
    headOfLineWarningSeconds: 3600,
    humanDecisionWarningSeconds: 3600,
    repoStaleSyncSeconds:
      snapshot.config.syncIntervalMs > 0 ? (snapshot.config.syncIntervalMs / 1000) * 2 : 3600,
    ...options.thresholds,
  };
  const healthUp = options.healthUp ?? true;
  const prior = options.prior ?? {};

  return OBSERVABILITY_ALERTS.map((definition) => {
    const base = {
      id: definition.id,
      title: definition.title,
      severity: definition.severity,
      enabled: definition.enabled,
      forMs: definition.forMs,
    };
    if (!definition.enabled) {
      const { holds } = predicate(definition.id, snapshot, thresholds, healthUp);
      return { ...base, state: "disabled" as const, predicateHolds: holds, since: null };
    }
    const { holds, evaluable } = predicate(definition.id, snapshot, thresholds, healthUp);
    if (!evaluable) {
      return { ...base, state: "not_evaluable" as const, predicateHolds: false, since: null };
    }
    if (!holds) {
      return { ...base, state: "ok" as const, predicateHolds: false, since: null };
    }
    const priorSince = prior[definition.id];
    const priorMs = priorSince !== undefined ? Date.parse(priorSince) : NaN;
    // Clamp a future-dated carry-over (clock skew, bad state) to now: treat
    // it as a fresh first observation rather than a negative hold time.
    if (Number.isFinite(priorMs) && priorMs <= now.getTime()) {
      const heldFor = now.getTime() - priorMs;
      if (heldFor >= definition.forMs) {
        return { ...base, state: "firing" as const, predicateHolds: true, since: priorSince };
      }
      return {
        ...base,
        state: "pending" as const,
        predicateHolds: true,
        since: new Date(priorMs).toISOString(),
      };
    }
    return { ...base, state: "pending" as const, predicateHolds: true, since: now.toISOString() };
  });
}
