import { describe, expect, it, vi } from "vitest";
import type { GroomingEvidenceSnapshot } from "./groomer/evidence-snapshot";
import {
  applyReportClose,
  evaluateReportClose,
  resolveAlreadyDoneFromAgentReport,
  type ReportCloseClient,
  type ReportCloseCriterion,
  type ReportCloseDeps,
} from "./report-close";
import { resolvePrFixFromAgentReport } from "./pr-fix-queue";

const HEAD = "aaaa1111bbbb2222";

const LOGIN_TS =
  'export function redirectAfterLogin(session: Session) {\n  return session.returnTo ?? "/";\n}\n';

const BODY = [
  "## Acceptance criteria",
  "- [ ] Login redirects after password reset",
  "",
  "## Expected files",
  "- `src/auth/login.ts`",
].join("\n");

const GROUNDED_EXCERPT = 'return session.returnTo ?? "/";';

function snapshot(overrides: Partial<GroomingEvidenceSnapshot> = {}): GroomingEvidenceSnapshot {
  return {
    capturedAt: "2026-10-10T00:00:00.000Z",
    repoFullName: "org/repo",
    defaultBranch: "main",
    headSha: HEAD,
    pinnedRef: HEAD,
    issue: {
      number: 42,
      title: "Fix login redirect after password reset",
      body: BODY,
      labels: ["priority/p1", "status/backlog"],
      state: "open",
      stateReason: null,
      updatedAt: "2026-10-09T00:00:00.000Z",
      url: "https://github.com/org/repo/issues/42",
    },
    issueFingerprint: "fp",
    comments: [],
    evidenceDigest: "digest",
    warnings: [],
    sources: [],
    ...overrides,
  };
}

function criterion(overrides: Partial<ReportCloseCriterion> = {}): ReportCloseCriterion {
  return {
    criterion: "Login redirects after password reset",
    path: "src/auth/login.ts",
    excerpt: GROUNDED_EXCERPT,
    ...overrides,
  };
}

function deps(overrides: Partial<ReportCloseDeps> = {}): ReportCloseDeps {
  return {
    collectSnapshot: async () => snapshot(),
    fetchComments: async () => [],
    fetchIssueState: async () => ({ state: "open", stateReason: null }),
    fetchFullIssue: async () => ({
      title: "Fix login redirect after password reset",
      body: BODY,
      labels: ["priority/p1", "status/backlog"],
      state: "open",
      stateReason: null,
    }),
    fetchHeadSha: async () => HEAD,
    readFile: async (_repo, path) => (path === "src/auth/login.ts" ? LOGIN_TS : ""),
    closeIssue: vi.fn(async () => {}),
    transitionStatus: vi.fn(async (_repo, _issue, _labels, target) => ["status/backlog", target]),
    now: () => new Date("2026-10-10T00:00:00.000Z"),
    ...overrides,
  };
}

