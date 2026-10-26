import { describe, expect, it } from "vitest";
import {
  computeObservabilitySnapshot,
  type ObservabilityAgentWorkRow,
  type ObservabilityIssueRow,
  type ObservabilityLeaseRow,
  type ObservabilityPrFixRow,
  type ObservabilitySnapshotInputs,
} from "@/lib/observability-signals";
import {
  exportObservabilityMetrics,
  observabilityMetricFamilies,
  observabilityMetricsEnabled,
} from "@/lib/observability-export";

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
    handoutAckTimes: [],
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
      ],
    },
    admissionMode: "off",
    syncPipeline: "auto",
    admissionRuns: new Map(),
    thresholds: {
      strandedAssignmentMs: 1_800_000,
      assignmentEvidenceLookbackMs: 30 * 24 * 60 * 60 * 1000,
      prFixHandoutTimeoutMs: 1_800_000,
      prFixAckLivenessMs: 24 * 60 * 60 * 1000,
    },
    ...overrides,
  };
}

function metrics(overrides: Partial<ObservabilitySnapshotInputs> = {}): string {
  return exportObservabilityMetrics(computeObservabilitySnapshot(baseInputs(overrides)));
}

function sampleLines(body: string, name: string): string[] {
  return body.split("\n").filter((l) => l.startsWith(name));
}

