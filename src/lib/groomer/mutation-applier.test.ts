import { describe, expect, it, vi } from "vitest";
import { childBriefKey } from "@/lib/decomposition";
import type { GroomingEvidenceSnapshot } from "./evidence-snapshot";
import { buildEvidenceCatalog } from "./plan-evidence";
import { collectPinnedReadContent } from "./close-grounding";
import { validateGroomingPlan, type GroomingPlan, type GroomingPlanDraft } from "./plan";
import type { LiveComment, LiveIssueState } from "./mutation-validator";
import {
  ACTIVE_CLAIM_MS,
  MANAGED_BODY_END,
  MANAGED_BODY_START,
  applyGroomingMutations,
  commentMarker,
  commentMarkerKey,
  computeApplicationKey,
  groomerCommentKey,
  computeMutationDiff,
  makePrismaApplicationStore,
  parseManagedBody,
  renderManagedBody,
  type ApplicationRecord,
  type ApplicationStore,
  type ApplierGitHub,
  type ApplyInput,
  type ApplySteps,
  type ChildClaimRecord,
  type GroomingMutationDiff,
} from "./mutation-applier";

const HEAD = "aaaa1111bbbb2222";
const KEY = "a".repeat(64);

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
      body: "Broken.",
      labels: ["priority/p1", "status/backlog"],
      state: "open",
      updatedAt: "2026-09-25T00:00:00.000Z",
      url: "https://github.com/org/repo/issues/42",
    },
    issueFingerprint: "fp",
    comments: [],
    evidenceDigest: "digest",
    warnings: [],
    sources: [{ path: "src/auth/login.ts", provenance: "repository", via: "read", ref: HEAD }],
    ...overrides,
  };
}

const LOGIN_TS = "export function redirectAfterLogin(session: Session) {\n  return session.returnTo ?? \"/\";\n}\n";

/** The run's catalog, with login.ts as read at the pinned head (dispatch#1099). */
function catalogFor(snap: GroomingEvidenceSnapshot) {
  return buildEvidenceCatalog(snap, collectPinnedReadContent(HEAD, [{ path: "src/auth/login.ts", ref: HEAD, content: LOGIN_TS }]));
}

function draft(patch: Partial<GroomingPlanDraft["verdict"]> = {}, mutations: Partial<GroomingPlanDraft["mutations"]> = {}): GroomingPlanDraft {
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
      ...patch,
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
      acceptanceCriteria: [{ criterion: "test passes", verification: "automated_test" }],
      tests: [],
    },
    mutations: {
      labelsToAdd: ["type/bug"],
      labelsToRemove: [],
      proposedTitle: null,
      proposedBody: null,
      githubComment: null,
      close: null,
      ...mutations,
    },
    decomposition: { required: false, reason: null, childBriefs: [] },
    relatedWork: [],
  };
}

function alreadyDone(mutations: Partial<GroomingPlanDraft["mutations"]> = {}): GroomingPlanDraft {
  return {
    ...draft({ actionability: "already_done", lane: { id: "backlog", confidence: "high", reason: "done" } }),
    implementationBrief: null,
    mutations: {
      labelsToAdd: [],
      labelsToRemove: [],
      proposedTitle: null,
      proposedBody: null,
      githubComment: "Already fixed on main.",
      close: {
        reason: "already_done",
        rationale: "login.ts keeps returnTo",
        evidenceRefs: ["repo:src/auth/login.ts"],
        criteria: [
          { criterion: "login redirects to the saved return URL", evidenceRef: "repo:src/auth/login.ts", excerpt: 'return session.returnTo ?? "/";' },
        ],
      },
      ...mutations,
    },
  };
}

function planFor(d: GroomingPlanDraft, snap = snapshot()): GroomingPlan {
  const result = validateGroomingPlan(d, { catalog: catalogFor(snap) });
  if (!result.valid) throw new Error(result.errors!.join("; "));
  return result.plan!;
}

/** A plan that splits the issue into `count` bounded children (dispatch#1066). */
function decomposeDraft(count = 2): GroomingPlanDraft {
  // A ready `implementation` plan may not decompose, so the split lands as a
  // non-ready (backlog) verdict.
  const letter = (n: number) => String.fromCharCode(64 + n);
  return {
    ...draft({ actionability: "backlog", lane: { id: "backlog", confidence: "high", reason: "bounded" } }),
    implementationBrief: null,
    decomposition: {
      required: true,
      reason: `splits into ${count} bounded children`,
      childBriefs: Array.from({ length: count }, (_, i) => {
        const l = letter(i + 1);
        return {
          title: `Child issue ${l}`,
          problem: `Child ${l} problem`,
          designDecision: null,
          verifiedCurrentBehavior: null,
          relevantPaths: [],
          inScope: [l],
          outOfScope: [],
          dependencies: [],
          acceptanceCriteria: [`Child ${l} works`],
          tests: [],
        };
      }),
    },
  };
}

function live(snap = snapshot()): LiveIssueState {
  return { title: snap.issue.title, body: snap.issue.body, labels: snap.issue.labels, state: snap.issue.state };
}

function diffFor(d: GroomingPlanDraft, snap = snapshot()): GroomingMutationDiff {
  return computeMutationDiff({ plan: planFor(d, snap), live: live(snap), catalog: catalogFor(snap) });
}

