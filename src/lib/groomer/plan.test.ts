import { describe, expect, it } from "vitest";
import { setLaneConfig } from "@/lib/lane-config";
import type { GroomingEvidenceSnapshot } from "./evidence-snapshot";
import { buildEvidenceCatalog, type EvidenceCatalog } from "./plan-evidence";
import {
  GROOMING_PLAN_SCHEMA_VERSION,
  PLAN_LIMITS,
  evaluateReadiness,
  toGroomerOutput,
  validateGroomingPlan,
  type GroomingPlan,
  type GroomingPlanDraft,
} from "./plan";

function snapshot(overrides: Partial<GroomingEvidenceSnapshot> = {}): GroomingEvidenceSnapshot {
  return {
    capturedAt: "2026-09-26T00:00:00.000Z",
    repoFullName: "org/repo",
    defaultBranch: "main",
    headSha: "abc123def4567890",
    pinnedRef: "abc123def4567890",
    issue: {
      number: 42,
      title: "Fix login redirect after password reset",
      body: "Login fails after password reset.",
      labels: ["priority/p1"],
      state: "open",
      updatedAt: "2026-09-25T00:00:00.000Z",
      url: "https://github.com/org/repo/issues/42",
    },
    issueFingerprint: "fp-1",
    comments: [
      { id: "101", author: "alice", createdAt: "2026-09-24T00:00:00Z", body: "Repro: reset then log in.", provenance: "human_comment", authoritative: true },
      { id: "102", author: "itsmiso-ai", createdAt: "2026-09-24T01:00:00Z", body: "Grooming: backlog.", provenance: "automation_comment", authoritative: false },
    ],
    evidenceDigest: "digest-1",
    warnings: [],
    sources: [
      { path: "src/auth/login.ts", provenance: "repository", via: "read", ref: "abc123def4567890" },
      { path: "src/auth/session.ts", provenance: "repository", via: "read", ref: "abc123def4567890" },
      {
        key: "github:pr:org/repo#12",
        provenance: "github_pull_request",
        state: "merged",
        url: "https://github.com/org/repo/pull/12",
        via: "read",
        observedAt: "2026-09-26T00:00:01.000Z",
        ref: null,
      },
      {
        key: "github:issue:org/repo#7",
        provenance: "github_issue",
        state: "open",
        url: "https://github.com/org/repo/issues/7",
        via: "read",
        observedAt: "2026-09-26T00:00:02.000Z",
        ref: null,
      },
    ],
    ...overrides,
  };
}

const catalog = (overrides: Partial<GroomingEvidenceSnapshot> = {}): EvidenceCatalog =>
  buildEvidenceCatalog(snapshot(overrides));

function readyDraft(): GroomingPlanDraft {
  return {
    verdict: {
      actionability: "ready",
      workType: "implementation",
      confidence: "high",
      lane: { id: "local", confidence: "high", reason: "bounded bug fix" },
      summary: "Ready: the redirect drops the return URL after a reset.",
      rationale: "login.ts builds the redirect without the saved return URL; the fix is local to it.",
      evidenceRefs: ["repo:src/auth/login.ts", "comment:101"],
      uncertainties: [],
    },
    implementationBrief: {
      problem: "After a password reset, login redirects to / instead of the saved return URL.",
      verifiedCurrentBehavior: {
        statement: "redirectAfterLogin ignores session.returnTo.",
        evidenceRefs: ["repo:src/auth/login.ts"],
      },
      relevantPaths: [
        { ref: "repo:src/auth/login.ts", change: "modify" },
        { ref: "repo:src/auth/session.ts", change: "reference" },
      ],
      filesToCreate: [],
      invariants: ["normal login without a reset still redirects to returnTo"],
      inScope: ["read session.returnTo in redirectAfterLogin"],
      outOfScope: ["changing the reset email flow"],
      dependencies: [],
      acceptanceCriteria: [
        { criterion: "a reset-then-login test lands on the return URL", verification: "automated_test" },
      ],
      tests: ["src/auth/login.test.ts: reset then login"],
    },
    mutations: {
      labelsToAdd: ["type/bug"],
      labelsToRemove: [],
      proposedTitle: null,
      proposedBody: null,
      githubComment: null,
      close: null,
    },
    decomposition: { required: false, reason: null, childBriefs: [] },
    relatedWork: [],
  };
}

