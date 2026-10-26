import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  evaluateObservabilityAlerts,
  OBSERVABILITY_ALERTS_BY_ID,
} from "@/lib/observability-alerts";
import { exportObservabilityMetrics, observabilityMetricFamilies } from "@/lib/observability-export";
import type { ObservabilitySnapshot } from "@/lib/observability-signals";

// The optional deploy assets under observability/ are renderings of the
// portable catalogue; this suite is the drift contract between them and the
// exporter/evaluator, so an asset can never reference a metric the exporter
// does not emit, arm a disabled catalogue row, or contradict a `for` window.
function repoRoot(): string {
  let dir = path.resolve(import.meta.dirname, "..");
  while (!existsSync(path.join(dir, "observability")) && dir !== path.dirname(dir)) {
    dir = path.dirname(dir);
  }
  return dir;
}

const ROOT = repoRoot();
const rules = readFileSync(path.join(ROOT, "observability/prometheus-rules.yaml"), "utf8");
const dashboardRaw = readFileSync(path.join(ROOT, "observability/grafana-dashboard.json"), "utf8");
const dashboard = JSON.parse(dashboardRaw) as { panels: Array<{ targets?: Array<{ expr?: string }>; title?: string }> };

const EXPORTED = new Set(observabilityMetricFamilies());

function dispatchTokens(text: string): string[] {
  return [...text.matchAll(/dispatch_[a-z0-9_]+/g)].map((m) => m[0]);
}

/** Alert blocks of the rules file: `- alert: A<n>` … until the next alert. */
function alertBlocks(text: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const parts = text.split(/(?=^\s*- alert: A\d+\s*$)/m);
  for (const part of parts) {
    const match = /^\s*- alert: (A\d+)\s*$/m.exec(part);
    if (match) blocks.set(match[1], part);
  }
  return blocks;
}