describe("managed body section", () => {
  it("appends one managed section after the human text, which is kept byte for byte", () => {
    for (const [human, separator] of [
      ["Broken.  ", "\n\n"],
      ["Broken.\n", "\n"],
      ["Broken.\r\n\n", ""],
    ]) {
      const parsed = parseManagedBody(human);
      if (!parsed.ok) throw new Error("parse failed");
      const rendered = renderManagedBody(parsed, "## Context\nlogin.ts");
      expect(rendered).toBe(`${human}${separator}${MANAGED_BODY_START}\n## Context\nlogin.ts\n${MANAGED_BODY_END}`);
      expect(rendered.startsWith(human)).toBe(true);
    }
  });

  it("replaces an existing section in place and is a fixed point", () => {
    const body = `Intro.\n\n${MANAGED_BODY_START}\nold notes\n${MANAGED_BODY_END}\n\nA human added this below.`;
    const parsed = parseManagedBody(body);
    if (!parsed.ok) throw new Error("parse failed");
    expect(parsed.human).toBe("Intro.\n\nA human added this below.");
    const once = renderManagedBody(parsed, "new notes");
    expect(once).toBe(`Intro.\n\n${MANAGED_BODY_START}\nnew notes\n${MANAGED_BODY_END}\n\nA human added this below.`);
    const again = parseManagedBody(once);
    if (!again.ok) throw new Error("parse failed");
    expect(renderManagedBody(again, "new notes")).toBe(once);
  });

  it("refuses malformed markers rather than guessing", () => {
    expect(parseManagedBody(`x ${MANAGED_BODY_START} y`)).toMatchObject({ ok: false });
    expect(parseManagedBody(`${MANAGED_BODY_END} x ${MANAGED_BODY_START}`)).toMatchObject({ ok: false });
    expect(parseManagedBody(`${MANAGED_BODY_START}a${MANAGED_BODY_END}${MANAGED_BODY_START}b${MANAGED_BODY_END}`)).toMatchObject({
      ok: false,
    });
  });

  it("strips markers the model put inside its own content", () => {
    const parsed = parseManagedBody(null);
    if (!parsed.ok) throw new Error("parse failed");
    expect(renderManagedBody(parsed, `a ${MANAGED_BODY_END} b`)).toBe(`${MANAGED_BODY_START}\na  b\n${MANAGED_BODY_END}`);
  });
});

describe("computeMutationDiff", () => {
  it("diffs labels from the live issue and leaves the derived status as the only status", () => {
    const snap = snapshot({ issue: { ...snapshot().issue, labels: ["priority/p1", "status/backlog", "status/needs-review"] } });
    const diff = diffFor(draft(), snap);
    expect(diff.labelsBefore).toEqual(["priority/p1", "status/backlog", "status/needs-review"]);
    expect(diff.labelsAfter.filter((l) => l.startsWith("status/"))).toEqual(["status/ready"]);
    expect(diff.labelsAfter).toContain("type/bug");
    expect(diff.labelsStep).toEqual(diff.labelsAfter);
  });

  it("defers status/done to after the close", () => {
    const diff = diffFor(alreadyDone());
    expect(diff.close).toBe(true);
    expect(diff.labelsAfter).toEqual(["priority/p1", "status/done"]);
    expect(diff.labelsStep).toEqual(["priority/p1", "status/backlog"]);
  });

  it("collapses several live statuses to status/backlog before a close, so a failed close leaves exactly one", () => {
    const snap = snapshot({ issue: { ...snapshot().issue, labels: ["priority/p1", "status/backlog", "status/needs-review"] } });
    const diff = diffFor(alreadyDone(), snap);
    expect(diff.labelsStep.filter((l) => l.startsWith("status/"))).toEqual(["status/backlog"]);
    expect(diff.labelsAfter.filter((l) => l.startsWith("status/"))).toEqual(["status/done"]);
  });

  it("keeps a non-status label in the labels step on the done (close) branch", () => {
    // The umbrella is a non-status label; `umbrella` itself is not a model-usable
    // label, so a representative allowed non-status label (type/bug) proves the
    // done branch preserves non-status labels — the same derivation that keeps
    // the umbrella once the decomposition adds it to labelsAfter.
    const diff = diffFor(alreadyDone({ labelsToAdd: ["type/bug"] }));
    expect(diff.close).toBe(true);
    expect(diff.labelsAfter).toContain("type/bug");
    expect(diff.labelsStep).toContain("type/bug");
  });

  it("neutralizes @-mentions in a rewritten title and in the managed body section", () => {
    const snap = snapshot({ issue: { ...snapshot().issue, title: "P0" } });
    const diff = diffFor(draft({}, { proposedTitle: "Ask @alice about the redirect", proposedBody: "cc @bob" }), snap);
    expect(diff.title).toBe("Ask `@alice` about the redirect");
    expect(diff.body).toContain("cc `@bob`");
  });

  it("keeps good titles and non-sparse bodies, and records why the body was skipped", () => {
    const long = "A".repeat(150);
    const snap = snapshot({ issue: { ...snapshot().issue, body: long } });
    const diff = diffFor(draft({}, { proposedTitle: "A better title for this", proposedBody: "Notes." }), snap);
    expect(diff.title).toBeNull();
    expect(diff.body).toBeNull();
    expect(diff.bodySkippedReason).toBe("the human-authored body is not sparse");
  });

  it("does not rewrite the managed section when it already holds the proposed content", () => {
    const body = `Broken.\n\n${MANAGED_BODY_START}\nNotes.\n${MANAGED_BODY_END}`;
    const snap = snapshot({ issue: { ...snapshot().issue, body } });
    const diff = diffFor(draft({}, { proposedBody: "Notes." }), snap);
    expect(diff.body).toBeNull();
    expect(diff.bodySkippedReason).toBe("the managed section already holds this content");
  });

  it("withholds a close the close policy rejects, landing it as backlog with nothing else", () => {
    const plan = planFor(alreadyDone({ proposedTitle: "Rewritten title here" }));
    const forged: GroomingPlan = { ...plan, verdict: { ...plan.verdict, confidence: "medium" } };
    const diff = computeMutationDiff({ plan: forged, live: live(), catalog: catalogFor(snapshot()) });
    expect(diff.withheld.close).toEqual(["verdict confidence is medium; closing requires high"]);
    expect(diff.close).toBe(false);
    expect(diff.comment).toBeNull();
    expect(diff.title).toBeNull();
    expect(diff.labelsAfter).toEqual(["priority/p1", "status/backlog"]);
    expect(diff.output.notReadyReason).toMatch(/^Dispatch withheld the already_done close: verdict confidence is medium/);
  });

  it("withholds a ready promotion whose readiness does not hold against the catalog", () => {
    const plan = planFor(draft({}, { githubComment: "Ready!" }));
    const unpinned = catalogFor(snapshot({ headSha: null, pinnedRef: null }));
    const diff = computeMutationDiff({ plan, live: live(), catalog: unpinned });
    expect(diff.withheld.ready?.length).toBeGreaterThan(0);
    expect(diff.labelsAfter).not.toContain("status/ready");
    expect(diff.labelsAfter).toContain("status/backlog");
    expect(diff.lane).toBe("backlog");
    expect(diff.comment).toBeNull();
  });

  it("neutralizes mentions in the comment", () => {
    expect(diffFor(draft({}, { githubComment: "@alice fixed" })).comment).toBe("`@alice` fixed");
  });
});