type DraftPatch = {
  verdict?: Partial<GroomingPlanDraft["verdict"]>;
  implementationBrief?: Partial<NonNullable<GroomingPlanDraft["implementationBrief"]>> | null;
  mutations?: Partial<GroomingPlanDraft["mutations"]>;
  decomposition?: Partial<GroomingPlanDraft["decomposition"]>;
  relatedWork?: GroomingPlanDraft["relatedWork"];
};

function draft(patch: DraftPatch = {}): GroomingPlanDraft {
  const base = readyDraft();
  return {
    verdict: { ...base.verdict, ...patch.verdict },
    implementationBrief:
      patch.implementationBrief === null ? null : { ...base.implementationBrief!, ...patch.implementationBrief },
    mutations: { ...base.mutations, ...patch.mutations },
    decomposition: { ...base.decomposition, ...patch.decomposition },
    relatedWork: patch.relatedWork ?? base.relatedWork,
  };
}

function notReady(actionability: "needs_info" | "blocked" | "backlog", patch: DraftPatch = {}): GroomingPlanDraft {
  return draft({
    ...patch,
    verdict: { actionability, lane: { id: "backlog", confidence: "medium", reason: "not ready" }, ...patch.verdict },
    implementationBrief: patch.implementationBrief === undefined ? null : patch.implementationBrief,
  });
}

function validate(data: unknown, cat: EvidenceCatalog = catalog()) {
  return validateGroomingPlan(data, { catalog: cat });
}

function expectInvalid(data: unknown, fragment: string, cat?: EvidenceCatalog): string[] {
  const result = validate(data, cat);
  expect(result.valid).toBe(false);
  expect(result.errors?.some((e) => e.includes(fragment)), `errors: ${JSON.stringify(result.errors)}`).toBe(true);
  return result.errors ?? [];
}

function validPlan(data: unknown, cat?: EvidenceCatalog): GroomingPlan {
  const result = validate(data, cat);
  expect(result.errors).toBeUndefined();
  expect(result.valid).toBe(true);
  return result.plan!;
}

