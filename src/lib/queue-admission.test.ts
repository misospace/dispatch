import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { computeGroomingIssueFingerprint } from "@/lib/groomer/freshness";
import { resetLaneConfig, setLaneConfig } from "@/lib/lane-config";
import {
  admissionRunIds,
  evaluateQueueAdmission,
  getQueueAdmissionMode,
  loadAdmissionRuns,
  readPlanReadiness,
  withAdmissionAnnotations,
  type AdmissionIssueState,
  type AdmissionRunState,
} from "./queue-admission";

const DIGEST = "sha256:evidence";
const LABELS = ["status/ready", "priority/p2", "type/feature"];

function fingerprintOf(issue: { title: string; body: string | null; labels: string[] }) {
  return computeGroomingIssueFingerprint({ ...issue, state: "open" });
}

/** A ready issue with a fresh, verified baseline from run-1. */
function freshIssue(over: Partial<AdmissionIssueState> = {}): AdmissionIssueState {
  const base = { title: "Add a thing", body: "Body", labels: LABELS };
  return {
    ...base,
    state: "open",
    currentLane: "default",
    groomedRunId: "run-1",
    groomedIssueFingerprint: fingerprintOf(base),
    groomedEvidenceDigest: DIGEST,
    groomedEvidenceScope: "paths",
    groomingStaleAt: null,
    groomingStaleReasons: [],
    groomingVerifiedSha: "a".repeat(40),
    admissionOverrideId: null,
    ...over,
  };
}

function appliedRun(over: Partial<AdmissionRunState> = {}, readiness: Record<string, unknown> = {}): AdmissionRunState {
  return {
    id: "run-1",
    status: "completed",
    stage: "applied",
    dryRun: false,
    validatedOutput: {
      readiness: { ready: true, admission: "implementation", lane: "default", evidenceDigest: DIGEST, reasons: [], ...readiness },
    },
    ...over,
  };
}

function codes(issue: AdmissionIssueState, run: AdmissionRunState | null, extra: { dependencyBlockReason?: string } = {}) {
  return evaluateQueueAdmission(issue, { mode: "enforce", run, ...extra }).reasons.map((r) => r.code);
}

// vitest.setup.ts re-applies its local/cloud/frontier lane config before each test.
afterEach(() => {
  delete process.env.DISPATCH_QUEUE_ADMISSION_MODE;
});

describe("getQueueAdmissionMode", () => {
  it("defaults to off", () => {
    expect(getQueueAdmissionMode()).toBe("off");
  });

  it.each(["off", "audit", "enforce", " Enforce ", "AUDIT"])("parses %j", (value) => {
    process.env.DISPATCH_QUEUE_ADMISSION_MODE = value;
    expect(getQueueAdmissionMode()).toBe(value.trim().toLowerCase());
  });

  it("treats an unrecognised value as off (a typo must not starve the fleet) and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.DISPATCH_QUEUE_ADMISSION_MODE = "strict";
    expect(getQueueAdmissionMode()).toBe("off");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unrecognised"));
    warn.mockRestore();
  });
});

