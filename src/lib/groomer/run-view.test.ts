import { describe, expect, it } from "vitest";

import { buildGroomingRunView, serializeGroomingRunSummary } from "./run-view";

const HEAD = "a".repeat(40);
const DIGEST = "b".repeat(64);
const FINGERPRINT = "c".repeat(64);

function evidenceSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evidence: {
      capturedAt: "2026-10-10T00:00:00.000Z",
      defaultBranch: "main",
      headSha: HEAD,
      pinnedRef: HEAD,
      evidenceDigest: DIGEST,
      issueFingerprint: FINGERPRINT,
      issueUpdatedAt: "2026-10-09T00:00:00.000Z",
      issueState: "open",
      commentCount: 3,
      humanCommentCount: 2,
      automationCommentCount: 1,
      commentProvenance: [],
      sourceCount: 2,
      sources: [
        { path: "src/a.ts", provenance: "repository", via: "read", ref: HEAD },
        { key: "github:pr:org/repo#12", provenance: "github_pull_request", state: "open", url: "https://github.com/org/repo/pull/12", via: "read", observedAt: "2026-10-10T00:00:00.000Z", ref: null },
      ],
      warnings: [],
      ...overrides,
    },
  };
}

function appliedPlanRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run-1",
    status: "completed",
    stage: "applied",
    dryRun: false,
    contextSummary: evidenceSummary(),
    validatedOutput: {
      schemaVersion: 1,
      verdict: {
        actionability: "ready",
        workType: "implementation",
        confidence: "high",
        lane: { id: "local", confidence: "high", reason: "scoped" },
        summary: "Ready to implement",
        evidenceRefs: ["issue", `repo:src/a.ts`],
        uncertainties: [],
      },
      readiness: { ready: true, admission: "implementation", lane: "local", evidenceDigest: DIGEST, reasons: [] },
      mutations: {
        labelsToAdd: ["status/ready"],
        labelsToRemove: [],
        proposedTitle: null,
        proposedBody: null,
        githubComment: null,
        close: null,
      },
      decomposition: { required: false, reason: null, childBriefs: [] },
      citations: [],
    },
    mutationPlan: {
      labelsToAdd: ["status/ready"],
      labelsToRemove: [],
      lane: { id: "local" },
      summary: "Ready to implement",
      willCloseIssue: false,
      willCreateChildren: false,
      planSchemaVersion: 1,
      evidenceDigest: DIGEST,
      readiness: { ready: true, admission: "implementation", lane: "local", evidenceDigest: DIGEST, reasons: [] },
      closeRecommendation: null,
      applicationKey: "app-key-1",
    },
    preconditions: {
      ok: true,
      checks: [
        { name: "issue", status: "passed", detail: "title, body, labels and state unchanged" },
        { name: "head", status: "passed", detail: "main head unchanged" },
      ],
    },
    preconditionFailures: [],
    applyOutcome: "applied",
    applicationKey: "app-key-1",
    appliedMutations: {
      outcome: "applied",
      steps: {},
      labelsUpdated: true,
    },
    _count: { applications: 1 },
    ...overrides,
  };
}

