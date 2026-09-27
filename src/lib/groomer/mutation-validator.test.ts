import { describe, expect, it, vi } from "vitest";
import type { GroomingEvidenceSnapshot } from "./evidence-snapshot";
import { buildEvidenceCatalog } from "./plan-evidence";
import { collectPinnedReadContent } from "./close-grounding";
import { validateGroomingPlan, type GroomingPlan, type GroomingPlanDraft } from "./plan";
import {
  evaluateClosePolicy,
  evaluateReadyPolicy,
  validateApplyPreconditions,
  type LiveComment,
  type PreconditionInput,
  type PreconditionReader,
} from "./mutation-validator";

const HEAD = "aaaa1111bbbb2222";
const NEW_HEAD = "cccc3333dddd4444";

function snapshot(overrides: Partial<GroomingEvidenceSnapshot> = {}): GroomingEvidenceSnapshot {
  return {
    capturedAt: "2026-09-26T00:00:00.000Z",
    repoFullName: "org/repo",
    defaultBranch: "main",
    headSha: HEAD,
    pinnedRef: HEAD,
    issue: {
      number: 42,
      title: "Fix login redirect after password reset",
      body: "Login fails after password reset.",
      labels: ["priority/p1", "status/backlog"],
      state: "open",
      updatedAt: "2026-09-25T00:00:00.000Z",
      url: "https://github.com/org/repo/issues/42",
    },
    issueFingerprint: "fp",
    comments: [
      { id: "101", author: "alice", createdAt: "2026-09-24T00:00:00Z", body: "Repro.", provenance: "human_comment", authoritative: true },
    ],
    evidenceDigest: "digest",
    warnings: [],
    sources: [
      { path: "src/auth/login.ts", provenance: "repository", via: "read", ref: HEAD },
      {
        key: "github:pr:org/repo#12",
        provenance: "github_pull_request",
        state: "merged",
        url: null,
        via: "read",
        observedAt: "2026-09-26T00:00:01.000Z",
        ref: null,
      },
    ],
    ...overrides,
  };
}

const LOGIN_TS = "export function redirectAfterLogin(session: Session) {\n  return session.returnTo ?? \"/\";\n}\n";

/** The run's catalog, with login.ts as read at the pinned head (dispatch#1099). */
function catalogFor(snap: GroomingEvidenceSnapshot) {
  return buildEvidenceCatalog(snap, collectPinnedReadContent(HEAD, [{ path: "src/auth/login.ts", ref: HEAD, content: LOGIN_TS }]));
}

function readyDraft(): GroomingPlanDraft {
  return {
    verdict: {
      actionability: "ready",
      workType: "implementation",
      confidence: "high",
      lane: { id: "local", confidence: "high", reason: "bounded" },
      summary: "Ready.",
      rationale: "login.ts drops the return URL.",
      evidenceRefs: ["repo:src/auth/login.ts"],
      uncertainties: [],
    },
    implementationBrief: {
      problem: "Redirect drops the return URL.",
      verifiedCurrentBehavior: { statement: "redirect ignores returnTo", evidenceRefs: ["repo:src/auth/login.ts"] },
      relevantPaths: [{ ref: "repo:src/auth/login.ts", change: "modify" }],
      filesToCreate: [],
      invariants: [],
      inScope: ["read returnTo"],
      outOfScope: [],
      dependencies: [],
      acceptanceCriteria: [{ criterion: "reset-then-login test passes", verification: "automated_test" }],
      tests: [],
    },
    mutations: { labelsToAdd: [], labelsToRemove: [], proposedTitle: null, proposedBody: null, githubComment: null, close: null },
    decomposition: { required: false, reason: null, childBriefs: [] },
    relatedWork: [],
  };
}