describe("GroomingPlan contract", () => {
  it("validates a ready implementation plan and stamps it with the snapshot it came from", () => {
    const plan = validPlan(readyDraft());

    expect(plan.schemaVersion).toBe(GROOMING_PLAN_SCHEMA_VERSION);
    expect(plan.evidence).toEqual({
      evidenceDigest: "digest-1",
      issueFingerprint: "fp-1",
      headSha: "abc123def4567890",
      pinnedRef: "abc123def4567890",
      defaultBranch: "main",
      capturedAt: "2026-09-26T00:00:00.000Z",
    });
    expect(plan.readiness).toEqual({
      ready: true,
      admission: "implementation",
      lane: "local",
      evidenceDigest: "digest-1",
      reasons: [],
    });
    expect(plan.mutations.status).toBe("status/ready");
  });

  it("resolves every citation with the provenance the snapshot distinguishes", () => {
    const plan = validPlan(
      draft({ verdict: { evidenceRefs: ["repo:src/auth/login.ts", "comment:101", "comment:102", "github:pr:org/repo#12", "issue"] } }),
    );
    const byId = Object.fromEntries(plan.citations.map((c) => [c.id, c]));

    expect(byId["repo:src/auth/login.ts"]).toMatchObject({ subject: "repository", provenance: "repository", pinned: true, authoritative: true });
    expect(byId["comment:101"]).toMatchObject({ provenance: "human_comment", authoritative: true });
    expect(byId["comment:102"]).toMatchObject({ provenance: "automation_comment", authoritative: false });
    expect(byId["github:pr:org/repo#12"]).toMatchObject({ provenance: "github_pull_request", state: "merged", pinned: false });
    expect(byId.issue).toMatchObject({ subject: "issue", provenance: "github_issue" });
  });

  it("canonicalizes omitted optional sections, nulls and whitespace", () => {
    const raw: Record<string, unknown> = {
      verdict: { ...readyDraft().verdict, summary: "  Ready.  ", actionability: "backlog", lane: { id: "backlog", confidence: "low", reason: " parked " } },
      mutations: { labelsToAdd: ["priority/p3"], githubComment: "   ", proposedTitle: null },
    };
    const plan = validPlan(raw);

    expect(plan.verdict.summary).toBe("Ready.");
    expect(plan.verdict.lane.reason).toBe("parked");
    expect(plan.implementationBrief).toBeNull();
    expect(plan.decomposition).toEqual({ required: false, reason: null, childBriefs: [] });
    expect(plan.relatedWork).toEqual([]);
    expect(plan.mutations).toMatchObject({ labelsToRemove: [], githubComment: null, proposedTitle: null, proposedBody: null, close: null, status: "status/backlog" });
  });

  it("resolves configured lane aliases and records the resolution", () => {
    const result = validate(draft({ verdict: { lane: { id: "normal", confidence: "high", reason: "r" } } }));
    expect(result.valid).toBe(true);
    expect(result.plan!.verdict.lane.id).toBe("local");
    expect(result.resolutions).toContainEqual({ field: "verdict.lane.id", rawValue: "normal", resolvedValue: "local", source: "alias" });
  });

  it("represents unknowns instead of forcing a confident answer", () => {
    const plan = validPlan(
      notReady("needs_info", {
        verdict: {
          confidence: "low",
          evidenceRefs: [],
          uncertainties: [{ kind: "missing_information", question: "Which login flow is affected?", material: true }],
        },
      }),
    );
    expect(plan.readiness).toMatchObject({ ready: false, admission: null, lane: null, reasons: ["verdict is needs_info"] });
    expect(plan.verdict.uncertainties[0].material).toBe(true);
  });

  it("derives status from the verdict", () => {
    expect(validPlan(notReady("blocked")).mutations.status).toBe("status/blocked");
    expect(validPlan(notReady("needs_info")).mutations.status).toBe("status/backlog");
    expect(validPlan(notReady("backlog")).mutations.status).toBe("status/backlog");
  });

  it("is deterministic: the same input yields the same errors in the same order", () => {
    const bad = draft({ verdict: { evidenceRefs: ["repo:nope.ts"], confidence: "certain" as never } });
    expect(validate(bad).errors).toEqual(validate(bad).errors);
    expect(validate(bad).errors!.length).toBeGreaterThan(1);
  });
});

