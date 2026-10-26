/**
 * Opt-in Prometheus text-exposition exporter (#1255).
 *
 * Renders the #1252 snapshot — the bounded signal catalogue of
 * docs/observability.md — as Prometheus text format 0.0.4, so any
 * Prometheus-compatible backend (Prometheus, VictoriaMetrics, vmagent) can
 * scrape it. Pure: one snapshot in, one deterministic document out. No labels
 * outside the catalogue allowlists ever appear (§9): no repository names,
 * issue/PR numbers, agent identities, or error strings.
 *
 * Modelling rules (§4.1):
 * - Every series is a gauge. Windowed values are as-of-scrape counts over the
 *   fixed `window` label (seconds); consumers evaluate them directly —
 *   rate()/increase()/delta() are unsound over non-monotonic series.
 * - Absent baselines stay absent: a null age omits its series, and a
 *   never-successful sync omits `dispatch_sync_last_success_timestamp_seconds`
 *   entirely — the absent series is load-bearing for A2 (§6).
 * - `dispatch_health_up` is 1 whenever this document exists: the collector
 *   needs the database to answer, so a failed scrape (backend `up == 0`) is
 *   the down signal and an absent series is never coerced to healthy.
 * - A family with no samples emits nothing (no HELP/TYPE, no series); the
 *   full contract lives in `observabilityMetricFamilies()`.
 */
import type { ObservabilitySnapshot } from "@/lib/observability-signals";
import { SYNC_PIPELINE_STATES } from "@/lib/sync-pipeline";

const ADMISSION_MODES = ["off", "audit", "enforce"] as const;

interface Sample {
  labels: Array<[string, string]>;
  value: number;
}