describe("evaluateQueueAdmission", () => {
  it("admits a ready issue with a current, applied, ready, evidence-bound grooming decision", () => {
    const admission = evaluateQueueAdmission(freshIssue(), { mode: "enforce", run: appliedRun() });
    expect(admission).toEqual({
      mode: "enforce",
      admitted: true,
      basis: "grooming",
      reasons: [],
      summary: "",
      groomedRunId: "run-1",
    });
  });

  it("does not gate non-ready statuses (a worker's in-progress work is never stranded)", () => {
    const issue = freshIssue({ labels: ["status/in-progress", "agent/alpha"], groomedIssueFingerprint: null });
    expect(evaluateQueueAdmission(issue, { mode: "enforce", run: null })).toMatchObject({ admitted: true, basis: "not_gated" });
  });

  it("withholds unknown freshness (a bare ready label is not a grooming decision)", () => {
    const issue = freshIssue({ groomedIssueFingerprint: null, groomedRunId: null });
    expect(codes(issue, null)).toEqual(["grooming_unknown"]);
  });

  it("withholds a stale decision and names the stale reasons", () => {
    const issue = freshIssue({ groomingStaleAt: new Date(), groomingStaleReasons: ["human_comment", "evidence_path_changed"] });
    const admission = evaluateQueueAdmission(issue, { mode: "enforce", run: appliedRun() });
    expect(admission.reasons.map((r) => r.code)).toEqual(["grooming_stale"]);
    expect(admission.summary).toContain("human_comment, evidence_path_changed");
  });

  it("withholds when the cached issue changed but the freshness pass has not recorded it yet", () => {
    const issue = freshIssue({ body: "Edited by a human" });
    expect(codes(issue, appliedRun())).toEqual(["grooming_issue_changed"]);
  });

  it("ignores agent/* claim labels in the fingerprint comparison", () => {
    const issue = freshIssue({ labels: [...LABELS, "agent/alpha"] });
    expect(codes(issue, appliedRun())).toEqual([]);
  });

  it("withholds a repository-dependent decision that was never pinned to a verified SHA", () => {
    expect(codes(freshIssue({ groomingVerifiedSha: null }), appliedRun())).toEqual(["grooming_unverified"]);
    expect(codes(freshIssue({ groomingVerifiedSha: null, groomedEvidenceScope: "global" }), appliedRun())).toEqual([
      "grooming_unverified",
    ]);
    expect(codes(freshIssue({ groomingVerifiedSha: null, groomedEvidenceScope: null }), appliedRun())).toEqual([
      "grooming_unverified",
    ]);
  });

  it("does not require a verified SHA when the decision consulted no repository state", () => {
    expect(codes(freshIssue({ groomingVerifiedSha: null, groomedEvidenceScope: "none" }), appliedRun())).toEqual([]);
  });

  it("withholds when the baseline's grooming run is missing", () => {
    expect(codes(freshIssue(), null)).toEqual(["grooming_run_missing"]);
  });

  it("withholds a plan whose readiness is not ready, with the plan's reasons", () => {
    const admission = evaluateQueueAdmission(freshIssue(), {
      mode: "enforce",
      run: appliedRun({}, { ready: false, admission: null, lane: null, reasons: ["verdict is backlog"] }),
    });
    expect(admission.reasons.map((r) => r.code)).toEqual(["grooming_not_ready"]);
    expect(admission.summary).toContain("verdict is backlog");
  });

  it("ignores readiness recorded on a skipped (in-flight) run", () => {
    const skipped = appliedRun({ stage: "skipped" });
    expect(codes(freshIssue(), skipped)).toEqual(["grooming_not_applied"]);
  });

  it("withholds dry-run, failed and non-applied runs", () => {
    expect(codes(freshIssue(), appliedRun({ dryRun: true }))).toEqual(["grooming_not_applied"]);
    expect(codes(freshIssue(), appliedRun({ status: "failed" }))).toEqual(["grooming_not_applied"]);
    expect(codes(freshIssue(), appliedRun({ status: "stale", stage: "validated" }))).toEqual(["grooming_not_applied"]);
  });

  it("withholds a partially applied run", () => {
    expect(codes(freshIssue(), appliedRun({ status: "partial" }))).toEqual(["grooming_partial"]);
  });

  it("withholds a run without structured readiness", () => {
    expect(codes(freshIssue(), appliedRun({ validatedOutput: { summary: "legacy" } }))).toEqual(["grooming_readiness_missing"]);
    expect(codes(freshIssue(), appliedRun({ validatedOutput: null }))).toEqual(["grooming_readiness_missing"]);
  });

  it("withholds a plan bound to different evidence than the baseline", () => {
    expect(codes(freshIssue(), appliedRun({}, { evidenceDigest: "sha256:other" }))).toEqual(["grooming_evidence_mismatch"]);
    expect(codes(freshIssue({ groomedEvidenceDigest: null }), appliedRun())).toEqual(["grooming_evidence_mismatch"]);
  });

  it("reports an open dependency blocker alongside grooming reasons", () => {
    const admission = evaluateQueueAdmission(freshIssue({ groomedIssueFingerprint: null }), {
      mode: "audit",
      run: null,
      dependencyBlockReason: "Blocked by open #5",
    });
    expect(admission.reasons.map((r) => r.code)).toEqual(["dependency_blocked", "grooming_unknown"]);
    expect(admission.admitted).toBe(false);
    expect(admission.mode).toBe("audit");
  });

  it("reports every failing run condition, not just the first", () => {
    const run = appliedRun({ status: "partial" }, { ready: false, reasons: ["verdict is needs_info"], evidenceDigest: "x" });
    expect(codes(freshIssue(), run)).toEqual(["grooming_partial", "grooming_not_ready", "grooming_evidence_mismatch"]);
  });

  describe("escalation admission", () => {
    beforeEach(() => {
      setLaneConfig({
        lanes: [
          { id: "local", title: "Local", claimable: true, role: "default" },
          { id: "frontier", title: "Frontier", claimable: true, role: "escalation" },
          { id: "backlog", title: "Backlog", claimable: false },
        ],
      });
    });

    it("admits escalation-ready work on the escalation lane", () => {
      const run = appliedRun({}, { admission: "escalation", lane: "frontier" });
      expect(codes(freshIssue({ currentLane: "frontier" }), run)).toEqual([]);
    });

    it("withholds escalation-ready work moved onto the default lane", () => {
      const run = appliedRun({}, { admission: "escalation", lane: "frontier" });
      expect(codes(freshIssue({ currentLane: "local" }), run)).toEqual(["escalation_lane_mismatch"]);
    });

    it("admits implementation-ready work on either lane", () => {
      expect(codes(freshIssue({ currentLane: "frontier" }), appliedRun())).toEqual([]);
    });
  });

  it("admits escalation-ready work in a single-lane install (the escalation lane is the default lane)", () => {
    resetLaneConfig();
    const run = appliedRun({}, { admission: "escalation", lane: "default" });
    expect(codes(freshIssue({ currentLane: "default" }), run)).toEqual([]);
  });

  describe("operator override", () => {
    const override = () =>
      freshIssue({ groomedRunId: "override_1", admissionOverrideId: "override_1", groomedEvidenceDigest: null, groomedEvidenceScope: "global" });

    it("admits a current override without any grooming run", () => {
      const admission = evaluateQueueAdmission(override(), { mode: "enforce", run: null });
      expect(admission).toMatchObject({ admitted: true, basis: "override", groomedRunId: "override_1" });
    });

    it("is freshness-bound: a stale override is withheld", () => {
      const issue = { ...override(), groomingStaleAt: new Date(), groomingStaleReasons: ["global_evidence_commit"] };
      expect(codes(issue, null)).toEqual(["grooming_stale"]);
    });

    it("is freshness-bound: an issue edit after the override withholds it", () => {
      expect(codes({ ...override(), title: "Changed" }, null)).toEqual(["grooming_issue_changed"]);
    });

    it("is superseded once a later groom replaces the baseline", () => {
      const issue = freshIssue({ groomedRunId: "run-2", admissionOverrideId: "override_1" });
      const run = appliedRun({ id: "run-2" }, { ready: false, reasons: ["verdict is backlog"] });
      expect(codes(issue, run)).toEqual(["grooming_not_ready"]);
    });

    it("never bypasses a dependency blocker", () => {
      expect(codes(override(), null, { dependencyBlockReason: "Blocked by open #5" })).toEqual(["dependency_blocked"]);
    });
  });
});

