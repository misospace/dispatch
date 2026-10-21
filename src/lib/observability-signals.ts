/**
 * Standalone observability signals (#1252) — pure derivation layer.
 *
 * Implements the signal/state catalogue of docs/observability.md against
 * Dispatch's own persisted cache, backend-neutral and read-only: every value
 * is computed from rows the caller already loaded, and the derived snapshot
 * carries only bounded, allowlisted dimensions. No repository names, issue or
 * PR numbers, agent identities, raw error text, or secrets ever enter the
 * output — the design's §9 privacy rule is enforced here by construction
 * (the output type simply has no place to put them).
 *
 * Kind rules (§4.1): every windowed value here is an as-of-scrape gauge
 * recomputed from row timestamps over a fixed window. It is NOT a monotonic
 * counter; consumers must evaluate it directly, never via rate/increase/delta.
 * Absent baselines stay absent (`null`), which is distinct from zero.
 */
import { getStatusFromLabels, getAgentFromLabels } from "@/types";
import { getLaneIds, resolveLaneId } from "@/lib/lane-config";
import {
  evaluateQueueAdmission,
  ADMISSION_REASON_CODES,
  type AdmissionIssueState,
  type AdmissionRunState,
  type QueueAdmissionMode,
} from "@/lib/queue-admission";
import {
  parseIssueDependencies,
  parseNativeBlockedBy,
  mergeDependencyRefs,
  resolveOpenBlockers,
  formatDependencyBlockReason,
  dependencyKey,
} from "@/lib/issue-dependencies";

// ─── Bounded window allowlists (§4.10) ──────────────────────────────────────

/** Windows for `auditFailuresInWindow` / PR-fix windowed counts, in seconds. */
export const OBSERVABILITY_FAILURE_WINDOWS_SECONDS = [900, 3600] as const;
/** Windows for pickup / reported / started activity gauges, in seconds. */
export const OBSERVABILITY_ACTIVITY_WINDOWS_SECONDS = [1800, 3600] as const;

/**
 * System emitters excluded from task-execution signals (§4.3): the hosted
 * groomer takes its own lease and writes its own run rows with no worker
 * involvement, so counting them would make an idle fleet look busy.
 */
export const OBSERVABILITY_SYSTEM_EMITTER_AGENTS: ReadonlySet<string> = new Set([
  "hosted-groomer",
]);

/** Task run types — allowlist (not subtraction), so heartbeat/groom rows can
 *  never keep the reported/started gauges above zero (§4.3). */
export const OBSERVABILITY_TASK_RUN_TYPES: ReadonlySet<string> = new Set([
  "implement",
  "followup-pr",
]);

const ISSUE_STATUS_DIMS = [
  "backlog",
  "ready",
  "in-progress",
  "in-review",
  "blocked",
  "done",
] as const;

const AGENT_WORK_STATES = [
  "CLAIMED",
  "IN_PROGRESS",
  "BLOCKED",
  "DONE",
  "RELEASED",
  "STALE",
] as const;
const ACTIVE_AGENT_WORK_STATES: ReadonlySet<string> = new Set(["CLAIMED", "IN_PROGRESS"]);
const OBSERVED_AGENT_WORK_STATES: ReadonlySet<string> = new Set([
  "CLAIMED",
  "IN_PROGRESS",
  "BLOCKED",
]);

const PR_FIX_STATUSES = [
  "QUEUED",
  "FIXED",
  "BLOCKED",
  "PARKED",
  "STALE",
  "IGNORED",
  "WAITING_EXTERNAL",
] as const;
const PR_FIX_SETTLEMENT_STATUSES: ReadonlySet<string> = new Set([
  "FIXED",
  "BLOCKED",
  "PARKED",
  "STALE",
  "IGNORED",
]);
const PR_FIX_LANES = ["NORMAL", "ESCALATED", "NEEDS_HUMAN"] as const;
const PR_FIX_PARKED_OUTCOMES = [
  "no_progress",
  "infra_failure",
  "security_failure",
] as const;

const SYNC_TYPES = ["scheduled", "manual", "automation"] as const;

const GROOMING_RUN_STATUSES = [
  "running",
  "completed",
  "partial",
  "failed",
  "dry_run_completed",
  "unverifiable",
  "deferred",
] as const;

const GROOMING_STALE_REASON_DIMS = [
  "issue_changed",
  "human_comment",
  "dependency_changed",
  "related_work_changed",
  "evidence_path_changed",
  "global_evidence_commit",
  "compare_unreliable",
] as const;

/**
 * Allowlisted AuditLog.action values that can carry `success: false`, plus
 * the three dynamic families (`issue_groomed_*`, `reconcile_*`,
 * `workflow_*`) folded into a single bucket each. Anything else lands in
 * `unknown`; the error string itself is never read (§9).
 */