describe("buildGroomingRunView", () => {
  it("summarizes a current applied plan-format run", () => {
    const view = buildGroomingRunView(appliedPlanRun());

    expect(view.stage).toBe("applied");
    expect(view.status).toBe("completed");

    expect(view.evidence.available).toBe(true);
    expect(view.evidence.headSha).toBe(HEAD);
    expect(view.evidence.pinnedRef).toBe(HEAD);
    expect(view.evidence.pinned).toBe(true);
    expect(view.evidence.defaultBranch).toBe("main");
    expect(view.evidence.evidenceDigest).toBe(DIGEST);
    expect(view.evidence.issueFingerprint).toBe(FINGERPRINT);
    expect(view.evidence.capturedAt).toBe("2026-10-10T00:00:00.000Z");
    expect(view.evidence.repositoryReadCount).toBe(1);
    expect(view.evidence.repositorySurfacedCount).toBe(0);
    expect(view.evidence.relatedWorkCount).toBe(1);
    expect(view.evidence.humanCommentCount).toBe(2);
    expect(view.evidence.automationCommentCount).toBe(1);

    expect(view.plan.schemaVersion).toBe(1);
    expect(view.plan.format).toBe("grooming-plan");
    expect(view.plan.actionability).toBe("ready");
    expect(view.plan.ready).toBe(true);
    expect(view.plan.admission).toBe("implementation");

    expect(view.precondition.recorded).toBe(true);
    expect(view.precondition.ok).toBe(true);
    expect(view.precondition.failures).toEqual([]);
    expect(view.precondition.checks).toEqual([
      { name: "issue", status: "passed", detail: "title, body, labels and state unchanged" },
      { name: "head", status: "passed", detail: "main head unchanged" },
    ]);
    expect(view.precondition.stale).toBe(false);

    expect(view.application.freshApplication).toBe(true);
    expect(view.application.replayed).toBe(false);
    expect(view.application.applicationKey).toBe("app-key-1");
    expect(view.application.applyOutcome).toBe("applied");
    expect(view.application.applicationCount).toBe(1);

    expect(view.decision.close).toBeNull();
    expect(view.decision.readyPromotion).not.toBeNull();
    expect(view.decision.readyPromotion?.admission).toBe("implementation");
    expect(view.decision.readyPromotion?.evidenceRefs).toEqual(["issue", "repo:src/a.ts"]);
    expect(view.decision.decomposition).toBeNull();
  });

  it("surfaces close justification with evidence refs", () => {
    const run = appliedPlanRun({
      validatedOutput: {
        schemaVersion: 1,
        verdict: { actionability: "already_done", summary: "done", evidenceRefs: ["issue"] },
        readiness: { ready: false, admission: null, lane: "backlog", evidenceDigest: DIGEST, reasons: ["already_done"] },
        mutations: {
          close: {
            reason: "already_done",
            rationale: "Acceptance criteria verified at pinned head",
            evidenceRefs: ["repo:src/a.ts"],
            criteria: [],
          },
        },
        decomposition: { required: false, reason: null, childBriefs: [] },
      },
      mutationPlan: {
        planSchemaVersion: 1,
        evidenceDigest: DIGEST,
        closeRecommendation: {
          reason: "already_done",
          rationale: "Acceptance criteria verified at pinned head",
          evidenceRefs: ["repo:src/a.ts"],
        },
        willCreateChildren: false,
        applicationKey: "app-key-close",
      },
      applyOutcome: "applied",
    });

    const view = buildGroomingRunView(run);
    expect(view.decision.close).toEqual({
      reason: "already_done",
      rationale: "Acceptance criteria verified at pinned head",
      evidenceRefs: ["repo:src/a.ts"],
    });
    expect(view.decision.readyPromotion).toBeNull();
  });

  it("surfaces decomposition with child links from appliedMutations", () => {
    const run = appliedPlanRun({
      mutationPlan: {
        planSchemaVersion: 1,
        willCreateChildren: true,
        applicationKey: "app-key-2",
      },
      validatedOutput: {
        schemaVersion: 1,
        verdict: { actionability: "backlog", summary: "umbrella" },
        decomposition: { required: true, reason: "parent audit issue needs splitting", childBriefs: [] },
      },
      appliedMutations: {
        outcome: "applied",
        steps: {},
        childrenCreated: [
          { number: 1300, url: "https://github.com/org/repo/issues/1300" },
          { number: 1301, url: "https://github.com/org/repo/issues/1301" },
        ],
        childrenReused: [{ number: 1290, url: "https://github.com/org/repo/issues/1290" }],
      },
    });

    const view = buildGroomingRunView(run);
    expect(view.decision.decomposition).toEqual({
      required: true,
      reason: "parent audit issue needs splitting",
      childrenCreated: [
        { number: 1300, url: "https://github.com/org/repo/issues/1300" },
        { number: 1301, url: "https://github.com/org/repo/issues/1301" },
      ],
      childrenReused: [{ number: 1290, url: "https://github.com/org/repo/issues/1290" }],
    });
  });

  it("surfaces a stale-aborted run and what changed", () => {
    const run = appliedPlanRun({
      status: "stale",
      stage: "validated",
      applyOutcome: "stale",
      preconditions: {
        ok: false,
        checks: [
          { name: "issue", status: "changed", detail: "issue changed since the evidence snapshot: labels" },
          { name: "head", status: "passed", detail: "main head unchanged" },
        ],
      },
      preconditionFailures: ["issue changed since the evidence snapshot: labels"],
      appliedMutations: { outcome: "stale", steps: {}, preconditionFailures: ["issue changed since the evidence snapshot: labels"] },
    });

    const view = buildGroomingRunView(run);
    expect(view.precondition.ok).toBe(false);
    expect(view.precondition.stale).toBe(true);
    expect(view.precondition.failures).toEqual(["issue changed since the evidence snapshot: labels"]);
    expect(view.precondition.checks[0]).toEqual({
      name: "issue",
      status: "changed",
      detail: "issue changed since the evidence snapshot: labels",
    });
    expect(view.application.freshApplication).toBe(false);
    expect(view.application.applyOutcome).toBe("stale");
  });

  it("marks unverifiable preconditions", () => {
    const run = appliedPlanRun({
      status: "failed",
      applyOutcome: "unverifiable",
      preconditions: { ok: false, checks: [{ name: "issue", status: "unverifiable", detail: "failed to re-read the live issue" }] },
      preconditionFailures: ["issue: failed to re-read the live issue"],
    });

    const view = buildGroomingRunView(run);
    expect(view.precondition.unverifiable).toBe(true);
    expect(view.precondition.stale).toBe(false);
  });

  it("marks a replayed run as distinct from a fresh application", () => {
    const run = appliedPlanRun({
      status: "completed",
      applyOutcome: "replayed",
      _count: { applications: 2 },
      applications: [
        { id: "app-1", status: "applied", attempts: 1, createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z" },
        { id: "app-2", status: "applied", attempts: 1, createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z" },
      ],
    });

    const view = buildGroomingRunView(run);
    expect(view.application.replayed).toBe(true);
    expect(view.application.freshApplication).toBe(false);
    expect(view.application.applicationCount).toBe(2);
    expect(view.application.lastApplicationAt).toBe("2026-10-09T00:00:00.000Z");
  });

  it("degrades a legacy run without evidence or plan JSON", () => {
    const view = buildGroomingRunView({
      id: "run-legacy",
      status: "completed",
      stage: "applied",
      validatedOutput: { actionability: "ready", lane: { id: "local" }, summary: "legacy" },
      contextSummary: { findings: "old shape" },
    });

    expect(view.evidence.available).toBe(false);
    expect(view.evidence.pinned).toBe(false);
    expect(view.evidence.warnings).toEqual([]);
    expect(view.plan.format).toBe("legacy");
    expect(view.plan.actionability).toBe("ready");
    expect(view.plan.schemaVersion).toBeNull();
    expect(view.precondition.recorded).toBe(false);
    expect(view.precondition.ok).toBeNull();
    expect(view.application.replayed).toBe(false);
    expect(view.application.applicationCount).toBeNull();
    expect(view.decision.close).toBeNull();
    expect(view.decision.readyPromotion).toBeNull();
    expect(view.decision.decomposition).toBeNull();
  });

  it("marks unpinned evidence when headSha is null", () => {
    const run = appliedPlanRun({
      contextSummary: evidenceSummary({ headSha: null, pinnedRef: null }),
    });

    const view = buildGroomingRunView(run);
    expect(view.evidence.available).toBe(true);
    expect(view.evidence.pinned).toBe(false);
    expect(view.evidence.headSha).toBeNull();
  });

  it("does not leak bodies, raw output or file contents", () => {
    const run = appliedPlanRun({
      rawOutput: { RAW_OUTPUT: "full raw model output" },
      commentBodyPreview: "comment body text",
      contextSummary: evidenceSummary({
        sources: [{ path: "src/a.ts", provenance: "repository", via: "read", ref: HEAD, body: "full file contents" }],
      }),
      validatedOutput: JSON.parse(
        JSON.stringify(appliedPlanRun().validatedOutput),
      ),
    });
    (run.validatedOutput as Record<string, unknown>).mutations = {
      ...(run.validatedOutput as Record<string, unknown>).mutations as Record<string, unknown>,
      proposedBody: "proposed body text",
      githubComment: "comment body text",
    };

    const view = buildGroomingRunView(run);
    const json = JSON.stringify(view);
    expect(json).not.toContain("RAW OUTPUT");
    expect(json).not.toContain("comment body text");
    expect(json).not.toContain("proposed body text");
    expect(json).not.toContain("full file contents");
  });

  it("clips and bounds oversized strings and arrays", () => {
    const run = appliedPlanRun({
      contextSummary: evidenceSummary({
        warnings: Array.from({ length: 30 }, (_, i) => `warn-${i}`),
        sources: [
          ...Array.from({ length: 10 }, (_, i) => ({ path: `src/f${i}.ts`, provenance: "repository", via: "read", ref: HEAD })),
          ...Array.from({ length: 10 }, (_, i) => ({ key: `github:issue:${i}`, provenance: "github_issue", state: "open", url: null, via: "search", observedAt: "2026-10-10T00:00:00.000Z", ref: null })),
        ],
      }),
      mutationPlan: {
        planSchemaVersion: 1,
        closeRecommendation: { reason: "already_done", rationale: "x".repeat(1000), evidenceRefs: Array.from({ length: 30 }, (_, i) => `ref-${i}`) },
      },
    });

    const view = buildGroomingRunView(run);
    expect(view.evidence.warnings).toHaveLength(20);
    expect(view.evidence.repositoryReadCount).toBe(10);
    expect(view.evidence.relatedWorkCount).toBe(10);
    expect(view.decision.close?.rationale.length).toBeLessThanOrEqual(400);
    expect(view.decision.close?.evidenceRefs).toHaveLength(20);
  });

  it("does not throw on malformed inputs", () => {
    expect(() => buildGroomingRunView(null)).not.toThrow();
    expect(() => buildGroomingRunView("nope")).not.toThrow();
    expect(() => buildGroomingRunView(42)).not.toThrow();

    const view = buildGroomingRunView({
      contextSummary: { evidence: "not-an-object" },
      validatedOutput: "corrupt",
      mutationPlan: 7,
      preconditions: "broken",
      preconditionFailures: "not-an-array",
      appliedMutations: [],
      applications: "not-an-array",
      _count: "nope",
    });
    expect(view.evidence.available).toBe(false);
    expect(view.plan.format).toBe("unknown");
    expect(view.precondition.recorded).toBe(false);
    expect(view.application.applicationCount).toBeNull();
  });
});

describe("serializeGroomingRunSummary", () => {
  it("strips heavy debug fields and attaches the view", () => {
    const serialized = serializeGroomingRunSummary(appliedPlanRun()) as Record<string, unknown>;

    expect(serialized).not.toHaveProperty("rawOutput");
    expect(serialized).not.toHaveProperty("contextSummary");
    expect(serialized).not.toHaveProperty("commentBodyPreview");
    expect(serialized).toHaveProperty("view");
    const view = serialized.view as { evidence: { headSha: string | null } };
    expect(view.evidence.headSha).toBe(HEAD);
    // validatedOutput stays so the UI verdict cell keeps working.
    expect(serialized).toHaveProperty("validatedOutput");
    expect(serialized).toHaveProperty("mutationPlan");
  });

  it("passes through non-object rows safely", () => {
    const serialized = serializeGroomingRunSummary(null) as Record<string, unknown>;
    expect(serialized).toHaveProperty("view");
    expect((serialized.view as { evidence: { available: boolean } }).evidence.available).toBe(false);
  });
});
