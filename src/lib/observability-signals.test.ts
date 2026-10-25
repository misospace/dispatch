import { describe, expect, it } from "vitest";
import {
  computeObservabilitySnapshot,
  type ObservabilityAgentRunRow,
  type ObservabilityAssignmentAuditRow,
  type ObservabilityIssueRow,
  type ObservabilityLeaseRow,
  type ObservabilityAgentWorkRow,
  type ObservabilityPrFixHistoryRow,
  type ObservabilityPrFixRow,
  type ObservabilitySnapshotInputs,
} from "@/lib/observability-signals";

const NOW = new Date("2026-10-20T12:00:00Z");

function ago(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
}

function secondsBetween(a: Date | null, b: Date | null): number | null {
  if (a === null || b === null) return null;
  return Math.floor((b.getTime() - a.getTime()) / 1000);
}

function makeIssue(overrides: Partial<ObservabilityIssueRow> & { id: string }): ObservabilityIssueRow {
  return {
    number: 1,
    repoFullName: "acme/widgets",
    state: "open",
    labels: ["status/ready"],
    title: `issue ${overrides.id}`,
    body: null,
    currentLane: null,
    createdAt: ago(3600),
    lastSyncedAt: ago(60),
    nativeBlockedBy: [],
    groomedRunId: null,
    groomedIssueFingerprint: null,
    groomedEvidenceDigest: null,
    groomedEvidenceScope: null,
    groomingStaleAt: null,
    groomingStaleReasons: [],
    groomingVerifiedSha: null,
    groomingRetryAfter: null,
    admissionOverrideId: null,
    ...overrides,
  };
}

function makeLease(overrides: Partial<ObservabilityLeaseRow>): ObservabilityLeaseRow {
  return {
    agentName: "worker-a",
    issueId: "i1",
    expiredAt: ago(-1800), // 30m in the future = active
    renewedAt: null,
    createdAt: ago(120),
    ...overrides,
  };
}

function makeWork(overrides: Partial<ObservabilityAgentWorkRow>): ObservabilityAgentWorkRow {
  return {
    agentName: "worker-a",
    issueId: "i1",
    state: "IN_PROGRESS",
    checkpoint: "CHANGES_MADE",
    lastHeartbeatAt: ago(40),
    staleClaimReleasePending: false,
    createdAt: ago(600),
    ...overrides,
  };
}

function makePrFix(overrides: Partial<ObservabilityPrFixRow>): ObservabilityPrFixRow {
  return {
    status: "QUEUED",
    lane: "NORMAL",
    queuedAt: ago(300),
    updatedAt: ago(300),
    dispatchedAt: null,
    dispatchedGeneration: null,
    generation: 1,
    handoutAcks: [],
    outcome: null,
    ...overrides,
  };
}

function baseInputs(
  overrides: Partial<ObservabilitySnapshotInputs> = {},
): ObservabilitySnapshotInputs {
  return {
    now: NOW,
    issues: [],
    leases: [],
    agentWork: [],
    prFixItems: [],
    prFixHistory: [],
    agentRuns: [],
    auditFailures: [],
    assignmentAudit: [],
    groomingRuns: [],
    sync: { lastSuccessAt: ago(120), running: 0, failed: [] },
    repoLastSyncedAt: [ago(120)],
    scheduler: {
      enabled: true,
      syncIntervalMs: 900_000,
      jobs: [
        { name: "sync", intervalMs: 900_000, lastRunAt: ago(120).toISOString(), overdue: false },
        { name: "groomer", intervalMs: 600_000, lastRunAt: ago(120).toISOString(), overdue: false },
      ],
    },
    admissionMode: "off",
    syncPipeline: "auto",
    admissionRuns: new Map(),
    thresholds: {
      strandedAssignmentMs: 1_800_000,
      assignmentEvidenceLookbackMs: 30 * 24 * 60 * 60 * 1000,
      prFixHandoutTimeoutMs: 1_800_000,
    },
    ...overrides,
  };
}

function snapshot(overrides: Partial<ObservabilitySnapshotInputs> = {}) {
  return computeObservabilitySnapshot(baseInputs(overrides));
}