function client(): ReportCloseClient & {
  issue: { update: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
} {
  return {
    issue: { update: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
  };
}

describe("evaluateReportClose — grounded close", () => {
  it("is eligible when every criterion grounds against the pinned head", async () => {
    const result = await evaluateReportClose(
      { repoFullName: "org/repo", issueNumber: 42, criteria: [criterion()] },
      deps(),
    );
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.headSha).toBe(HEAD);
    expect(result.issueKey).toBe("org/repo#42");
    expect(result.criteria).toEqual([{ criterion: "Login redirects after password reset", path: "src/auth/login.ts" }]);
  });

  it("does not require or read a worker confidence claim", async () => {
    const result = await evaluateReportClose(
      { repoFullName: "org/repo", issueNumber: 42, criteria: [criterion()] },
      deps(),
    );
    expect(result.eligible).toBe(true);
  });

  it("applies the close: GitHub close, status/done, mirror and audit", async () => {
    const d = deps();
    const c = client();
    const evaluation = await evaluateReportClose(
      { repoFullName: "org/repo", issueNumber: 42, criteria: [criterion()] },
      d,
    );
    const applied = await applyReportClose({
      evaluation,
      actor: "alpha",
      issueId: "issue-42",
      client: c,
      evidence: "already shipped in abc123",
      deps: d,
    });
    expect(applied.closed).toBe(true);
    expect(applied.labelsAfter).toEqual(["status/backlog", "status/done"]);
    expect(d.closeIssue).toHaveBeenCalledWith("org/repo", 42);
    expect(c.issue.update).toHaveBeenCalledWith({
      where: { id: "issue-42" },
      data: expect.objectContaining({ state: "closed" }),
    });
    const audit = c.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe("already_done");
    expect(audit.actor).toBe("alpha");
    expect(audit.success).toBe(true);
    expect(JSON.parse(audit.notes).evidence).toBe("already shipped in abc123");
    expect(JSON.parse(audit.notes).headSha).toBe(HEAD);
  });

  it("surfaces a best-effort warning when the status write fails after the close", async () => {
    const d = deps({
      transitionStatus: vi.fn(async () => {
        throw new Error("labels unavailable");
      }),
    });
    const c = client();
    const evaluation = await evaluateReportClose(
      { repoFullName: "org/repo", issueNumber: 42, criteria: [criterion()] },
      d,
    );
    const applied = await applyReportClose({ evaluation, actor: "alpha", issueId: "issue-42", client: c, deps: d });
    expect(applied.closed).toBe(true);
    expect(applied.warning).toContain("status/done");
    expect(applied.labelsAfter).toEqual(["priority/p1", "status/done"]);
  });

  it("resolver returns action closed", async () => {
    const d = deps();
    const c = client();
    const result = await resolveAlreadyDoneFromAgentReport({
      repoFullName: "org/repo",
      issueNumber: 42,
      criteria: [criterion()],
      actor: "alpha",
      issueId: "issue-42",
      client: c,
      deps: d,
    });
    expect(result.action).toBe("closed");
    expect(result.matched).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});

describe("evaluateReportClose — refusal (fail closed)", () => {
  const cases: Array<[string, Partial<ReportCloseCriterion>, Partial<GroomingEvidenceSnapshot>]> = [
    ["forged excerpt not present in the file", { excerpt: "this text is definitely not in the file at all" }, {}],
    ["trivial excerpt", { excerpt: "return" }, {}],
    ["criterion cites an unreadable path", { path: "src/auth/missing.ts" }, {}],
  ];

  it.each(cases)("refuses: %s", async (_name, criterionOverride, snapshotOverride) => {
    const result = await evaluateReportClose(
      { repoFullName: "org/repo", issueNumber: 42, criteria: [criterion(criterionOverride)] },
      deps({ collectSnapshot: async () => snapshot(snapshotOverride) }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("refuses when there are no criteria", async () => {
    const result = await evaluateReportClose(
      { repoFullName: "org/repo", issueNumber: 42, criteria: [] },
      deps(),
    );
    expect(result.eligible).toBe(false);
  });

  it("refuses when the head SHA is unavailable", async () => {
    const result = await evaluateReportClose(
      { repoFullName: "org/repo", issueNumber: 42, criteria: [criterion()] },
      deps({ collectSnapshot: async () => snapshot({ headSha: null, pinnedRef: null }) }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("head"))).toBe(true);
  });

  it("refuses when the live issue could not be read", async () => {
    const result = await evaluateReportClose(
      { repoFullName: "org/repo", issueNumber: 42, criteria: [criterion()] },
      deps({
        collectSnapshot: async () => snapshot({ issue: { ...snapshot().issue, state: "unknown" } }),
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("could not be read"))).toBe(true);
  });

  it("refuses when the issue is already closed", async () => {
    const result = await evaluateReportClose(
      { repoFullName: "org/repo", issueNumber: 42, criteria: [criterion()] },
      deps({
        collectSnapshot: async () => snapshot({ issue: { ...snapshot().issue, state: "closed" } }),
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("not open"))).toBe(true);
  });

  it("refuses when the issue names expected files none of which are grounded", async () => {
    const body = [
      "## Acceptance criteria",
      "- [ ] Login redirects after password reset",
      "",
      "## Expected files",
      "- `src/other/file.ts`",
    ].join("\n");
    const result = await evaluateReportClose(
      { repoFullName: "org/repo", issueNumber: 42, criteria: [criterion()] },
      deps({ collectSnapshot: async () => snapshot({ issue: { ...snapshot().issue, body } }) }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("expected files"))).toBe(true);
  });

  it("refuses when acceptance-criteria coverage is incomplete", async () => {
    const body = [
      "## Acceptance criteria",
      "- [ ] Login redirects after password reset",
      "- [ ] Sessions are revoked on reset",
      "",
      "## Expected files",
      "- `src/auth/login.ts`",
    ].join("\n");
    const result = await evaluateReportClose(
      { repoFullName: "org/repo", issueNumber: 42, criteria: [criterion()] },
      deps({ collectSnapshot: async () => snapshot({ issue: { ...snapshot().issue, body } }) }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("not grounded"))).toBe(true);
  });

  it("refuses when the reopen history was not captured (fail closed)", async () => {
    const result = await evaluateReportClose(
      { repoFullName: "org/repo", issueNumber: 42, criteria: [criterion()] },
      deps({
        collectSnapshot: async () =>
          snapshot({ issue: { ...snapshot().issue, stateReason: undefined } }),
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("reopen history"))).toBe(true);
  });

  it("refuses a reopened issue", async () => {
    const result = await evaluateReportClose(
      { repoFullName: "org/repo", issueNumber: 42, criteria: [criterion()] },
      deps({
        collectSnapshot: async () =>
          snapshot({ issue: { ...snapshot().issue, stateReason: "reopened" } }),
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("reopened"))).toBe(true);
  });

  it("refuses when an authoritative comment reports a regression", async () => {
    const result = await evaluateReportClose(
      { repoFullName: "org/repo", issueNumber: 42, criteria: [criterion()] },
      deps({
        collectSnapshot: async () =>
          snapshot({
            comments: [
              {
                id: "55",
                author: "alice",
                createdAt: "2026-10-09T12:00:00Z",
                body: "This is still broken on main.",
                provenance: "human_comment",
                authoritative: true,
              },
            ],
          }),
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("still reproduces"))).toBe(true);
  });

  it("resolver reports refused with the policy reasons", async () => {
    const result = await resolveAlreadyDoneFromAgentReport({
      repoFullName: "org/repo",
      issueNumber: 42,
      criteria: [criterion({ excerpt: "not in the file" })],
      actor: "alpha",
      issueId: null,
      client: client(),
      deps: deps(),
    });
    expect(result.action).toBe("refused");
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

describe("resolveAlreadyDoneFromAgentReport — apply-time freshness re-check", () => {
  function resolve(d: ReportCloseDeps) {
    return resolveAlreadyDoneFromAgentReport({
      repoFullName: "org/repo",
      issueNumber: 42,
      criteria: [criterion()],
      actor: "alpha",
      issueId: "issue-42",
      client: client(),
      deps: d,
    });
  }

  it("refuses when the issue was reopened between evaluation and close", async () => {
    const result = await resolve(deps({ fetchIssueState: async () => ({ state: "open", stateReason: "reopened" }) }));
    expect(result.action).toBe("refused");
    expect(result.reasons.some((r) => r.includes("reopened"))).toBe(true);
  });

  it("refuses when a new regression comment appears before the close", async () => {
    const result = await resolve(
      deps({
        fetchComments: async () => [
          { id: 9, author: "bob", createdAt: "2026-10-10T00:00:01Z", body: "This is still broken.", authorAssociation: null },
        ],
      }),
    );
    expect(result.action).toBe("refused");
    expect(result.reasons.some((r) => r.includes("still reproduces"))).toBe(true);
  });

  it("refuses when the issue is already closed at close time", async () => {
    const result = await resolve(deps({ fetchIssueState: async () => ({ state: "closed", stateReason: null }) }));
    expect(result.action).toBe("refused");
    expect(result.reasons.some((r) => r.includes("not open"))).toBe(true);
  });

  it("fails closed when the issue state cannot be re-read before the close", async () => {
    const result = await resolve(
      deps({
        fetchIssueState: async () => {
          throw new Error("github down");
        },
      }),
    );
    expect(result.action).toBe("refused");
    expect(result.reasons.some((r) => r.includes("could not be re-read"))).toBe(true);
  });

  it("returns failed when the GitHub close itself throws", async () => {
    const result = await resolve(
      deps({
        closeIssue: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(result.action).toBe("failed");
    expect(result.reason).toContain("GitHub close failed");
  });
});

describe("recheckCloseFreshness — issue identity + head SHA + live assignment pins (#1143 review of #1219)", () => {
  const livePinned: {
    title: string;
    body: string | null;
    labels: string[];
    state: string;
    stateReason: string | null;
  } = {
    title: "Fix login redirect after password reset",
    body: BODY,
    labels: ["priority/p1", "status/backlog"],
    state: "open",
    stateReason: null,
  };
  const pinned = {
    headSha: HEAD,
    defaultBranch: "main",
    issue: livePinned,
  };

  function freshen(overrides: Partial<ReportCloseDeps> = {}): ReportCloseDeps {
    return deps({
      fetchIssueState: async () => ({ state: "open", stateReason: null }),
      fetchComments: async () => [],
      fetchFullIssue: async () => ({ ...livePinned }),
      fetchHeadSha: async () => HEAD,
      ...overrides,
    });
  }

  it("emits no reasons when the live issue and head match the snapshot", async () => {
    const { recheckCloseFreshness } = await import("./report-close");
    const reasons = await recheckCloseFreshness(
      { repoFullName: "org/repo", issueNumber: 42 },
      pinned,
      freshen(),
    );
    expect(reasons).toEqual([]);
  });

  it("refuses when the live issue body changed (mid-flight criteria edit)", async () => {
    const { recheckCloseFreshness } = await import("./report-close");
    const reasons = await recheckCloseFreshness(
      { repoFullName: "org/repo", issueNumber: 42 },
      pinned,
      freshen({
        fetchFullIssue: async () => ({ ...livePinned, body: BODY + "\n- [ ] Additional criterion" }),
      }),
    );
    expect(reasons.some((r) => r.includes("body changed"))).toBe(true);
  });

  it("refuses when the live issue title changed", async () => {
    const { recheckCloseFreshness } = await import("./report-close");
    const reasons = await recheckCloseFreshness(
      { repoFullName: "org/repo", issueNumber: 42 },
      pinned,
      freshen({
        fetchFullIssue: async () => ({ ...livePinned, title: "Rename: fix login redirect" }),
      }),
    );
    expect(reasons.some((r) => r.includes("title changed"))).toBe(true);
  });

  it("refuses when the live issue labels changed (assignment shifted off the worker)", async () => {
    const { recheckCloseFreshness } = await import("./report-close");
    const reasons = await recheckCloseFreshness(
      { repoFullName: "org/repo", issueNumber: 42 },
      pinned,
      freshen({
        fetchFullIssue: async () => ({ ...livePinned, labels: ["agent/bravo", "status/backlog"] }),
      }),
    );
    expect(reasons.some((r) => r.includes("labels changed"))).toBe(true);
  });

  it("refuses when the live default-branch head SHA moved under the pinned evidence", async () => {
    const { recheckCloseFreshness } = await import("./report-close");
    const reasons = await recheckCloseFreshness(
      { repoFullName: "org/repo", issueNumber: 42 },
      pinned,
      freshen({ fetchHeadSha: async () => "cccc3333dddd4444" }),
    );
    expect(reasons.some((r) => r.includes("head moved"))).toBe(true);
  });

  it("fails closed when the live issue cannot be re-read", async () => {
    const { recheckCloseFreshness } = await import("./report-close");
    const reasons = await recheckCloseFreshness(
      { repoFullName: "org/repo", issueNumber: 42 },
      pinned,
      freshen({
        fetchFullIssue: async () => {
          throw new Error("github down");
        },
      }),
    );
    expect(reasons.some((r) => r.includes("could not be re-read"))).toBe(true);
    expect(reasons.some((r) => r.includes("title/body/labels"))).toBe(true);
  });

  it("fails closed when the live head SHA cannot be re-read", async () => {
    const { recheckCloseFreshness } = await import("./report-close");
    const reasons = await recheckCloseFreshness(
      { repoFullName: "org/repo", issueNumber: 42 },
      pinned,
      freshen({
        fetchHeadSha: async () => null,
      }),
    );
    expect(reasons.some((r) => r.includes("head SHA could not be re-read"))).toBe(true);
  });

  it("fails closed when the live head SHA read itself throws", async () => {
    const { recheckCloseFreshness } = await import("./report-close");
    const reasons = await recheckCloseFreshness(
      { repoFullName: "org/repo", issueNumber: 42 },
      pinned,
      freshen({
        fetchHeadSha: async () => {
          throw new Error("network blip");
        },
      }),
    );
    expect(reasons.some((r) => r.includes("default-branch head"))).toBe(true);
  });

  it("refuses when the snapshot pinned state_reason was lost on the live re-read", async () => {
    const { recheckCloseFreshness } = await import("./report-close");
    const reasons = await recheckCloseFreshness(
      { repoFullName: "org/repo", issueNumber: 42 },
      { ...pinned, issue: { ...livePinned, stateReason: null } },
      freshen({
        fetchFullIssue: async () => ({ ...livePinned, stateReason: undefined }),
      }),
    );
    expect(reasons.some((r) => r.includes("state_reason was not captured"))).toBe(true);
  });
});

describe("recheckCloseFreshness — bound worker final-read identity check (#1143 review of #1219 P1)", () => {
  // The route's pre-close scope gate already enforces agent<=auth on the
  // FIRST live read; this block covers the snapshot/final-read TOCTOU window
  // — the apply-time freshness re-check independently requires the FINAL
  // live labels to still assign the issue to agent/<boundAgent>, fail-closed
  // before closeIssue.

  const alphaPinned: {
    title: string;
    body: string | null;
    labels: string[];
    state: string;
    stateReason: string | null;
  } = {
    title: "Fix login redirect after password reset",
    body: BODY,
    labels: ["agent/alpha", "priority/p1", "status/backlog"],
    state: "open",
    stateReason: null,
  };
  const pinnedAlpha = {
    headSha: HEAD,
    defaultBranch: "main",
    issue: alphaPinned,
    boundAgent: "alpha",
  };

  function freshenAlpha(overrides: Partial<ReportCloseDeps> = {}): ReportCloseDeps {
    return deps({
      fetchIssueState: async () => ({ state: "open", stateReason: null }),
      fetchComments: async () => [],
      fetchFullIssue: async () => ({ ...alphaPinned }),
      fetchHeadSha: async () => HEAD,
      ...overrides,
    });
  }

  it("refuses when the live issue is no longer assigned to the bound worker (reassigned to bravo)", async () => {
    // Gate saw agent/alpha; the snapshot captured the same; by close time the
    // live labels have been reassigned to bravo. The snapshot-vs-final diff
    // catches this directly (labels changed) AND the bound-agent check fires
    // independently — both branches refuse.
    const { recheckCloseFreshness } = await import("./report-close");
    const reasons = await recheckCloseFreshness(
      { repoFullName: "org/repo", issueNumber: 42 },
      pinnedAlpha,
      freshenAlpha({
        fetchFullIssue: async () => ({
          ...alphaPinned,
          labels: ["agent/bravo", "priority/p1", "status/backlog"],
        }),
      }),
    );
    expect(reasons.some((r) => r.includes('live agent assignment is "agent/bravo"'))).toBe(true);
    expect(reasons.some((r) => r.includes("agent/bravo"))).toBe(true);
  });

  it("refuses when the live assignment label has been removed mid-flight", async () => {
    // Gate saw agent/alpha; the snapshot captured the same; the live label
    // set no longer carries any agent/* label. The snapshot-vs-final diff
    // catches this (labels changed), AND the bound-agent check independently
    // confirms the live assignment is gone (none != agent/alpha).
    const { recheckCloseFreshness } = await import("./report-close");
    const reasons = await recheckCloseFreshness(
      { repoFullName: "org/repo", issueNumber: 42 },
      pinnedAlpha,
      freshenAlpha({
        fetchFullIssue: async () => ({ ...alphaPinned, labels: ["priority/p1", "status/backlog"] }),
      }),
    );
    expect(reasons.some((r) => r.includes('live agent assignment is "none"'))).toBe(true);
  });

  it("refuses when the snapshot already shows the wrong agent (TOCTOU between gate and snapshot)", async () => {
    // This is the case the snapshot-vs-final diff cannot catch by itself:
    // gate saw agent/alpha (allowed), the snapshot was taken AFTER a
    // reassignment to bravo so the snapshot shows bravo, and the final read
    // also shows bravo — labels do not change between snapshot and close.
    // The bound-agent check still catches it: live assignment is bravo, not
    // alpha.
    const { recheckCloseFreshness } = await import("./report-close");
    const reasons = await recheckCloseFreshness(
      { repoFullName: "org/repo", issueNumber: 42 },
      {
        ...pinnedAlpha,
        issue: { ...alphaPinned, labels: ["agent/bravo", "priority/p1", "status/backlog"] },
      },
      freshenAlpha({
        fetchFullIssue: async () => ({
          ...alphaPinned,
          labels: ["agent/bravo", "priority/p1", "status/backlog"],
        }),
      }),
    );
    expect(reasons.some((r) => r.includes('live agent assignment is "agent/bravo"'))).toBe(true);
  });

  it("emits no reasons when the live issue is still assigned to the bound worker", async () => {
    const { recheckCloseFreshness } = await import("./report-close");
    const reasons = await recheckCloseFreshness(
      { repoFullName: "org/repo", issueNumber: 42 },
      pinnedAlpha,
      freshenAlpha(),
    );
    expect(reasons).toEqual([]);
  });

  it("does not apply the bound-agent check when boundAgent is null (maintainer escape hatch)", async () => {
    // Same live labels that would refuse under a bound worker — but the
    // route passes null for maintainer / OIDC / basic / auth-disabled
    // callers, so the check is a no-op and the only refusal reasons come
    // from the snapshot-vs-final labels diff (live=bravo vs snapshot=alpha).
    const { recheckCloseFreshness } = await import("./report-close");
    const reasons = await recheckCloseFreshness(
      { repoFullName: "org/repo", issueNumber: 42 },
      { ...pinnedAlpha, boundAgent: null },
      freshenAlpha({
        fetchFullIssue: async () => ({
          ...alphaPinned,
          labels: ["agent/bravo", "priority/p1", "status/backlog"],
        }),
      }),
    );
    // The bound-agent reason MUST NOT appear; only the labels-changed diff
    // reason should be present.
    expect(reasons.some((r) => r.includes("live agent assignment"))).toBe(false);
    expect(reasons.some((r) => r.includes("labels changed"))).toBe(true);
  });
});

describe("resolveAlreadyDoneFromAgentReport — mid-flight change refuses with zero GitHub closes (#1143 review of #1219)", () => {
  function resolve(d: ReportCloseDeps) {
    return resolveAlreadyDoneFromAgentReport({
      repoFullName: "org/repo",
      issueNumber: 42,
      criteria: [criterion()],
      actor: "alpha",
      issueId: "issue-42",
      client: client(),
      deps: d,
    });
  }

  it("refuses with zero close calls when the live issue body changes between evaluation and close", async () => {
    const closeMock = vi.fn(async () => {});
    const result = await resolve(
      deps({
        closeIssue: closeMock,
        fetchFullIssue: async () => ({
          title: "Fix login redirect after password reset",
          body: BODY + "\n- [ ] New criterion added mid-flight",
          labels: ["priority/p1", "status/backlog"],
          state: "open",
          stateReason: null,
        }),
      }),
    );
    expect(result.action).toBe("refused");
    expect(result.reasons.some((r) => r.includes("body changed"))).toBe(true);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("refuses with zero close calls when the default-branch head moves between evaluation and close", async () => {
    const closeMock = vi.fn(async () => {});
    const result = await resolve(
      deps({
        closeIssue: closeMock,
        fetchHeadSha: async () => "cccc3333dddd4444",
      }),
    );
    expect(result.action).toBe("refused");
    expect(result.reasons.some((r) => r.includes("head moved"))).toBe(true);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("refuses with zero close calls when the live agent label shifts off the worker", async () => {
    const closeMock = vi.fn(async () => {});
    const result = await resolve(
      deps({
        closeIssue: closeMock,
        fetchFullIssue: async () => ({
          title: "Fix login redirect after password reset",
          body: BODY,
          // Worker is bound to "alpha"; live assignment moved to bravo.
          labels: ["agent/bravo", "status/backlog", "priority/p1"],
          state: "open",
          stateReason: null,
        }),
      }),
    );
    expect(result.action).toBe("refused");
    expect(result.reasons.some((r) => r.includes("labels changed"))).toBe(true);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("refuses when the live issue title is renamed mid-flight", async () => {
    const closeMock = vi.fn(async () => {});
    const result = await resolve(
      deps({
        closeIssue: closeMock,
        fetchFullIssue: async () => ({
          title: "Fix login redirect after password reset (renamed)",
          body: BODY,
          labels: ["priority/p1", "status/backlog"],
          state: "open",
          stateReason: null,
        }),
      }),
    );
    expect(result.action).toBe("refused");
    expect(result.reasons.some((r) => r.includes("title changed"))).toBe(true);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("fails closed with zero close calls when the live issue read throws", async () => {
    const closeMock = vi.fn(async () => {});
    const result = await resolve(
      deps({
        closeIssue: closeMock,
        fetchFullIssue: async () => {
          throw new Error("github down");
        },
      }),
    );
    expect(result.action).toBe("refused");
    expect(result.reasons.some((r) => r.includes("title/body/labels"))).toBe(true);
    expect(closeMock).not.toHaveBeenCalled();
  });
});

describe("resolveAlreadyDoneFromAgentReport — bound worker final-read identity check (#1143 review of #1219 P1)", () => {
  // The route passes `boundAgent` from the auth context so the resolver can
  // close the TOCTOU window between the gate's first read and the snapshot
  // and final reads. Snapshot vs final labels alone are not enough: a
  // reassignment that lands before the snapshot read shows up identically
  // in both, so the diff is benign — only the independent bound-agent
  // check on the FINAL live labels catches it.

  function resolveBound(boundAgent: string | null, d: ReportCloseDeps) {
    return resolveAlreadyDoneFromAgentReport({
      repoFullName: "org/repo",
      issueNumber: 42,
      criteria: [criterion()],
      actor: boundAgent ?? "alpha",
      issueId: "issue-42",
      client: client(),
      deps: d,
      boundAgent,
    });
  }

  it("refuses with zero close calls when the snapshot already shows the wrong agent (TOCTOU before snapshot)", async () => {
    // Gate allowed alpha (worker bound to alpha); the snapshot was taken
    // AFTER a reassignment to bravo so the pinned snapshot shows bravo;
    // final live labels also show bravo. The snapshot-vs-final diff is
    // benign; the bound-agent check refuses the close.
    const closeMock = vi.fn(async () => {});
    const result = await resolveBound(
      "alpha",
      deps({
        closeIssue: closeMock,
        collectSnapshot: async () =>
          snapshot({
            issue: {
              ...snapshot().issue,
              labels: ["agent/bravo", "priority/p1", "status/backlog"],
            },
          }),
        fetchFullIssue: async () => ({
          title: "Fix login redirect after password reset",
          body: BODY,
          labels: ["agent/bravo", "priority/p1", "status/backlog"],
          state: "open",
          stateReason: null,
        }),
      }),
    );
    expect(result.action).toBe("refused");
    expect(result.reasons.some((r) => r.includes('live agent assignment is "agent/bravo"'))).toBe(true);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("refuses with zero close calls when the live agent label is removed mid-flight", async () => {
    // Snapshot was alpha (gate allowed alpha); final live labels have no
    // agent/* label. The bound-agent check independently catches the
    // removed assignment.
    const closeMock = vi.fn(async () => {});
    const result = await resolveBound(
      "alpha",
      deps({
        closeIssue: closeMock,
        fetchFullIssue: async () => ({
          title: "Fix login redirect after password reset",
          body: BODY,
          labels: ["priority/p1", "status/backlog"],
          state: "open",
          stateReason: null,
        }),
      }),
    );
    expect(result.action).toBe("refused");
    expect(result.reasons.some((r) => r.includes('live agent assignment is "none"'))).toBe(true);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("closes when the live issue is still assigned to the bound worker", async () => {
    const closeMock = vi.fn(async () => {});
    const result = await resolveBound(
      "alpha",
      deps({
        closeIssue: closeMock,
        // Snapshot includes agent/alpha so the labels-diff is clean; the
        // bound-agent check then independently confirms the live labels
        // also still carry agent/alpha.
        collectSnapshot: async () =>
          snapshot({
            issue: {
              ...snapshot().issue,
              labels: ["agent/alpha", "priority/p1", "status/backlog"],
            },
          }),
        fetchFullIssue: async () => ({
          title: "Fix login redirect after password reset",
          body: BODY,
          labels: ["agent/alpha", "priority/p1", "status/backlog"],
          state: "open",
          stateReason: null,
        }),
      }),
    );
    expect(result.action).toBe("closed");
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("does not refuse on a bound-agent mismatch when boundAgent is null (maintainer escape hatch)", async () => {
    // Same live-vs-snapshot assignment drift that would refuse under a
    // bound worker — but the route passes null for maintainer / OIDC /
    // basic / auth-disabled callers. The labels-changed diff still fires
    // because the labels genuinely differ from the snapshot; the
    // bound-agent reason must NOT fire.
    const closeMock = vi.fn(async () => {});
    const result = await resolveBound(
      null,
      deps({
        closeIssue: closeMock,
        fetchFullIssue: async () => ({
          title: "Fix login redirect after password reset",
          body: BODY,
          labels: ["agent/bravo", "priority/p1", "status/backlog"],
          state: "open",
          stateReason: null,
        }),
      }),
    );
    expect(result.reasons.some((r) => r.includes("live agent assignment"))).toBe(false);
  });
});

describe("already_done never touches the PR-fix queue (#1143)", () => {
  it("resolvePrFixFromAgentReport no-ops for already_done", async () => {
    const result = await resolvePrFixFromAgentReport({
      repoFullName: "org/repo",
      pullRequestNumber: 10,
      outcome: "already_done",
    });
    expect(result).toEqual({
      matched: false,
      action: "none",
      reason: "already_done is an issue close, not a pr-fix settlement",
    });
  });
});

describe("applyReportClose — lifecycle evidence (#1202)", () => {
  function lifecycleClient() {
    const createEvent = vi.fn(async () => ({}));
    const upsertEvent = vi.fn(async () => ({}));
    return {
      createEvent,
      upsertEvent,
      client: { ...client(), issueLifecycleEvent: { create: createEvent, upsert: upsertEvent } },
    };
  }

  /** Swaps every status label like the real transitionIssueStatus does. */
  function swapToDone() {
    return deps({
      transitionStatus: vi.fn(async (_repo: string, _number: number, labels: string[]) => [
        ...labels.filter((label) => !label.startsWith("status/")),
        "status/done",
      ]),
    });
  }

  it("records the completion with the status the close left behind", async () => {
    const d = swapToDone();
    const { client: c, createEvent } = lifecycleClient();
    const evaluation = await evaluateReportClose(
      { repoFullName: "org/repo", issueNumber: 42, criteria: [criterion()] },
      d,
    );

    await applyReportClose({ evaluation, actor: "alpha", issueId: "issue-42", client: c, deps: d });

    expect(createEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({
        issueId: "issue-42",
        repoFullName: "org/repo",
        issueNumber: 42,
        // A completion is its own fact, not the status label moving to done.
        kind: "completed",
        source: "agent-report",
        actor: "alpha",
        fromStatus: "status/backlog",
        toStatus: "status/done",
        metadata: { evidenceDigest: evaluation.evidenceDigest, headSha: HEAD },
      }),
    });
  });

  it("records nothing when the close could not resolve to a cached issue", async () => {
    const d = deps();
    const { client: c, createEvent } = lifecycleClient();
    const evaluation = await evaluateReportClose(
      { repoFullName: "org/repo", issueNumber: 42, criteria: [criterion()] },
      d,
    );

    await applyReportClose({ evaluation, actor: "alpha", issueId: null, client: c, deps: d });

    expect(createEvent).not.toHaveBeenCalled();
  });

  it("reports a failed evidence write as a warning without undoing the close", async () => {
    const d = deps();
    const { client: c, createEvent } = lifecycleClient();
    createEvent.mockRejectedValueOnce(new Error("db down"));
    const evaluation = await evaluateReportClose(
      { repoFullName: "org/repo", issueNumber: 42, criteria: [criterion()] },
      d,
    );

    const applied = await applyReportClose({ evaluation, actor: "alpha", issueId: "issue-42", client: c, deps: d });

    expect(applied.closed).toBe(true);
    expect(applied.warning).toContain("lifecycle event write failed");
  });
});
