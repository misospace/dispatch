import { describe, expect, it } from "vitest";
import {
  computeObservabilitySnapshot,
  type ObservabilityAssignmentAuditRow,
  type ObservabilityAuditFailureRow,
  type ObservabilityIssueRow,
  type ObservabilityLeaseRow,
  type ObservabilityAgentWorkRow,
  type ObservabilityPrFixRow,
  type ObservabilitySnapshotInputs,
} from "@/lib/observability-signals";
import {
  evaluateObservabilityAlerts,
  OBSERVABILITY_ALERTS,
  OBSERVABILITY_ALERTS_BY_ID,
  type ObservabilityAlertState,
} from "@/lib/observability-alerts";

const NOW = new Date("2026-10-20T12:00:00Z");

function ago(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
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
    expiredAt: ago(-1800),
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

function states(inputs?: Partial<ObservabilitySnapshotInputs>, options = {}): ObservabilityAlertState[] {
  return evaluateObservabilityAlerts(snapshot(inputs), options);
}

function byId(states: ObservabilityAlertState[]): Map<string, ObservabilityAlertState> {
  return new Map(states.map((s) => [s.id, s]));
}

function auditRow(overrides: Partial<ObservabilityAssignmentAuditRow> & { issueId: string }): ObservabilityAssignmentAuditRow {
  return { action: "assign_agent", createdAt: ago(60), ...overrides };
}

describe("observability alert catalogue structure", () => {
  it("defines A1–A13 exactly once with a duration for enabled rows", () => {
    expect(OBSERVABILITY_ALERTS.map((a) => a.id)).toEqual(
      Array.from({ length: 13 }, (_, i) => `A${i + 1}`),
    );
    for (const alert of OBSERVABILITY_ALERTS) {
      if (alert.enabled) expect(alert.forMs, `${alert.id} forMs`).toBeGreaterThan(0);
      else expect(alert.forMs, `${alert.id} forMs`).toBe(0);
    }
    expect(OBSERVABILITY_ALERTS_BY_ID.get("A6")?.enabled).toBe(false);
  });
});

describe("acceptance fixtures (#1255)", () => {
  it("aged stranded claim: A5 fires and the A6 age evidence is visible but never armed", () => {
    const inputs = {
      issues: [makeIssue({ id: "i1", labels: ["status/in-progress", "agent/alpha"] })],
      leases: [makeLease({ issueId: "i1", expiredAt: ago(600), createdAt: ago(4000) })],
      agentWork: [makeWork({ issueId: "i1", state: "STALE", createdAt: ago(4000) })],
    };
    const s = snapshot(inputs);
    expect(s.execution.expiredLeases).toBe(1);
    expect(s.execution.agentWorkByState["STALE"]).toBe(1);

    const result = byId(
      states(inputs, { prior: { A5: ago(16 * 60).toISOString() } }),
    );
    expect(result.get("A5")?.state).toBe("firing");

    // Known-age assignment (audit row 40m old, threshold 30m) past threshold:
    // reported as evidence, but A6 stays disabled forever.
    const stranded = {
      issues: [makeIssue({ id: "i2", labels: ["status/ready", "agent/alpha"] })],
      assignmentAudit: [auditRow({ issueId: "i2", createdAt: ago(40 * 60) })],
    };
    const strandedSnapshot = snapshot(stranded);
    expect(strandedSnapshot.assignmentObservation.agedPastThreshold).toBe(1);
    const a6 = byId(states(stranded)).get("A6");
    expect(a6?.enabled).toBe(false);
    expect(a6?.state).toBe("disabled");
    expect(a6?.predicateHolds).toBe(true);
  });

  it("overlapping rapidly resolved assignments: aggregate nonzero, no alert fires (§8.7)", () => {
    const inputs = {
      issues: [
        makeIssue({ id: "assigned", labels: ["status/ready", "agent/alpha"] }),
        makeIssue({ id: "busy", labels: ["status/in-progress", "agent/beta"] }),
      ],
      leases: [makeLease({ issueId: "busy", createdAt: ago(10) })],
      agentRuns: [
        { runType: "implement", status: "completed", startedAt: ago(300), createdAt: ago(30) },
      ],
      assignmentAudit: [auditRow({ issueId: "assigned", createdAt: ago(20) })],
    };
    const s = snapshot(inputs);
    // The aggregate is nonzero at this scrape — healthy churn, not a fault.
    expect(s.execution.assigned).toBe(2);
    expect(s.assignmentObservation.withoutExecutionAggregate).toBe(1);
    const result = states(inputs);
    const firingOrPending = result.filter(
      (a) => a.state === "firing" || a.state === "pending",
    );
    expect(firingOrPending).toEqual([]);
    expect(byId(result).get("A4")?.state).toBe("ok");
  });

  it("prolonged unacked hand-out: A7 arms; fresh churn does not (§8.5)", () => {
    const stranded = {
      prFixItems: [
        makePrFix({ dispatchedAt: ago(40 * 60), dispatchedGeneration: 1 }),
      ],
    };
    expect(snapshot(stranded).prFix.handouts.overdueUnacked).toBe(1);
    const firing = byId(
      states(stranded, { prior: { A7: ago(36 * 60).toISOString() } }),
    ).get("A7");
    expect(firing?.state).toBe("firing");

    const fresh = {
      prFixItems: [
        makePrFix({ dispatchedAt: ago(30), dispatchedGeneration: 1 }),
        makePrFix({ queuedAt: ago(120), updatedAt: ago(120), dispatchedAt: null }),
      ],
    };
    const freshSnapshot = snapshot(fresh);
    expect(freshSnapshot.prFix.handouts.unackedAggregate).toBe(1);
    expect(freshSnapshot.prFix.handouts.overdueUnacked).toBe(0);
    expect(byId(states(fresh)).get("A7")?.predicateHolds).toBe(false);
  });

  it("zero-actionable queue: healthy idle renders with no alert armed (§8.2)", () => {
    const result = states();
    for (const alert of result) {
      expect(["ok", "disabled", "not_evaluable"], `${alert.id} → ${alert.state}`).toContain(
        alert.state,
      );
      expect(alert.state === "pending" || alert.state === "firing").toBe(false);
    }
    expect(byId(result).get("A4")?.state).toBe("ok");
    expect(byId(result).get("A7")?.state).toBe("ok");
  });

  it("first sync missing: A2 fires from the absent series and A4 stays suppressed", () => {
    const inputs = {
      issues: [makeIssue({ id: "i1" })],
      sync: { lastSuccessAt: null, running: 0, failed: [] },
    };
    const s = snapshot(inputs);
    expect(s.pipeline.sync.everSucceeded).toBe(false);
    expect(s.pipeline.sync.lastSuccessTimestampSeconds).toBeNull();
    const result = byId(states(inputs));
    expect(result.get("A2")?.predicateHolds).toBe(true);
    expect(result.get("A2")?.state).toBe("pending");
    expect(result.get("A4")?.predicateHolds).toBe(false);
  });

  it("failed sync: A13 fires and the stale-sync guard suppresses A4", () => {
    const inputs = {
      issues: [makeIssue({ id: "i1" })],
      sync: {
        lastSuccessAt: ago(45 * 60),
        running: 0,
        failed: [{ syncType: "scheduled", startedAt: ago(10 * 60) }],
      },
      repoLastSyncedAt: [ago(45 * 60)],
    };
    const s = snapshot(inputs);
    expect(s.pipeline.sync.failedInWindowByType["900"]["scheduled"]).toBe(1);
    expect(s.observations.syncDiscoveryFailing).toBe(true);
    const result = byId(states(inputs));
    expect(result.get("A13")?.predicateHolds).toBe(true);
    expect(result.get("A4")?.predicateHolds).toBe(false);
    expect(result.get("A4")?.state).toBe("ok");
  });

  it("real execution outage: A4 arms only under its full conjunction", () => {
    const inputs = {
      issues: [makeIssue({ id: "i1" }), makeIssue({ id: "i2" }), makeIssue({ id: "i3" })],
    };
    const s = snapshot(inputs);
    expect(s.workSupply.openClaimable).toBe(3);
    expect(s.observations.eligibleWorkNotHandedOut).toBe(true);
    const result = byId(states(inputs));
    expect(result.get("A4")?.state).toBe("pending");
    const firing = byId(
      states(inputs, { prior: { A4: ago(31 * 60).toISOString() } }),
    ).get("A4");
    expect(firing?.state).toBe("firing");

    // Any single leg failing keeps it silent: a live lease is enough.
    const withWork = { ...inputs, leases: [makeLease({ issueId: "i1" })] };
    expect(byId(states(withWork)).get("A4")?.predicateHolds).toBe(false);
    // A heartbeating groomer lease alone must NOT satisfy the in-flight guard
    // (§4.3 system-emitter exclusion).
    const groomerOnly = {
      ...inputs,
      leases: [makeLease({ agentName: "hosted-groomer", issueId: "groom-lease" })],
    };
    const groomerSnapshot = snapshot(groomerOnly);
    expect(groomerSnapshot.execution.executionActive).toBe(0);
    expect(byId(states(groomerOnly)).get("A4")?.predicateHolds).toBe(true);
  });

  it("audit failures in a constant-size rolling window: direct evaluation fires while a delta would read zero", () => {
    const failures: ObservabilityAuditFailureRow[] = [
      { action: "claim_issue", createdAt: ago(1000) },
      { action: "set_status", createdAt: ago(800) },
      { action: "move_issue", createdAt: new Date(NOW.getTime() + 150 * 1000 - 50 * 1000) },
    ];
    const inputs: Partial<ObservabilitySnapshotInputs> = { auditFailures: failures };
    // First evaluation: 900s window holds exactly {set_status}.
    const first = evaluateObservabilityAlerts(
      computeObservabilitySnapshot(baseInputs(inputs)),
      { now: NOW },
    );
    const firstA12 = byId(first).get("A12");
    expect(firstA12?.predicateHolds).toBe(true);
    const firstWindow = snapshot(inputs).failures.auditFailuresInWindowByAction["900"];
    expect(firstWindow).toEqual({ set_status: 1 });

    // 150s later: set_status expired, move_issue arrived — the rolling count
    // is still exactly 1 at both ends, so a delta() would read 0 and miss the
    // fresh failure. Direct evaluation still holds.
    const later = new Date(NOW.getTime() + 150 * 1000);
    const secondSnapshot = computeObservabilitySnapshot(baseInputs({ auditFailures: failures, now: later }));
    expect(secondSnapshot.failures.auditFailuresInWindowByAction["900"]).toEqual({
      move_issue: 1,
    });
    const second = evaluateObservabilityAlerts(secondSnapshot, { now: later });
    expect(byId(second).get("A12")?.predicateHolds).toBe(true);
  });

  it("stopped telemetry: A1 fires and A4 is suppressed while the scheduler is unhealthy", () => {
    const inputs = {
      issues: [makeIssue({ id: "i1" })],
      scheduler: {
        enabled: true,
        syncIntervalMs: 900_000,
        jobs: [
          { name: "sync", intervalMs: 900_000, lastRunAt: ago(45 * 60).toISOString(), overdue: true },
          { name: "groomer", intervalMs: 600_000, lastRunAt: ago(120).toISOString(), overdue: false },
        ],
      },
    };
    const s = snapshot(inputs);
    expect(s.pipeline.scheduler.overdueJobs).toBe(1);
    expect(s.observations.schedulerOverdue).toBe(true);
    const result = byId(states(inputs, { prior: { A1: ago(11 * 60).toISOString() } }));
    expect(result.get("A1")?.state).toBe("firing");
    expect(result.get("A4")?.predicateHolds).toBe(false);
  });
});

describe("sync pipeline arm state gates A2/A4", () => {
  const externalScheduler = {
    enabled: false,
    syncIntervalMs: 900_000,
    jobs: [],
  };

  it("armed and never synced: A2 fires from the absent series", () => {
    const inputs = {
      issues: [makeIssue({ id: "i1" })],
      sync: { lastSuccessAt: null, running: 0, failed: [] },
    };
    const s = snapshot(inputs);
    expect(s.pipeline.syncPipelineState).toBe("armed");
    const result = byId(states(inputs));
    expect(result.get("A2")?.predicateHolds).toBe(true);
    expect(byId(states(inputs, { prior: { A2: ago(6 * 60).toISOString() } })).get("A2")?.state).toBe(
      "firing",
    );
  });

  it("armed with sync history: A2 holds on a stale success and not on a fresh one", () => {
    const stale = {
      issues: [makeIssue({ id: "i1" })],
      sync: { lastSuccessAt: ago(45 * 60), running: 0, failed: [] },
    };
    expect(byId(states(stale)).get("A2")?.predicateHolds).toBe(true);

    const fresh = {
      issues: [makeIssue({ id: "i1" })],
      sync: { lastSuccessAt: ago(120), running: 0, failed: [] },
    };
    const result = byId(states(fresh)).get("A2");
    expect(result?.predicateHolds).toBe(false);
    expect(result?.state).toBe("ok");
  });

  it("an operator opt-out is not_evaluable for A2 and A4 even with sync history", () => {
    const optedOut = {
      syncPipeline: "off" as const,
      issues: [makeIssue({ id: "i1" })],
      sync: { lastSuccessAt: ago(120), running: 0, failed: [] },
    };
    const result = byId(states(optedOut));
    expect(result.get("A2")?.state).toBe("not_evaluable");
    expect(result.get("A4")?.state).toBe("not_evaluable");
  });

  it("an undeterminable pipeline is not_evaluable for A2 and A4", () => {
    const unknown = {
      scheduler: externalScheduler,
      sync: { lastSuccessAt: null, running: 0, failed: [] },
    };
    const s = snapshot(unknown);
    expect(s.pipeline.syncPipelineState).toBe("unknown");
    const result = byId(states(unknown));
    expect(result.get("A2")?.state).toBe("not_evaluable");
    expect(result.get("A4")?.state).toBe("not_evaluable");
  });

  it("the default deployment never pages on a one-off manual sync", () => {
    // `auto` + unarmed in-process scheduler + a completed sync in history:
    // sync history is not evidence of a pipeline, so the arm state stays
    // unknown and A2/A4 stay silent (not_evaluable) — never a false CRITICAL
    // page from a single manual `POST /api/sync`.
    const oneOffSync = {
      scheduler: externalScheduler,
      sync: { lastSuccessAt: ago(120), running: 0, failed: [] },
    };
    expect(snapshot(oneOffSync).pipeline.syncPipelineState).toBe("unknown");
    const fresh = byId(states(oneOffSync));
    expect(fresh.get("A2")?.state).toBe("not_evaluable");
    expect(fresh.get("A4")?.state).toBe("not_evaluable");

    // Same default deployment, but the one-off sync aged out of the
    // freshness window: still unknown, still silent.
    const agedOneOffSync = {
      scheduler: externalScheduler,
      sync: { lastSuccessAt: ago(45 * 60), running: 0, failed: [] },
    };
    const stale = byId(states(agedOneOffSync));
    expect(stale.get("A2")?.state).toBe("not_evaluable");
    expect(stale.get("A4")?.state).toBe("not_evaluable");
  });

  it("an armed external deployment is evaluable for A2 (never suppressed by an unarmed scheduler)", () => {
    const external = {
      syncPipeline: "external" as const,
      scheduler: externalScheduler,
      issues: [makeIssue({ id: "i1" })],
      sync: { lastSuccessAt: ago(120), running: 0, failed: [] },
    };
    const s = snapshot(external);
    expect(s.pipeline.syncPipelineState).toBe("armed");
    const a2 = byId(states(external)).get("A2");
    expect(a2?.state).not.toBe("not_evaluable");
    expect(a2?.state).toBe("ok");
  });

  it("an armed external deployment with eligible work fires A4", () => {
    const external = {
      syncPipeline: "external" as const,
      scheduler: externalScheduler,
      issues: [makeIssue({ id: "i1" }), makeIssue({ id: "i2" })],
      sync: { lastSuccessAt: ago(120), running: 0, failed: [] },
    };
    const s = snapshot(external);
    expect(s.observations.eligibleWorkNotHandedOut).toBe(true);
    const a4 = byId(states(external)).get("A4");
    expect(a4?.predicateHolds).toBe(true);
    expect(
      byId(states(external, { prior: { A4: ago(31 * 60).toISOString() } })).get("A4")?.state,
    ).toBe("firing");
  });
});

describe("evaluator for/pending semantics", () => {
  const failingInputs = {
    auditFailures: [{ action: "set_status", createdAt: ago(60) }],
  };

  it("a first observation is pending since now", () => {
    const state = byId(states(failingInputs)).get("A12");
    expect(state?.state).toBe("pending");
    expect(state?.since).toBe(NOW.toISOString());
  });

  it("prior state younger than for stays pending; older fires", () => {
    const young = byId(
      states(failingInputs, { prior: { A12: ago(60).toISOString() } }),
    ).get("A12");
    expect(young?.state).toBe("pending");
    expect(young?.since).toBe(ago(60).toISOString());

    const old = byId(
      states(failingInputs, { prior: { A12: ago(6 * 60).toISOString() } }),
    ).get("A12");
    expect(old?.state).toBe("firing");
    expect(old?.since).toBe(ago(6 * 60).toISOString());
  });

  it("a cleared predicate resets to ok and drops the since", () => {
    const state = byId(states()).get("A12");
    expect(state?.state).toBe("ok");
    expect(state?.since).toBeNull();
  });

  it("a future-dated carry-over is treated as a fresh first observation", () => {
    const future = new Date(NOW.getTime() + 10 * 60 * 1000).toISOString();
    const state = byId(
      states(failingInputs, { prior: { A12: future } }),
    ).get("A12");
    expect(state?.state).toBe("pending");
    expect(state?.since).toBe(NOW.toISOString());
  });

  it("A10 is not_evaluable while admission is off, evaluable when withholding", () => {
    expect(byId(states()).get("A10")?.state).toBe("not_evaluable");
    const enforcing = {
      admissionMode: "enforce" as const,
      issues: [makeIssue({ id: "held", number: 101, labels: ["status/ready"] })],
    };
    const withheld = byId(states(enforcing)).get("A10");
    expect(withheld?.state).toBe("pending");
    expect(snapshot(enforcing).admission.notAdmitted?.byReason["grooming_unknown"]).toBe(1);
  });

  it("A2 is not_evaluable when the pipeline is opted out, evaluable when armed", () => {
    // Fully disabled: no scheduler, no sync interval, no history.
    const disabled = {
      scheduler: {
        enabled: false,
        syncIntervalMs: 0,
        jobs: [],
      },
      sync: { lastSuccessAt: null, running: 0, failed: [] },
    };
    const result = byId(states(disabled));
    expect(result.get("A2")?.state).toBe("not_evaluable");
    expect(result.get("A4")?.state).toBe("not_evaluable");
    expect(result.get("A1")?.state).toBe("not_evaluable");

    // Scheduler merely unarmed (default deployment): the sync interval stays
    // at its default, but the pipeline still should not have run — A2 must
    // not page on an operator opt-out.
    const unarmed = {
      scheduler: { enabled: false, syncIntervalMs: 900_000, jobs: [] },
      sync: { lastSuccessAt: null, running: 0, failed: [] },
    };
    expect(byId(states(unarmed)).get("A2")?.state).toBe("not_evaluable");

    // Sync job disabled while the scheduler runs: the opt-out is unknown for
    // A4 in either history shape — never `ok`, which would assert that the
    // fresh-sync prerequisite held. (AI-review follow-up: the interval-0 guard
    // used to fire only with a sync history, so a never-synced opted-out
    // pipeline classified A4 as healthy.)
    const jobOffNoHistory = {
      issues: [makeIssue({ id: "work", number: 201, labels: ["status/ready"] })],
      scheduler: { enabled: true, syncIntervalMs: 0, jobs: [] },
      sync: { lastSuccessAt: null, running: 0, failed: [] },
    };
    expect(byId(states(jobOffNoHistory)).get("A4")?.state).toBe("not_evaluable");
    expect(byId(states(jobOffNoHistory)).get("A2")?.state).toBe("not_evaluable");

    const jobOffWithHistory = {
      scheduler: { enabled: true, syncIntervalMs: 0, jobs: [] },
      sync: { lastSuccessAt: ago(120), running: 0, failed: [] },
    };
    expect(byId(states(jobOffWithHistory)).get("A4")?.state).toBe("not_evaluable");
  });

  it("A8/A9 use the configured thresholds and null ages never hold", () => {
    const queued = { prFixItems: [makePrFix({ queuedAt: ago(7200), dispatchedAt: null })] };
    expect(byId(states(queued)).get("A8")?.predicateHolds).toBe(true);
    expect(
      byId(states(queued, { thresholds: { headOfLineWarningSeconds: 10800 } })).get("A8")
        ?.predicateHolds,
    ).toBe(false);

    const blocked = {
      prFixItems: [
        makePrFix({ status: "BLOCKED", updatedAt: ago(7200), outcome: "human_decision" }),
      ],
    };
    expect(byId(states(blocked)).get("A9")?.predicateHolds).toBe(true);
    expect(
      byId(states(blocked, { thresholds: { humanDecisionWarningSeconds: 10800 } })).get("A9")
        ?.predicateHolds,
    ).toBe(false);
  });

  it("A3 fires only from an explicit failed probe", () => {
    expect(byId(states()).get("A3")?.state).toBe("ok");
    expect(byId(states({}, { healthUp: false })).get("A3")?.state).toBe("pending");
  });
});
