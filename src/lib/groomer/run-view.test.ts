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
    expect(view.evidence.sources).toEqual([
      { kind: "repository", path: "src/a.ts", via: "read", ref: HEAD },
      {
        kind: "github_pull_request",
        key: "github:pr:org/repo#12",
        state: "open",
        url: "https://github.com/org/repo/pull/12",
        via: "read",
        observedAt: "2026-10-10T00:00:00.000Z",
        closes: [],
      },
    ]);

    expect(view.plan.schemaVersion).toBe(1);
    expect(view.plan.format).toBe("grooming-plan");
    expect(view.plan.actionability).toBe("ready");
    expect(view.plan.ready).toBe(true);
    expect(view.plan.gapClass).toBeNull();
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
    expect(view.decision.readyPromotion?.confidence).toBe("high");
    expect(view.decision.readyPromotion?.evidenceRefs).toEqual(["issue", "repo:src/a.ts"]);
    expect(view.decision.decomposition).toBeNull();
  });

  it("surfaces the resolved gap class of a needs_info plan (dispatch#1452)", () => {
    const run = appliedPlanRun({
      validatedOutput: {
        schemaVersion: 1,
        verdict: { actionability: "needs_info", summary: "waiting", lane: { id: "backlog" } },
        readiness: {
          ready: false,
          admission: null,
          gapClass: "investigation_incomplete",
          reasons: ["verdict is needs_info", "investigation incomplete (tool_failure:search_code): which page?"],
        },
      },
    });

    const view = buildGroomingRunView(run);
    expect(view.plan.format).toBe("grooming-plan");
    expect(view.plan.actionability).toBe("needs_info");
    expect(view.plan.ready).toBe(false);
    expect(view.plan.gapClass).toBe("investigation_incomplete");
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
      confidence: null,
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
      confidence: null,
      evidenceRefs: [],
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

  it("surfaces decision confidence for close, ready and decomposition, unknown for legacy", () => {
    const verdict = {
      actionability: "already_done",
      summary: "done",
      confidence: "high",
      evidenceRefs: ["issue", "repo:src/a.ts"],
    };

    const closeRun = appliedPlanRun({
      validatedOutput: {
        schemaVersion: 1,
        verdict,
        readiness: { ready: false, admission: null, lane: "backlog", evidenceDigest: DIGEST, reasons: ["already_done"] },
        mutations: {
          close: { reason: "already_done", rationale: "done", evidenceRefs: ["repo:src/a.ts"], criteria: [] },
        },
        decomposition: { required: false, reason: null, childBriefs: [] },
      },
      mutationPlan: {
        planSchemaVersion: 1,
        evidenceDigest: DIGEST,
        closeRecommendation: { reason: "already_done", rationale: "done", evidenceRefs: ["repo:src/a.ts"] },
        willCreateChildren: false,
        applicationKey: "app-key-close",
      },
      applyOutcome: "applied",
    });
    const closeView = buildGroomingRunView(closeRun);
    expect(closeView.decision.close?.confidence).toBe("high");
    expect(closeView.decision.readyPromotion).toBeNull();
    expect(closeView.decision.decomposition).toBeNull();

    const readyRun = appliedPlanRun({
      validatedOutput: {
        schemaVersion: 1,
        verdict: { ...verdict, actionability: "ready", confidence: "medium" },
        readiness: { ready: true, admission: "implementation", lane: "local", evidenceDigest: DIGEST, reasons: [] },
        mutations: { close: null },
        decomposition: { required: false, reason: null, childBriefs: [] },
      },
    });
    expect(buildGroomingRunView(readyRun).decision.readyPromotion?.confidence).toBe("medium");

    const decomposeRun = appliedPlanRun({
      mutationPlan: {
        planSchemaVersion: 1,
        willCreateChildren: true,
        applicationKey: "app-key-decomp",
      },
      validatedOutput: {
        schemaVersion: 1,
        verdict: { ...verdict, actionability: "backlog", confidence: "low" },
        decomposition: { required: true, reason: "umbrella", childBriefs: [] },
      },
      appliedMutations: {
        outcome: "applied",
        steps: {},
        childrenCreated: [{ number: 1300, url: "https://github.com/org/repo/issues/1300" }],
        childrenReused: [],
      },
    });
    const decomposeView = buildGroomingRunView(decomposeRun);
    expect(decomposeView.decision.decomposition?.confidence).toBe("low");
    expect(decomposeView.decision.decomposition?.evidenceRefs).toEqual(["issue", "repo:src/a.ts"]);

    // Unknown: verdict carries an out-of-contract value (degraded/legacy output).
    const unknownRun = appliedPlanRun({
      validatedOutput: {
        schemaVersion: 1,
        verdict: { actionability: "ready", summary: "x", confidence: "certain", evidenceRefs: ["issue"] },
        readiness: { ready: true, admission: "implementation", lane: "local", evidenceDigest: DIGEST, reasons: [] },
        mutations: { close: null },
        decomposition: { required: false, reason: null, childBriefs: [] },
      },
    });
    expect(buildGroomingRunView(unknownRun).decision.readyPromotion?.confidence).toBeNull();

    // Unknown: no verdict at all (legacy shape) but a persisted plan decision.
    const legacyCloseRun = appliedPlanRun({
      validatedOutput: { actionability: "already_done", summary: "legacy" },
      mutationPlan: {
        planSchemaVersion: 1,
        evidenceDigest: DIGEST,
        closeRecommendation: { reason: "already_done", rationale: "legacy close", evidenceRefs: ["repo:src/a.ts"] },
        willCreateChildren: false,
        applicationKey: "app-key-legacy-close",
      },
      applyOutcome: "applied",
    });
    expect(buildGroomingRunView(legacyCloseRun).decision.close?.confidence).toBeNull();
  });

  it("preserves bounded source identities with attribution", () => {
    const run = appliedPlanRun({
      contextSummary: evidenceSummary({
        sources: [
          { path: "src/pinned.ts", provenance: "repository", via: "read", ref: HEAD },
          { path: "src/surfaced.ts", provenance: "repository", via: "surfaced", ref: null },
          {
            key: "github:pr:org/repo#12",
            provenance: "github_pull_request",
            state: "merged",
            url: "https://github.com/org/repo/pull/12",
            via: "read",
            observedAt: "2026-10-10T00:00:00.000Z",
            ref: null,
            closes: ["owner/repo#7", "owner/repo#8"],
          },
          { key: "github:issue:org/repo#3", provenance: "github_issue", state: "open", url: null, via: "search", observedAt: "2026-10-10T01:00:00.000Z", ref: null },
        ],
      }),
    });

    const view = buildGroomingRunView(run);
    expect(view.evidence.sources).toEqual([
      { kind: "repository", path: "src/pinned.ts", via: "read", ref: HEAD },
      { kind: "repository", path: "src/surfaced.ts", via: "surfaced", ref: null },
      {
        kind: "github_pull_request",
        key: "github:pr:org/repo#12",
        state: "merged",
        url: "https://github.com/org/repo/pull/12",
        via: "read",
        observedAt: "2026-10-10T00:00:00.000Z",
        closes: ["owner/repo#7", "owner/repo#8"],
      },
      {
        kind: "github_issue",
        key: "github:issue:org/repo#3",
        state: "open",
        url: null,
        via: "search",
        observedAt: "2026-10-10T01:00:00.000Z",
        closes: [],
      },
    ]);
  });

  it("bounds the source list and drops unknown provenance shapes", () => {
    const run = appliedPlanRun({
      contextSummary: evidenceSummary({
        sources: [
          ...Array.from({ length: 15 }, (_, i) => ({ path: `src/f${i}.ts`, provenance: "repository", via: "read", ref: HEAD })),
          ...Array.from({ length: 10 }, (_, i) => ({ key: `github:issue:${i}`, provenance: "github_issue", state: "open", url: null, via: "search", observedAt: "2026-10-10T00:00:00.000Z", ref: null })),
          { provenance: "mystery", data: "whatever" },
          "not-an-object",
        ],
      }),
    });

    const view = buildGroomingRunView(run);
    expect(view.evidence.sources).toHaveLength(20);
    expect(view.evidence.sources.every((source) => source.kind !== ("mystery" as never))).toBe(true);
    expect(view.evidence.repositoryReadCount).toBe(15);
    expect(view.evidence.relatedWorkCount).toBe(10);
  });

  it("normalizes Prisma Date application timestamps to JSON-safe ISO strings", () => {
    const run = appliedPlanRun({
      status: "completed",
      applyOutcome: "applied",
      _count: { applications: 2 },
      applications: [
        { id: "app-1", status: "applied", attempts: 1, createdAt: new Date("2026-10-09T00:00:00.000Z"), updatedAt: new Date("2026-10-09T00:00:00.000Z") },
        { id: "app-2", status: "applied", attempts: 1, createdAt: new Date("2026-10-08T00:00:00.000Z"), updatedAt: new Date("2026-10-08T00:00:00.000Z") },
      ],
    });

    const view = buildGroomingRunView(run);
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
    expect(view.evidence.sources).toEqual([]);
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
    // The source identity survives (bounded redaction), but its content does not.
    expect(view.evidence.sources).toEqual([{ kind: "repository", path: "src/a.ts", via: "read", ref: HEAD }]);
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
    expect(view.evidence.sources).toHaveLength(20);
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
    expect(serialized).not.toHaveProperty("validatedOutput");
    expect(serialized).not.toHaveProperty("mutationPlan");
    expect(serialized).not.toHaveProperty("appliedMutations");
    expect(serialized).not.toHaveProperty("applications");
    expect(serialized).toHaveProperty("view");
    // The verdict cell renders from the view's plan summary alone.
    const view = serialized.view as {
      evidence: { headSha: string | null };
      plan: { format: string; actionability: string | null; ready: boolean | null; citationCount: number };
    };
    expect(view.evidence.headSha).toBe(HEAD);
    expect(view.plan.format).toBe("grooming-plan");
    expect(view.plan.actionability).toBe("ready");
    expect(view.plan.ready).toBe(true);
    expect(typeof view.plan.citationCount).toBe("number");
  });

  it("never leaks proposed bodies or comment drafts through list rows", () => {
    const run = appliedPlanRun({
      validatedOutput: {
        schemaVersion: 1,
        verdict: { actionability: "ready", confidence: "high", summary: "Ready to implement" },
        mutations: {
          proposedTitle: "secret title",
          proposedBody: "proposed body text",
          githubComment: "comment body text",
          close: { reason: "already_done", rationale: "close criterion excerpt text" },
        },
        childBriefs: [{ title: "child brief", body: "child brief body" }],
      },
      rawOutput: "raw model output text",
      commentBodyPreview: "comment preview text",
      contextSummary: { evidence: { issueFingerprint: "fp" }, commentBodies: ["comment body text"] },
      appliedMutations: { outcome: "applied", appliedBody: "applied body text" },
    });
    const serialized = JSON.stringify(serializeGroomingRunSummary(run));

    expect(serialized).not.toContain("proposed body text");
    expect(serialized).not.toContain("comment body text");
    expect(serialized).not.toContain("raw model output text");
    expect(serialized).not.toContain("comment preview text");
    expect(serialized).not.toContain("applied body text");
    // The operator verdict summary still renders.
    const view = (JSON.parse(serialized) as { view: { plan: { format: string; actionability: string | null } } }).view;
    expect(view.plan.format).toBe("grooming-plan");
    expect(view.plan.actionability).toBe("ready");
  });

  it("derives lastApplicationAt from a latest-application list include", () => {
    const run = appliedPlanRun({
      applications: [{ id: "app-9", status: "applied", createdAt: "2026-10-11T00:00:00.000Z" }],
      _count: { applications: 3 },
    });
    const serialized = serializeGroomingRunSummary(run) as {
      view: { application: { applicationCount: number | null; lastApplicationAt: string | null } };
    };
    expect(serialized.view.application.lastApplicationAt).toBe("2026-10-11T00:00:00.000Z");
    // Count still comes from `_count`, not the single included row.
    expect(serialized.view.application.applicationCount).toBe(3);
  });

  it("passes through non-object rows safely", () => {
    const serialized = serializeGroomingRunSummary(null) as Record<string, unknown>;
    expect(serialized).toHaveProperty("view");
    expect((serialized.view as { evidence: { available: boolean } }).evidence.available).toBe(false);
  });
});