describe("computeApplicationKey", () => {
  const plan = planFor(draft());
  const diff = diffFor(draft());

  it("is stable for the same plan and intent, whatever the label order", () => {
    const shuffled = { ...diff, labelsAfter: [...diff.labelsAfter].reverse() };
    expect(computeApplicationKey({ repoFullName: "Org/Repo", issueNumber: 42, plan, diff })).toBe(
      computeApplicationKey({ repoFullName: "org/repo", issueNumber: 42, plan, diff: shuffled }),
    );
  });

  it("changes with the evidence, the issue or the intent", () => {
    const base = computeApplicationKey({ repoFullName: "org/repo", issueNumber: 42, plan, diff });
    const otherEvidence = { ...plan, evidence: { ...plan.evidence, evidenceDigest: "other" } };
    expect(computeApplicationKey({ repoFullName: "org/repo", issueNumber: 42, plan: otherEvidence, diff })).not.toBe(base);
    expect(computeApplicationKey({ repoFullName: "org/repo", issueNumber: 43, plan, diff })).not.toBe(base);
    expect(computeApplicationKey({ repoFullName: "org/repo", issueNumber: 42, plan, diff: { ...diff, comment: "hi" } })).not.toBe(base);
  });

  it("is carried by the comment marker, which only counts at the end of a comment Dispatch posted", () => {
    expect(commentMarkerKey(`text\n\n${commentMarker(KEY)}`)).toBe(KEY);
    expect(commentMarkerKey("no marker")).toBeNull();
    expect(commentMarkerKey(`${commentMarker(KEY)}\n\nsomething after it`)).toBeNull();
    expect(groomerCommentKey({ author: "itsmiso-ai", body: `x\n\n${commentMarker(KEY)}` })).toBe(KEY);
    expect(groomerCommentKey({ author: "mallory", body: `x\n\n${commentMarker(KEY)}` })).toBeNull();
  });

  it("strips any Dispatch marker the model wrote into its comment", () => {
    const diff = diffFor(draft({}, { githubComment: `Ready. ${commentMarker("b".repeat(64))}` }));
    expect(diff.comment).toBe("Ready.");
  });
});

// ─── applyGroomingMutations ──────────────────────────────────────────────────

function memoryStore(initial?: ApplicationRecord): ApplicationStore & {
  rows: Map<string, ApplicationRecord>;
  children: Map<string, ChildClaimRecord>;
  decompositionStates: Array<{ labels: readonly string[]; followUpUrls: string[] }>;
} {
  const rows = new Map<string, ApplicationRecord>();
  const children = new Map<string, ChildClaimRecord>();
  const decompositionStates: Array<{ labels: readonly string[]; followUpUrls: string[] }> = [];
  if (initial) rows.set(initial.applicationKey, initial);
  return {
    rows,
    children,
    decompositionStates,
    find: async (key) => rows.get(key) ?? null,
    claim: async (input) => {
      const existing = rows.get(input.applicationKey) ?? null;
      if (!existing) {
        rows.set(input.applicationKey, {
          applicationKey: input.applicationKey,
          groomingRunId: input.groomingRunId,
          status: "in_progress",
          steps: {},
          attempts: 1,
        });
      }
      return { existing: existing ? { ...existing } : null };
    },
    save: async (key, data) => {
      const row = rows.get(key)!;
      row.status = data.status;
      row.steps = JSON.parse(JSON.stringify(data.steps));
    },
    hasRecentComment: async () => false,
    resume: async (key, seen) => {
      const row = rows.get(key)!;
      if (row.attempts !== seen.attempts || row.status !== seen.status) return false;
      row.attempts += 1;
      row.updatedAt = new Date();
      return true;
    },
    claimChild: async (input) => {
      const existing = children.get(input.childKey) ?? null;
      if (!existing) {
        // Mirrors @updatedAt: the row is stamped at create, so a claim left by
        // a crashed attempt is "fresh" until it ages out.
        children.set(input.childKey, {
          childKey: input.childKey,
          childNumber: null,
          childUrl: null,
          applicationKey: input.applicationKey,
          updatedAt: new Date(),
        });
      }
      return { existing: existing ? { ...existing } : null };
    },
    saveChild: async (childKey, data) => {
      const row = children.get(childKey)!;
      row.childNumber = data.childNumber;
      row.childUrl = data.childUrl;
    },
    // The shared helper's persistence is exercised by the route and
    // integration tests; the in-memory fake records the call only.
    setDecompositionState: async (input) => {
      decompositionStates.push({ labels: input.issue.labels, followUpUrls: input.followUpUrls });
    },
  };
}

function fakeGitHub(overrides: Partial<ApplierGitHub> = {}) {
  const calls: string[] = [];
  const github: ApplierGitHub = {
    updateLabels: vi.fn(async (_r, _n, labels: string[]) => {
      calls.push(`labels:${labels.filter((l) => l.startsWith("status/")).join(",")}`);
    }),
    addLabel: vi.fn(async (_r, _n, label: string) => {
      calls.push(`addLabel:${label}`);
    }),
    addComment: vi.fn(async () => {
      calls.push("comment");
      return { url: "https://github.com/org/repo/issues/42#issuecomment-1" };
    }),
    updateTitleAndBody: vi.fn(async (_r, _n, fields) => {
      calls.push(`content:${Object.keys(fields).join("+")}`);
    }),
    closeIssue: vi.fn(async () => {
      calls.push("close");
    }),
    createIssue: vi.fn(async (_r, input) => {
      calls.push(`child:${input.title}`);
      return { number: 43, url: "https://github.com/org/repo/issues/43" };
    }),
    fetchRecentComments: vi.fn(async () => []),
    ...overrides,
  };
  return { github, calls };
}