function alreadyDoneDraft(evidenceRefs: string[] = ["repo:src/auth/login.ts"]): GroomingPlanDraft {
  return {
    ...readyDraft(),
    verdict: {
      ...readyDraft().verdict,
      actionability: "already_done",
      lane: { id: "backlog", confidence: "high", reason: "done" },
    },
    implementationBrief: null,
    mutations: {
      ...readyDraft().mutations,
      close: {
        reason: "already_done",
        rationale: "login.ts already keeps returnTo",
        evidenceRefs,
        criteria: [
          { criterion: "login redirects to the saved return URL", evidenceRef: "repo:src/auth/login.ts", excerpt: 'return session.returnTo ?? "/";' },
        ],
      },
    },
  };
}

function planFor(draft: GroomingPlanDraft, snap = snapshot()): GroomingPlan {
  const result = validateGroomingPlan(draft, { catalog: catalogFor(snap) });
  if (!result.valid) throw new Error(result.errors!.join("; "));
  return result.plan!;
}

const WINDOW_START = new Date("2026-09-26T00:00:00.000Z");

function input(overrides: Partial<PreconditionInput> = {}): PreconditionInput {
  return {
    repoFullName: "org/repo",
    issueNumber: 42,
    evidence: snapshot(),
    evidenceWindowStart: WINDOW_START,
    plan: planFor(readyDraft()),
    repositoryQueries: [],
    explorationRan: true,
    explorationToolCalls: [],
    ...overrides,
  };
}

function reader(overrides: Partial<PreconditionReader> & { fresh?: Partial<GroomingEvidenceSnapshot> } = {}): PreconditionReader {
  const { fresh, ...rest } = overrides;
  return {
    recapture: vi.fn(async () => snapshot(fresh)),
    fetchRecentComments: vi.fn(async (): Promise<LiveComment[]> => []),
    compareCommits: vi.fn(async () => ({ ok: true as const, status: "ahead", files: ["README.md"], truncated: false })),
    ...rest,
  };
}

function check(result: Awaited<ReturnType<typeof validateApplyPreconditions>>, name: string) {
  return result.checks.find((c) => c.name === name)!;
}

