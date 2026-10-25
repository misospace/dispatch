/**
 * Read-only observability snapshot collector (#1252).
 *
 * Loads the raw rows behind the signals in `@/lib/observability-signals`
 * from Dispatch's Postgres cache — only findMany/findFirst/count, never a
 * write — and hands them to the pure derivation layer. No GitHub/forge
 * calls, no scheduler mutation: a scrape must be side-effect free.
 */
import { prisma } from "@/lib/prisma";
import {
  computeObservabilitySnapshot,
  type ObservabilityIssueRow,
  type ObservabilitySnapshot,
} from "@/lib/observability-signals";
import {
  getQueueAdmissionMode,
  loadAdmissionRuns,
  type AdmissionIssueState,
  type AdmissionRunState,
} from "@/lib/queue-admission";
import { schedulerConfigFromEnv, schedulerState } from "@/lib/scheduler";
import { prFixHandoutTimeoutMs } from "@/lib/pr-fix-queue";
import { syncPipelineDeclarationFromEnv } from "@/lib/sync-pipeline";

const STRANDED_ASSIGNMENT_DEFAULT_MS = 30 * 60 * 1000;
const STRANDED_ASSIGNMENT_MIN_MS = 60_000;
const STRANDED_ASSIGNMENT_MAX_MS = 86_400_000;
const LONG_WINDOW_MS = 3_600_000;
// Assignment age evidence horizon. Bounded on purpose; the horizon is
// exported in the snapshot (`evidenceLookbackSeconds`) so assignments older
// than it report as age-UNKNOWN (never aged) with the horizon visible,
// instead of the alertable signal silently switching off.
const ASSIGNMENT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export function strandedAssignmentThresholdMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.DISPATCH_OBSERVABILITY_STRANDED_ASSIGNMENT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return STRANDED_ASSIGNMENT_DEFAULT_MS;
  return Math.min(STRANDED_ASSIGNMENT_MAX_MS, Math.max(STRANDED_ASSIGNMENT_MIN_MS, parsed));
}