function applyInput(diff: GroomingMutationDiff, overrides: Partial<ApplyInput> = {}): ApplyInput {
  return {
    repoFullName: "org/repo",
    issueNumber: 42,
    issueId: "issue-42",
    parentUrl: "https://github.com/org/repo/issues/42",
    groomingRunId: "run-1",
    applicationKey: KEY,
    diff,
    recentComments: [],
    force: false,
    commentCooldownHours: 24,
    ...overrides,
  };
}

const fullDiff = () =>
  diffFor(alreadyDone({ labelsToAdd: ["type/bug"], proposedTitle: "Rewritten descriptive title", proposedBody: "Notes." }), snapshot({ issue: { ...snapshot().issue, title: "P0" } }));

describe("applyGroomingMutations", () => {
  it("applies lowest impact first: labels, comment, title/body, close, then status/done", async () => {
    const { github, calls } = fakeGitHub();
    const store = memoryStore();
    const result = await applyGroomingMutations(applyInput(fullDiff()), github, store);
    expect(calls).toEqual(["labels:status/backlog", "comment", "content:title+body", "close", "labels:status/done"]);
    expect(result.outcome).toBe("applied");
    expect(result.closed).toBe(true);
    expect(result.labels).toContain("status/done");
    expect(store.rows.get(KEY)).toMatchObject({ status: "applied" });
    expect((addCommentBody(github))).toMatch(new RegExp(`\\n\\n${commentMarker(KEY)}$`));
  });

  it("halts at the first failure: a failed comment prevents the title/body rewrite and the close", async () => {
    const { github, calls } = fakeGitHub({
      addComment: vi.fn(async () => {
        throw new Error("GitHub API error adding comment: 504");
      }),
    });
    const store = memoryStore();
    const result = await applyGroomingMutations(applyInput(fullDiff()), github, store);
    expect(calls).toEqual(["labels:status/backlog"]);
    expect(github.addComment).toHaveBeenCalledTimes(2);
    expect(github.updateTitleAndBody).not.toHaveBeenCalled();
    expect(github.closeIssue).not.toHaveBeenCalled();
    expect(result.outcome).toBe("partial");
    expect(result.failure).toMatchObject({ step: "comment", error: expect.stringContaining("504") });
    expect(result.steps).toMatchObject({
      labels: { status: "applied" },
      comment: { status: "failed" },
      content: { status: "not_attempted" },
      close: { status: "not_attempted" },
      done_label: { status: "not_attempted" },
    });
    expect(result.closed).toBe(false);
    expect(store.rows.get(KEY)).toMatchObject({ status: "partial" });
  });

  it("reports failed, with nothing applied, when the first needed write fails", async () => {
    const { github } = fakeGitHub({
      updateLabels: vi.fn(async () => {
        throw new Error("422");
      }),
    });
    const store = memoryStore();
    const result = await applyGroomingMutations(applyInput(fullDiff()), github, store);
    expect(result.outcome).toBe("failed");
    expect(store.rows.get(KEY)).toMatchObject({ status: "failed" });
    expect(github.addComment).not.toHaveBeenCalled();
    expect(github.closeIssue).not.toHaveBeenCalled();
  });

  it("does not repeat anything for an application already applied", async () => {
    const { github } = fakeGitHub();
    const store = memoryStore();
    await applyGroomingMutations(applyInput(fullDiff()), github, store);
    const again = fakeGitHub();
    const replay = await applyGroomingMutations(applyInput(fullDiff(), { groomingRunId: "run-2" }), again.github, store);
    expect(replay.outcome).toBe("replayed");
    expect(replay.claimedByRunId).toBe("run-1");
    expect(again.calls).toEqual([]);
    expect(replay.steps.comment?.status).toBe("replayed");
    expect(replay.commentUrl).toBe("https://github.com/org/repo/issues/42#issuecomment-1");
  });

  it("resumes a partial application without repeating the steps that landed", async () => {
    const first = fakeGitHub({
      closeIssue: vi.fn(async () => {
        throw new Error("502");
      }),
    });
    const store = memoryStore();
    const partial = await applyGroomingMutations(applyInput(fullDiff()), first.github, store);
    expect(partial.outcome).toBe("partial");

    const retry = fakeGitHub();
    const resumed = await applyGroomingMutations(applyInput(fullDiff(), { groomingRunId: "run-2" }), retry.github, store);
    expect(retry.calls).toEqual(["close", "labels:status/done"]);
    expect(resumed.outcome).toBe("applied");
    expect(resumed.steps).toMatchObject({
      labels: { status: "replayed" },
      comment: { status: "replayed" },
      content: { status: "replayed" },
      close: { status: "applied" },
      done_label: { status: "applied" },
    });
    expect(store.rows.get(KEY)).toMatchObject({ status: "applied" });
  });

  it("finds its own comment on GitHub by marker instead of posting it twice", async () => {
    const own: LiveComment = { id: 7, author: "itsmiso-ai", createdAt: "2026-09-26T00:00:00Z", body: `x\n\n${commentMarker(KEY)}`, url: "u7" };
    const { github } = fakeGitHub();
    const result = await applyGroomingMutations(applyInput(fullDiff(), { recentComments: [own] }), github, memoryStore());
    expect(github.addComment).not.toHaveBeenCalled();
    expect(result.steps.comment).toMatchObject({ status: "replayed", commentUrl: "u7" });
    expect(result.commentUrl).toBe("u7");
  });

  it("does not retry a failed comment when it cannot tell whether the first write landed", async () => {
    const { github } = fakeGitHub({
      addComment: vi.fn(async () => {
        throw new Error("504");
      }),
      fetchRecentComments: vi.fn(async () => {
        throw new Error("502");
      }),
    });
    const result = await applyGroomingMutations(applyInput(fullDiff()), github, memoryStore());
    expect(github.addComment).toHaveBeenCalledTimes(1);
    expect(result.steps.comment).toMatchObject({ status: "failed", error: "504" });
    expect(github.closeIssue).not.toHaveBeenCalled();
  });

  it("records steps that landed earlier as replayed even when an earlier step fails this time", async () => {
    const store = memoryStore({
      applicationKey: KEY,
      groomingRunId: "run-0",
      status: "partial",
      steps: { comment: { status: "applied", commentUrl: "u0" } },
      attempts: 1,
    });
    const { github } = fakeGitHub({
      updateLabels: vi.fn(async () => {
        throw new Error("422");
      }),
    });
    const result = await applyGroomingMutations(applyInput(fullDiff()), github, store);
    expect(result.steps.labels?.status).toBe("failed");
    expect(result.steps.comment).toMatchObject({ status: "replayed", commentUrl: "u0" });
    expect(result.steps.close?.status).toBe("not_attempted");
    expect(github.addComment).not.toHaveBeenCalled();
  });

  it("does not retry a comment that landed despite a failed response", async () => {
    let posted = "";
    const { github } = fakeGitHub({
      addComment: vi.fn(async (_r, _n, body: string) => {
        posted = body;
        throw new Error("504 after accept");
      }),
      fetchRecentComments: vi.fn(async () => [{ id: 9, author: "itsmiso-ai", createdAt: "2026-09-26T00:00:00Z", body: posted, url: "u9" }]),
    });
    const result = await applyGroomingMutations(applyInput(fullDiff()), github, memoryStore());
    expect(github.addComment).toHaveBeenCalledTimes(1);
    expect(result.steps.comment).toMatchObject({ status: "applied", commentUrl: "u9" });
    expect(result.outcome).toBe("applied");
  });

  it("skips the comment inside the cooldown window, seen either on a run or on GitHub by marker", async () => {
    const other: LiveComment = {
      id: 3,
      author: "itsmiso-ai",
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      body: `earlier\n\n${commentMarker("b".repeat(64))}`,
      url: null,
    };
    const { github } = fakeGitHub();
    const result = await applyGroomingMutations(applyInput(fullDiff(), { recentComments: [other] }), github, memoryStore());
    expect(github.addComment).not.toHaveBeenCalled();
    expect(result.steps.comment).toMatchObject({ status: "skipped", detail: "cooldown" });
    // A skipped comment is not a failure: the close still happens.
    expect(github.closeIssue).toHaveBeenCalled();

    const forced = fakeGitHub();
    await applyGroomingMutations(applyInput(fullDiff(), { recentComments: [other], force: true, applicationKey: "c".repeat(64) }), forced.github, memoryStore());
    expect(forced.github.addComment).toHaveBeenCalledTimes(1);
  });

  it("ignores a forged marker from a non-automation author for replay and cooldown", async () => {
    const forged: LiveComment[] = [
      { id: 1, author: "mallory", createdAt: new Date().toISOString(), body: `hi\n\n${commentMarker(KEY)}`, url: "m1" },
      { id: 2, author: "mallory", createdAt: new Date().toISOString(), body: `hi\n\n${commentMarker("b".repeat(64))}`, url: "m2" },
    ];
    const { github } = fakeGitHub();
    const result = await applyGroomingMutations(applyInput(fullDiff(), { recentComments: forged }), github, memoryStore());
    expect(github.addComment).toHaveBeenCalledTimes(1);
    expect(result.steps.comment?.status).toBe("applied");
  });

  it("does nothing while another attempt holds a fresh unfinished claim on the same key", async () => {
    const store = memoryStore({
      applicationKey: KEY,
      groomingRunId: "run-0",
      status: "in_progress",
      steps: {},
      attempts: 1,
      updatedAt: new Date(Date.now() - 60 * 1000),
    });
    const { github, calls } = fakeGitHub();
    const result = await applyGroomingMutations(applyInput(fullDiff()), github, store);
    expect(result.outcome).toBe("busy");
    expect(result.claimedByRunId).toBe("run-0");
    expect(calls).toEqual([]);
    expect(store.rows.get(KEY)!.attempts).toBe(1);
  });

  it("stays busy when another attempt resumed the abandoned claim first", async () => {
    const store = memoryStore({
      applicationKey: KEY,
      groomingRunId: "run-0",
      status: "in_progress",
      steps: {},
      attempts: 1,
      updatedAt: new Date(Date.now() - 11 * 60 * 1000),
    });
    const stale = { ...store.rows.get(KEY)! };
    store.claim = async () => ({ existing: stale });
    // The first resumer wins the compare-and-swap and moves updatedAt on.
    expect(await store.resume(KEY, stale)).toBe(true);
    const { github, calls } = fakeGitHub();
    const result = await applyGroomingMutations(applyInput(fullDiff()), github, store);
    expect(result.outcome).toBe("busy");
    expect(calls).toEqual([]);
  });

  it("resumes an abandoned unfinished claim once it has aged out", async () => {
    const store = memoryStore({
      applicationKey: KEY,
      groomingRunId: "run-0",
      status: "in_progress",
      steps: { labels: { status: "applied" } },
      attempts: 1,
      updatedAt: new Date(Date.now() - 11 * 60 * 1000),
    });
    const { github, calls } = fakeGitHub();
    const result = await applyGroomingMutations(applyInput(fullDiff()), github, store);
    expect(result.outcome).toBe("applied");
    expect(calls).toEqual(["comment", "content:title+body", "close", "labels:status/done"]);
    expect(store.rows.get(KEY)!.attempts).toBe(2);
  });

  it("writes nothing when live state already matches the plan", async () => {
    const snap = snapshot({ issue: { ...snapshot().issue, labels: ["priority/p1", "status/ready", "type/bug"] } });
    const { github } = fakeGitHub();
    const result = await applyGroomingMutations(applyInput(diffFor(draft(), snap)), github, memoryStore());
    expect(result.outcome).toBe("noop");
    expect(github.updateLabels).not.toHaveBeenCalled();
    expect(result.steps.labels).toMatchObject({ status: "noop" });
  });
});