describe("optional assets match the shipped contracts (#1255)", () => {
  it("the dashboard JSON parses and only queries exported metric families", () => {
    expect(dashboard.panels.length).toBeGreaterThan(20);
    const unknown = new Set<string>();
    for (const panel of dashboard.panels) {
      for (const target of panel.targets ?? []) {
        for (const token of dispatchTokens(target.expr ?? "")) {
          if (!EXPORTED.has(token)) unknown.add(`${token} (${panel.title})`);
        }
      }
    }
    expect([...unknown], "dashboard queries an unexported metric").toEqual([]);
  });

  it("the rules file only references exported metric families", () => {
    // Strip comments so prose mentions of metrics are not treated as queries.
    const queries = rules
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    const unknown = new Set<string>();
    for (const token of dispatchTokens(queries)) {
      if (!EXPORTED.has(token)) unknown.add(token);
    }
    expect([...unknown], "rules reference an unexported metric").toEqual([]);
  });

  it("uses no rate-style function anywhere in the rules or dashboard (§4.1)", () => {
    const offenders: string[] = [];
    const scan = (text: string, where: string) => {
      for (const line of text.split("\n")) {
        if (line.trim().startsWith("#")) continue;
        if (/\b(increase|rate|delta)\s*\(/.test(line)) offenders.push(`${where}: ${line.trim()}`);
      }
    };
    scan(rules, "prometheus-rules.yaml");
    for (const panel of dashboard.panels) {
      for (const target of panel.targets ?? []) scan(target.expr ?? "", `dashboard: ${panel.title}`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps each rule's expression structurally faithful to its catalogue predicate", () => {
    // Required metric legs per alert: the load-bearing conjunction members an
    // operator (or a refactor) must not silently drop from the rendering.
    const REQUIRED_LEGS: Record<string, string[]> = {
      A1: ["dispatch_scheduler_job_overdue"],
      A2: [
        "dispatch_sync_pipeline_state",
        "absent(",
        "dispatch_sync_stale",
        'up{job="dispatch"}',
      ],
      A3: ['up{job="dispatch"}'],
      A4: [
        "dispatch_issues_open_claimable",
        "dispatch_execution_active",
        'dispatch_work_pickups_in_window{window="1800"}',
        'dispatch_agent_runs_reported_in_window{window="1800"}',
        "dispatch_sync_pipeline_state",
        "dispatch_sync_stale",
        "dispatch_scheduler_healthy",
      ],
      A5: ["dispatch_leases_expired", 'dispatch_agent_work{state="STALE"}'],
      A7: ["dispatch_pr_fix_overdue_unacked"],
      A8: ["dispatch_pr_fix_oldest_queued_seconds"],
      A9: ["dispatch_pr_fix_human_decisions", "dispatch_pr_fix_oldest_human_decision_seconds"],
      A10: ['dispatch_queue_withheld{reason=~"grooming_unknown|grooming_stale"}'],
      A11: ["dispatch_grooming_backoff"],
      A12: ['sum(dispatch_audit_failures_in_window{window="900"})'],
      A13: [
        "dispatch_repo_stale_sync_seconds",
        "dispatch_repo_stale_sync_threshold_seconds",
        "dispatch_grooming_backoff",
      ],
    };
    const blocks = alertBlocks(rules);
    const problems: string[] = [];
    for (const [id, legs] of Object.entries(REQUIRED_LEGS)) {
      const block = blocks.get(id);
      if (!block) {
        problems.push(`${id}: no rule block`);
        continue;
      }
      // Block text between `expr:` and `for:` — covers folded (>-) and
      // single-line expressions alike.
      const start = block.indexOf("expr:");
      const end = block.indexOf("for:", start);
      const expr = start >= 0 && end > start ? block.slice(start + 5, end) : "";
      if (!expr.trim()) problems.push(`${id}: no expr found`);
      for (const leg of legs) {
        if (!expr.includes(leg)) problems.push(`${id}: expr missing required leg ${leg}`);
      }
      // Conjunction-heavy predicates must not rely on bare `and`/`or`
      // matching: label sets differ between bare gauges ({job,instance})
      // and aggregate/absent legs, so label-insensitive matching is mandatory
      // — every `and` in these exprs must be `and on(`.
      if (id === "A2" || id === "A4") {
        const bareAnds = expr.match(/\band(?!\s*on\()/g) ?? [];
        if (bareAnds.length > 0) {
          problems.push(`${id}: ${bareAnds.length} bare and(s) without on() label matching`);
        }
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("gates the sync-freshness alerts on the sync-pipeline arm state, not the in-process scheduler", () => {
    // The in-process scheduler is OFF by default while external cron/CronJob
    // drivers are a supported topology: gating A2/A4 on it silenced every
    // sync-freshness alert in exactly the deployments where the pipeline
    // genuinely runs. The arm state (dispatch_sync_pipeline_state) is the
    // declared+derived fact that replaces that inference.
    const blocks = alertBlocks(rules);
    const problems: string[] = [];

    const a2 = blocks.get("A2") ?? "";
    if (!a2.includes('dispatch_sync_pipeline_state{state="armed"}')) {
      problems.push("A2: does not gate on the sync-pipeline arm state");
    }
    if (a2.includes("dispatch_scheduler_up == 1")) {
      problems.push("A2: still gates the pipeline arm on the in-process scheduler");
    }

    const a4 = blocks.get("A4") ?? "";
    if (!a4.includes('dispatch_sync_pipeline_state{state="armed"}')) {
      problems.push("A4: does not gate on the sync-pipeline arm state");
    }
    // The scheduler leg may survive inside the guard's `or` (an external
    // driver has no in-process job to be overdue), but never as a bare
    // `and on()` conjunct that would gate the arm state on it.
    if (/and on\(\)\s*dispatch_scheduler_healthy\s*==\s*1/.test(a4)) {
      problems.push("A4: still gates the pipeline arm on dispatch_scheduler_healthy");
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("renders exactly one active sync-pipeline arm state", () => {
    const snapshot = emptySnapshot();
    const body = exportObservabilityMetrics({
      ...snapshot,
      pipeline: { ...snapshot.pipeline, syncPipelineState: "off" },
    });
    const samples = body
      .split("\n")
      .filter((line) => line.startsWith("dispatch_sync_pipeline_state"));
    expect(samples).toContain('dispatch_sync_pipeline_state{state="armed"} 0');
    expect(samples).toContain('dispatch_sync_pipeline_state{state="off"} 1');
    expect(samples).toContain('dispatch_sync_pipeline_state{state="unknown"} 0');
  });

  it("arms exactly the enabled catalogue rows, with the catalogue severities and for-windows", () => {
    const blocks = alertBlocks(rules);
    const expected = OBSERVABILITY_ALERTS_BY_ID;
    const armedExpected = new Set(
      [...expected.values()].filter((a) => a.enabled).map((a) => a.id),
    );
    expect(new Set(blocks.keys()), "armed rows must equal the enabled catalogue rows").toEqual(
      armedExpected,
    );
    expect(blocks.has("A6"), "A6 is disabled and must never be armed").toBe(false);

    for (const [id, block] of blocks) {
      const definition = expected.get(id)!;
      const severity = /severity:\s*(\w+)/.exec(block)?.[1];
      expect(severity, `${id} severity`).toBe(definition.severity);
      const forValue = /for:\s*(\d+[mh])/.exec(block)?.[1];
      expect(forValue, `${id} for`).toBeDefined();
      const unitMs = forValue!.endsWith("h") ? 3_600_000 : 60_000;
      expect(Number.parseInt(forValue!.slice(0, -1), 10) * unitMs, `${id} for window`).toBe(
        definition.forMs,
      );
    }
  });

  it("evaluator and dashboard agree that healthy idle renders without any alert", () => {
    // A completely idle fleet: the evaluator's replay over the empty snapshot
    // is the non-Courier consumer's contract that the assets display.
    const idle = evaluateObservabilityAlerts(emptySnapshot());
    const armed = idle.filter((a) => a.state === "firing" || a.state === "pending");
    expect(armed).toEqual([]);
  });
});

function emptySnapshot(): ObservabilitySnapshot {
  const now = new Date("2026-10-20T12:00:00Z");
  const ago = (s: number) => new Date(now.getTime() - s * 1000);
  return {
    generatedAt: now.toISOString(),
    source: "dispatch-cache",
    windows: { failures: [900, 3600], activity: [1800, 3600] },
    config: {
      admissionMode: "off",
      schedulerEnabled: true,
      syncIntervalMs: 900_000,
      prFixHandoutTimeoutMs: 1_800_000,
      prFixAckLivenessMs: 24 * 60 * 60 * 1000,
      strandedAssignmentThresholdMs: 1_800_000,
      syncPipeline: "auto",
    },
    workSupply: {
      openIssues: 0,
      byStatus: {},
      byLane: {},
      openClaimable: 0,
      oldestOpenClaimableAgeSeconds: null,
      dependencyBlocked: 0,
      maxIssueStaleSyncSeconds: null,
    },
    execution: {
      assigned: 0,
      activeLeases: 0,
      expiredLeases: 0,
      executionActive: 0,
      agentWorkByState: {},
      agentWorkReleasePending: 0,
      oldestActiveWorkHeartbeatAgeSeconds: null,
      pickupsInWindow: { 1800: 0, 3600: 0 },
      reportedInWindow: { 1800: 0, 3600: 0 },
      startedInWindow: { 1800: 0, 3600: 0 },
      taskRunFailuresInWindow: { 1800: 0, 3600: 0 },
    },
    assignmentObservation: {
      withoutExecutionAggregate: 0,
      ageKnown: 0,
      ageUnknown: 0,
      oldestKnownAgeSeconds: null,
      agedPastThreshold: 0,
      thresholdSeconds: 1800,
      evidenceLookbackSeconds: 30 * 24 * 3600,
    },
    prFix: {
      byStatus: {},
      byLane: {},
      oldestQueuedAgeSeconds: null,
      handouts: {
        unackedAggregate: 0,
        overdueUnacked: 0,
        overdueAcked: 0,
        oldestUnackedHandoutAgeSeconds: null,
        reclaimHistoryInWindow: { 900: 0, 3600: 0 },
      },
      settlement: {
        humanDecisionsBlocked: 0,
        oldestHumanDecisionAgeSeconds: null,
        parkedByOutcome: {},
        stale: 0,
        waitingExternal: 0,
        settledInWindowByStatus: { 900: {}, 3600: {} },
      },
    },
    admission: { mode: "off", notAdmitted: null },
    grooming: { freshness: { fresh: 0, stale: 0, unknown: 0 }, backoff: 0, staleReasons: {}, runsInWindowByStatus: { 900: {}, 3600: {} } },
    pipeline: {
      syncPipelineState: "armed",
      scheduler: {
        enabled: true,
        overdueJobs: 0,
        jobs: [{ name: "sync", intervalMs: 900_000, lastSuccessTimestampSeconds: Math.floor(ago(120).getTime() / 1000), overdue: 0 }],
      },
      sync: {
        lastSuccessTimestampSeconds: Math.floor(ago(120).getTime() / 1000),
        everSucceeded: true,
        secondsSinceLastSuccess: 120,
        running: 0,
        failedInWindowByType: { 900: {}, 3600: {} },
      },
      maxRepoStaleSyncSeconds: 120,
    },
    failures: { auditFailuresInWindowByAction: { 900: {}, 3600: {} } },
    observations: {
      eligibleWorkNotHandedOut: false,
      staleOwnership: false,
      prFixOverdueUnacked: false,
      agedUnpickedAssignments: false,
      neverSyncedSuccessfully: false,
      syncDiscoveryFailing: false,
      schedulerOverdue: false,
      admissionWithholding: null,
    },
  };
}