export async function collectObservabilitySnapshot(
  now = new Date(),
): Promise<ObservabilitySnapshot> {
  const windowStart = new Date(now.getTime() - LONG_WINDOW_MS);
  const lookbackStart = new Date(now.getTime() - ASSIGNMENT_LOOKBACK_MS);
  const admissionMode = getQueueAdmissionMode();

  const [
    issueRows,
    leaseRows,
    agentWorkRows,
    prFixRows,
    prFixHistoryRows,
    agentRunRows,
    auditFailureRows,
    groomingRunRows,
    lastSyncRun,
    runningSyncCount,
    failedSyncRows,
    repoRows,
    assignmentAuditRows,
  ] = await Promise.all([
    prisma.issue.findMany({
      where: { state: "open", repository: { enabled: true } },
      select: {
        id: true,
        number: true,
        state: true,
        labels: true,
        title: true,
        body: true,
        currentLane: true,
        createdAt: true,
        lastSyncedAt: true,
        nativeBlockedBy: true,
        groomedRunId: true,
        groomedIssueFingerprint: true,
        groomedEvidenceDigest: true,
        groomedEvidenceScope: true,
        groomingStaleAt: true,
        groomingStaleReasons: true,
        groomingVerifiedSha: true,
        groomingRetryAfter: true,
        admissionOverrideId: true,
        repository: { select: { fullName: true } },
      },
    }),
    prisma.lease.findMany({
      select: {
        agentName: true,
        issueId: true,
        expiredAt: true,
        renewedAt: true,
        createdAt: true,
      },
    }),
    prisma.agentWork.findMany({
      select: {
        agentName: true,
        issueId: true,
        state: true,
        checkpoint: true,
        lastHeartbeatAt: true,
        staleClaimReleasePending: true,
        createdAt: true,
      },
    }),
    prisma.prFixQueueItem.findMany({
      select: {
        status: true,
        lane: true,
        queuedAt: true,
        updatedAt: true,
        dispatchedAt: true,
        dispatchedGeneration: true,
        generation: true,
        handoutAcks: true,
        outcome: true,
      },
    }),
    prisma.prFixHistory.findMany({
      where: { at: { gte: windowStart }, action: { in: ["reclaim", "mark"] } },
      select: { action: true, status: true, at: true },
    }),
    prisma.agentRun.findMany({
      where: {
        OR: [{ createdAt: { gte: windowStart } }, { startedAt: { gte: windowStart } }],
      },
      select: { runType: true, status: true, startedAt: true, createdAt: true },
    }),
    prisma.auditLog.findMany({
      where: { success: false, createdAt: { gte: windowStart } },
      select: { action: true, createdAt: true },
    }),
    prisma.groomingRun.findMany({
      where: { createdAt: { gte: windowStart } },
      select: { status: true, createdAt: true },
    }),
    prisma.issueSyncRun.findFirst({
      where: { status: "completed", completedAt: { not: null } },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true },
    }),
    prisma.issueSyncRun.count({ where: { status: "running" } }),
    prisma.issueSyncRun.findMany({
      where: { status: "failed", startedAt: { gte: windowStart } },
      select: { syncType: true, startedAt: true },
    }),
    prisma.automationRepo.findMany({ select: { lastSyncedAt: true } }),
    prisma.auditLog.findMany({
      where: {
        action: { in: ["assign_agent", "unassign_agent"] },
        success: true,
        issueId: { not: null },
        createdAt: { gte: lookbackStart },
      },
      select: { issueId: true, action: true, createdAt: true },
    }),
  ]);

  const issues: ObservabilityIssueRow[] = issueRows.map((row) => ({
    id: row.id,
    number: row.number,
    repoFullName: row.repository.fullName,
    state: row.state,
    labels: row.labels,
    title: row.title,
    body: row.body,
    currentLane: row.currentLane,
    createdAt: row.createdAt,
    lastSyncedAt: row.lastSyncedAt,
    nativeBlockedBy: row.nativeBlockedBy,
    groomedRunId: row.groomedRunId,
    groomedIssueFingerprint: row.groomedIssueFingerprint,
    groomedEvidenceDigest: row.groomedEvidenceDigest,
    groomedEvidenceScope: row.groomedEvidenceScope,
    groomingStaleAt: row.groomingStaleAt,
    groomingStaleReasons: row.groomingStaleReasons,
    groomingVerifiedSha: row.groomingVerifiedSha,
    groomingRetryAfter: row.groomingRetryAfter,
    admissionOverrideId: row.admissionOverrideId,
  }));

  const schedulerConfig = schedulerConfigFromEnv(process.env);
  const schedulerStateSummary = schedulerState();

  const admissionRuns =
    admissionMode === "off"
      ? new Map<string, AdmissionRunState>()
      : await loadAdmissionRuns(issueRows as unknown as AdmissionIssueState[]);

  return computeObservabilitySnapshot({
    now,
    issues,
    leases: leaseRows.map((row) => ({
      agentName: row.agentName,
      issueId: row.issueId,
      expiredAt: row.expiredAt,
      renewedAt: row.renewedAt,
      createdAt: row.createdAt,
    })),
    agentWork: agentWorkRows.map((row) => ({
      agentName: row.agentName,
      issueId: row.issueId,
      state: row.state,
      checkpoint: row.checkpoint,
      lastHeartbeatAt: row.lastHeartbeatAt,
      staleClaimReleasePending: row.staleClaimReleasePending,
      createdAt: row.createdAt,
    })),
    prFixItems: prFixRows.map((row) => ({
      status: row.status,
      lane: row.lane,
      queuedAt: row.queuedAt,
      updatedAt: row.updatedAt,
      dispatchedAt: row.dispatchedAt,
      dispatchedGeneration: row.dispatchedGeneration,
      generation: row.generation,
      handoutAcks: row.handoutAcks,
      outcome: row.outcome,
    })),
    prFixHistory: prFixHistoryRows.map((row) => ({
      action: row.action,
      status: row.status,
      at: row.at,
    })),
    agentRuns: agentRunRows.map((row) => ({
      runType: row.runType,
      status: row.status,
      startedAt: row.startedAt,
      createdAt: row.createdAt,
    })),
    auditFailures: auditFailureRows.map((row) => ({
      action: row.action,
      createdAt: row.createdAt,
    })),
    assignmentAudit: assignmentAuditRows.map((row) => ({
      issueId: row.issueId as string,
      action: row.action,
      createdAt: row.createdAt,
    })),
    groomingRuns: groomingRunRows.map((row) => ({
      status: row.status,
      createdAt: row.createdAt,
    })),
    sync: {
      lastSuccessAt: lastSyncRun?.completedAt ?? null,
      running: runningSyncCount,
      failed: failedSyncRows.map((row) => ({ syncType: row.syncType, startedAt: row.startedAt })),
    },
    repoLastSyncedAt: repoRows.map((row) => row.lastSyncedAt),
    scheduler: {
      enabled: schedulerConfig.enabled,
      syncIntervalMs: schedulerConfig.jobs.find((j) => j.name === "sync")?.intervalMs ?? 0,
      jobs: schedulerStateSummary.jobs.map((j) => ({
        name: j.name,
        intervalMs: j.intervalMs,
        lastRunAt: j.lastRunAt,
        overdue: j.overdue,
      })),
    },
    admissionMode,
    syncPipeline: syncPipelineDeclarationFromEnv(process.env),
    admissionRuns,
    thresholds: {
      strandedAssignmentMs: strandedAssignmentThresholdMs(),
      assignmentEvidenceLookbackMs: ASSIGNMENT_LOOKBACK_MS,
      prFixHandoutTimeoutMs: prFixHandoutTimeoutMs(),
    },
  });
}