describe("applyGroomingMutations → decomposition", () => {
  it("creates each child issue, adds the umbrella via addLabel after all children land, and records the child links", async () => {
    const { github, calls } = fakeGitHub();
    const store = memoryStore();
    const diff = diffFor(decomposeDraft());
    expect(diff.children).not.toBeNull();
    // The umbrella is NOT part of the labels step: it is an additive write the
    // children step makes via addLabel, so it never rides labelsStep/labelsAfter.
    expect(diff.labelsAfter).not.toContain("umbrella");
    expect(diff.labelsStep).not.toContain("umbrella");
    const result = await applyGroomingMutations(applyInput(diff), github, store);
    expect(result.outcome).toBe("applied");
    expect(github.createIssue).toHaveBeenCalledTimes(2);
    expect(store.children.size).toBe(2);
    // The single labels write carries no umbrella; the children step makes it.
    expect(github.updateLabels).toHaveBeenCalledTimes(1);
    expect(github.updateLabels).toHaveBeenCalledWith("org/repo", 42, expect.not.arrayContaining(["umbrella"]));
    // addLabel is called exactly once, with the umbrella, and only after every
    // child was created or reused.
    expect(github.addLabel).toHaveBeenCalledTimes(1);
    expect(github.addLabel).toHaveBeenCalledWith("org/repo", 42, "umbrella");
    const addLabelIdx = calls.indexOf("addLabel:umbrella");
    const childAIdx = calls.indexOf("child:Child issue A");
    const childBIdx = calls.indexOf("child:Child issue B");
    expect(addLabelIdx).toBeGreaterThan(childAIdx);
    expect(addLabelIdx).toBeGreaterThan(childBIdx);
    // The children step carries the created child LINKS (key/number/url), not counts.
    const step = result.steps.children!;
    expect(step.status).toBe("applied");
    expect(step.children?.created).toHaveLength(2);
    expect(step.children?.reused).toHaveLength(0);
    for (const link of step.children!.created) {
      expect(link.key).toBeTypeOf("string");
      expect(link.number).toBeTypeOf("number");
      expect(link.url).toBeTypeOf("string");
    }
    // The parent's decomposition state is recorded with the final label set
    // (labelsAfter + umbrella) and the child URLs as the follow-ups.
    expect(store.decompositionStates).toHaveLength(1);
    expect(store.decompositionStates[0].labels).toContain("umbrella");
    expect(store.decompositionStates[0].followUpUrls).toHaveLength(2);
    // ApplyResult.labels (freshness baseline / audit) includes the umbrella.
    expect(result.labels).toContain("umbrella");
    // ApplyResult.children carries the created links in brief order.
    expect(result.children).toHaveLength(2);
  });

  it("records the decomposition state before adding the umbrella label (step ordering)", async () => {
    const { github, calls } = fakeGitHub();
    const store = memoryStore();
    const recordState = store.setDecompositionState;
    store.setDecompositionState = async (input) => {
      calls.push("decompositionState");
      return recordState(input);
    };
    const diff = diffFor(decomposeDraft());
    const result = await applyGroomingMutations(applyInput(diff), github, store);
    expect(result.outcome).toBe("applied");
    // The umbrella, which removes the parent from every selection path, must
    // be the children step's final write: the state lands before it.
    const stateIdx = calls.indexOf("decompositionState");
    const addLabelIdx = calls.indexOf("addLabel:umbrella");
    expect(stateIdx).toBeGreaterThan(-1);
    expect(addLabelIdx).toBeGreaterThan(stateIdx);
  });

  it("reuses a child an earlier attempt already created, creating only the missing one", async () => {
    const { github } = fakeGitHub();
    const store = memoryStore();
    const diff = diffFor(decomposeDraft());
    const briefs = diff.children!.briefs;
    // Simulate the first child having been created by an earlier attempt.
    const firstKey = childBriefKey("org/repo", 42, briefs[0]);
    store.children.set(firstKey, {
      childKey: firstKey,
      childNumber: 99,
      childUrl: "https://github.com/org/repo/issues/99",
      applicationKey: KEY,
    });
    const result = await applyGroomingMutations(applyInput(diff), github, store);
    expect(github.createIssue).toHaveBeenCalledTimes(1);
    const step = result.steps.children!;
    expect(step.children?.created).toHaveLength(1);
    expect(step.children?.reused).toEqual([{ key: firstKey, number: 99, url: "https://github.com/org/repo/issues/99" }]);
    // ApplyResult.children is in brief order: the reused first child, then the created one.
    expect(result.children.map((l) => l.number)).toEqual([99, 43]);
  });

  it("surfaces the created child links again on a replay, without re-creating them", async () => {
    const store = memoryStore();
    const diff = diffFor(decomposeDraft());
    const first = fakeGitHub();
    const applied = await applyGroomingMutations(applyInput(diff), first.github, store);
    expect(applied.outcome).toBe("applied");
    expect(applied.children).toHaveLength(2);
    // A replay of the same applied key re-surfaces the links and writes nothing.
    const second = fakeGitHub();
    const replayed = await applyGroomingMutations(applyInput(diff), second.github, store);
    expect(replayed.outcome).toBe("replayed");
    expect(second.github.createIssue).not.toHaveBeenCalled();
    expect(replayed.children).toEqual(applied.children);
  });

  it("creates no children when the decomposition is withheld by policy", async () => {
    const { github } = fakeGitHub();
    const store = memoryStore();
    // A low-confidence split is withheld; no children land.
    const base = decomposeDraft();
    const diff = diffFor({ ...base, verdict: { ...base.verdict, confidence: "low" } });
    expect(diff.children).toBeNull();
    expect(diff.withheld.decomposition).toBeDefined();
    const result = await applyGroomingMutations(applyInput(diff), github, store);
    expect(github.createIssue).not.toHaveBeenCalled();
    expect(github.addLabel).not.toHaveBeenCalled();
    expect(store.children.size).toBe(0);
    expect(store.decompositionStates).toHaveLength(0);
    expect(result.steps.children).toMatchObject({ status: "noop" });
    expect(result.labels).not.toContain("umbrella");
  });

  it("adds no umbrella when the decomposition is withheld for material uncertainty", async () => {
    const { github } = fakeGitHub();
    const store = memoryStore();
    // A split with a material uncertainty is withheld; no children and no umbrella.
    const base = decomposeDraft();
    const diff = diffFor({
      ...base,
      verdict: { ...base.verdict, uncertainties: [{ kind: "scope", question: "Which child owns the migration?", material: true }] },
    });
    expect(diff.children).toBeNull();
    expect(diff.withheld.decomposition).toBeDefined();
    const result = await applyGroomingMutations(applyInput(diff), github, store);
    expect(github.createIssue).not.toHaveBeenCalled();
    expect(github.addLabel).not.toHaveBeenCalled();
    expect(store.children.size).toBe(0);
    expect(store.decompositionStates).toHaveLength(0);
    expect(result.steps.children).toMatchObject({ status: "noop" });
    expect(result.labels).not.toContain("umbrella");
  });

  it("does not create a child whose null claim is held by a fresh in-flight attempt", async () => {
    const { github } = fakeGitHub();
    const store = memoryStore();
    const diff = diffFor(decomposeDraft());
    const briefs = diff.children!.briefs;
    const firstKey = childBriefKey("org/repo", 42, briefs[0]);
    // A claim with no recorded child under a DIFFERENT application key,
    // written moments ago: another attempt is in flight on it. Do not create a
    // duplicate on top of it.
    store.children.set(firstKey, {
      childKey: firstKey,
      childNumber: null,
      childUrl: null,
      applicationKey: "b".repeat(64),
      updatedAt: new Date(),
    });
    const result = await applyGroomingMutations(applyInput(diff), github, store);
    expect(result.outcome).toBe("partial"); // the labels step landed, children failed
    expect(result.failure).toMatchObject({ step: "children", error: expect.stringContaining(`child claim ${firstKey} is held by another in-flight attempt`) });
    expect(result.steps.children).toMatchObject({ status: "failed" });
    // No create for the held child, and no umbrella on a failed decomposition.
    expect(github.createIssue).not.toHaveBeenCalled();
    expect(github.addLabel).not.toHaveBeenCalled();
    expect(result.labels).not.toContain("umbrella");
  });

  it("creates a child whose fresh null claim is its own (same application key)", async () => {
    const { github } = fakeGitHub();
    const store = memoryStore();
    const diff = diffFor(decomposeDraft());
    const briefs = diff.children!.briefs;
    const firstKey = childBriefKey("org/repo", 42, briefs[0]);
    // A claim with no recorded child under THIS application's own key, written
    // moments ago: the GroomingApplication resume CAS already excludes a
    // concurrent same-key attempt, so this is my own abandoned create from a
    // crashed attempt — create on top of it (the immediate same-key retry).
    store.children.set(firstKey, {
      childKey: firstKey,
      childNumber: null,
      childUrl: null,
      applicationKey: KEY,
      updatedAt: new Date(),
    });
    const result = await applyGroomingMutations(applyInput(diff), github, store);
    expect(result.outcome).toBe("applied");
    expect(github.createIssue).toHaveBeenCalledTimes(2);
    // The abandoned claim is overwritten with the newly created child.
    expect(store.children.get(firstKey)).toMatchObject({ childNumber: 43, childUrl: "https://github.com/org/repo/issues/43" });
    expect(github.addLabel).toHaveBeenCalledTimes(1);
  });

  it("creates a child whose null claim has aged out (no in-flight attempt)", async () => {
    const { github } = fakeGitHub();
    const store = memoryStore();
    const diff = diffFor(decomposeDraft());
    const briefs = diff.children!.briefs;
    const firstKey = childBriefKey("org/repo", 42, briefs[0]);
    // A claim with no recorded child and no applicationKey (a row shape no
    // deployed env has), written more than 2×ACTIVE_CLAIM_MS ago: the attempt
    // that took it is long gone, so create proceeds.
    store.children.set(firstKey, {
      childKey: firstKey,
      childNumber: null,
      childUrl: null,
      applicationKey: null,
      updatedAt: new Date(Date.now() - 2 * ACTIVE_CLAIM_MS),
    });
    const result = await applyGroomingMutations(applyInput(diff), github, store);
    expect(result.outcome).toBe("applied");
    expect(github.createIssue).toHaveBeenCalledTimes(2);
    // The stale claim is overwritten with the newly created child.
    expect(store.children.get(firstKey)).toMatchObject({ childNumber: 43, childUrl: "https://github.com/org/repo/issues/43" });
    expect(github.addLabel).toHaveBeenCalledTimes(1);
  });

  it("carries the partial children on a failed create, and converges on a retry of the same key", async () => {
    const first = fakeGitHub({
      createIssue: vi.fn(async (_r: string, input: { title: string }) => {
        if (input.title === "Child issue B") throw new Error("GitHub API error creating issue: 502");
        return { number: 43, url: "https://github.com/org/repo/issues/43" };
      }),
    });
    const store = memoryStore();
    const diff = diffFor(decomposeDraft(3));
    const attempt = await applyGroomingMutations(applyInput(diff), first.github, store);
    expect(attempt.outcome).toBe("partial"); // the labels step landed
    const step = attempt.steps.children!;
    expect(step.status).toBe("failed");
    expect(step.error).toContain("502");
    // The failed step record carries the child that landed before the failure.
    expect(step.children?.created).toHaveLength(1);
    expect(step.children?.created[0].number).toBe(43);
    expect(attempt.failure).toMatchObject({ step: "children" });
    // A partial decomposition never lands the umbrella.
    expect(first.github.addLabel).not.toHaveBeenCalled();

    // A retry under the same application key (no hand-seeded rows): child A
    // is reused; child B's fresh null claim carries THIS key, which the
    // GroomingApplication resume CAS proves is not a concurrent holder, so the
    // held-claim guard does not fire and only the missing children are created,
    // and the umbrella lands at that point.
    const retry = fakeGitHub();
    const converged = await applyGroomingMutations(applyInput(diff), retry.github, store);
    expect(converged.outcome).toBe("applied");
    expect(retry.github.createIssue).toHaveBeenCalledTimes(2); // B and C, not A
    expect(retry.github.createIssue).not.toHaveBeenCalledWith("org/repo", expect.objectContaining({ title: "Child issue A" }));
    const retriedStep = converged.steps.children!;
    expect(retriedStep.children?.created).toHaveLength(2);
    expect(retriedStep.children?.reused).toHaveLength(1);
    expect(retry.github.addLabel).toHaveBeenCalledTimes(1);
    expect(retry.github.addLabel).toHaveBeenCalledWith("org/repo", 42, "umbrella");
  });

  it("reuses every child under a different application key, creating no duplicates", async () => {
    const first = fakeGitHub();
    const store = memoryStore();
    const diff = diffFor(decomposeDraft());
    const applied = await applyGroomingMutations(applyInput(diff), first.github, store);
    expect(applied.outcome).toBe("applied");
    expect(first.github.createIssue).toHaveBeenCalledTimes(2);

    // A different application (a re-plan under a new key) that plans the same
    // children: the child claims from the first run are reused, no duplicates.
    const otherKey = "b".repeat(64);
    const second = fakeGitHub();
    const reused = await applyGroomingMutations(applyInput(diff, { applicationKey: otherKey, groomingRunId: "run-2" }), second.github, store);
    expect(reused.outcome).toBe("applied");
    expect(second.github.createIssue).not.toHaveBeenCalled();
    expect(reused.steps.children?.children?.reused).toHaveLength(2);
    expect(reused.steps.children?.children?.created).toHaveLength(0);
    expect(second.github.addLabel).toHaveBeenCalledTimes(1);
  });

  it("computes an identical application key for the same children in a different brief order", () => {
    const base = decomposeDraft();
    const keyA = computeApplicationKey({
      repoFullName: "org/repo",
      issueNumber: 42,
      plan: planFor(base),
      diff: diffFor(base),
    });
    // The same set of children, reordered: the application key is stable.
    const reordered: GroomingPlanDraft = { ...base, decomposition: { ...base.decomposition, childBriefs: [...base.decomposition.childBriefs].reverse() } };
    const keyB = computeApplicationKey({
      repoFullName: "org/repo",
      issueNumber: 42,
      plan: planFor(reordered),
      diff: diffFor(reordered),
    });
    expect(keyB).toBe(keyA);
    // A changed brief (a new title) is a different application.
    const changed: GroomingPlanDraft = {
      ...base,
      decomposition: { ...base.decomposition, childBriefs: base.decomposition.childBriefs.map((b, i) => (i === 0 ? { ...b, title: "A renamed child" } : b)) },
    };
    const keyC = computeApplicationKey({
      repoFullName: "org/repo",
      issueNumber: 42,
      plan: planFor(changed),
      diff: diffFor(changed),
    });
    expect(keyC).not.toBe(keyA);
  });
});