describe("GroomingPlan readiness invariant", () => {
  it("rejects a ready verdict with no evidence references", () => {
    expectInvalid(draft({ verdict: { evidenceRefs: [] } }), "readiness: verdict.evidenceRefs must cite at least one repository source");
  });

  it("rejects ready backed only by the issue itself and comments", () => {
    expectInvalid(draft({ verdict: { evidenceRefs: ["issue", "comment:101"] } }), "readiness: verdict.evidenceRefs");
  });

  it("does not count automation comments as support", () => {
    expectInvalid(draft({ verdict: { evidenceRefs: ["comment:102"] } }), "readiness: verdict.evidenceRefs");
  });

  it("rejects ready when the snapshot is not pinned to a head SHA", () => {
    const errors = expectInvalid(readyDraft(), "not pinned to a default-branch head SHA", catalog({ headSha: null, pinnedRef: null }));
    // Repository reads without a pin are not current evidence either.
    expect(errors.some((e) => e.includes("verdict.evidenceRefs"))).toBe(true);
  });

  it("does not accept a code-search hit as pinned repository evidence", () => {
    const hitOnly = catalog({
      sources: [{ path: "src/auth/login.ts", provenance: "repository", via: "surfaced", ref: null }],
    });
    const cited = draft({ implementationBrief: { relevantPaths: [{ ref: "repo:src/auth/login.ts", change: "modify" }] } });
    const errors = expectInvalid(cited, "readiness: verdict.evidenceRefs must cite at least one repository source read at the pinned head SHA", hitOnly);
    expect(errors.some((e) => e.includes("verifiedCurrentBehavior.evidenceRefs must cite repository evidence"))).toBe(true);
  });

  it("rejects ready when the snapshot was never captured", () => {
    expectInvalid(readyDraft(), "evidence snapshot was not captured", catalog({ evidenceDigest: "" }));
  });

  it("rejects ready while a material uncertainty remains", () => {
    expectInvalid(
      draft({ verdict: { uncertainties: [{ kind: "scope", question: "Also fix SSO?", material: true }] } }),
      "readiness: material uncertainty remains (verdict.uncertainties[0]): Also fix SSO?",
    );
  });

  it("accepts ready with only non-material uncertainties", () => {
    const plan = validPlan(draft({ verdict: { uncertainties: [{ kind: "other", question: "Copy tweak?", material: false }] } }));
    expect(plan.readiness.ready).toBe(true);
  });

  it("rejects ready at low confidence", () => {
    expectInvalid(draft({ verdict: { confidence: "low" } }), "readiness: verdict.confidence is low");
  });

  it("requires a bounded implementation brief", () => {
    expectInvalid(draft({ implementationBrief: null }), "readiness: implementationBrief is required");
    expectInvalid(
      draft({ implementationBrief: { verifiedCurrentBehavior: { statement: "s", evidenceRefs: ["comment:101"] } } }),
      "verifiedCurrentBehavior.evidenceRefs must cite repository evidence",
    );
    expectInvalid(draft({ implementationBrief: { relevantPaths: [], filesToCreate: [] } }), "at least one relevant path or file to create");
    expectInvalid(draft({ implementationBrief: { inScope: [] } }), "implementationBrief.inScope must not be empty");
    expectInvalid(draft({ implementationBrief: { acceptanceCriteria: [] } }), "acceptanceCriteria must not be empty");
  });

  it("accepts a brief whose only path is a file to create", () => {
    const plan = validPlan(draft({ implementationBrief: { relevantPaths: [], filesToCreate: ["src/auth/redirect.ts"] } }));
    expect(plan.readiness.ready).toBe(true);
  });

  it("rejects non-deterministic acceptance criteria", () => {
    expectInvalid(
      draft({ implementationBrief: { acceptanceCriteria: [{ criterion: "login feels right", verification: "subjective" }] } }),
      "readiness: implementationBrief.acceptanceCriteria[0] is not deterministic",
    );
  });

  it("rejects implementation-ready work that needs decomposition", () => {
    expectInvalid(
      draft({ decomposition: { required: true, reason: "two changes", childBriefs: [{ title: "Fix redirect after reset", problem: "p", acceptanceCriteria: [] }] } }),
      "readiness: decomposition.required is true",
    );
  });

  it("rejects ready with a close recommendation", () => {
    expectInvalid(
      draft({
        mutations: { close: { reason: "duplicate", rationale: "dup", evidenceRefs: ["github:issue:org/repo#7"] } },
        relatedWork: [{ ref: "github:issue:org/repo#7", relation: "duplicate_of", note: "same bug" }],
      }),
      "readiness: a close is recommended",
    );
  });

  it("moves a ready implementation verdict out of the non-claimable lane (dispatch#492)", () => {
    const result = validate(draft({ verdict: { lane: { id: "backlog", confidence: "high", reason: "r" } } }));
    expect(result.valid).toBe(true);
    expect(result.plan!.verdict.lane.id).toBe("local");
    expect(result.plan!.readiness.lane).toBe("local");
    expect(result.resolutions).toContainEqual({ field: "verdict.lane.id", rawValue: "backlog", resolvedValue: "local", source: "invariant" });
  });

  it("allows implementation-ready work in other claimable lanes", () => {
    expect(validPlan(draft({ verdict: { lane: { id: "frontier", confidence: "high", reason: "hard" } } })).readiness).toMatchObject({
      ready: true,
      admission: "implementation",
      lane: "frontier",
    });
  });

  describe("design work", () => {
    const design = (lane: string, uncertainties: GroomingPlanDraft["verdict"]["uncertainties"] = []) =>
      draft({
        verdict: { workType: "design", lane: { id: lane, confidence: "high", reason: "needs a decision" }, uncertainties },
        implementationBrief: null,
      });

    it("never validates into the default implementation lane", () => {
      expectInvalid(design("local"), 'readiness: design work must route to the escalation lane "frontier", not "local"');
    });

    it("never validates into a non-escalation claimable lane", () => {
      expectInvalid(design("cloud"), 'must route to the escalation lane "frontier", not "cloud"');
    });

    it("is ready only for escalation, where design choices are the work", () => {
      const plan = validPlan(design("frontier", [{ kind: "design_choice", question: "Token or session store?", material: true }]));
      expect(plan.readiness).toMatchObject({ ready: true, admission: "escalation", lane: "frontier" });
    });

    it("is still blocked by material uncertainty that is not a design choice", () => {
      expectInvalid(
        design("frontier", [{ kind: "missing_information", question: "Which tenants?", material: true }]),
        "readiness: material uncertainty remains",
      );
    });

    it("moves a ready design verdict from the backlog lane to the escalation lane", () => {
      const plan = validPlan(design("backlog"));
      expect(plan.verdict.lane.id).toBe("frontier");
      expect(plan.readiness.admission).toBe("escalation");
    });

    it("parks non-ready design work in the backlog lane, never the default lane", () => {
      const plan = validPlan(draft({ verdict: { actionability: "backlog", workType: "design" }, implementationBrief: null }));
      expect(plan.verdict.lane.id).toBe("backlog");
      expect(plan.readiness.ready).toBe(false);
    });

    it("cannot be ready when no escalation lane is configured", () => {
      setLaneConfig({
        lanes: [
          { id: "default", title: "Default", claimable: true, role: "default" },
          { id: "backlog", title: "Backlog", claimable: false },
        ],
      });
      expectInvalid(
        draft({ verdict: { workType: "design", lane: { id: "backlog", confidence: "high", reason: "r" } }, implementationBrief: null }),
        "design work cannot be ready: no escalation lane is configured",
      );
    });
  });

  it("moves a non-ready verdict out of a claimable lane so the lane cannot imply readiness", () => {
    const result = validate(notReady("blocked", { verdict: { lane: { id: "local", confidence: "high", reason: "r" } } }));
    expect(result.valid).toBe(true);
    expect(result.plan!.verdict.lane.id).toBe("backlog");
    expect(result.plan!.readiness.ready).toBe(false);
    expect(result.resolutions).toContainEqual({ field: "verdict.lane.id", rawValue: "local", resolvedValue: "backlog", source: "invariant" });
  });

  it("re-evaluates a stored plan against a fresh catalog", () => {
    const plan = validPlan(readyDraft());
    expect(evaluateReadiness(plan, catalog())).toEqual([]);
    const fresh = catalog({ sources: [] });
    expect(evaluateReadiness(plan, fresh)).toContain(
      "verdict.evidenceRefs must cite at least one repository source read at the pinned head SHA",
    );
  });
});