describe("observability signal derivation", () => {
  describe("windows are fixed allowlists", () => {
    it("exposes 900/3600 failure and 1800/3600 activity windows", () => {
      const s = snapshot();
      expect(s.windows.failures).toEqual([900, 3600]);
      expect(s.windows.activity).toEqual([1800, 3600]);
      expect(Object.keys(s.failures.auditFailuresInWindowByAction)).toEqual(["900", "3600"]);
      expect(Object.keys(s.execution.pickupsInWindow)).toEqual(["1800", "3600"]);
    });
  });

  describe("work supply", () => {
    it("counts open issues by status and lane dimensions", () => {
      const s = snapshot({
        issues: [
          makeIssue({ id: "i1", labels: ["status/ready"] }),
          makeIssue({ id: "i2", labels: ["status/backlog", "priority/p1"] }),
          makeIssue({ id: "i3", labels: [] }),
          makeIssue({ id: "i4", labels: ["status/ready"], currentLane: "backlog" }),
          makeIssue({ id: "i5", labels: ["status/ready"], currentLane: "no-such-lane" }),
          makeIssue({ id: "closed", state: "closed", labels: ["status/done"] }),
        ],
      });
      expect(s.workSupply.openIssues).toBe(5);
      expect(s.workSupply.byStatus).toMatchObject({ ready: 3, backlog: 1, unknown: 1 });
      expect(s.workSupply.byLane["none"]).toBe(3);
      expect(s.workSupply.byLane["backlog"]).toBe(1);
      expect(s.workSupply.byLane["unknown"]).toBe(1);
      expect(s.workSupply.openClaimable).toBe(3); // i1, i4, i5: ready status; lane/backlog-label/none-status excluded
    });

    it("openClaimable excludes done/blocked and un-statused issues", () => {
      const s = snapshot({
        issues: [
          makeIssue({ id: "i1", labels: ["status/in-progress"] }),
          makeIssue({ id: "i2", labels: ["status/in-review"] }),
          makeIssue({ id: "i3", labels: ["status/blocked"] }),
          makeIssue({ id: "i4", labels: ["status/done"] }),
        ],
      });
      expect(s.workSupply.openClaimable).toBe(1);
    });
  });

  describe("execution vs system emitters", () => {
    it("hosted-groomer leases never mark the fleet executing", () => {
      const s = snapshot({
        leases: [makeLease({ agentName: "hosted-groomer" })],
      });
      expect(s.execution.executionActive).toBe(0);
      expect(s.execution.activeLeases).toBe(0);
    });

    it("BLOCKED AgentWork is not active execution (A4 suppressor rule)", () => {
      const s = snapshot({
        agentWork: [makeWork({ state: "BLOCKED" })],
      });
      expect(s.execution.executionActive).toBe(0);
      expect(s.execution.agentWorkByState["BLOCKED"]).toBe(1);
    });

    it("a live worker lease or CLAIMED/IN_PROGRESS work marks execution", () => {
      expect(
        snapshot({ leases: [makeLease({})] }).execution.executionActive,
      ).toBe(1);
      expect(
        snapshot({ agentWork: [makeWork({ state: "IN_PROGRESS" })] }).execution.executionActive,
      ).toBe(1);
    });

    it("heartbeat-only and groom AgentRun rows never satisfy reported/started gauges", () => {
      const runs: ObservabilityAgentRunRow[] = [
        { runType: "heartbeat", status: "ok", startedAt: ago(60), createdAt: ago(60) },
        { runType: "groom", status: "completed", startedAt: ago(60), createdAt: ago(60) },
      ];
      const s = snapshot({ agentRuns: runs });
      expect(s.execution.reportedInWindow["1800"]).toBe(0);
      expect(s.execution.startedInWindow["1800"]).toBe(0);
    });

    it("counts task pickups from new Lease and AgentWork rows only", () => {
      const s = snapshot({
        leases: [
          makeLease({ createdAt: ago(60) }), // inside 1800s
          makeLease({ issueId: "old", createdAt: ago(7200) }), // outside
        ],
        agentWork: [makeWork({ createdAt: ago(300) })],
      });
      expect(s.execution.pickupsInWindow["1800"]).toBe(2);
      expect(s.execution.pickupsInWindow["3600"]).toBe(2); // 7200s-old lease is outside both
    });

    it("lease renewals do not count as pickups (createdAt is the pickup time)", () => {
      const s = snapshot({
        leases: [makeLease({ createdAt: ago(7200), renewedAt: ago(30) })],
      });
      expect(s.execution.pickupsInWindow["1800"]).toBe(0);
    });

    it("system-emitter AgentWork rows never count as pickups", () => {
      const s = snapshot({
        agentWork: [makeWork({ agentName: "hosted-groomer", createdAt: ago(60) })],
      });
      expect(s.execution.pickupsInWindow["1800"]).toBe(0);
    });
  });

  describe("aged specific assignments (A6 evidence)", () => {
    it("promptly-claimed overlapping assignments are NOT aged stranded", () => {
      // Three assignments arrive within a minute of each other; each gains a
      // lease seconds later. The aggregate is nonzero while the age-tied
      // stranded count stays zero.
      const issues = [1, 2, 3].map((n) =>
        makeIssue({ id: `i${n}`, labels: ["status/ready", `agent/worker-${n}`] }),
      );
      const audit: ObservabilityAssignmentAuditRow[] = [1, 2, 3].map((n) => ({
        issueId: `i${n}`,
        action: "assign_agent",
        createdAt: ago(40 + n * 5),
      }));
      // Leases created after each assignment; expired since (work finished).
      const leases = [1, 2, 3].map((n) =>
        makeLease({
          agentName: `worker-${n}`,
          issueId: `i${n}`,
          createdAt: ago(30 + n * 5),
          expiredAt: ago(3600),
        }),
      );
      const s = snapshot({ issues, assignmentAudit: audit, leases });
      // Expired leases are counted for ownership, never as active execution.
      expect(s.execution.activeLeases).toBe(0);
      expect(s.assignmentObservation.withoutExecutionAggregate).toBe(3);
      expect(s.assignmentObservation.agedPastThreshold).toBe(0);
      expect(s.observations.agedUnpickedAssignments).toBe(false);
    });

    it("an actual aged assignment with audit evidence IS reported", () => {
      const s = snapshot({
        issues: [makeIssue({ id: "stuck", labels: ["status/ready", "agent/worker-a"] })],
        assignmentAudit: [
          { issueId: "stuck", action: "assign_agent", createdAt: ago(7200) },
        ],
      });
      expect(s.assignmentObservation.ageKnown).toBe(1);
      expect(s.assignmentObservation.agedPastThreshold).toBe(1);
      expect(s.assignmentObservation.oldestKnownAgeSeconds).toBe(7200);
      expect(s.observations.agedUnpickedAssignments).toBe(true);
    });

    it("GitHub-side assignments without audit evidence are unknown-age, never aged", () => {
      const s = snapshot({
        issues: [makeIssue({ id: "gh", labels: ["status/ready", "agent/worker-a"] })],
      });
      expect(s.assignmentObservation.withoutExecutionAggregate).toBe(1);
      expect(s.assignmentObservation.ageUnknown).toBe(1);
      expect(s.assignmentObservation.ageKnown).toBe(0);
      expect(s.assignmentObservation.agedPastThreshold).toBe(0);
      expect(s.observations.agedUnpickedAssignments).toBe(false);
    });

    it("a newer unassign supersedes the stale assignment evidence", () => {
      const s = snapshot({
        issues: [makeIssue({ id: "i1", labels: ["status/ready", "agent/worker-a"] })],
        assignmentAudit: [
          { issueId: "i1", action: "assign_agent", createdAt: ago(7200) },
          { issueId: "i1", action: "unassign_agent", createdAt: ago(600) },
        ],
      });
      expect(s.assignmentObservation.ageUnknown).toBe(1);
      expect(s.assignmentObservation.agedPastThreshold).toBe(0);
    });

    it("terminal AgentWork after assignment proves execution happened (delivered, not stranded)", () => {
      const s = snapshot({
        issues: [makeIssue({ id: "i1", labels: ["status/in-review", "agent/worker-a"] })],
        assignmentAudit: [{ issueId: "i1", action: "assign_agent", createdAt: ago(7200) }],
        agentWork: [makeWork({ issueId: "i1", state: "DONE", createdAt: ago(3600) })],
      });
      expect(s.assignmentObservation.withoutExecutionAggregate).toBe(1); // label lingers
      expect(s.assignmentObservation.ageKnown).toBe(0);
      expect(s.assignmentObservation.agedPastThreshold).toBe(0);
    });

    it("a re-assign of already-delivered work does not re-arm the aged clock", () => {
      // Assigned T0, claimed and delivered (lease created then, gone since),
      // operator re-runs the same assign 10 days later. Presence of the old
      // execution evidence must keep this out of the aged count.
      const s = snapshot({
        issues: [makeIssue({ id: "i1", labels: ["status/in-progress", "agent/worker-a"] })],
        assignmentAudit: [
          { issueId: "i1", action: "assign_agent", createdAt: ago(10 * 86_400 + 3600) },
          { issueId: "i1", action: "assign_agent", createdAt: ago(600) }, // no-op re-assign
        ],
        leases: [
          makeLease({
            issueId: "i1",
            createdAt: ago(10 * 86_400),
            expiredAt: ago(10 * 86_400 - 1800),
          }),
        ],
      });
      expect(s.assignmentObservation.ageKnown).toBe(0);
      expect(s.assignmentObservation.agedPastThreshold).toBe(0);
      expect(s.observations.agedUnpickedAssignments).toBe(false);
    });

    it("declares the evidence lookback horizon in the snapshot", () => {
      const s = snapshot();
      expect(s.assignmentObservation.evidenceLookbackSeconds).toBe(30 * 86_400);
    });
  });

  describe("PR-fix hand-out / ack / settlement", () => {
    it("steady churn: unacked aggregate > 0 but overdue (age-tied) == 0", () => {
      const s = snapshot({
        prFixItems: [
          makePrFix({ dispatchedAt: ago(30), dispatchedGeneration: 1 }), // fresh unacked
          makePrFix({
            dispatchedAt: ago(120),
            dispatchedGeneration: 2,
            generation: 2,
            handoutAcks: ["worker-a@2"],
          }), // acked current generation
          makePrFix({
            dispatchedAt: ago(600),
            dispatchedGeneration: 1,
            generation: 2, // older generation hand-out: inert
            handoutAcks: [],
          }),
        ],
      });
      expect(s.prFix.handouts.unackedAggregate).toBe(1);
      expect(s.prFix.handouts.overdueUnacked).toBe(0);
      expect(s.observations.prFixOverdueUnacked).toBe(false);
    });

    it("overdue unacked hand-out past the timeout is distinguishable", () => {
      const s = snapshot({
        prFixItems: [
          makePrFix({ dispatchedAt: ago(3600), dispatchedGeneration: 1 }),
        ],
      });
      expect(s.prFix.handouts.unackedAggregate).toBe(1);
      expect(s.prFix.handouts.overdueUnacked).toBe(1);
      expect(s.prFix.handouts.oldestUnackedHandoutAgeSeconds).toBe(3600);
      expect(s.observations.prFixOverdueUnacked).toBe(true);
    });

    it("ack for a different generation does not count", () => {
      const s = snapshot({
        prFixItems: [
          makePrFix({
            dispatchedAt: ago(60),
            dispatchedGeneration: 2,
            generation: 2,
            handoutAcks: ["worker-a@1"],
          }),
        ],
      });
      expect(s.prFix.handouts.unackedAggregate).toBe(1);
    });

    it("acks parse with @-bearing agent names and reject malformed entries", () => {
      const acked = snapshot({
        prFixItems: [
          makePrFix({
            dispatchedAt: ago(60),
            dispatchedGeneration: 2,
            generation: 2,
            handoutAcks: ["worker@corp.example@2"], // name may contain "@"
          }),
        ],
      });
      expect(acked.prFix.handouts.unackedAggregate).toBe(0);

      const malformed = snapshot({
        prFixItems: [
          makePrFix({
            dispatchedAt: ago(60),
            dispatchedGeneration: 2,
            generation: 2,
            handoutAcks: ["worker@", "@2", "worker@x"],
          }),
        ],
      });
      expect(malformed.prFix.handouts.unackedAggregate).toBe(1);
    });

    it("PARKED is operational exhaustion, BLOCKED is the human decision", () => {
      const s = snapshot({
        prFixItems: [
          makePrFix({ status: "PARKED", outcome: "no_progress" }),
          makePrFix({ status: "PARKED", outcome: "infra_failure" }),
          makePrFix({ status: "PARKED", outcome: null }),
          makePrFix({ status: "BLOCKED", outcome: "human_decision", updatedAt: ago(7200) }),
          makePrFix({ status: "STALE" }),
          makePrFix({ status: "WAITING_EXTERNAL" }),
        ],
      });
      expect(s.prFix.settlement.parkedByOutcome).toEqual({
        no_progress: 1,
        infra_failure: 1,
        unknown: 1,
      });
      expect(s.prFix.settlement.humanDecisionsBlocked).toBe(1);
      expect(s.prFix.settlement.oldestHumanDecisionAgeSeconds).toBe(7200);
      expect(s.prFix.settlement.stale).toBe(1);
      expect(s.prFix.settlement.waitingExternal).toBe(1);
      // PARKED must never inflate the human-decision gauge.
      expect(s.prFix.settlement.humanDecisionsBlocked).toBe(1);
    });

    it("settled history counts terminal marks only, not re-enqueues to QUEUED", () => {
      const history: ObservabilityPrFixHistoryRow[] = [
        { action: "mark", status: "FIXED", at: ago(300) },
        { action: "mark", status: "QUEUED", at: ago(300) }, // retry re-enqueue
        { action: "mark", status: "PARKED", at: ago(1200) },
        { action: "reclaim", status: null, at: ago(200) },
      ];
      const s = snapshot({ prFixHistory: history });
      expect(s.prFix.settlement.settledInWindowByStatus["900"]).toEqual({ FIXED: 1 });
      expect(s.prFix.settlement.settledInWindowByStatus["3600"]).toEqual({
        FIXED: 1,
        PARKED: 1,
      });
      expect(s.prFix.handouts.reclaimHistoryInWindow["900"]).toBe(1);
    });
  });

  describe("windowed failure gauges (never rate/delta)", () => {
    it("a fresh failure is visible in the 900s window even when an older one expires at the same moment", () => {
      // Scrape 1: one failure 600s ago.
      const scrape1 = snapshot({
        auditFailures: [{ action: "claim_issue", createdAt: ago(600) }],
      });
      expect(scrape1.failures.auditFailuresInWindowByAction["900"]).toEqual({
        claim_issue: 1,
      });

      // Scrape 2 (10 minutes later, same equal count of 1 in the long run):
      // the old failure has aged out of the 900s window, and a NEW failure
      // arrived. A delta() over a cumulative count can cancel these; the
      // as-of-scrape gauge shows the arrival directly.
      const scrape2 = snapshot({
        auditFailures: [
          { action: "claim_issue", createdAt: ago(1200) }, // outside 900s
          { action: "set_status", createdAt: ago(100) }, // fresh arrival
        ],
      });
      expect(scrape2.failures.auditFailuresInWindowByAction["900"]).toEqual({
        set_status: 1,
      });
      expect(
        scrape2.failures.auditFailuresInWindowByAction["900"]["claim_issue"] ?? 0,
      ).toBe(0);
      expect(Object.values(scrape2.failures.auditFailuresInWindowByAction["900"]).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    });

    it("folds dynamic action families and buckets unknown actions", () => {
      const s = snapshot({
        auditFailures: [
          { action: "reconcile_close", createdAt: ago(100) },
          { action: "issue_groomed_promote", createdAt: ago(100) },
          { action: "workflow_rerun", createdAt: ago(100) },
          { action: "totally_unseen_action", createdAt: ago(100) },
        ],
      });
      expect(s.failures.auditFailuresInWindowByAction["900"]).toEqual({
        reconcile: 1,
        issue_groomed: 1,
        workflow_rerun: 1,
        unknown: 1,
      });
    });
  });

  describe("sync / scheduler / grooming freshness", () => {
    it("no first successful sync is an absent series, not zero", () => {
      const s = snapshot({ sync: { lastSuccessAt: null, running: 0, failed: [] } });
      expect(s.pipeline.sync.lastSuccessTimestampSeconds).toBeNull();
      expect(s.pipeline.sync.everSucceeded).toBe(false);
      expect(s.pipeline.sync.secondsSinceLastSuccess).toBeNull();
      expect(s.observations.neverSyncedSuccessfully).toBe(true);
    });

    it("failing discovery: failures + stale success series are distinguishable", () => {
      const s = snapshot({
        sync: {
          lastSuccessAt: ago(2400), // 40m > 2x 15m interval
          running: 0,
          failed: [{ syncType: "scheduled", startedAt: ago(300) }],
        },
      });
      expect(s.pipeline.sync.failedInWindowByType["900"]).toEqual({ scheduled: 1 });
      expect(s.observations.syncDiscoveryFailing).toBe(true);
      // A2 territory: A4 must NOT also fire (fresh-sync guard).
      expect(s.observations.eligibleWorkNotHandedOut).toBe(false);
    });

    it("failed sync while the latest sync is still fresh does not claim discovery failing", () => {
      const s = snapshot({
        sync: {
          lastSuccessAt: ago(120),
          running: 1,
          failed: [{ syncType: "manual", startedAt: ago(300) }],
        },
      });
      expect(s.pipeline.sync.running).toBe(1);
      expect(s.observations.syncDiscoveryFailing).toBe(false);
    });

    it("scheduler overdue and disabled states are explicit", () => {
      const overdue = snapshot({
        scheduler: {
          enabled: true,
          syncIntervalMs: 900_000,
          jobs: [
            { name: "sync", intervalMs: 900_000, lastRunAt: ago(2400).toISOString(), overdue: true },
          ],
        },
      });
      expect(overdue.pipeline.scheduler.overdueJobs).toBe(1);
      expect(overdue.observations.schedulerOverdue).toBe(true);
      expect(overdue.observations.eligibleWorkNotHandedOut).not.toBe(true);

      const disabled = snapshot({
        scheduler: { enabled: false, syncIntervalMs: 0, jobs: [] },
      });
      expect(disabled.observations.eligibleWorkNotHandedOut).toBeNull();

      // Scheduler armed but the sync job disabled: the fresh-sync guard has
      // no interval to evaluate against, so the A4-style state is unknown in
      // either success-history shape — never a silent false or true.
      const syncJobDisabled = snapshot({
        issues: [makeIssue({ id: "i1" })],
        scheduler: { enabled: true, syncIntervalMs: 0, jobs: [] },
      });
      expect(syncJobDisabled.observations.eligibleWorkNotHandedOut).toBeNull();
      const syncJobDisabledNoHistory = snapshot({
        issues: [makeIssue({ id: "i1" })],
        scheduler: { enabled: true, syncIntervalMs: 0, jobs: [] },
        sync: { lastSuccessAt: null, running: 0, failed: [] },
      });
      expect(syncJobDisabledNoHistory.observations.eligibleWorkNotHandedOut).toBeNull();
    });

    it("grooming freshness: absent fingerprint is unknown, never fresh", () => {
      const s = snapshot({
        issues: [
          makeIssue({ id: "f1", groomedIssueFingerprint: "fp", groomingStaleAt: null }),
          makeIssue({ id: "f2", groomedIssueFingerprint: "fp", groomingStaleAt: ago(600), groomingStaleReasons: ["issue_changed", "bogus_reason"] }),
          makeIssue({ id: "f3", groomedIssueFingerprint: null }),
          makeIssue({ id: "f4", groomedIssueFingerprint: "fp", groomingRetryAfter: ago(-600) }),
        ],
      });
      expect(s.grooming.freshness).toEqual({ fresh: 2, stale: 1, unknown: 1 });
      expect(s.grooming.backoff).toBe(1);
      expect(s.grooming.staleReasons).toEqual({ issue_changed: 1, unknown: 1 });
    });
  });

  describe("sync pipeline arm state", () => {
    it("armed with the in-process scheduler ticking, unknown without it", () => {
      expect(snapshot().pipeline.syncPipelineState).toBe("armed");

      // The DEFAULT deployment: in-process scheduler off, `auto`. Sync
      // history is NOT evidence of a pipeline — one manual sync must not arm
      // anything, so the state stays unknown and A4 stays silent.
      const unarmed = snapshot({
        scheduler: { enabled: false, syncIntervalMs: 900_000, jobs: [] },
        sync: { lastSuccessAt: ago(120), running: 0, failed: [] },
      });
      expect(unarmed.pipeline.syncPipelineState).toBe("unknown");
      expect(unarmed.observations.eligibleWorkNotHandedOut).toBeNull();
    });

    it("an operator opt-out is off, and stays off despite sync history", () => {
      const optedOut = snapshot({ syncPipeline: "off" });
      expect(optedOut.pipeline.syncPipelineState).toBe("off");
      expect(optedOut.observations.eligibleWorkNotHandedOut).toBeNull();
    });

    it("a declared external driver is armed even with an unarmed in-process scheduler", () => {
      const external = snapshot({
        syncPipeline: "external",
        scheduler: { enabled: false, syncIntervalMs: 900_000, jobs: [] },
        issues: [makeIssue({ id: "i1" })],
      });
      expect(external.pipeline.syncPipelineState).toBe("armed");
      expect(external.observations.eligibleWorkNotHandedOut).toBe(true);
    });

    it("a disabled sync job leaves the freshness window unknown", () => {
      const disabled = snapshot({
        scheduler: { enabled: true, syncIntervalMs: 0, jobs: [] },
        issues: [makeIssue({ id: "i1" })],
      });
      expect(disabled.pipeline.syncPipelineState).toBe("off");
      expect(disabled.observations.eligibleWorkNotHandedOut).toBeNull();
    });
  });

  describe("admission withholding", () => {
    it("off mode reports an unknown (null) withholding state, not zero", () => {
      const s = snapshot({ issues: [makeIssue({ id: "i1" })] });
      expect(s.admission.mode).toBe("off");
      expect(s.admission.notAdmitted).toBeNull();
      expect(s.observations.admissionWithholding).toBeNull();
    });

    it("held dependency: a ready issue with an open blocker is withheld and counted", () => {
      const s = snapshot({
        admissionMode: "enforce",
        issues: [
          makeIssue({ id: "blocker", number: 100, labels: ["status/in-progress"] }),
          makeIssue({ id: "held", number: 101, labels: ["status/ready"], body: "Concrete task. Depends on #100." }),
        ],
      });
      expect(s.workSupply.dependencyBlocked).toBe(1);
      expect(s.admission.notAdmitted?.total).toBe(1);
      expect(s.admission.notAdmitted?.byReason["dependency_blocked"]).toBe(1);
      expect(s.admission.notAdmitted?.byReason["grooming_unknown"]).toBe(1);
      expect(s.observations.admissionWithholding).toBe(true);
    });

    it("a ready issue on a current operator-override baseline is admitted", async () => {
      const { computeGroomingIssueFingerprint } = await import("@/lib/groomer/freshness");
      const issue = makeIssue({
        id: "ok",
        title: "Ready work",
        body: "Concrete task.",
        groomedRunId: "ovr-1",
        admissionOverrideId: "ovr-1",
        groomedIssueFingerprint: computeGroomingIssueFingerprint({
          title: "Ready work",
          body: "Concrete task.",
          state: "open",
          labels: ["status/ready"],
        }),
        groomedEvidenceScope: "none",
      });
      const s = snapshot({ admissionMode: "enforce", issues: [issue] });
      expect(s.admission.notAdmitted?.total).toBe(0);
      expect(s.observations.admissionWithholding).toBe(false);
    });
  });

  describe("scenario distinguishability (acceptance matrix)", () => {
    function digest(s: ReturnType<typeof snapshot>): string {
      const { generatedAt: _omit, ...rest } = s;
      return JSON.stringify(rest);
    }

    const scenarios: Record<string, Partial<ObservabilitySnapshotInputs>> = {
      healthyIdle: {},
      busyChurn: {
        issues: [makeIssue({ id: "i1", labels: ["status/ready"] })],
        leases: [makeLease({})],
        agentRuns: [
          { runType: "implement", status: "completed", startedAt: ago(900), createdAt: ago(60) },
        ],
        prFixItems: [makePrFix({ dispatchedAt: ago(30), dispatchedGeneration: 1 })],
      },
      strandedAssignment: {
        issues: [makeIssue({ id: "stuck", labels: ["status/ready", "agent/worker-a"] })],
        assignmentAudit: [{ issueId: "stuck", action: "assign_agent", createdAt: ago(7200) }],
      },
      noFirstSync: {
        sync: { lastSuccessAt: null, running: 0, failed: [] },
        issues: [makeIssue({ id: "i1" })],
      },
      failingDiscovery: {
        sync: {
          lastSuccessAt: ago(2400),
          running: 0,
          failed: [{ syncType: "scheduled", startedAt: ago(300) }],
        },
      },
      inactiveWorker: {
        issues: [makeIssue({ id: "i1" }), makeIssue({ id: "i2" })],
      },
      heldDependency: {
        admissionMode: "enforce",
        issues: [
          makeIssue({ id: "blocker", number: 5, labels: ["status/in-progress"] }),
          makeIssue({ id: "held", number: 6, labels: ["status/ready"], body: "Depends on #5." }),
        ],
      },
    };

    it("each scenario produces a distinguishable snapshot", () => {
      const digests = Object.entries(scenarios).map(
        ([name, overrides]) => [name, digest(snapshot(overrides))] as const,
      );
      const seen = new Map<string, string[]>();
      for (const [name, d] of digests) {
        seen.set(d, [...(seen.get(d) ?? []), name]);
      }
      const collisions = [...seen.values()].filter((names) => names.length > 1);
      expect(collisions).toEqual([]);
    });

    it("healthy idle fires nothing", () => {
      const s = snapshot(scenarios.healthyIdle);
      expect(s.observations).toEqual({
        eligibleWorkNotHandedOut: false,
        staleOwnership: false,
        prFixOverdueUnacked: false,
        agedUnpickedAssignments: false,
        neverSyncedSuccessfully: false,
        syncDiscoveryFailing: false,
        schedulerOverdue: false,
        admissionWithholding: null,
      });
    });

    it("busy steady churn does not fire overdue/aged observations", () => {
      const s = snapshot(scenarios.busyChurn);
      expect(s.execution.executionActive).toBe(1);
      expect(s.execution.pickupsInWindow["1800"]).toBe(1); // the active lease row
      expect(s.execution.reportedInWindow["1800"]).toBe(1);
      expect(s.prFix.handouts.unackedAggregate).toBe(1);
      expect(s.prFix.handouts.overdueUnacked).toBe(0);
      expect(s.observations.prFixOverdueUnacked).toBe(false);
      expect(s.observations.agedUnpickedAssignments).toBe(false);
    });

    it("inactive worker with fresh supply and eligible work is the only A4-style firing", () => {
      const s = snapshot(scenarios.inactiveWorker);
      expect(s.observations.eligibleWorkNotHandedOut).toBe(true);
      expect(s.observations.neverSyncedSuccessfully).toBe(false);
      expect(s.observations.syncDiscoveryFailing).toBe(false);
    });

    it("no first sync routes to the absent-series observation, never to A4", () => {
      const s = snapshot(scenarios.noFirstSync);
      expect(s.observations.neverSyncedSuccessfully).toBe(true);
      expect(s.observations.eligibleWorkNotHandedOut).toBe(false);
    });

    it("stranded assignment is distinguishable from inactive worker", () => {
      const stranded = snapshot(scenarios.strandedAssignment);
      const inactive = snapshot(scenarios.inactiveWorker);
      expect(stranded.observations.agedUnpickedAssignments).toBe(true);
      expect(inactive.observations.agedUnpickedAssignments).toBe(false);
    });

    it("held dependency is distinguishable via admission + dependency gauges", () => {
      const s = snapshot(scenarios.heldDependency);
      expect(s.observations.admissionWithholding).toBe(true);
      expect(s.workSupply.dependencyBlocked).toBe(1);
    });
  });

  describe("privacy / bounded dimensions", () => {
    it("never leaks repo names, issue numbers, or agent identities into the snapshot", () => {
      const s = snapshot({
        issues: [
          makeIssue({
            id: "i1",
            number: 4242,
            repoFullName: "acme/topsecret-widgets",
            labels: ["status/ready", "agent/superworker9"],
          }),
        ],
        leases: [makeLease({ agentName: "superworker9", issueId: "i1" })],
        agentWork: [makeWork({ agentName: "superworker9", issueId: "i1" })],
        assignmentAudit: [{ issueId: "i1", action: "assign_agent", createdAt: ago(7200) }],
        agentRuns: [
          { runType: "implement", status: "failed", startedAt: ago(60), createdAt: ago(30) },
        ],
      });
      const json = JSON.stringify(s);
      expect(json).not.toContain("superworker9");
      expect(json).not.toContain("topsecret");
      expect(json).not.toContain("4242");
      expect(json).not.toContain("acme");
    });

    it("bucketed dims never emit raw free-string values", () => {
      const s = snapshot({
        prFixItems: [makePrFix({ status: "QUEUED", lane: "NORMAL" })],
        agentWork: [makeWork({ state: "STALE", staleClaimReleasePending: true })],
      });
      expect(s.execution.agentWorkReleasePending).toBe(1);
      expect(Object.keys(s.prFix.byLane)).toEqual(["NORMAL"]);
      expect(Object.keys(s.execution.agentWorkByState)).toEqual(["STALE"]);
    });
  });

  describe("age monotonicity sanity", () => {
    it("seconds since last success matches the input dates", () => {
      const s = snapshot({ sync: { lastSuccessAt: ago(500), running: 0, failed: [] } });
      expect(secondsBetween(ago(500), NOW)).toBe(500);
      expect(s.pipeline.sync.secondsSinceLastSuccess).toBe(500);
    });
  });
});