interface Family {
  name: string;
  help: string;
  samples: Sample[];
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function escapeHelp(help: string): string {
  return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function formatValue(value: number): string {
  return String(value);
}

function renderSample(name: string, sample: Sample): string {
  if (sample.labels.length === 0) return `${name} ${formatValue(sample.value)}`;
  const labels = sample.labels
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(",");
  return `${name}{${labels}} ${formatValue(sample.value)}`;
}

function family(name: string, help: string, samples: Sample[]): Family | null {
  if (samples.length === 0) return null;
  // Deterministic output: stable sort samples by their rendered label set.
  const sorted = [...samples].sort((a, b) =>
    JSON.stringify(a.labels) < JSON.stringify(b.labels) ? -1 : 1,
  );
  return { name, help, samples: sorted };
}

function scalar(name: string, help: string, value: number | null | undefined): Family | null {
  if (value === null || value === undefined) return null;
  return family(name, help, [{ labels: [], value }]);
}

function byDimension(
  name: string,
  help: string,
  counts: Record<string, number>,
  label: string,
): Family | null {
  return family(
    name,
    help,
    Object.entries(counts).map(([value, count]) => ({ labels: [[label, value] as [string, string]], value: count })),
  );
}

function windowed(
  name: string,
  help: string,
  counts: Record<string, number>,
): Family | null {
  return family(
    name,
    help,
    Object.entries(counts).map(([window, count]) => ({
      labels: [["window", window] as [string, string]],
      value: count,
    })),
  );
}

function windowedByDimension(
  name: string,
  help: string,
  windowed: Record<string, Record<string, number>>,
  label: string,
): Family | null {
  const samples: Sample[] = [];
  for (const [window, counts] of Object.entries(windowed)) {
    for (const [value, count] of Object.entries(counts)) {
      samples.push({
        labels: [
          [label, value],
          ["window", window],
        ],
        value: count,
      });
    }
  }
  return family(name, help, samples);
}

/**
 * The exporter's metric-family contract: every family the exposition may
 * carry, in render order. Consumers (and the asset drift test) match rule and
 * dashboard queries against this list.
 */
export function observabilityMetricFamilies(): string[] {
  return [
    "dispatch_audit_failures_in_window",
    "dispatch_dependency_blocked",
    "dispatch_agent_run_failures_in_window",
    "dispatch_agent_runs_reported_in_window",
    "dispatch_agent_runs_started_in_window",
    "dispatch_agent_work",
    "dispatch_agent_work_heartbeat_age_seconds",
    "dispatch_agent_work_release_pending",
    "dispatch_assigned_without_execution",
    "dispatch_assignment_age_known",
    "dispatch_assignment_age_unknown",
    "dispatch_assignment_aged_past_threshold",
    "dispatch_assignment_evidence_lookback_seconds",
    "dispatch_assignment_oldest_known_age_seconds",
    "dispatch_grooming_backoff",
    "dispatch_grooming_freshness",
    "dispatch_grooming_last_success_timestamp_seconds",
    "dispatch_grooming_runs_in_window",
    "dispatch_grooming_stale_reasons",
    "dispatch_grooming_stall_threshold_seconds",
    "dispatch_health_up",
    "dispatch_issue_assigned",
    "dispatch_issue_oldest_open_claimable_age_seconds",
    "dispatch_issue_stale_sync_seconds",
    "dispatch_issues",
    "dispatch_issues_lane",
    "dispatch_issues_open_claimable",
    "dispatch_leases_active",
    "dispatch_leases_expired",
    "dispatch_execution_active",
    "dispatch_pr_fix_human_decisions",
    "dispatch_pr_fix_items",
    "dispatch_pr_fix_items_lane",
    "dispatch_pr_fix_oldest_human_decision_seconds",
    "dispatch_pr_fix_oldest_queued_seconds",
    "dispatch_pr_fix_oldest_unacked_handout_seconds",
    "dispatch_pr_fix_overdue_acked",
    "dispatch_pr_fix_overdue_unacked",
    "dispatch_pr_fix_parked",
    "dispatch_pr_fix_reclaims_in_window",
    "dispatch_pr_fix_settled_in_window",
    "dispatch_pr_fix_stale",
    "dispatch_pr_fix_unacked_handouts",
    "dispatch_pr_fix_waiting_external",
    "dispatch_queue_admission_mode",
    "dispatch_queue_withheld",
    "dispatch_queue_withheld_grooming",
    "dispatch_queue_withheld_oldest_seconds",
    "dispatch_repo_stale_sync_seconds",
    "dispatch_repo_stale_sync_threshold_seconds",
    "dispatch_scheduler_healthy",
    "dispatch_scheduler_job_last_success_timestamp_seconds",
    "dispatch_scheduler_job_overdue",
    "dispatch_scheduler_up",
    "dispatch_sync_failures_in_window",
    "dispatch_sync_last_success_timestamp_seconds",
    "dispatch_sync_pipeline_state",
    "dispatch_sync_running",
    "dispatch_sync_stale",
    "dispatch_work_pickups_in_window",
  ].sort();
}

/**
 * Render the snapshot as Prometheus text format 0.0.4. Deterministic for a
 * given snapshot: families in the `observabilityMetricFamilies()` order,
 * samples sorted by label set.
 */
export function exportObservabilityMetrics(snapshot: ObservabilitySnapshot): string {
  const families: Array<Family | null> = [];

  // ── Work supply (§4.2) ──
  families.push(byDimension("dispatch_issues", "Open issues by status (dispatch-cache).", snapshot.workSupply.byStatus, "status"));
  families.push(byDimension("dispatch_issues_lane", "Open issues by configured lane (dispatch-cache).", snapshot.workSupply.byLane, "lane"));
  families.push(scalar("dispatch_issues_open_claimable", "Open issues with a claimable status: eligible-to-work supply.", snapshot.workSupply.openClaimable));
  families.push(scalar("dispatch_issue_oldest_open_claimable_age_seconds", "Age of the oldest open claimable issue.", snapshot.workSupply.oldestOpenClaimableAgeSeconds));
  families.push(scalar("dispatch_issue_stale_sync_seconds", "Seconds since the newest open issue was last synced (cache staleness).", snapshot.workSupply.maxIssueStaleSyncSeconds));
  families.push(scalar("dispatch_dependency_blocked", "Claimable-status open issues with at least one open blocker.", snapshot.workSupply.dependencyBlocked));

  // ── Execution (§4.3/§4.4/§4.10; system emitters excluded upstream) ──
  families.push(scalar("dispatch_issue_assigned", "Open eligible issues carrying an agent/* label (label-only, no lease).", snapshot.execution.assigned));
  families.push(scalar("dispatch_assigned_without_execution", "Assigned (agent/*) with no ACTIVE lease/AgentWork right now. Dashboard aggregate only — must not fire alerts (§8.7).", snapshot.assignmentObservation.withoutExecutionAggregate));
  families.push(scalar("dispatch_leases_active", "Worker leases with expiredAt in the future.", snapshot.execution.activeLeases));
  families.push(scalar("dispatch_leases_expired", "Worker leases past TTL (recoverable ownership loss).", snapshot.execution.expiredLeases));
  families.push(scalar("dispatch_execution_active", "1 when a worker lease or CLAIMED/IN_PROGRESS AgentWork exists (A4 in-flight guard).", snapshot.execution.executionActive));
  families.push(byDimension("dispatch_agent_work", "AgentWork rows by state.", snapshot.execution.agentWorkByState, "state"));
  families.push(scalar("dispatch_agent_work_release_pending", "AgentWork rows with staleClaimReleasePending (stale recovery in flight).", snapshot.execution.agentWorkReleasePending));
  families.push(scalar("dispatch_agent_work_heartbeat_age_seconds", "Age of the oldest active AgentWork heartbeat.", snapshot.execution.oldestActiveWorkHeartbeatAgeSeconds));
  families.push(windowed("dispatch_work_pickups_in_window", "New worker AgentWork/Lease rows per activity window (as-of-scrape gauge; evaluate directly).", snapshot.execution.pickupsInWindow));
  families.push(windowed("dispatch_agent_runs_reported_in_window", "Task AgentRun rows reported per activity window (as-of-scrape gauge; evaluate directly).", snapshot.execution.reportedInWindow));
  families.push(windowed("dispatch_agent_runs_started_in_window", "Task AgentRun rows by reported start time per activity window (as-of-scrape gauge; evaluate directly).", snapshot.execution.startedInWindow));
  families.push(windowed("dispatch_agent_run_failures_in_window", "Failed task AgentRun rows per activity window (as-of-scrape gauge; evaluate directly).", snapshot.execution.taskRunFailuresInWindow));

  // ── Assignment observation (A6 evidence; §4.3, §10) ──
  families.push(scalar("dispatch_assignment_age_known", "Assigned-without-execution issues whose age comes from persisted assign_agent evidence.", snapshot.assignmentObservation.ageKnown));
  families.push(scalar("dispatch_assignment_age_unknown", "Assigned-without-execution issues with no age evidence — never reported as aged.", snapshot.assignmentObservation.ageUnknown));
  families.push(scalar("dispatch_assignment_aged_past_threshold", "Known-age unexecuted assignments past the stranded-assignment threshold (A6 evidence only).", snapshot.assignmentObservation.agedPastThreshold));
  families.push(scalar("dispatch_assignment_oldest_known_age_seconds", "Oldest known-age unexecuted assignment.", snapshot.assignmentObservation.oldestKnownAgeSeconds));
  families.push(scalar("dispatch_assignment_evidence_lookback_seconds", "Horizon of the loaded assignment-age evidence; older assignments report ageUnknown.", snapshot.assignmentObservation.evidenceLookbackSeconds));

  // ── PR-fix (§4.5/§4.6) ──
  families.push(byDimension("dispatch_pr_fix_items", "PR-fix queue items by status.", snapshot.prFix.byStatus, "status"));
  families.push(byDimension("dispatch_pr_fix_items_lane", "PR-fix queue items by lane.", snapshot.prFix.byLane, "lane"));
  families.push(scalar("dispatch_pr_fix_oldest_queued_seconds", "Age of the oldest QUEUED PR-fix item (A8).", snapshot.prFix.oldestQueuedAgeSeconds));
  families.push(scalar("dispatch_pr_fix_unacked_handouts", "QUEUED items with a current-generation hand-out and no ack, any age. Dashboard aggregate — never alert on it.", snapshot.prFix.handouts.unackedAggregate));
  families.push(scalar("dispatch_pr_fix_overdue_unacked", "Unacked hand-outs past the ack timeout (age-tied; A7).", snapshot.prFix.handouts.overdueUnacked));
  families.push(scalar("dispatch_pr_fix_overdue_acked", "Acknowledged hand-outs stuck past PR_FIX_ACK_LIVENESS_MS — the dead-owner recovery population (#1419).", snapshot.prFix.handouts.overdueAcked));
  families.push(scalar("dispatch_pr_fix_oldest_unacked_handout_seconds", "Age of the oldest unacknowledged hand-out.", snapshot.prFix.handouts.oldestUnackedHandoutAgeSeconds));
  families.push(windowed("dispatch_pr_fix_reclaims_in_window", "PR-fix reclaim history rows per failure window (as-of-scrape gauge).", snapshot.prFix.handouts.reclaimHistoryInWindow));
  families.push(scalar("dispatch_pr_fix_human_decisions", "BLOCKED PR-fix items: genuine human decisions awaiting a call.", snapshot.prFix.settlement.humanDecisionsBlocked));
  families.push(scalar("dispatch_pr_fix_oldest_human_decision_seconds", "Age of the oldest unresolved human decision.", snapshot.prFix.settlement.oldestHumanDecisionAgeSeconds));
  families.push(byDimension("dispatch_pr_fix_parked", "PARKED PR-fix items by outcome: operational exhaustion, not a human decision.", snapshot.prFix.settlement.parkedByOutcome, "outcome"));
  families.push(scalar("dispatch_pr_fix_stale", "PR-fix items STALE (upstream PR merged/closed).", snapshot.prFix.settlement.stale));
  families.push(scalar("dispatch_pr_fix_waiting_external", "PR-fix items WAITING_EXTERNAL (external-dependency wait).", snapshot.prFix.settlement.waitingExternal));
  families.push(windowedByDimension("dispatch_pr_fix_settled_in_window", "Terminal PR-fix settlements per status and failure window (as-of-scrape gauge).", snapshot.prFix.settlement.settledInWindowByStatus, "status"));

  // ── Admission (§4.7) ──
  if (snapshot.admission.notAdmitted !== null) {
    families.push(
      byDimension("dispatch_queue_withheld", "Ready issues withheld by admission, by reason code.", snapshot.admission.notAdmitted.byReason, "reason"),
    );
    families.push(
      scalar("dispatch_queue_withheld_grooming", "Ready issues withheld by at least one grooming-evidence reason (#1420): the impacted-ready count the groomer-stall alert exposes.", snapshot.admission.notAdmitted.byGrooming),
    );
    families.push(
      scalar("dispatch_queue_withheld_oldest_seconds", "Age of the oldest admission-withheld issue.", snapshot.admission.notAdmitted.oldestAgeSeconds),
    );
  }
  families.push(
    family(
      "dispatch_queue_admission_mode",
      "Active queue-admission mode (1 for the active mode).",
      ADMISSION_MODES.map((mode) => ({
        labels: [["mode", mode] as [string, string]],
        value: snapshot.admission.mode === mode ? 1 : 0,
      })),
    ),
  );

  // ── Grooming (§4.8) ──
  families.push(
    family(
      "dispatch_grooming_freshness",
      "Open issues by grooming freshness; absent fingerprint is unknown, never fresh.",
      Object.entries(snapshot.grooming.freshness).map(([freshness, count]) => ({
        labels: [["freshness", freshness] as [string, string]],
        value: count,
      })),
    ),
  );
  families.push(scalar("dispatch_grooming_backoff", "Open issues backing off after an unreadable upstream read (A11).", snapshot.grooming.backoff));
  families.push(byDimension("dispatch_grooming_stale_reasons", "Why grooming decisions went stale.", snapshot.grooming.staleReasons, "reason"));
  families.push(windowedByDimension("dispatch_grooming_runs_in_window", "Grooming runs per status and failure window (as-of-scrape gauge).", snapshot.grooming.runsInWindowByStatus, "status"));
  families.push(
    scalar(
      "dispatch_grooming_last_success_timestamp_seconds",
      "Last successful applied grooming run (status completed, not a dry run) as a unix timestamp. Absent until the first completion — the absent series is A14's firing baseline, never zero.",
      snapshot.grooming.lastSuccessTimestampSeconds,
    ),
  );
  families.push(
    scalar(
      "dispatch_grooming_stall_threshold_seconds",
      "A14 grooming-stall threshold as configured: N groomer intervals (DISPATCH_GROOMER_INTERVAL_MS × DISPATCH_GROOMING_STALL_INTERVALS, N default 2). Absent when the groomer interval is disabled — the stall is then not evaluable, never healthy (mirrors the packaged rule comparing dispatch_repo_stale_sync_threshold_seconds).",
      snapshot.grooming.stallThresholdSeconds,
    ),
  );

  // ── Pipeline (§4.9) ──
  const schedulerHealthy =
    snapshot.pipeline.scheduler.enabled && snapshot.pipeline.scheduler.overdueJobs === 0;
  families.push(scalar("dispatch_scheduler_up", "1 when the in-process scheduler is armed.", snapshot.pipeline.scheduler.enabled ? 1 : 0));
  families.push(scalar("dispatch_scheduler_healthy", "1 when the scheduler is armed and no job is overdue (A4 guard).", schedulerHealthy ? 1 : 0));
  families.push(
    family(
      "dispatch_scheduler_job_overdue",
      "Per scheduled job: 1 when no run landed within two intervals (A1).",
      snapshot.pipeline.scheduler.jobs.map((job) => ({
        labels: [["job", job.name] as [string, string]],
        value: job.overdue,
      })),
    ),
  );
  families.push(
    family(
      "dispatch_scheduler_job_last_success_timestamp_seconds",
      "Per scheduled job: last completed tick as a unix timestamp (jobs with no run yet are omitted).",
      snapshot.pipeline.scheduler.jobs
        .filter((job) => job.lastSuccessTimestampSeconds !== null)
        .map((job) => ({
          labels: [["job", job.name] as [string, string]],
          value: job.lastSuccessTimestampSeconds as number,
        })),
    ),
  );
  families.push(
    scalar(
      "dispatch_sync_last_success_timestamp_seconds",
      "Last completed issue sync as a unix timestamp. Absent until the first completion — the absent series is the A2 firing case, never zero.",
      snapshot.pipeline.sync.lastSuccessTimestampSeconds,
    ),
  );
  families.push(
    scalar(
      "dispatch_sync_stale",
      "1 when the last completed sync is older than two sync intervals (fresh-sync guard of A4; absent until the first completion, and absent unless the sync pipeline is armed — an unarmed or unknown pipeline is unknown, never healthy).",
      syncStaleFlag(snapshot),
    ),
  );
  families.push(
    family(
      "dispatch_sync_pipeline_state",
      "Arm state of the issue-sync pipeline (1 for the active state): armed (the pipeline is expected to run), off (operator opted out), unknown (cannot tell — never healthy, never stale).",
      SYNC_PIPELINE_STATES.map((state) => ({
        labels: [["state", state] as [string, string]],
        value: snapshot.pipeline.syncPipelineState === state ? 1 : 0,
      })),
    ),
  );
  families.push(scalar("dispatch_sync_running", "Issue sync runs currently in flight.", snapshot.pipeline.sync.running));
  families.push(windowedByDimension("dispatch_sync_failures_in_window", "Failed syncs per type and failure window (as-of-scrape gauge; evaluate directly).", snapshot.pipeline.sync.failedInWindowByType, "type"));
  families.push(scalar("dispatch_repo_stale_sync_seconds", "Oldest tracked-repo cache staleness (A13).", snapshot.pipeline.maxRepoStaleSyncSeconds));
  families.push(
    scalar(
      "dispatch_repo_stale_sync_threshold_seconds",
      "A13 repo-staleness threshold as configured: two sync intervals, or 3600 when the sync job is disabled (mirrors the evaluator default so packaged rules track DISPATCH_SYNC_INTERVAL_MS).",
      defaultRepoStaleSyncThresholdSeconds(snapshot.config.syncIntervalMs),
    ),
  );
  families.push(windowedByDimension("dispatch_audit_failures_in_window", "Failed audit mutations per action and failure window (as-of-scrape gauge; evaluate directly, never via delta-style functions — §4.1).", snapshot.failures.auditFailuresInWindowByAction, "action"));
  families.push(scalar("dispatch_health_up", "1: this document exists, so the process and its database answered. A failed scrape is the down signal (A3).", 1));

  const rendered: string[] = [];
  const order = new Map(observabilityMetricFamilies().map((name, index) => [name, index]));
  const present = families.filter((f): f is Family => f !== null);
  present.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
  for (const f of present) {
    rendered.push(`# HELP ${f.name} ${escapeHelp(f.help)}`);
    rendered.push(`# TYPE ${f.name} gauge`);
    for (const sample of f.samples) {
      rendered.push(renderSample(f.name, sample));
    }
  }
  return `${rendered.join("\n")}\n`;
}

/** §4.9 fresh-sync guard: stale past 2× interval; only meaningful once a sync
 *  has ever completed AND the pipeline is armed. Before the first completion
 *  the series is absent (the A2 firing case); an unarmed or unknown pipeline
 *  has no freshness window to judge (an opt-out is unknown, never healthy) —
 *  so the rules' A4 guard leg goes empty exactly like the evaluator's
 *  not_evaluable (mirrors the A2/A4 arm-state guards in
 *  observability-alerts.ts). */
function syncStaleFlag(snapshot: ObservabilitySnapshot): number | null {
  if (snapshot.pipeline.syncPipelineState !== "armed") return null;
  if (!snapshot.pipeline.sync.everSucceeded) return null;
  if (snapshot.config.syncIntervalMs <= 0) return null;
  const age = snapshot.pipeline.sync.secondsSinceLastSuccess;
  if (age === null) return null;
  return age * 1000 > snapshot.config.syncIntervalMs * 2 ? 1 : 0;
}

/** A13 repo-staleness threshold as configured: two sync intervals, or the
 *  3600 fallback when the sync job is disabled. Single source of truth shared
 *  with the evaluator's default so the packaged A13 rule (which compares
 *  `dispatch_repo_stale_sync_seconds` against this exported gauge) can never
 *  drift from `DISPATCH_SYNC_INTERVAL_MS`. */
export function defaultRepoStaleSyncThresholdSeconds(syncIntervalMs: number): number {
  return syncIntervalMs > 0 ? (syncIntervalMs / 1000) * 2 : 3600;
}

/** Strict, fail-closed opt-in: the scrape endpoint exists only when the
 *  operator asks for it (mirrors DISPATCH_SCHEDULER_ENABLED parsing). */
export function observabilityMetricsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DISPATCH_METRICS_ENABLED === "true";
}