const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})? (-?\d+)(\.\d+)?(e[+-]?\d+)?$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*="([^"\\]|\\.)*"(,[a-zA-Z_][a-zA-Z0-9_]*="([^"\\]|\\.)*")*$/;

describe("exportObservabilityMetrics", () => {
  it("renders every always-present family for a completely idle Dispatch", () => {
    const body = metrics();
    for (const alwaysPresent of [
      "dispatch_issues_open_claimable",
      "dispatch_leases_active",
      "dispatch_execution_active",
      "dispatch_health_up",
      "dispatch_scheduler_up",
      "dispatch_scheduler_healthy",
      "dispatch_grooming_freshness",
      "dispatch_queue_admission_mode",
      "dispatch_work_pickups_in_window",
      "dispatch_agent_runs_reported_in_window",
    ]) {
      expect(sampleLines(body, alwaysPresent).length, alwaysPresent).toBeGreaterThan(0);
    }
    expect(sampleLines(body, "dispatch_health_up")[0]).toBe("dispatch_health_up 1");
    expect(sampleLines(body, "dispatch_execution_active")[0]).toBe("dispatch_execution_active 0");
  });

  it("emits well-formed exposition lines only (grammar check)", () => {
    const body = metrics({
      issues: [makeIssue({ id: "i1" }), makeIssue({ id: "i2", labels: ["status/blocked"] })],
      leases: [makeLease({})],
      prFixItems: [makePrFix({ dispatchedAt: ago(2400), dispatchedGeneration: 1 })],
      auditFailures: [{ action: "set_status", createdAt: ago(60) }],
    });
    const lines = body.split("\n");
    expect(lines[lines.length - 1]).toBe("");
    for (const line of lines.slice(0, -1)) {
      if (line.startsWith("# HELP ") || line.startsWith("# TYPE ")) continue;
      const match = SAMPLE.exec(line);
      if (!match) {
        throw new Error(`malformed exposition line: ${line}`);
      }
      const labels = match[2];
      if (labels) {
        expect(LABEL.test(labels.slice(1, -1)), `bad labels: ${line}`).toBe(true);
      }
    }
    for (const line of lines) {
      if (line.startsWith("# TYPE ")) {
        expect(line.endsWith(" gauge"), line).toBe(true);
      }
    }
  });

  it("carries the fixed window labels and per-action sparse maps", () => {
    const body = metrics({
      auditFailures: [
        { action: "set_status", createdAt: ago(60) },
        { action: "issue_groomed_widgets", createdAt: ago(1800) },
      ],
    });
    const inWindow = sampleLines(body, "dispatch_audit_failures_in_window{");
    expect(inWindow).toContain('dispatch_audit_failures_in_window{action="set_status",window="900"} 1');
    expect(inWindow).toContain('dispatch_audit_failures_in_window{action="issue_groomed",window="3600"} 1');
    expect(inWindow.some((l) => l.includes("issue_groomed_widgets"))).toBe(false);
  });

  it("keeps the absent series absent: a never-successful sync emits no last-success line", () => {
    const body = metrics({ sync: { lastSuccessAt: null, running: 0, failed: [] } });
    expect(sampleLines(body, "dispatch_sync_last_success_timestamp_seconds")).toEqual([]);
    expect(sampleLines(body, "dispatch_sync_stale")).toEqual([]);
  });

  it("a disabled sync job is unknown, never healthy: no stale flag, pipeline off", () => {
    const body = metrics({
      scheduler: { enabled: true, syncIntervalMs: 0, jobs: [] },
      sync: { lastSuccessAt: ago(7200), running: 0, failed: [] },
    });
    expect(sampleLines(body, "dispatch_sync_stale")).toEqual([]);
    expect(sampleLines(body, "dispatch_sync_pipeline_state")).toEqual([
      'dispatch_sync_pipeline_state{state="armed"} 0',
      'dispatch_sync_pipeline_state{state="off"} 1',
      'dispatch_sync_pipeline_state{state="unknown"} 0',
    ]);
  });

  it("exports the arm state of the sync pipeline with exactly one active value", () => {
    const armed = sampleLines(metrics(), "dispatch_sync_pipeline_state");
    expect(armed).toEqual([
      'dispatch_sync_pipeline_state{state="armed"} 1',
      'dispatch_sync_pipeline_state{state="off"} 0',
      'dispatch_sync_pipeline_state{state="unknown"} 0',
    ]);

    const unknown = sampleLines(
      metrics({
        scheduler: { enabled: false, syncIntervalMs: 900_000, jobs: [] },
        sync: { lastSuccessAt: null, running: 0, failed: [] },
      }),
      "dispatch_sync_pipeline_state",
    );
    expect(unknown).toEqual([
      'dispatch_sync_pipeline_state{state="armed"} 0',
      'dispatch_sync_pipeline_state{state="off"} 0',
      'dispatch_sync_pipeline_state{state="unknown"} 1',
    ]);

    const optedOut = sampleLines(
      metrics({ syncPipeline: "off" }),
      "dispatch_sync_pipeline_state",
    );
    expect(optedOut).toEqual([
      'dispatch_sync_pipeline_state{state="armed"} 0',
      'dispatch_sync_pipeline_state{state="off"} 1',
      'dispatch_sync_pipeline_state{state="unknown"} 0',
    ]);
  });

  it("the stale flag is absent unless the pipeline is armed and has synced", () => {
    // Unknown pipeline: no freshness judgement is possible.
    const unknown = metrics({
      scheduler: { enabled: false, syncIntervalMs: 900_000, jobs: [] },
      sync: { lastSuccessAt: null, running: 0, failed: [] },
    });
    expect(sampleLines(unknown, "dispatch_sync_stale")).toEqual([]);

    // Opted out: an opt-out is not a fault, so no staleness is reported.
    const off = metrics({ syncPipeline: "off" });
    expect(sampleLines(off, "dispatch_sync_stale")).toEqual([]);

    // Armed but never synced: the absent series IS the A2 firing case, never 0.
    const neverSynced = metrics({
      sync: { lastSuccessAt: null, running: 0, failed: [] },
    });
    expect(sampleLines(neverSynced, "dispatch_sync_stale")).toEqual([]);
  });

  it("flags a stale completed sync for the fresh-sync guard, absent otherwise", () => {
    const fresh = sampleLines(metrics(), "dispatch_sync_stale");
    expect(fresh).toEqual(["dispatch_sync_stale 0"]);
    const stale = sampleLines(
      metrics({ sync: { lastSuccessAt: ago(3600), running: 0, failed: [] } }),
      "dispatch_sync_stale",
    );
    expect(stale).toEqual(["dispatch_sync_stale 1"]);
  });

  it("no longer emits the scheduler-derived sync-job armed family", () => {
    expect(observabilityMetricFamilies()).not.toContain("dispatch_sync_job_armed");
    expect(sampleLines(metrics(), "dispatch_sync_job_armed")).toEqual([]);
  });

  it("exports the A13 repo-staleness threshold as configured (rules track DISPATCH_SYNC_INTERVAL_MS)", () => {
    // The packaged A13 rule compares dispatch_repo_stale_sync_seconds
    // against this gauge instead of a hard-coded 1800.
    expect(sampleLines(metrics(), "dispatch_repo_stale_sync_threshold_seconds")).toEqual([
      "dispatch_repo_stale_sync_threshold_seconds 1800",
    ]);
    const custom = metrics({ scheduler: { enabled: true, syncIntervalMs: 300_000, jobs: [] } });
    expect(sampleLines(custom, "dispatch_repo_stale_sync_threshold_seconds")).toEqual([
      "dispatch_repo_stale_sync_threshold_seconds 600",
    ]);
    const disabled = metrics({ scheduler: { enabled: true, syncIntervalMs: 0, jobs: [] } });
    expect(sampleLines(disabled, "dispatch_repo_stale_sync_threshold_seconds")).toEqual([
      "dispatch_repo_stale_sync_threshold_seconds 3600",
    ]);
  });

  it("an unarmed in-process scheduler stays unknown even with sync history", () => {
    // Default deployment: DISPATCH_SCHEDULER_ENABLED off while the sync
    // interval stays at its default, and no topology declared. Dispatch cannot
    // tell whether an external driver runs the pipeline — unknown, neither
    // healthy (0) nor stale (1).
    const noEvidence = metrics({
      scheduler: { enabled: false, syncIntervalMs: 900_000, jobs: [] },
      sync: { lastSuccessAt: null, running: 0, failed: [] },
    });
    expect(sampleLines(noEvidence, "dispatch_sync_stale")).toEqual([]);
    expect(sampleLines(noEvidence, "dispatch_scheduler_up")).toEqual([
      "dispatch_scheduler_up 0",
    ]);
    expect(sampleLines(noEvidence, "dispatch_sync_pipeline_state")).toEqual([
      'dispatch_sync_pipeline_state{state="armed"} 0',
      'dispatch_sync_pipeline_state{state="off"} 0',
      'dispatch_sync_pipeline_state{state="unknown"} 1',
    ]);

    // A completed sync is NOT evidence of a pipeline: one manual sync must
    // not arm the freshness guard, or the default deployment pages CRITICAL
    // A2 half an hour later. The state stays unknown and the stale flag
    // stays absent.
    const withHistory = metrics({
      scheduler: { enabled: false, syncIntervalMs: 900_000, jobs: [] },
      sync: { lastSuccessAt: ago(120), running: 0, failed: [] },
    });
    expect(sampleLines(withHistory, "dispatch_sync_pipeline_state")).toEqual([
      'dispatch_sync_pipeline_state{state="armed"} 0',
      'dispatch_sync_pipeline_state{state="off"} 0',
      'dispatch_sync_pipeline_state{state="unknown"} 1',
    ]);
    expect(sampleLines(withHistory, "dispatch_sync_stale")).toEqual([]);
  });

  it("a declared external driver is armed and its freshness is evaluated", () => {
    const external = {
      syncPipeline: "external" as const,
      scheduler: { enabled: false, syncIntervalMs: 900_000, jobs: [] },
    };

    // Fresh: the guard is evaluated and reports 0.
    const fresh = metrics({
      ...external,
      sync: { lastSuccessAt: ago(120), running: 0, failed: [] },
    });
    expect(sampleLines(fresh, "dispatch_sync_pipeline_state")).toEqual([
      'dispatch_sync_pipeline_state{state="armed"} 1',
      'dispatch_sync_pipeline_state{state="off"} 0',
      'dispatch_sync_pipeline_state{state="unknown"} 0',
    ]);
    expect(sampleLines(fresh, "dispatch_sync_stale")).toEqual(["dispatch_sync_stale 0"]);

    // Stale: 1 — the external driver is judged on its declared cadence.
    const stale = metrics({
      ...external,
      sync: { lastSuccessAt: ago(7200), running: 0, failed: [] },
    });
    expect(sampleLines(stale, "dispatch_sync_stale")).toEqual(["dispatch_sync_stale 1"]);

    // Never synced: absent (A2's absent-series case), never 0.
    const neverSynced = metrics({
      ...external,
      sync: { lastSuccessAt: null, running: 0, failed: [] },
    });
    expect(sampleLines(neverSynced, "dispatch_sync_stale")).toEqual([]);
  });

  it("escapes label values and never emits high-cardinality dimensions", () => {
    const body = metrics({
      issues: [makeIssue({ id: "x", labels: ['status/ready', 'agent/evil"\\name'] })],
    });
    // The agent identity must not appear anywhere (§9); status stays clean.
    expect(body).not.toContain("evil");
    expect(body).toContain('dispatch_issues{status="ready"} 1');
  });

  it("excludes system-emitter identities from execution gauges", () => {
    const body = metrics({
      leases: [makeLease({ agentName: "hosted-groomer", issueId: "g" })],
    });
    expect(sampleLines(body, "dispatch_execution_active")[0]).toBe("dispatch_execution_active 0");
    expect(body).not.toContain("hosted-groomer");
  });

  it("emits null ages as absent series, not zero", () => {
    const body = metrics();
    for (const omitted of [
      "dispatch_issue_oldest_open_claimable_age_seconds",
      "dispatch_pr_fix_oldest_queued_seconds",
      "dispatch_pr_fix_oldest_human_decision_seconds",
      "dispatch_assignment_oldest_known_age_seconds",
      "dispatch_queue_withheld",
    ]) {
      expect(sampleLines(body, omitted), omitted).toEqual([]);
    }
  });

  it("matches the declared family contract on a populated snapshot", () => {
    const body = metrics({
      issues: [makeIssue({ id: "i1" }), makeIssue({ id: "i2", labels: ["status/blocked"] })],
      leases: [makeLease({})],
      prFixItems: [makePrFix({ dispatchedAt: ago(2400), dispatchedGeneration: 1 })],
      auditFailures: [{ action: "set_status", createdAt: ago(60) }],
      admissionMode: "enforce",
    });
    const emitted = new Set(
      body
        .split("\n")
        .filter((l) => l.startsWith("# TYPE "))
        .map((l) => l.split(" ")[2]),
    );
    const declared = new Set(observabilityMetricFamilies());
    for (const name of emitted) {
      expect(declared.has(name), `undeclared family ${name}`).toBe(true);
    }
    // The populated fixture should realize a healthy share of the contract.
    expect(emitted.size).toBeGreaterThan(30);
  });

  it("emits every declared family on a maximally populated snapshot", () => {
    const body = metrics({
      issues: [
        makeIssue({ id: "i1", labels: ["status/ready"] }),
        makeIssue({
          id: "i2",
          number: 2,
          labels: ["status/in-progress", "agent/alpha"],
        }),
        makeIssue({ id: "i3", number: 3, labels: ["status/ready", "agent/beta"], body: "Depends on #4." }),
        makeIssue({ id: "i4", number: 4, labels: ["status/in-progress"] }),
        makeIssue({
          id: "i5",
          number: 5,
          labels: ["status/ready"],
          groomedIssueFingerprint: "fp",
          groomingRetryAfter: ago(-600),
        }),
        makeIssue({
          id: "i6",
          number: 6,
          labels: ["status/ready"],
          groomedIssueFingerprint: "fp",
          groomingStaleAt: ago(120),
          groomingStaleReasons: ["issue_changed"],
        }),
      ],
      leases: [
        makeLease({ agentName: "worker-a", issueId: "i7" }),
        makeLease({ agentName: "worker-b", issueId: "i8", expiredAt: ago(600), createdAt: ago(4000) }),
      ],
      agentWork: [
        makeWork({ agentName: "worker-a", issueId: "i9", createdAt: ago(600) }),
        makeWork({
          agentName: "worker-b",
          issueId: "i8",
          state: "STALE",
          staleClaimReleasePending: true,
          createdAt: ago(4000),
        }),
      ],
      prFixItems: [
        makePrFix({ dispatchedAt: ago(2400), dispatchedGeneration: 1 }),
        makePrFix({ status: "PARKED", outcome: "no_progress" }),
        makePrFix({ status: "BLOCKED", outcome: "human_decision", updatedAt: ago(7200) }),
        makePrFix({ status: "STALE" }),
        makePrFix({ status: "WAITING_EXTERNAL" }),
      ],
      prFixHistory: [
        { action: "reclaim", status: null, at: ago(300) },
        { action: "mark", status: "FIXED", at: ago(300) },
      ],
      agentRuns: [
        { runType: "implement", status: "completed", startedAt: ago(900), createdAt: ago(60) },
        { runType: "implement", status: "failed", startedAt: ago(600), createdAt: ago(120) },
      ],
      auditFailures: [{ action: "set_status", createdAt: ago(60) }],
      assignmentAudit: [{ issueId: "i2", action: "assign_agent", createdAt: ago(2400) }],
      groomingRuns: [{ status: "completed", createdAt: ago(300) }],
      sync: {
        lastSuccessAt: ago(120),
        running: 1,
        failed: [{ syncType: "scheduled", startedAt: ago(600) }],
      },
      admissionMode: "enforce",
    });
    const emitted = new Set(
      body
        .split("\n")
        .filter((l) => l.startsWith("# TYPE "))
        .map((l) => l.split(" ")[2]),
    );
    const missing = observabilityMetricFamilies().filter((name) => !emitted.has(name));
    expect(missing, "declared families that never emitted").toEqual([]);
  });

  it("is deterministic for the same snapshot", () => {
    const overrides = {
      issues: [makeIssue({ id: "i1" })],
      auditFailures: [{ action: "groom", createdAt: ago(30) }],
    };
    expect(metrics(overrides)).toBe(metrics(overrides));
  });
});

describe("observabilityMetricsEnabled", () => {
  it("is fail-closed: off unless the operator sets exactly true", () => {
    expect(observabilityMetricsEnabled({})).toBe(false);
    expect(observabilityMetricsEnabled({ DISPATCH_METRICS_ENABLED: "1" })).toBe(false);
    expect(observabilityMetricsEnabled({ DISPATCH_METRICS_ENABLED: "yes" })).toBe(false);
    expect(observabilityMetricsEnabled({ DISPATCH_METRICS_ENABLED: "TRUE" })).toBe(false);
    expect(observabilityMetricsEnabled({ DISPATCH_METRICS_ENABLED: "true" })).toBe(true);
  });
});