describe("validateApplyPreconditions", () => {
  it("passes when the live issue, comments and head all match the snapshot", async () => {
    const result = await validateApplyPreconditions(input(), reader());
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.checks.map((c) => [c.name, c.status])).toEqual([
      ["issue", "passed"],
      ["comments", "passed"],
      ["head", "passed"],
    ]);
    expect(result.live).toMatchObject({ title: snapshot().issue.title, labels: ["priority/p1", "status/backlog"] });
  });

  describe("issue", () => {
    it.each([
      ["title", { title: "Edited title" }, /title/],
      ["body", { body: "Edited body." }, /body/],
      ["labels", { labels: ["priority/p1", "status/in-progress", "agent/coder"] }, /labels \(\+agent\/coder \+status\/in-progress -status\/backlog\)/],
      ["state", { state: "closed" }, /state \(open -> closed\)/],
    ])("fails when the %s changed after the snapshot", async (_field, patch, detail) => {
      const result = await validateApplyPreconditions(
        input(),
        reader({ fresh: { issue: { ...snapshot().issue, ...patch } } }),
      );
      expect(result.ok).toBe(false);
      expect(check(result, "issue").status).toBe("changed");
      expect(check(result, "issue").detail).toMatch(detail);
      expect(result.failures[0]).toMatch(/^issue: /);
    });

    it("ignores label order", async () => {
      const result = await validateApplyPreconditions(
        input(),
        reader({ fresh: { issue: { ...snapshot().issue, labels: ["status/backlog", "priority/p1"] } } }),
      );
      expect(check(result, "issue").status).toBe("passed");
    });

    it("fails when the issue is no longer open, even if the snapshot saw it closed", async () => {
      const closed = { ...snapshot().issue, state: "closed" };
      const result = await validateApplyPreconditions(input({ evidence: snapshot({ issue: closed }) }), reader({ fresh: { issue: closed } }));
      expect(check(result, "issue")).toMatchObject({ status: "changed", detail: "issue is closed, not open" });
    });

    it("is unverifiable when the live issue cannot be re-read", async () => {
      const result = await validateApplyPreconditions(
        input(),
        reader({ fresh: { issue: { ...snapshot().issue, state: "unknown" }, warnings: ["evidence: failed to fetch live issue state: 502"] } }),
      );
      expect(check(result, "issue")).toMatchObject({ status: "unverifiable", detail: expect.stringContaining("502") });
      expect(result.ok).toBe(false);
    });

    it("is unverifiable when the snapshot never captured the issue", async () => {
      const shell = snapshot({ issue: { ...snapshot().issue, state: "unknown", title: "", body: null, labels: [] }, issueFingerprint: "" });
      const result = await validateApplyPreconditions(input({ evidence: shell, plan: planFor(alreadyDoneDraft(), snapshot()) }), reader());
      expect(check(result, "issue").status).toBe("unverifiable");
    });

    it("fails every live check when the re-capture itself throws", async () => {
      const result = await validateApplyPreconditions(
        input(),
        reader({ recapture: vi.fn(async () => Promise.reject(new Error("boom"))) }),
      );
      expect(check(result, "issue").status).toBe("unverifiable");
      expect(check(result, "head").status).toBe("unverifiable");
    });
  });

  describe("comments", () => {
    const comment = (author: string, createdAt: string): LiveComment => ({ id: 1, author, createdAt, body: "x", url: null });

    it("fails on a human comment after the evidence window opened", async () => {
      const result = await validateApplyPreconditions(
        input(),
        reader({ fetchRecentComments: vi.fn(async () => [comment("bob", "2026-09-26T00:00:05Z")]) }),
      );
      expect(check(result, "comments")).toMatchObject({ status: "changed", detail: expect.stringContaining("bob") });
    });

    it("ignores new automation comments and older human ones", async () => {
      const result = await validateApplyPreconditions(
        input(),
        reader({
          fetchRecentComments: vi.fn(async () => [comment("itsmiso-ai", "2026-09-26T00:00:05Z"), comment("alice", "2026-09-24T00:00:00Z")]),
        }),
      );
      expect(check(result, "comments").status).toBe("passed");
    });

    it("is unverifiable when a full window is all new comments", async () => {
      const many = Array.from({ length: 30 }, () => comment("dependabot[bot]", "2026-09-26T00:00:05Z"));
      const result = await validateApplyPreconditions(input(), reader({ fetchRecentComments: vi.fn(async () => many) }));
      expect(check(result, "comments").status).toBe("unverifiable");
    });

    it("is unverifiable when comments cannot be read", async () => {
      const result = await validateApplyPreconditions(
        input(),
        reader({ fetchRecentComments: vi.fn(async () => Promise.reject(new Error("504"))) }),
      );
      expect(check(result, "comments")).toMatchObject({ status: "unverifiable", detail: expect.stringContaining("504") });
    });
  });

  describe("head", () => {
    it("is skipped when the snapshot was never pinned", async () => {
      const unpinned = snapshot({ headSha: null, pinnedRef: null, defaultBranch: null });
      const result = await validateApplyPreconditions(input({ evidence: unpinned }), reader({ fresh: { headSha: null, pinnedRef: null } }));
      expect(check(result, "head").status).toBe("skipped");
    });

    it("is unverifiable when the live head cannot be resolved", async () => {
      const result = await validateApplyPreconditions(
        input(),
        reader({ fresh: { headSha: null, pinnedRef: null, warnings: ["evidence: failed to resolve default-branch head SHA: 500"] } }),
      );
      expect(check(result, "head")).toMatchObject({ status: "unverifiable", detail: expect.stringContaining("500") });
    });

    it("fails when the default branch changed", async () => {
      const result = await validateApplyPreconditions(input(), reader({ fresh: { defaultBranch: "trunk" } }));
      expect(check(result, "head")).toMatchObject({ status: "changed", detail: "default branch changed: main -> trunk" });
    });

    it("fails when the head moved and touched a path the plan relies on", async () => {
      const compareCommits = vi.fn(async () => ({ ok: true as const, status: "ahead", files: ["src/auth/login.ts"], truncated: false }));
      const result = await validateApplyPreconditions(input(), reader({ fresh: { headSha: NEW_HEAD }, compareCommits }));
      expect(compareCommits).toHaveBeenCalledWith(HEAD, NEW_HEAD);
      expect(check(result, "head")).toMatchObject({ status: "changed", detail: expect.stringContaining("touched src/auth/login.ts") });
      expect(result.liveHeadSha).toBe(NEW_HEAD);
    });

    it("passes when the head moved without touching the plan's evidence", async () => {
      const result = await validateApplyPreconditions(input(), reader({ fresh: { headSha: NEW_HEAD } }));
      expect(check(result, "head")).toMatchObject({ status: "passed", detail: expect.stringContaining("without touching") });
    });

    it("fails on any move when the plan relies on repo-wide evidence", async () => {
      const compareCommits = vi.fn();
      const result = await validateApplyPreconditions(
        input({ explorationToolCalls: [{ name: "search_code", ok: true, bytes: 0 }] }),
        reader({ fresh: { headSha: NEW_HEAD }, compareCommits }),
      );
      expect(check(result, "head")).toMatchObject({ status: "changed", detail: expect.stringContaining("repo-wide") });
      expect(compareCommits).not.toHaveBeenCalled();
    });

    it("passes a move when the plan used no repository evidence", async () => {
      const noRepo = snapshot({ sources: [] });
      const plan = planFor(
        { ...readyDraft(), verdict: { ...readyDraft().verdict, actionability: "backlog", lane: { id: "backlog", confidence: "low", reason: "r" }, evidenceRefs: [] }, implementationBrief: null },
        noRepo,
      );
      const result = await validateApplyPreconditions(
        input({ evidence: noRepo, plan, explorationRan: false }),
        reader({ fresh: { headSha: NEW_HEAD } }),
      );
      expect(check(result, "head").status).toBe("passed");
    });

    it.each([
      ["diverged history", { ok: true as const, status: "diverged", files: [], truncated: false }, "changed"],
      ["a truncated file list", { ok: true as const, status: "ahead", files: [], truncated: true }, "changed"],
      ["a definitive compare failure", { ok: false as const, httpStatus: 404, definitive: true, message: "404" }, "changed"],
      ["a transient compare failure", { ok: false as const, httpStatus: 502, definitive: false, message: "502" }, "unverifiable"],
    ])("fails closed on %s", async (_why, comparison, status) => {
      const result = await validateApplyPreconditions(
        input(),
        reader({ fresh: { headSha: NEW_HEAD }, compareCommits: vi.fn(async () => comparison) }),
      );
      expect(check(result, "head").status).toBe(status);
      expect(result.ok).toBe(false);
    });
  });

  it("records every failed precondition, in check order", async () => {
    const result = await validateApplyPreconditions(
      input(),
      reader({
        fresh: { headSha: NEW_HEAD, issue: { ...snapshot().issue, body: "edited" } },
        fetchRecentComments: vi.fn(async () => [{ id: 2, author: "bob", createdAt: "2026-09-26T00:01:00Z", body: "wait", url: null }]),
        compareCommits: vi.fn(async () => ({ ok: true as const, status: "ahead", files: ["src/auth/login.ts"], truncated: false })),
      }),
    );
    expect(result.failures.map((f) => f.split(":")[0])).toEqual(["issue", "comments", "head"]);
  });
});