const AUDIT_ACTION_ALLOWLIST: ReadonlySet<string> = new Set([
  "groom",
  "claim_issue",
  "unclaim_issue",
  "set_status",
  "promote_to_ready",
  "pr_fix_mark",
  "pr_fix_enqueue",
  "orphan_work_released",
  "orphan_lease_released",
  "orphan_lease_released_during_finish",
  "orphan_lease_released_during_checkpoint",
  "orphan_work_release_failed",
  "issue_capacity_handoff",
  "stale_agentwork_cleanup",
  "stale_agentwork_released",
  "stale_agentwork_claim_retained",
  "remove_tracked_repo",
  "add_tracked_repo",
  "move_issue",
  "lease_released",
  "grooming_stale",
  "groomer_reply_hold_write_failed",
  "groomer_reply_suppressed",
  "groomer_reply_held",
  "groomer_reply_dismissed",
  "groomer_reply_approved",
  "agent_work_released",
  "agent_work_reassigned",
  "agent_work_reassign_failed",
  "agent_work_release_failed",
  "agent_work_started",
  "agent_work_finished",
  "agent_work_checkpoint",
  "workflow_rerun",
  "worker_scope_denied",
  "ownership_register",
  "ownership_disposition",
  "issue_decomposed",
  "release",
  "remove_label",
  "add_comment",
  "auth_tier_denied",
  "ambient_out_of_transaction",
  "already_done",
  "admission_override",
  "admission_override_cleared",
  "assign_agent",
  "unassign_agent",
]);

function foldAuditAction(action: string): string {
  if (AUDIT_ACTION_ALLOWLIST.has(action)) return action;
  if (action.startsWith("issue_groomed_")) return "issue_groomed";
  if (action.startsWith("reconcile_")) return "reconcile";
  if (action.startsWith("workflow_")) return "workflow";
  return "unknown";
}

type CountMap = Record<string, number>;