function addCommentBody(github: ApplierGitHub): string {
  return (github.addComment as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
}

describe("makePrismaApplicationStore", () => {
  function client() {
    const rows = new Map<string, ApplicationRecord>();
    return {
      rows,
      groomingApplication: {
        findUnique: vi.fn(async ({ where }: { where: { applicationKey: string } }): Promise<ApplicationRecord | null> =>
          rows.get(where.applicationKey) ?? null,
        ),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          rows.set(String(data.applicationKey), {
            applicationKey: String(data.applicationKey),
            groomingRunId: (data.groomingRunId as string) ?? null,
            status: String(data.status),
            steps: data.steps,
            attempts: 1,
          });
          return data;
        }),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      groomingRun: { findFirst: vi.fn(async () => null) },
      groomingChildClaim: {
        findUnique: vi.fn(async (): Promise<ChildClaimRecord | null> => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
        update: vi.fn(async () => ({})),
      },
      issue: { update: vi.fn(async () => ({})) },
      auditLog: { create: vi.fn(async () => ({})) },
    };
  }

  it("claims a new key, and returns the existing record on a repeat claim", async () => {
    const c = client();
    const store = makePrismaApplicationStore(c);
    const input = { applicationKey: KEY, issueId: "i", groomingRunId: "r1", repoFullName: "org/repo", issueNumber: 42 };
    expect(await store.claim(input)).toEqual({ existing: null });
    expect(c.groomingApplication.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ applicationKey: KEY, status: "in_progress", steps: {} }),
    });
    const second = await store.claim({ ...input, groomingRunId: "r2" });
    expect(second.existing).toMatchObject({ applicationKey: KEY, groomingRunId: "r1" });
    // A repeat claim only reads; resuming it is what counts an attempt.
    expect(c.groomingApplication.update).not.toHaveBeenCalled();
    const seen = second.existing!;
    expect(await store.resume(KEY, seen)).toBe(true);
    expect(c.groomingApplication.updateMany).toHaveBeenCalledWith({
      where: { applicationKey: KEY, status: seen.status, attempts: 1 },
      data: { attempts: { increment: 1 } },
    });
  });

  it("lets only one of two resumers take over an abandoned claim", async () => {
    const c = client();
    c.groomingApplication.updateMany.mockResolvedValueOnce({ count: 0 });
    const store = makePrismaApplicationStore(c);
    const seen = { applicationKey: KEY, groomingRunId: "r0", status: "in_progress", steps: {}, attempts: 1, updatedAt: new Date(0) };
    expect(await store.resume(KEY, seen)).toBe(false);
  });

  it("looks for a recorded hosted-groomer comment on this issue inside the window", async () => {
    const c = client();
    const since = new Date("2026-09-25T00:00:00Z");
    const store = makePrismaApplicationStore(c);
    expect(await store.hasRecentComment("issue-42", since)).toBe(false);
    expect(c.groomingRun.findFirst).toHaveBeenCalledWith({
      where: { issueId: "issue-42", commentUrl: { not: null }, updatedAt: { gte: since } },
    });
    c.groomingRun.findFirst.mockResolvedValueOnce({ id: "gr-0" } as never);
    expect(await store.hasRecentComment("issue-42", since)).toBe(true);
  });

  it("reads the winner when it loses a concurrent claim (P2002)", async () => {
    const c = client();
    const winner = { applicationKey: KEY, groomingRunId: "r0", status: "applied", steps: {} as ApplySteps, attempts: 1 };
    c.groomingApplication.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    c.groomingApplication.create.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    const store = makePrismaApplicationStore(c);
    const claimed = await store.claim({ applicationKey: KEY, issueId: "i", groomingRunId: "r1", repoFullName: "org/repo", issueNumber: 42 });
    expect(claimed.existing).toEqual(winner);
  });

  it("propagates other database errors, so nothing is applied unclaimed", async () => {
    const c = client();
    c.groomingApplication.create.mockRejectedValueOnce(new Error("connection refused"));
    const store = makePrismaApplicationStore(c);
    await expect(
      store.claim({ applicationKey: KEY, issueId: "i", groomingRunId: "r1", repoFullName: "org/repo", issueNumber: 42 }),
    ).rejects.toThrow("connection refused");
  });
});