describe("readPlanReadiness", () => {
  it("reads #1062 readiness tolerantly", () => {
    expect(readPlanReadiness({ readiness: { ready: true, admission: "implementation", lane: "x", evidenceDigest: "d", reasons: [] } })).toEqual({
      ready: true,
      admission: "implementation",
      lane: "x",
      evidenceDigest: "d",
      reasons: [],
    });
    expect(readPlanReadiness({ readiness: { ready: "yes" } })).toBeNull();
    expect(readPlanReadiness("nope")).toBeNull();
  });
});

describe("loadAdmissionRuns", () => {
  it("looks up only the runs ready issues' baselines point at, by primary key", async () => {
    const findMany = vi.fn().mockResolvedValue([appliedRun()]);
    const client = { groomingRun: { findMany } } as never;
    const issues = [
      freshIssue(),
      freshIssue({ groomedRunId: "run-2", labels: ["status/in-progress"] }),
      freshIssue({ groomedRunId: "override_1", admissionOverrideId: "override_1" }),
      freshIssue({ groomedRunId: null }),
    ];
    expect(admissionRunIds(issues)).toEqual(["run-1"]);
    const runs = await loadAdmissionRuns(issues, client);
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ["run-1"] } },
      select: { id: true, status: true, stage: true, dryRun: true, validatedOutput: true },
    });
    expect(runs.get("run-1")?.status).toBe("completed");
  });

  it("skips the query when no ready issue has a groomer baseline", async () => {
    const findMany = vi.fn();
    await loadAdmissionRuns([freshIssue({ groomedRunId: null })], { groomingRun: { findMany } } as never);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("withAdmissionAnnotations", () => {
  it("returns the board issues untouched when admission is off", async () => {
    const issues = [{ ...freshIssue({ groomedIssueFingerprint: null }), state: "open" }];
    const result = await withAdmissionAnnotations(issues, {} as never);
    expect(result).toBe(issues);
    expect(result[0]).not.toHaveProperty("admissionWithheldReason");
  });

  it("annotates withheld open ready issues by mode", async () => {
    const findMany = vi.fn().mockResolvedValue([appliedRun()]);
    const client = { groomingRun: { findMany } } as never;
    const issues = [
      { ...freshIssue(), state: "open" },
      { ...freshIssue({ groomedIssueFingerprint: null, groomedRunId: null }), state: "open" },
      { ...freshIssue({ groomedIssueFingerprint: null }), state: "closed" },
    ];

    process.env.DISPATCH_QUEUE_ADMISSION_MODE = "audit";
    const audit = await withAdmissionAnnotations(issues, client);
    expect(audit.map((i) => i.admissionWithheldReason)).toEqual([
      null,
      expect.stringMatching(/^Would be withheld from workers \(audit\): No current grooming decision/),
      null,
    ]);

    process.env.DISPATCH_QUEUE_ADMISSION_MODE = "enforce";
    const enforce = await withAdmissionAnnotations(issues, client);
    expect(enforce[1].admissionWithheldReason).toMatch(/^Withheld from workers: /);
  });
});