describe("evaluateClosePolicy", () => {
  const catalog = catalogFor(snapshot());

  it("allows a high-confidence already_done close on pinned repository evidence", () => {
    expect(evaluateClosePolicy(planFor(alreadyDoneDraft()), catalog)).toEqual([]);
  });

  it("refuses a close without pinned repository evidence", () => {
    // Built as if valid, to exercise the apply-time backstop directly.
    const plan = planFor(alreadyDoneDraft());
    const forged: GroomingPlan = { ...plan, mutations: { ...plan.mutations, close: { ...plan.mutations.close!, evidenceRefs: ["github:pr:org/repo#12"] } } };
    expect(evaluateClosePolicy(forged, catalog)).toEqual(["the close cites no repository content read at the pinned head SHA"]);
  });

  it("refuses a close below high confidence or with a material uncertainty", () => {
    const plan = planFor(alreadyDoneDraft());
    const forged: GroomingPlan = {
      ...plan,
      verdict: { ...plan.verdict, confidence: "medium", uncertainties: [{ kind: "scope", question: "Is it deployed?", material: true }] },
    };
    expect(evaluateClosePolicy(forged, catalog)).toEqual([
      "verdict confidence is medium; closing requires high",
      "material uncertainty remains (verdict.uncertainties[0]): Is it deployed?",
    ]);
  });

  it("never applies duplicate or superseded closes", () => {
    const plan = planFor(alreadyDoneDraft());
    const forged: GroomingPlan = { ...plan, mutations: { ...plan.mutations, close: { ...plan.mutations.close!, reason: "duplicate" } } };
    expect(evaluateClosePolicy(forged, catalog)).toEqual(["only an already_done verdict with an already_done close is ever applied"]);
  });

  it("re-checks close grounding at apply time (dispatch#1099)", () => {
    const plan = planFor(alreadyDoneDraft());
    const paraphrased: GroomingPlan = {
      ...plan,
      mutations: {
        ...plan.mutations,
        close: {
          ...plan.mutations.close!,
          criteria: [{ criterion: "login keeps returnTo", evidenceRef: "repo:src/auth/login.ts", excerpt: "returns session.returnTo" }],
        },
      },
    };
    expect(evaluateClosePolicy(paraphrased, catalog)).toEqual([
      expect.stringMatching(/^mutations\.close\.criteria\[0\]\.excerpt: not found verbatim in src\/auth\/login\.ts/),
    ]);
    const ungrounded: GroomingPlan = { ...plan, mutations: { ...plan.mutations, close: { ...plan.mutations.close!, criteria: [] } } };
    expect(evaluateClosePolicy(ungrounded, catalog)).toEqual([expect.stringContaining("already_done must ground every acceptance criterion")]);
    // Without the pinned content (a catalog built without the run's reads) nothing can be checked.
    expect(evaluateClosePolicy(plan, buildEvidenceCatalog(snapshot()))).toEqual([
      expect.stringContaining("the content of src/auth/login.ts as read at the pinned head is not available"),
    ]);
  });

  it("refuses a close when the catalog is not pinned", () => {
    const plan = planFor(alreadyDoneDraft());
    const unpinned = catalogFor(snapshot({ headSha: null, pinnedRef: null }));
    expect(evaluateClosePolicy(plan, unpinned)).toContain("the close cites no repository content read at the pinned head SHA");
  });
});

describe("evaluateReadyPolicy", () => {
  it("accepts a plan whose readiness holds against the catalog", () => {
    expect(evaluateReadyPolicy(planFor(readyDraft()), catalogFor(snapshot()))).toEqual([]);
  });

  it("refuses a ready plan bound to a different snapshot or whose invariants fail", () => {
    const plan = planFor(readyDraft());
    const other = catalogFor(snapshot({ evidenceDigest: "other", headSha: null, pinnedRef: null }));
    const reasons = evaluateReadyPolicy(plan, other);
    expect(reasons).toContain("the plan's readiness is bound to a different evidence snapshot");
    expect(reasons).toContain("the evidence snapshot is not pinned to a default-branch head SHA");
  });

  it("refuses a plan whose derived readiness is not ready", () => {
    const plan = planFor(readyDraft());
    const forged: GroomingPlan = { ...plan, readiness: { ...plan.readiness, ready: false } };
    expect(evaluateReadyPolicy(forged, catalogFor(snapshot()))).toContain("the plan's derived readiness is not ready");
  });
});