function bump(map: CountMap, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function bucket(value: string | null | undefined, allowed: readonly string[]): string {
  return value !== null && value !== undefined && allowed.includes(value) ? value : "unknown";
}

function statusDim(labels: string[]): string {
  const status = getStatusFromLabels(labels);
  if (!status) return "unknown";
  const short = status.replace(/^status\//, "");
  return bucket(short, ISSUE_STATUS_DIMS);
}

function laneDim(currentLane: string | null | undefined): string {
  if (!currentLane) return "none";
  const lowered = currentLane.toLowerCase();
  // resolveLaneId returns unknown ids verbatim (for UI display); the snapshot
  // must stay bounded, so only configured lanes (or aliases resolving to
  // configured lanes) are emitted, everything else is "unknown".
  const resolved = resolveLaneId(lowered) ?? lowered;
  return getLaneIds().includes(resolved) ? resolved : "unknown";
}

function ageSeconds(from: Date | null | undefined, now: Date): number | null {
  if (!from) return null;
  const ms = from.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((now.getTime() - ms) / 1000));
}

function windowKey(seconds: number): string {
  return String(seconds);
}

// ─── Input shapes (rows already loaded by the collector) ────────────────────

export interface ObservabilityIssueRow {
  id: string;
  number: number;
  repoFullName: string;
  state: string;
  labels: string[];
  title: string;
  body: string | null;
  currentLane: string | null;
  createdAt: Date;
  lastSyncedAt: Date;
  nativeBlockedBy: string[];
  // Grooming freshness / admission columns.
  groomedRunId: string | null;
  groomedIssueFingerprint: string | null;
  groomedEvidenceDigest: string | null;
  groomedEvidenceScope: string | null;
  groomingStaleAt: Date | null;
  groomingStaleReasons: string[];
  groomingVerifiedSha: string | null;
  groomingRetryAfter: Date | null;
  admissionOverrideId: string | null;
}

export interface ObservabilityLeaseRow {
  agentName: string;
  issueId: string;
  expiredAt: Date;
  renewedAt: Date | null;
  createdAt: Date;
}

export interface ObservabilityAgentWorkRow {
  agentName: string;
  issueId: string | null;
  state: string;
  checkpoint: string;
  lastHeartbeatAt: Date;
  staleClaimReleasePending: boolean;
  createdAt: Date;
}

export interface ObservabilityPrFixRow {
  status: string;
  lane: string;
  queuedAt: Date;
  updatedAt: Date;
  dispatchedAt: Date | null;
  dispatchedGeneration: number | null;
  generation: number;
  handoutAcks: string[];
  outcome: string | null;
}

export interface ObservabilityPrFixHistoryRow {
  action: string;
  status: string | null;
  at: Date;
}

export interface ObservabilityAgentRunRow {
  runType: string;
  status: string;
  startedAt: Date;
  createdAt: Date;
}

export interface ObservabilityAuditFailureRow {
  action: string;
  createdAt: Date;
}

/** Successful `assign_agent` / `unassign_agent` audit rows in the lookback —
 *  the only persisted assignment-age evidence that exists today (§10 A6). */
export interface ObservabilityAssignmentAuditRow {
  issueId: string;
  action: string;
  createdAt: Date;
}

export interface ObservabilitySyncRunSummary {
  /** Newest `IssueSyncRun` with status "completed" and a completedAt. */
  lastSuccessAt: Date | null;
  running: number;
  /** `status = "failed"` runs in the longest failure window. */
  failed: Array<{ syncType: string; startedAt: Date }>;
}

export interface ObservabilityGroomingRunRow {
  status: string;
  createdAt: Date;
}

export interface ObservabilitySchedulerSummary {
  enabled: boolean;
  /** Resolved `sync` job interval in ms; 0 when the job is disabled. */
  syncIntervalMs: number;
  jobs: Array<{ name: string; intervalMs: number; lastRunAt: string | null; overdue: boolean }>;
}

export interface ObservabilitySnapshotInputs {
  now: Date;
  issues: ObservabilityIssueRow[];
  leases: ObservabilityLeaseRow[];
  agentWork: ObservabilityAgentWorkRow[];
  prFixItems: ObservabilityPrFixRow[];
  /** `reclaim` / terminal `mark` history rows within the longest window. */
  prFixHistory: ObservabilityPrFixHistoryRow[];
  /** AgentRun rows whose createdAt OR startedAt falls in the longest window. */
  agentRuns: ObservabilityAgentRunRow[];
  auditFailures: ObservabilityAuditFailureRow[];
  assignmentAudit: ObservabilityAssignmentAuditRow[];
  /** GroomingRun rows created within the longest window. */
  groomingRuns: ObservabilityGroomingRunRow[];
  sync: ObservabilitySyncRunSummary;
  repoLastSyncedAt: Date[];
  scheduler: ObservabilitySchedulerSummary;
  admissionMode: QueueAdmissionMode;
  /** Grooming runs the ready issues' baselines point at (loadAdmissionRuns). */
  admissionRuns: Map<string, AdmissionRunState>;
  thresholds: {
    /** A6 age threshold: past this, a known-age unexecuted assignment is aged. */
    strandedAssignmentMs: number;
    /** How far back the collector loaded assign/unassign audit evidence. */
    assignmentEvidenceLookbackMs: number;
    /** PR_FIX_HANDOUT_TIMEOUT_MS: age-tied overdue boundary for A7. */
    prFixHandoutTimeoutMs: number;
  };
}

// ─── Snapshot shape ─────────────────────────────────────────────────────────

export interface ObservabilityWindowedCount {
  [windowSeconds: string]: number;
}

export interface ObservabilityWindowedByDimension {
  [windowSeconds: string]: CountMap;
}

export interface ObservabilitySnapshot {
  generatedAt: string;
  /** Signals reflect Dispatch's cache of GitHub, not the forge itself (§2). */
  source: "dispatch-cache";
  windows: {
    failures: number[];
    activity: number[];
  };
  config: {
    admissionMode: QueueAdmissionMode;
    schedulerEnabled: boolean;
    syncIntervalMs: number;
    prFixHandoutTimeoutMs: number;
    strandedAssignmentThresholdMs: number;
  };
  workSupply: {
    openIssues: number;
    byStatus: CountMap;
    byLane: CountMap;
    /** Open, not done/blocked, claimable status (ready or in-progress). */
    openClaimable: number;
    oldestOpenClaimableAgeSeconds: number | null;
    /** Claimable-status open issues with at least one open blocker. */
    dependencyBlocked: number;
    maxIssueStaleSyncSeconds: number | null;
  };
  execution: {
    /** Open eligible issues carrying an `agent/*` label (label-only, no lease). */
    assigned: number;
    activeLeases: number;
    expiredLeases: number;
    /** 0/1: a live lease or CLAIMED/IN_PROGRESS AgentWork by a worker identity. */
    executionActive: 0 | 1;
    agentWorkByState: CountMap;
    agentWorkReleasePending: number;
    oldestActiveWorkHeartbeatAgeSeconds: number | null;
    /** New AgentWork/Lease rows (worker identities) per activity window. */
    pickupsInWindow: ObservabilityWindowedCount;
    /** Task AgentRun rows landed (reported) per activity window. */
    reportedInWindow: ObservabilityWindowedCount;
    /** Task AgentRun rows by reported start time per activity window. */
    startedInWindow: ObservabilityWindowedCount;
    taskRunFailuresInWindow: ObservabilityWindowedCount;
  };
  /**
   * A6 inputs (§6 A6, §10): the aggregate alone must never be read as an
   * alert. `agedPastThreshold` counts ONLY items with real age evidence
   * (successful `assign_agent` audit rows); GitHub-side assignments without
   * audit evidence are counted separately as `ageUnknown` and are never
   * aged — fail-open for alert safety, explicit for interpretation.
   */
  assignmentObservation: {
    withoutExecutionAggregate: number;
    ageKnown: number;
    ageUnknown: number;
    oldestKnownAgeSeconds: number | null;
    agedPastThreshold: number;
    thresholdSeconds: number;
    /**
     * Horizon of the loaded `assign_agent` evidence. An assignment older than
     * this has no loaded age evidence and is reported as `ageUnknown` (never
     * aged) — the horizon is declared so a consumer cannot mistake evidence
     * expiry for "no waiting".
     */
    evidenceLookbackSeconds: number;
  };
  prFix: {
    byStatus: CountMap;
    byLane: CountMap;
    oldestQueuedAgeSeconds: number | null;
    handouts: {
      /** QUEUED items with a current-generation hand-out and no ack (any age). */
      unackedAggregate: number;
      /** Age-tied subset past prFixHandoutTimeoutMs — the alertable signal. */
      overdueUnacked: number;
      oldestUnackedHandoutAgeSeconds: number | null;
      reclaimHistoryInWindow: ObservabilityWindowedCount;
    };
    settlement: {
      humanDecisionsBlocked: number;
      oldestHumanDecisionAgeSeconds: number | null;
      parkedByOutcome: CountMap;
      stale: number;
      waitingExternal: number;
      settledInWindowByStatus: ObservabilityWindowedByDimension;
    };
  };
  admission: {
    mode: QueueAdmissionMode;
    /** Null in `off` mode: nothing is evaluated, so the state is unknown. */
    notAdmitted: null | {
      total: number;
      byReason: CountMap;
      oldestAgeSeconds: number | null;
    };
  };
  grooming: {
    /** Open issues by freshness: absent fingerprint is `unknown`, not fresh. */
    freshness: { fresh: number; stale: number; unknown: number };
    backoff: number;
    staleReasons: CountMap;
    runsInWindowByStatus: ObservabilityWindowedByDimension;
  };
  pipeline: {
    scheduler: {
      enabled: boolean;
      overdueJobs: number;
      jobs: Array<{
        name: string;
        intervalMs: number;
        lastSuccessTimestampSeconds: number | null;
        overdue: 0 | 1;
      }>;
    };
    sync: {
      /** Null = no completed run has EVER existed: an absent series, not zero. */
      lastSuccessTimestampSeconds: number | null;
      everSucceeded: boolean;
      secondsSinceLastSuccess: number | null;
      running: number;
      failedInWindowByType: ObservabilityWindowedByDimension;
    };
    maxRepoStaleSyncSeconds: number | null;
  };
  failures: {
    /** As-of-scrape windowed gauges — evaluate directly, never via delta (§4.1). */
    auditFailuresInWindowByAction: ObservabilityWindowedByDimension;
  };
  observations: {
    /**
     * A4 conjunction: eligible work exists, nothing is executing, nothing was
     * picked up or reported in the pickup window, the scheduler is armed with
     * no overdue job, and the last sync is fresh (A2-suppresses-A4 guard).
     * `null` when the scheduler is disabled and the predicate is not
     * evaluable.
     */
    eligibleWorkNotHandedOut: boolean | null;
    /** A5: expired leases or STALE AgentWork exist. */
    staleOwnership: boolean;
    /** A7 (age-tied): at least one hand-out past the ack timeout. */
    prFixOverdueUnacked: boolean;
    /** A6 evidence: at least one assignment with KNOWN age past threshold. */
    agedUnpickedAssignments: boolean;
    /** A2 absent-series case: no IssueSyncRun has ever completed. */
    neverSyncedSuccessfully: boolean;
    /** A2/A13: sync is stale/absent AND failures landed in the window. */
    syncDiscoveryFailing: boolean;
    /** A1: scheduler armed but at least one job overdue. */
    schedulerOverdue: boolean;
    /** Admission is on and at least one ready issue is not admitted. */
    admissionWithholding: boolean | null;
  };
}

// ─── Window helpers ─────────────────────────────────────────────────────────

function windowedCount(rows: Date[], now: Date, windows: readonly number[]): ObservabilityWindowedCount {
  const out: ObservabilityWindowedCount = {};
  for (const w of windows) out[windowKey(w)] = 0;
  for (const at of rows) {
    const age = now.getTime() - at.getTime();
    if (age < 0) continue;
    for (const w of windows) {
      if (age <= w * 1000) bump(out, windowKey(w));
    }
  }
  return out;
}

function windowedBy(
  rows: Array<{ at: Date; dim: string }>,
  now: Date,
  windows: readonly number[],
): ObservabilityWindowedByDimension {
  const out: ObservabilityWindowedByDimension = {};
  for (const w of windows) out[windowKey(w)] = {};
  for (const row of rows) {
    const age = now.getTime() - row.at.getTime();
    if (age < 0) continue;
    for (const w of windows) {
      if (age <= w * 1000) bump(out[windowKey(w)], row.dim);
    }
  }
  return out;
}

// ─── Claimable predicate (mirrors agent-queue's isActionable+isClaimableStatus) ─

function isOpen(issue: { state: string }): boolean {
  return issue.state === "open";
}

function isEligible(labels: string[]): boolean {
  const status = getStatusFromLabels(labels);
  return status !== "status/done" && status !== "status/blocked";
}

function isClaimableStatus(labels: string[]): boolean {
  const status = getStatusFromLabels(labels);
  if (!status) return false;
  return status === "status/ready" || status === "status/in-progress";
}

function isWorkerIdentity(agentName: string): boolean {
  return !OBSERVABILITY_SYSTEM_EMITTER_AGENTS.has(agentName);
}

function ackedGenerations(handoutAcks: string[]): Set<number> {
  // Mirrors the canonical `parseAgentHandoutToken` rule (pr-fix-queue): the
  // agent name may contain "@", so the generation is what follows the LAST
  // "@"; malformed entries (empty/zero/non-integer generation, or no "@")
  // ack nothing.
  const acked = new Set<number>();
  for (const entry of handoutAcks) {
    const at = entry.lastIndexOf("@");
    if (at <= 0) continue;
    const gen = Number(entry.slice(at + 1));
    if (Number.isInteger(gen) && gen >= 1) acked.add(gen);
  }
  return acked;
}

// ─── Admission evaluation (reuses the canonical rule, no reimplementation) ──

interface WithheldInfo {
  reasons: string[];
  createdAt: Date;
}

function evaluateAdmission(
  inputs: ObservabilitySnapshotInputs,
): { withheld: WithheldInfo[]; dependencyBlocked: number } {
  const openIssueKeys = new Set(
    inputs.issues.filter(isOpen).map((i) => dependencyKey(i.repoFullName, i.number)),
  );
  let dependencyBlocked = 0;
  const withheld: WithheldInfo[] = [];

  for (const issue of inputs.issues) {
    if (!isOpen(issue)) continue;
    const blockers = resolveOpenBlockers(
      mergeDependencyRefs(
        parseNativeBlockedBy(issue.nativeBlockedBy, issue.repoFullName),
        parseIssueDependencies(issue.body),
      ),
      openIssueKeys,
      issue.repoFullName,
      { repo: issue.repoFullName, number: issue.number },
    );
    const claimable = isClaimableStatus(issue.labels);
    if (claimable && blockers.length > 0) dependencyBlocked += 1;

    if (inputs.admissionMode === "off") continue;
    if (getStatusFromLabels(issue.labels) !== "status/ready") continue;

    const admission = evaluateQueueAdmission(issue as AdmissionIssueState, {
      mode: inputs.admissionMode,
      run: issue.groomedRunId ? inputs.admissionRuns.get(issue.groomedRunId) ?? null : null,
      dependencyBlockReason: formatDependencyBlockReason(blockers, issue.repoFullName) || null,
    });
    if (!admission.admitted) {
      withheld.push({
        reasons: admission.reasons.map((r) => bucket(r.code, ADMISSION_REASON_CODES)),
        createdAt: issue.createdAt,
      });
    }
  }
  return { withheld, dependencyBlocked };
}

// ─── Assignment age (A6 evidence inputs) ────────────────────────────────────

/**
 * Per-issue assignment age evidence. The latest successful `assign_agent`
 * audit row stamps when Dispatch last saw the assignment appear; ANY
 * Lease/AgentWork creation for the issue (any time, any state — even a
 * completed attempt) proves the assignment became execution at least once,
 * and a later `unassign_agent` ends the current assignment. Presence (not
 * ordering) is deliberate: a no-op re-assign of an already-delivered issue
 * writes a fresh audit row, and an ordering rule would re-arm the A6 clock on
 * work the fleet already delivered. Issues with no audit evidence have an
 * UNKNOWN age and are never reported as aged (§6 A6 fail-open rule).
 */
function observeAssignments(
  inputs: ObservabilitySnapshotInputs,
  eligibleAssigned: ObservabilityIssueRow[],
): ObservabilitySnapshot["assignmentObservation"] {
  const now = inputs.now;
  const thresholdMs = inputs.thresholds.strandedAssignmentMs;

  // Latest relevant audit event per issue.
  const lastAssign = new Map<string, Date>();
  const lastUnassign = new Map<string, Date>();
  for (const row of inputs.assignmentAudit) {
    if (row.action === "assign_agent") {
      const prev = lastAssign.get(row.issueId);
      if (!prev || row.createdAt > prev) lastAssign.set(row.issueId, row.createdAt);
    } else if (row.action === "unassign_agent") {
      const prev = lastUnassign.get(row.issueId);
      if (!prev || row.createdAt > prev) lastUnassign.set(row.issueId, row.createdAt);
    }
  }

  // Any lease / AgentWork creation is execution evidence, regardless of the
  // row's current state or its order against the assignment audit: an issue
  // that was claimed and delivered is not "assigned but never picked up"
  // even after the lease expired, the work reached a terminal state while
  // the label lingers, or a no-op re-assign wrote a newer audit row.
  const executedIssueIds = new Set<string>();
  for (const lease of inputs.leases) executedIssueIds.add(lease.issueId);
  for (const work of inputs.agentWork) {
    if (work.issueId) executedIssueIds.add(work.issueId);
  }

  let aggregate = 0;
  let ageKnown = 0;
  let ageUnknown = 0;
  let aged = 0;
  let oldestKnown: number | null = null;

  for (const issue of eligibleAssigned) {
    aggregate += 1;
    const assignedAt = lastAssign.get(issue.id) ?? null;
    if (!assignedAt) {
      ageUnknown += 1;
      continue;
    }
    const unassignedAt = lastUnassign.get(issue.id) ?? null;
    if (unassignedAt && unassignedAt > assignedAt) {
      // The audit-visible assignment ended; the label is cache lag. Unknown.
      ageUnknown += 1;
      continue;
    }
    if (executedIssueIds.has(issue.id)) {
      // Execution was observed for this issue at some point: never aged.
      continue;
    }
    ageKnown += 1;
    const ageSec = ageSeconds(assignedAt, now) ?? 0;
    if (oldestKnown === null || ageSec > oldestKnown) oldestKnown = ageSec;
    if (now.getTime() - assignedAt.getTime() > thresholdMs) aged += 1;
  }

  return {
    withoutExecutionAggregate: aggregate,
    ageKnown,
    ageUnknown,
    oldestKnownAgeSeconds: oldestKnown,
    agedPastThreshold: aged,
    thresholdSeconds: Math.floor(thresholdMs / 1000),
    evidenceLookbackSeconds: Math.floor(inputs.thresholds.assignmentEvidenceLookbackMs / 1000),
  };
}

// ─── Main derivation ────────────────────────────────────────────────────────

export function computeObservabilitySnapshot(
  inputs: ObservabilitySnapshotInputs,
): ObservabilitySnapshot {
  const now = inputs.now;
  const openIssues = inputs.issues.filter(isOpen);
  const eligibleOpen = openIssues.filter((i) => isEligible(i.labels));
  const openClaimableIssues = eligibleOpen.filter((i) => isClaimableStatus(i.labels));

  const byStatus: CountMap = {};
  const byLane: CountMap = {};
  for (const issue of openIssues) {
    bump(byStatus, statusDim(issue.labels));
    bump(byLane, laneDim(issue.currentLane));
  }

  const { withheld, dependencyBlocked } = evaluateAdmission(inputs);

  // ── Execution ──
  const workerLeases = inputs.leases.filter((l) => isWorkerIdentity(l.agentName));
  const activeLeaseSet = new Set<string>();
  let activeLeases = 0;
  let expiredLeases = 0;
  for (const lease of workerLeases) {
    if (lease.expiredAt > now) {
      activeLeases += 1;
      activeLeaseSet.add(lease.issueId);
    } else {
      expiredLeases += 1;
    }
  }
  const agentWorkByState: CountMap = {};
  let activeWorkerWork = 0;
  let releasePending = 0;
  let oldestHeartbeat: number | null = null;
  const activeWorkIssueIds = new Set<string>();
  for (const work of inputs.agentWork) {
    bump(agentWorkByState, bucket(work.state, AGENT_WORK_STATES));
    if (work.staleClaimReleasePending) releasePending += 1;
    if (!isWorkerIdentity(work.agentName)) continue;
    if (ACTIVE_AGENT_WORK_STATES.has(work.state)) activeWorkerWork += 1;
    if (OBSERVED_AGENT_WORK_STATES.has(work.state) && work.issueId) {
      activeWorkIssueIds.add(work.issueId);
    }
    if (ACTIVE_AGENT_WORK_STATES.has(work.state)) {
      const age = ageSeconds(work.lastHeartbeatAt, now);
      if (age !== null && (oldestHeartbeat === null || age > oldestHeartbeat)) {
        oldestHeartbeat = age;
      }
    }
  }
  const executionActive: 0 | 1 = activeLeases > 0 || activeWorkerWork > 0 ? 1 : 0;

  const pickupTimes: Date[] = [
    ...workerLeases.filter((l) => l.createdAt <= now).map((l) => l.createdAt),
    ...inputs.agentWork
      .filter((w) => w.createdAt <= now && isWorkerIdentity(w.agentName))
      .map((w) => w.createdAt),
  ];
  const taskRuns = inputs.agentRuns.filter((r) => OBSERVABILITY_TASK_RUN_TYPES.has(r.runType));
  const reportedTimes = taskRuns.filter((r) => r.createdAt <= now).map((r) => r.createdAt);
  const startedTimes = taskRuns.filter((r) => r.startedAt <= now).map((r) => r.startedAt);
  const failedRunTimes = taskRuns
    .filter((r) => r.status === "failed" && r.createdAt <= now)
    .map((r) => r.createdAt);

  // Assigned (label-only) without observed execution.
  const assignedIssues = eligibleOpen.filter((i) => getAgentFromLabels(i.labels) !== null);
  const assignedWithoutExecution = assignedIssues.filter(
    (i) => !activeLeaseSet.has(i.id) && !activeWorkIssueIds.has(i.id),
  );
  const assignmentObservation = observeAssignments(inputs, assignedWithoutExecution);

  // ── PR-fix ──
  const prByStatus: CountMap = {};
  const prByLane: CountMap = {};
  let oldestQueued: number | null = null;
  let unackedAggregate = 0;
  let overdueUnacked = 0;
  let oldestUnackedHandout: number | null = null;
  let humanDecisions = 0;
  let oldestHumanDecision: number | null = null;
  const parkedByOutcome: CountMap = {};
  let prStale = 0;
  let waitingExternal = 0;
  const timeoutMs = inputs.thresholds.prFixHandoutTimeoutMs;

  for (const item of inputs.prFixItems) {
    bump(prByStatus, bucket(item.status, PR_FIX_STATUSES));
    bump(prByLane, bucket(item.lane, PR_FIX_LANES));
    if (item.status === "QUEUED") {
      const age = ageSeconds(item.queuedAt, now);
      if (age !== null && (oldestQueued === null || age > oldestQueued)) oldestQueued = age;
      if (
        item.dispatchedAt !== null &&
        item.dispatchedGeneration !== null &&
        item.dispatchedGeneration === item.generation
      ) {
        const acked = ackedGenerations(item.handoutAcks);
        if (!acked.has(item.generation)) {
          unackedAggregate += 1;
          const handoutAge = ageSeconds(item.dispatchedAt, now) ?? 0;
          if (oldestUnackedHandout === null || handoutAge > oldestUnackedHandout) {
            oldestUnackedHandout = handoutAge;
          }
          if (now.getTime() - item.dispatchedAt.getTime() > timeoutMs) overdueUnacked += 1;
        }
      }
    } else if (item.status === "BLOCKED") {
      humanDecisions += 1;
      const age = ageSeconds(item.updatedAt, now);
      if (age !== null && (oldestHumanDecision === null || age > oldestHumanDecision)) {
        oldestHumanDecision = age;
      }
    } else if (item.status === "PARKED") {
      bump(parkedByOutcome, bucket(item.outcome, PR_FIX_PARKED_OUTCOMES));
    } else if (item.status === "STALE") {
      prStale += 1;
    } else if (item.status === "WAITING_EXTERNAL") {
      waitingExternal += 1;
    }
  }

  const reclaimTimes = inputs.prFixHistory
    .filter((h) => h.action === "reclaim" && h.at <= now)
    .map((h) => h.at);
  const settledRows = inputs.prFixHistory
    .filter(
      (h) =>
        h.action === "mark" &&
        h.status !== null &&
        PR_FIX_SETTLEMENT_STATUSES.has(h.status) &&
        h.at <= now,
    )
    .map((h) => ({ at: h.at, dim: bucket(h.status, PR_FIX_STATUSES) }));

  // ── Admission section ──
  const admissionSection: ObservabilitySnapshot["admission"] =
    inputs.admissionMode === "off"
      ? { mode: "off", notAdmitted: null }
      : (() => {
          const byReason: CountMap = {};
          let oldest: number | null = null;
          for (const w of withheld) {
            for (const code of w.reasons) bump(byReason, code);
            const age = ageSeconds(w.createdAt, now);
            if (age !== null && (oldest === null || age > oldest)) oldest = age;
          }
          return { mode: inputs.admissionMode, notAdmitted: { total: withheld.length, byReason, oldestAgeSeconds: oldest } };
        })();

  // ── Grooming freshness (persisted columns only; absent = unknown) ──
  const freshness = { fresh: 0, stale: 0, unknown: 0 };
  let backoff = 0;
  const staleReasons: CountMap = {};
  for (const issue of openIssues) {
    if (!issue.groomedIssueFingerprint) freshness.unknown += 1;
    else if (issue.groomingStaleAt) freshness.stale += 1;
    else freshness.fresh += 1;
    if (issue.groomingRetryAfter && issue.groomingRetryAfter > now) backoff += 1;
    for (const reason of issue.groomingStaleReasons ?? []) {
      bump(staleReasons, bucket(reason, GROOMING_STALE_REASON_DIMS));
    }
  }

  // ── Pipeline ──
  const jobs = inputs.scheduler.jobs.map((job) => {
    const lastRunMs = job.lastRunAt !== null ? Date.parse(job.lastRunAt) : NaN;
    return {
      name: job.name,
      intervalMs: job.intervalMs,
      lastSuccessTimestampSeconds: Number.isFinite(lastRunMs) ? Math.floor(lastRunMs / 1000) : null,
      overdue: (job.overdue ? 1 : 0) as 0 | 1,
    };
  });
  const overdueJobs = jobs.filter((j) => j.overdue === 1).length;
  const secondsSinceLastSuccess = ageSeconds(inputs.sync.lastSuccessAt, now);
  const everSucceeded = inputs.sync.lastSuccessAt !== null;
  const syncIntervalKnown = inputs.scheduler.syncIntervalMs > 0;
  const freshSyncWindowMs = inputs.scheduler.syncIntervalMs * 2;
  const syncStale =
    !everSucceeded ||
    (syncIntervalKnown &&
      secondsSinceLastSuccess !== null &&
      secondsSinceLastSuccess * 1000 > freshSyncWindowMs);

  const failedSyncRows = inputs.sync.failed
    .filter((f) => f.startedAt <= now)
    .map((f) => ({ at: f.startedAt, dim: bucket(f.syncType, SYNC_TYPES) }));

  let maxRepoStale: number | null = null;
  for (const at of inputs.repoLastSyncedAt) {
    const age = ageSeconds(at, now);
    if (age !== null && (maxRepoStale === null || age > maxRepoStale)) maxRepoStale = age;
  }

  let maxIssueStaleSync: number | null = null;
  for (const issue of openIssues) {
    const age = ageSeconds(issue.lastSyncedAt, now);
    if (age !== null && (maxIssueStaleSync === null || age > maxIssueStaleSync)) {
      maxIssueStaleSync = age;
    }
  }

  // ── Observations (distinguishable derived states) ──
  const pickups30m = (windowedCount(pickupTimes, now, [1800])[windowKey(1800)] ?? 0);
  const reported30m = (windowedCount(reportedTimes, now, [1800])[windowKey(1800)] ?? 0);
  const schedulerHealthy = inputs.scheduler.enabled && overdueJobs === 0;
  const failedLong = failedSyncRows.filter((f) => now.getTime() - f.at.getTime() <= 3600 * 1000).length;

  const eligibleWorkNotHandedOut: boolean | null =
    !inputs.scheduler.enabled || (syncIntervalKnown === false && everSucceeded)
      ? // Not evaluable: scheduler unarmed, or the fresh-sync guard has no
        // interval to evaluate against (sync job disabled) while a success
        // series exists. Explicit unknown, never a silent false.
        null
      : openClaimableIssues.length > 0 &&
        executionActive === 0 &&
        pickups30m === 0 &&
        reported30m === 0 &&
        schedulerHealthy &&
        !syncStale;

  const agentWorkStale = (agentWorkByState["STALE"] ?? 0) > 0;
  const staleOwnership = expiredLeases > 0 || agentWorkStale;

  const snapshot: ObservabilitySnapshot = {
    generatedAt: now.toISOString(),
    source: "dispatch-cache",
    windows: {
      failures: [...OBSERVABILITY_FAILURE_WINDOWS_SECONDS],
      activity: [...OBSERVABILITY_ACTIVITY_WINDOWS_SECONDS],
    },
    config: {
      admissionMode: inputs.admissionMode,
      schedulerEnabled: inputs.scheduler.enabled,
      syncIntervalMs: inputs.scheduler.syncIntervalMs,
      prFixHandoutTimeoutMs: timeoutMs,
      strandedAssignmentThresholdMs: inputs.thresholds.strandedAssignmentMs,
    },
    workSupply: {
      openIssues: openIssues.length,
      byStatus,
      byLane,
      openClaimable: openClaimableIssues.length,
      oldestOpenClaimableAgeSeconds:
        openClaimableIssues.length === 0
          ? null
          : Math.max(
              ...openClaimableIssues.map((i) => ageSeconds(i.createdAt, now) ?? 0),
            ),
      dependencyBlocked,
      maxIssueStaleSyncSeconds: maxIssueStaleSync,
    },
    execution: {
      assigned: assignedIssues.length,
      activeLeases,
      expiredLeases,
      executionActive,
      agentWorkByState,
      agentWorkReleasePending: releasePending,
      oldestActiveWorkHeartbeatAgeSeconds: oldestHeartbeat,
      pickupsInWindow: windowedCount(pickupTimes, now, OBSERVABILITY_ACTIVITY_WINDOWS_SECONDS),
      reportedInWindow: windowedCount(reportedTimes, now, OBSERVABILITY_ACTIVITY_WINDOWS_SECONDS),
      startedInWindow: windowedCount(startedTimes, now, OBSERVABILITY_ACTIVITY_WINDOWS_SECONDS),
      taskRunFailuresInWindow: windowedCount(
        failedRunTimes,
        now,
        OBSERVABILITY_ACTIVITY_WINDOWS_SECONDS,
      ),
    },
    assignmentObservation,
    prFix: {
      byStatus: prByStatus,
      byLane: prByLane,
      oldestQueuedAgeSeconds: oldestQueued,
      handouts: {
        unackedAggregate,
        overdueUnacked,
        oldestUnackedHandoutAgeSeconds: oldestUnackedHandout,
        reclaimHistoryInWindow: windowedCount(reclaimTimes, now, OBSERVABILITY_FAILURE_WINDOWS_SECONDS),
      },
      settlement: {
        humanDecisionsBlocked: humanDecisions,
        oldestHumanDecisionAgeSeconds: oldestHumanDecision,
        parkedByOutcome,
        stale: prStale,
        waitingExternal,
        settledInWindowByStatus: windowedBy(settledRows, now, OBSERVABILITY_FAILURE_WINDOWS_SECONDS),
      },
    },
    admission: admissionSection,
    grooming: {
      freshness,
      backoff,
      staleReasons,
      runsInWindowByStatus: windowedBy(
        inputs.groomingRuns
          .filter((r) => r.createdAt <= now)
          .map((r) => ({ at: r.createdAt, dim: bucket(r.status, GROOMING_RUN_STATUSES) })),
        now,
        OBSERVABILITY_FAILURE_WINDOWS_SECONDS,
      ),
    },
    pipeline: {
      scheduler: {
        enabled: inputs.scheduler.enabled,
        overdueJobs,
        jobs,
      },
      sync: {
        lastSuccessTimestampSeconds: inputs.sync.lastSuccessAt
          ? Math.floor(inputs.sync.lastSuccessAt.getTime() / 1000)
          : null,
        everSucceeded,
        secondsSinceLastSuccess,
        running: inputs.sync.running,
        failedInWindowByType: windowedBy(
          failedSyncRows,
          now,
          OBSERVABILITY_FAILURE_WINDOWS_SECONDS,
        ),
      },
      maxRepoStaleSyncSeconds: maxRepoStale,
    },
    failures: {
      auditFailuresInWindowByAction: windowedBy(
        inputs.auditFailures
          .filter((f) => f.createdAt <= now)
          .map((f) => ({ at: f.createdAt, dim: foldAuditAction(f.action) })),
        now,
        OBSERVABILITY_FAILURE_WINDOWS_SECONDS,
      ),
    },
    observations: {
      eligibleWorkNotHandedOut,
      staleOwnership,
      prFixOverdueUnacked: overdueUnacked > 0,
      agedUnpickedAssignments: assignmentObservation.agedPastThreshold > 0,
      neverSyncedSuccessfully: !everSucceeded,
      syncDiscoveryFailing: failedLong > 0 && syncStale,
      schedulerOverdue: inputs.scheduler.enabled && overdueJobs > 0,
      admissionWithholding:
        inputs.admissionMode === "off" ? null : withheld.length > 0,
    },
  };
  return snapshot;
}