describe("GroomingPlan validation failures", () => {
  it("rejects non-objects", () => {
    expect(validate(null).errors).toEqual(["plan must be a JSON object"]);
    expect(validate([]).errors).toEqual(["plan must be a JSON object"]);
  });

  it("fails closed on the legacy GroomerOutput shape with a clear reason", () => {
    const result = validate({
      labelsToAdd: ["status/ready"],
      labelsToRemove: [],
      lane: { id: "local", confidence: "high", reason: "r" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0]).toContain("legacy GroomerOutput shape");
    expect(result.errors![0]).toContain(`GroomingPlan v${GROOMING_PLAN_SCHEMA_VERSION}`);
  });

  it("reports missing required sections", () => {
    const errors = expectInvalid({}, "verdict: is required");
    expect(errors).toContain("mutations: is required");
  });

  it("rejects out-of-enum values with the field path", () => {
    expectInvalid(draft({ verdict: { actionability: "maybe" as never } }), "verdict.actionability: must be one of");
    expectInvalid(draft({ verdict: { workType: "refactor" as never } }), "verdict.workType: must be one of");
    expectInvalid(draft({ verdict: { lane: { id: "gpu", confidence: "high", reason: "r" } } }), 'verdict.lane.id: must be a configured lane');
    expectInvalid(
      draft({ implementationBrief: { acceptanceCriteria: [{ criterion: "c", verification: "vibes" as never }] } }),
      "implementationBrief.acceptanceCriteria[0].verification: must be one of",
    );
  });

  it("rejects empty required text", () => {
    expectInvalid(draft({ verdict: { rationale: "   " } }), "verdict.rationale: must not be empty");
    expectInvalid(draft({ verdict: { lane: { id: "", confidence: "high", reason: "r" } } }), "verdict.lane.id: must not be empty");
  });

  it("enforces string and array bounds", () => {
    expectInvalid(draft({ verdict: { summary: "x".repeat(PLAN_LIMITS.summary + 1) } }), "verdict.summary: must be at most 500 characters");
    expectInvalid(
      draft({ implementationBrief: { inScope: Array.from({ length: PLAN_LIMITS.listItems + 1 }, (_, i) => `item ${i}`) } }),
      `implementationBrief.inScope: must have at most ${PLAN_LIMITS.listItems} items`,
    );
    expectInvalid(draft({ mutations: { proposedTitle: "short" } }), "mutations.proposedTitle: must be at least 10 characters");
    expectInvalid(draft({ mutations: { proposedBody: "b".repeat(PLAN_LIMITS.body + 1) } }), "mutations.proposedBody: must be at most");
  });

  it("rejects unknown evidence references wherever they are cited", () => {
    expectInvalid(draft({ verdict: { evidenceRefs: ["repo:src/invented.ts"] } }), 'verdict.evidenceRefs[0]: unknown evidence reference "repo:src/invented.ts"');
    expectInvalid(
      draft({ implementationBrief: { verifiedCurrentBehavior: { statement: "s", evidenceRefs: ["comment:999"] } } }),
      'implementationBrief.verifiedCurrentBehavior.evidenceRefs[0]: unknown evidence reference "comment:999"',
    );
    expectInvalid(
      draft({ implementationBrief: { relevantPaths: [{ ref: "repo:src/guess.ts", change: "modify" }] } }),
      "implementationBrief.relevantPaths[0].ref: unknown evidence reference",
    );
    expectInvalid(
      notReady("backlog", { mutations: { close: { reason: "superseded", rationale: "r", evidenceRefs: ["github:pr:org/repo#99"] } } }),
      "mutations.close.evidenceRefs[0]: unknown evidence reference",
    );
  });

  it("requires the right kind of evidence in typed positions", () => {
    expectInvalid(
      draft({ implementationBrief: { relevantPaths: [{ ref: "comment:101", change: "modify" }] } }),
      'implementationBrief.relevantPaths[0].ref: "comment:101" must be a repository evidence reference',
    );
    expectInvalid(
      notReady("backlog", { relatedWork: [{ ref: "repo:src/auth/login.ts", relation: "related", note: "n" }] }),
      'relatedWork[0].ref: "repo:src/auth/login.ts" must be a related-work evidence reference',
    );
    expectInvalid(
      draft({ implementationBrief: { dependencies: [{ ref: "#7", state: "open", evidenceRef: "comment:101" }] } }),
      'implementationBrief.dependencies[0].evidenceRef: "comment:101" must be a related-work evidence reference',
    );
  });

  it("keeps the label allowlist and leaves status to the verdict", () => {
    expect(validPlan(draft({ mutations: { labelsToAdd: ["priority/p2", "type/feature"], labelsToRemove: ["priority/p1"] } })).mutations.labelsToAdd).toEqual([
      "priority/p2",
      "type/feature",
    ]);
    expectInvalid(draft({ mutations: { labelsToAdd: ["status/ready"] } }), "mutations.labelsToAdd[0]: status is derived from verdict.actionability");
    expectInvalid(draft({ mutations: { labelsToRemove: ["agent/bob"] } }), "must not contain agent/* labels");
    expectInvalid(draft({ mutations: { labelsToAdd: ["type/refactor"] } }), "mutations.labelsToAdd[0]: disallowed label: type/refactor");
  });

  it("rejects a dependency state that contradicts the cited GitHub state", () => {
    expectInvalid(
      draft({ implementationBrief: { dependencies: [{ ref: "#7", state: "closed", evidenceRef: "github:issue:org/repo#7" }] } }),
      '"closed" contradicts the cited evidence (github:issue:org/repo#7 is open)',
    );
    // "unknown" never contradicts; an open dependency does not block readiness
    // (the depends-on gate owns that).
    const plan = validPlan(
      draft({ implementationBrief: { dependencies: [{ ref: "#7", state: "open", evidenceRef: "github:issue:org/repo#7" }, { ref: "#8", state: "unknown", evidenceRef: null }] } }),
    );
    expect(plan.readiness.ready).toBe(true);
  });

  it("requires children when decomposition is required", () => {
    expectInvalid(notReady("backlog", { decomposition: { required: true, reason: "umbrella", childBriefs: [] } }), "decomposition.childBriefs");
  });

  describe("close decisions", () => {
    const done = (patch: DraftPatch = {}) =>
      draft({
        ...patch,
        verdict: { actionability: "already_done", lane: { id: "backlog", confidence: "high", reason: "done" }, ...patch.verdict },
        implementationBrief: null,
      });

    it("requires already_done to carry an already_done close", () => {
      expectInvalid(done(), 'an already_done verdict requires a close with reason "already_done"');
    });

    it("accepts already_done backed by pinned repository evidence, with related work as corroboration", () => {
      for (const refs of [["repo:src/auth/login.ts"], ["repo:src/auth/login.ts", "github:pr:org/repo#12", "comment:101"]]) {
        const plan = validPlan(done({ mutations: { close: { reason: "already_done", rationale: "fixed by #12", evidenceRefs: refs } } }));
        expect(plan.mutations.status).toBe("status/done");
        expect(plan.readiness.ready).toBe(false);
      }
    });

    it("refuses to close on the issue itself or automation comments", () => {
      expectInvalid(
        done({ mutations: { close: { reason: "already_done", rationale: "r", evidenceRefs: ["issue", "comment:102"] } } }),
        "already_done must cite pinned repository evidence",
      );
    });

    it("refuses to close on merged work or a human comment without current-revision evidence (dispatch#1063)", () => {
      for (const ref of ["github:pr:org/repo#12", "comment:101"]) {
        expectInvalid(
          done({ mutations: { close: { reason: "already_done", rationale: "fixed by #12", evidenceRefs: [ref] } } }),
          "related work or a human comment may corroborate but cannot close an issue alone",
        );
      }
    });

    it("refuses to close below high confidence (dispatch#1063)", () => {
      for (const confidence of ["medium", "low"] as const) {
        expectInvalid(
          done({
            verdict: { confidence },
            mutations: { close: { reason: "already_done", rationale: "r", evidenceRefs: ["repo:src/auth/login.ts"] } },
          }),
          "requires high confidence",
        );
      }
    });

    it("refuses to close on unpinned repository reads", () => {
      expectInvalid(
        done({ mutations: { close: { reason: "already_done", rationale: "r", evidenceRefs: ["repo:src/auth/login.ts"] } } }),
        "already_done must cite",
        catalog({ headSha: null, pinnedRef: null }),
      );
    });

    it("refuses already_done with a material uncertainty", () => {
      expectInvalid(
        done({
          verdict: { uncertainties: [{ kind: "unverified_premise", question: "Is #12 deployed?", material: true }] },
          mutations: { close: { reason: "already_done", rationale: "r", evidenceRefs: ["repo:src/auth/login.ts", "github:pr:org/repo#12"] } },
        }),
        "already_done cannot carry a material uncertainty",
      );
    });

    it("keeps already_done close reasons tied to the already_done verdict", () => {
      expectInvalid(
        notReady("backlog", { mutations: { close: { reason: "already_done", rationale: "r", evidenceRefs: ["github:pr:org/repo#12"] } } }),
        'requires verdict.actionability "already_done"',
      );
    });

    it("records duplicate/superseded as a recommendation tied to related work", () => {
      expectInvalid(
        notReady("backlog", { mutations: { close: { reason: "duplicate", rationale: "r", evidenceRefs: ["github:issue:org/repo#7"] } } }),
        'must cite a relatedWork entry with relation "duplicate_of"',
      );
      const plan = validPlan(
        notReady("backlog", {
          mutations: { close: { reason: "duplicate", rationale: "same as #7", evidenceRefs: ["github:issue:org/repo#7"] } },
          relatedWork: [{ ref: "github:issue:org/repo#7", relation: "duplicate_of", note: "same bug" }],
        }),
      );
      expect(plan.mutations.close?.reason).toBe("duplicate");
      expect(plan.mutations.status).toBe("status/backlog");
    });
  });
});

describe("toGroomerOutput (legacy compatibility view)", () => {
  it("maps a ready plan and clears every stale status label", () => {
    const output = toGroomerOutput(validPlan(readyDraft()), ["status/backlog", "status/blocked", "priority/p1"]);
    expect(output).toMatchObject({
      actionability: "ready",
      confidence: "high",
      labelsToAdd: ["type/bug", "status/ready"],
      labelsToRemove: ["status/backlog", "status/blocked"],
      lane: { id: "local", confidence: "high", reason: "bounded bug fix" },
      nextGroomingAction: "promote_to_ready",
    });
  });

  it("carries the rationale into the reason field for each non-ready verdict", () => {
    expect(toGroomerOutput(validPlan(notReady("blocked")), [])).toMatchObject({
      blockedReason: readyDraft().verdict.rationale,
      nextGroomingAction: "mark_blocked",
      labelsToAdd: ["type/bug", "status/blocked"],
    });
    expect(toGroomerOutput(validPlan(notReady("needs_info")), [])).toMatchObject({ needsInfoReason: expect.any(String), nextGroomingAction: "mark_needs_info" });
    expect(toGroomerOutput(validPlan(notReady("backlog")), [])).toMatchObject({ notReadyReason: expect.any(String), nextGroomingAction: "mark_not_ready" });
  });

  it("maps escalation readiness to the escalate action", () => {
    const plan = validPlan(
      draft({ verdict: { workType: "design", lane: { id: "frontier", confidence: "high", reason: "r" } }, implementationBrief: null }),
    );
    expect(toGroomerOutput(plan, []).nextGroomingAction).toBe("escalate");
  });

  it("never touches in-progress or in-review status labels", () => {
    for (const status of ["status/in-progress", "status/in-review"]) {
      const output = toGroomerOutput(validPlan(notReady("blocked")), [status, "priority/p1"]);
      expect(output.labelsToAdd).toEqual(["type/bug"]);
      expect(output.labelsToRemove).toEqual([]);
    }
  });

  it("only removes grooming-owned statuses", () => {
    const output = toGroomerOutput(validPlan(readyDraft()), ["status/backlog", "status/done"]);
    expect(output.labelsToRemove).toEqual(["status/backlog", "status/done"]);
  });

  it("omits null text mutations", () => {
    const output = toGroomerOutput(validPlan(readyDraft()), []);
    expect(output).not.toHaveProperty("githubComment");
    expect(output).not.toHaveProperty("proposedTitle");
    expect(output).not.toHaveProperty("proposedBody");
  });
});
