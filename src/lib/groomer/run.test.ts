import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import type { GroomingCandidate } from "./selector";
import type { GroomingPlanDraft } from "./plan";
import type { HostedGroomerConfig } from "./config";
import type { ExploreResult } from "./explore";
import type { GroomingEvidenceSnapshot } from "./evidence-snapshot";

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => ({
  isAuthorizedAgentToken: vi.fn((token) => token === mockToken),
  isAuthorizedBearerToken: vi.fn((token) => token === mockToken),
  getAcceptedAgentTokens: vi.fn(() => [mockToken]),
  resetCaches: vi.fn(),
}));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    selectGroomingCandidate: vi.fn(),
    callGroomerLLM: vi.fn(),
    fetchIssueComments: vi.fn(),
    buildIssueContext: vi.fn(),
    getHostedGroomerConfig: vi.fn(),
    updateIssueLabels: vi.fn(),
    addIssueComment: vi.fn(),
    updateIssueTitleAndBody: vi.fn(),
    closeIssue: vi.fn(),
    createIssue: vi.fn(),
    findActiveLeasesForIssue: vi.fn(),
    upsertLease: vi.fn(),
    releaseLease: vi.fn(),
    addIssueLabel: vi.fn(),
    removeIssueLabel: vi.fn(),
    buildRepositoryContext: vi.fn(),
    exploreRepository: vi.fn(),
    collectGroomingEvidenceSnapshot: vi.fn(),
    acquireGroomerLock: vi.fn(),
    heartbeatGroomerLock: vi.fn(),
    releaseGroomerLock: vi.fn(),
    compareCommits: vi.fn(),
    applications: new Map<string, Record<string, any>>(),
    childClaims: new Map<string, Record<string, any>>(),
    prisma: {
      automationRepo: { findUnique: vi.fn() },
      groomingRun: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
      groomingApplication: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
      groomingChildClaim: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
      issue: { update: vi.fn(), findMany: vi.fn() },
      issueLane: { create: vi.fn() },
      agentRun: { create: vi.fn() },
      auditLog: { create: vi.fn() },
    },
  },
}));

vi.mock("./selector", () => ({
  selectGroomingCandidate: mocks.selectGroomingCandidate,
}));

vi.mock("./llm", () => ({
  callGroomerLLM: mocks.callGroomerLLM,
}));

vi.mock("./context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./context")>();
  return { ...actual, fetchIssueComments: mocks.fetchIssueComments, buildIssueContext: mocks.buildIssueContext };
});

vi.mock("./config", () => ({
  getHostedGroomerConfig: mocks.getHostedGroomerConfig,
}));

vi.mock("@/lib/github", () => ({
  updateIssueLabels: mocks.updateIssueLabels,
  addIssueComment: mocks.addIssueComment,
  updateIssueTitleAndBody: mocks.updateIssueTitleAndBody,
  closeIssue: mocks.closeIssue,
  createIssue: mocks.createIssue,
  addIssueLabel: mocks.addIssueLabel,
  removeIssueLabel: mocks.removeIssueLabel,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

vi.mock("@/lib/lease", () => ({
  findActiveLeasesForIssue: mocks.findActiveLeasesForIssue,
  upsertLease: mocks.upsertLease,
  releaseLease: mocks.releaseLease,
}));

vi.mock("./repository-context", () => ({
  buildRepositoryContext: mocks.buildRepositoryContext,
  exploreRepository: mocks.exploreRepository,
}));

vi.mock("./explore", () => ({
  exploreRepository: mocks.exploreRepository,
}));

vi.mock("./evidence-snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./evidence-snapshot")>();
  return { ...actual, collectGroomingEvidenceSnapshot: mocks.collectGroomingEvidenceSnapshot };
});
vi.mock("@/lib/github-code-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github-code-search")>();
  return { ...actual, compareCommits: mocks.compareCommits };
});
vi.mock("./groomer-lock", () => ({
  acquireGroomerLock: mocks.acquireGroomerLock,
  heartbeatGroomerLock: mocks.heartbeatGroomerLock,
  releaseGroomerLock: mocks.releaseGroomerLock,
  HEARTBEAT_MS: 30_000,
}));

import {
  captureFailureReason,
  FAILED_RUN_BACKOFF_MAX_MINUTES,
  FAILED_RUN_PRIOR_FAILURES_TO_CAP,
  failedRunBackoffMinutes,
  runHostedGroomer,
  UNVERIFIABLE_RETRY_BACKOFF_MINUTES,
} from "./run";
import { computeGroomingIssueFingerprint } from "./freshness";

const mockCandidate: GroomingCandidate = {
  id: "issue-42",
  number: 42,
  title: "Fix login bug",
  body: "Login fails after password reset.",
  url: "https://github.com/org/repo/issues/42",
  repoFullName: "org/repo",
  labels: ["priority/p0"],
  currentLane: "backlog",
  groomingSummary: null,
};

// A ready GroomingPlan draft that validates against mockEvidence.
const mockOutput: GroomingPlanDraft = {
  verdict: {
    actionability: "ready",
    workType: "implementation",
    confidence: "high",
    lane: { id: "local", confidence: "high", reason: "clear implementation task" },
    summary: "Ready for work.",
    rationale: "login.ts drops the return URL after a reset; the fix is local.",
    evidenceRefs: ["repo:src/auth/login.ts"],
    uncertainties: [],
  },
  implementationBrief: {
    problem: "Login fails after password reset.",
    verifiedCurrentBehavior: { statement: "The reset path skips the session refresh.", evidenceRefs: ["repo:src/auth/login.ts"] },
    relevantPaths: [{ ref: "repo:src/auth/login.ts", change: "modify" }],
    filesToCreate: [],
    invariants: [],
    inScope: ["refresh the session after a reset"],
    outOfScope: [],
    dependencies: [],
    acceptanceCriteria: [{ criterion: "reset-then-login test passes", verification: "automated_test" }],
    tests: ["login after reset"],
  },
  mutations: {
    labelsToAdd: [],
    labelsToRemove: [],
    proposedTitle: null,
    proposedBody: null,
    githubComment: null,
    close: null,
  },
  decomposition: { required: false, reason: null, childBriefs: [] },
  relatedWork: [],
};

type DraftPatch = {
  verdict?: Partial<GroomingPlanDraft["verdict"]>;
  implementationBrief?: GroomingPlanDraft["implementationBrief"];
  mutations?: Partial<GroomingPlanDraft["mutations"]>;
  decomposition?: GroomingPlanDraft["decomposition"];
  relatedWork?: GroomingPlanDraft["relatedWork"];
};

function planDraft(patch: DraftPatch = {}): GroomingPlanDraft {
  return {
    verdict: { ...mockOutput.verdict, ...patch.verdict },
    implementationBrief: patch.implementationBrief === undefined ? mockOutput.implementationBrief : patch.implementationBrief,
    mutations: { ...mockOutput.mutations, ...patch.mutations },
    decomposition: patch.decomposition ?? mockOutput.decomposition,
    relatedWork: patch.relatedWork ?? mockOutput.relatedWork,
  };
}

/** A non-ready draft: the model's verdict parks the issue. */
function notReadyDraft(
  actionability: "needs_info" | "blocked" | "backlog" | "already_done",
  patch: DraftPatch = {},
): GroomingPlanDraft {
  return planDraft({
    ...patch,
    verdict: { actionability, lane: { id: "backlog", confidence: "medium", reason: "not ready yet" }, ...patch.verdict },
    implementationBrief: patch.implementationBrief ?? null,
  });
}

const mockConfig: HostedGroomerConfig = {
  enabled: true,
  dryRun: false,
  llmBaseUrl: "https://llm.example.com",
  apiKey: "sk-test",
  model: "gpt-4o-mini",
  responseFormat: true,
  timeoutMs: 60000,
  maxContextBytes: 8192,
  repoContextEnabled: false,
  maxContextFiles: 5,
  maxSearches: 3,
  maxFileBytes: 4096,
  commentCooldownHours: 24,
  groomerToken: null,
  toolLoopEnabled: false,
  maxRounds: 12,
  maxSearchResults: 10,
  maxDirEntries: 60,
  exploration: { maxTotalBytes: 24576, maxFileBytes: 8192, timeoutMs: 150000, source: "medium" },
};

const LOGIN_TS = "export function redirectAfterLogin(session: Session) {\n  return session.returnTo ?? \"/\";\n}\n";
/** An already_done close's criterion, grounded in login.ts as read at the pin (dispatch#1099). */
const GROUNDED_CRITERIA = [
  { criterion: "login redirects to the saved return URL", evidenceRef: "repo:src/auth/login.ts", excerpt: 'return session.returnTo ?? "/";' },
];

const mockAutomationRepo = { id: "repo-1", fullName: "org/repo", enabled: true };
const mockGroomingRun = { id: "gr-1", stage: "selected" };

const mockEvidence: GroomingEvidenceSnapshot = {
  capturedAt: "2026-09-25T00:00:00.000Z",
  repoFullName: "org/repo",
  defaultBranch: "main",
  headSha: "abc123",
  pinnedRef: "abc123",
  issue: {
    number: 42,
    title: "Fix login bug",
    body: "Login fails after password reset.",
    labels: ["priority/p0"],
    state: "open",
    updatedAt: "2026-09-24T00:00:00.000Z",
    url: "https://github.com/org/repo/issues/42",
  },
  issueFingerprint: "fp",
  comments: [],
  evidenceDigest: "digest",
  warnings: [],
  sources: [{ path: "src/auth/login.ts", provenance: "repository", via: "read", ref: "abc123" }],
};

const mockExploration: ExploreResult = {
  findings: "",
  files: [],
  ask: null,
  sources: ["src/x.ts"],
  readSources: [],
  readContents: [],
  toolCalls: [],
  bytes: 0,
  warnings: [],
  relatedWorkQueries: [],
  relatedWorkRefs: [],
  relatedWork: [],
};

// True if any string leaf (or key) of a value carries a NUL or other C0 control
// character except newline/tab. Used to assert stored blobs are control-free
// (JSON.stringify would escape them, so a serialized check proves nothing).
function hasControlChars(value: unknown): boolean {
  if (typeof value === "string") return /[\u0000-\u0008\u000B-\u001F]/.test(value);
  if (Array.isArray(value)) return value.some(hasControlChars);
  if (value && typeof value === "object")
    return Object.entries(value).some(([k, v]) => /[\u0000-\u0008\u000B-\u001F]/.test(k) || hasControlChars(v));
  return false;
}

describe("runHostedGroomer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectGroomingCandidate.mockResolvedValue(mockCandidate);
    mocks.fetchIssueComments.mockResolvedValue([]);
    mocks.buildIssueContext.mockResolvedValue("test context");
    mocks.getHostedGroomerConfig.mockReturnValue(mockConfig);
    mocks.callGroomerLLM.mockResolvedValue(mockOutput);
    mocks.updateIssueLabels.mockResolvedValue(undefined);
    mocks.addIssueLabel.mockResolvedValue(undefined);
    mocks.updateIssueTitleAndBody.mockResolvedValue(undefined);
    mocks.addIssueComment.mockResolvedValue({ url: null });
    mocks.closeIssue.mockResolvedValue(undefined);
    mocks.findActiveLeasesForIssue.mockResolvedValue([]);
    mocks.upsertLease.mockResolvedValue({ created: true, lease: { id: "lease-1" } });
    mocks.releaseLease.mockResolvedValue({ id: "lease-1" });
    mocks.acquireGroomerLock.mockResolvedValue({ locked: true, token: "lock-token" });
    mocks.heartbeatGroomerLock.mockResolvedValue(undefined);
    mocks.releaseGroomerLock.mockResolvedValue(undefined);
    mocks.prisma.automationRepo.findUnique.mockResolvedValue(mockAutomationRepo);
    mocks.prisma.groomingRun.create.mockResolvedValue(mockGroomingRun);
    mocks.prisma.groomingRun.update.mockResolvedValue({ ...mockGroomingRun, stage: "planned" });
    mocks.prisma.groomingRun.findFirst.mockResolvedValue(null);
    mocks.prisma.groomingRun.findMany.mockResolvedValue([]);
    mocks.prisma.issue.update.mockResolvedValue({ id: "issue-42" });
    mocks.prisma.issueLane.create.mockResolvedValue({ id: "lane-1" });
    mocks.prisma.agentRun.create.mockResolvedValue({ id: "run-1" });
    mocks.prisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
    mocks.buildRepositoryContext.mockResolvedValue({
      text: "",
      sources: [],
      warnings: [],
      bytes: 0,
      queries: [],
      emptyQueries: [],
      // What the run read at the pinned head: the content close excerpts are
      // checked against (dispatch#1099).
      files: [{ path: "src/auth/login.ts", ref: "abc123", content: LOGIN_TS }],
    });
    // The live issue defaults to the candidate this run selected, so the
    // snapshot and the apply-time re-capture agree unless a test says not.
    mocks.collectGroomingEvidenceSnapshot.mockImplementation(async () => {
      const selected = mocks.selectGroomingCandidate.mock.results.at(-1);
      const c: GroomingCandidate = (selected ? await selected.value : null) ?? mockCandidate;
      return {
        ...mockEvidence,
        issue: { ...mockEvidence.issue, title: c.title, body: c.body, labels: [...c.labels].sort() },
      };
    });
    mocks.compareCommits.mockResolvedValue({ ok: true, status: "ahead", files: [], truncated: false });
    // In-memory GroomingApplication with the unique applicationKey claim.
    mocks.applications.clear();
    mocks.prisma.groomingApplication.findUnique.mockImplementation(
      async ({ where }: { where: { applicationKey: string } }) => mocks.applications.get(where.applicationKey) ?? null,
    );
    mocks.prisma.groomingApplication.create.mockImplementation(async ({ data }: { data: Record<string, any> }) => {
      if (mocks.applications.has(data.applicationKey)) throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
      const row = { ...data, attempts: 1 };
      mocks.applications.set(data.applicationKey, row);
      return row;
    });
    mocks.prisma.groomingApplication.updateMany.mockImplementation(
      async ({ where, data }: { where: { applicationKey: string; status: string; attempts: number }; data: Record<string, any> }) => {
        const row = mocks.applications.get(where.applicationKey);
        if (!row || row.status !== where.status || row.attempts !== where.attempts) return { count: 0 };
        if (data.attempts?.increment) row.attempts += data.attempts.increment;
        return { count: 1 };
      },
    );
    mocks.prisma.groomingApplication.update.mockImplementation(
      async ({ where, data }: { where: { applicationKey: string }; data: Record<string, any> }) => {
        const row = mocks.applications.get(where.applicationKey)!;
        if (data.attempts?.increment) row.attempts += data.attempts.increment;
        else Object.assign(row, JSON.parse(JSON.stringify(data)));
        return row;
      },
    );
    // In-memory GroomingChildClaim with the unique childKey claim (dispatch#1066).
    // A created row has no childNumber/childUrl until the creation is recorded,
    // matching the nullable columns the reuse check reads; updatedAt is stamped
    // at create, mirroring @updatedAt, and applicationKey is carried from the
    // claim input.
    mocks.childClaims.clear();
    mocks.prisma.groomingChildClaim.findUnique.mockImplementation(
      async ({ where }: { where: { childKey: string } }) => mocks.childClaims.get(where.childKey) ?? null,
    );
    mocks.prisma.groomingChildClaim.create.mockImplementation(async ({ data }: { data: Record<string, any> }) => {
      if (mocks.childClaims.has(data.childKey)) throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
      const row = { ...data, childNumber: null, childUrl: null, updatedAt: new Date() };
      mocks.childClaims.set(data.childKey, row);
      return row;
    });
    mocks.prisma.groomingChildClaim.update.mockImplementation(
      async ({ where, data }: { where: { childKey: string }; data: Record<string, any> }) => {
        const row = mocks.childClaims.get(where.childKey)!;
        Object.assign(row, JSON.parse(JSON.stringify(data)));
        return row;
      },
    );
    // Each created child gets its own number and URL, as GitHub would.
    mocks.createIssue.mockImplementation(async (repoFullName: string) => {
      const number = mocks.createIssue.mock.calls.length + 1001;
      return { number, html_url: `https://github.com/${repoFullName}/issues/${number}` };
    });
  });

  it("returns null when no grooming candidate available", async () => {
    mocks.selectGroomingCandidate.mockResolvedValue(null);

    const result = await runHostedGroomer();

    expect(result).toBeNull();
    expect(mocks.callGroomerLLM).not.toHaveBeenCalled();
  });

  it("bails without selecting when the groomer lock is held", async () => {
    mocks.acquireGroomerLock.mockResolvedValue({ locked: false });

    const result = await runHostedGroomer();

    expect(result).toBeNull();
    expect(mocks.selectGroomingCandidate).not.toHaveBeenCalled();
    expect(mocks.releaseGroomerLock).not.toHaveBeenCalled();
  });

  it("releases the groomer lock after a run completes", async () => {
    await runHostedGroomer();

    expect(mocks.acquireGroomerLock).toHaveBeenCalledTimes(1);
    expect(mocks.releaseGroomerLock).toHaveBeenCalledWith("lock-token");
  });

  it("heartbeats the lock while a long run is in flight (dispatch#967)", async () => {
    vi.useFakeTimers();
    try {
      // The LLM call hangs for 95s — three heartbeat intervals. Without the
      // heartbeat the 90s TTL would reclaim the lock mid-run; with it, the
      // lock stays fresh for the whole run.
      let resolveLLM: (value: GroomingPlanDraft) => void;
      mocks.callGroomerLLM.mockReturnValue(
        new Promise((resolve) => {
          resolveLLM = resolve;
        }),
      );

      const runPromise = runHostedGroomer();

      await vi.advanceTimersByTimeAsync(95_000);
      expect(mocks.heartbeatGroomerLock).toHaveBeenCalledTimes(3);
      expect(mocks.heartbeatGroomerLock).toHaveBeenCalledWith("lock-token");
      expect(mocks.releaseGroomerLock).not.toHaveBeenCalled();

      resolveLLM!(mockOutput);
      const result = await runPromise;

      expect(result).not.toBeNull();
      expect(mocks.releaseGroomerLock).toHaveBeenCalledWith("lock-token");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not heartbeat when the lock is not acquired", async () => {
    mocks.acquireGroomerLock.mockResolvedValue({ locked: false });

    const result = await runHostedGroomer();

    expect(result).toBeNull();
    expect(mocks.heartbeatGroomerLock).not.toHaveBeenCalled();
  });

  it("dry-run creates and completes groomingRun and result has groomingRunId", async () => {
    mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, dryRun: true });

    const result = await runHostedGroomer();

    expect(result).not.toBeNull();
    expect(result!.dryRun).toBe(true);
    expect(result!.groomingRunId).toBe("gr-1");
    expect(mocks.prisma.groomingRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          issueId: "issue-42",
          repoId: "repo-1",
          dryRun: true,
          status: "running",
        }),
      }),
    );
    expect(mocks.prisma.groomingRun.update).toHaveBeenCalled();
    expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
    expect(mocks.addIssueComment).not.toHaveBeenCalled();
    expect(mocks.prisma.issue.update).not.toHaveBeenCalled();
    expect(mocks.prisma.issueLane.create).not.toHaveBeenCalled();
    expect(mocks.prisma.agentRun.create).not.toHaveBeenCalled();
    expect(mocks.prisma.auditLog.create).not.toHaveBeenCalled();
    expect(mocks.releaseLease).toHaveBeenCalledWith("lease-1");
  });

  it("persists related-work queries and refs in the explored context summary", async () => {
    mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, toolLoopEnabled: true });
    mocks.exploreRepository.mockResolvedValue({
      findings: "",
      files: [],
      ask: null,
      sources: ["src/lib/prisma.ts"],
      toolCalls: [],
      bytes: 0,
      warnings: [],
      relatedWorkQueries: ["sslmode"],
      relatedWorkRefs: ["github:pr:org/repo#7"],
      relatedWork: [
        {
          key: "github:pr:org/repo#7",
          kind: "pull_request",
          state: "merged",
          url: "https://github.com/org/repo/pull/7",
          via: "read",
          observedAt: "2026-09-25T00:00:01.000Z",
        },
      ],
    });

    const result = await runHostedGroomer();

    expect(result).not.toBeNull();
    expect(mocks.exploreRepository).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.groomingRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "gr-1" },
        data: expect.objectContaining({
          stage: "explored",
          contextSummary: expect.objectContaining({
            commentCount: 0,
            relatedWorkQueries: ["sslmode"],
            relatedWorkRefs: ["github:pr:org/repo#7"],
          }),
        }),
      }),
    );
  });

  it("folds related-work into the evidence snapshot as unpinned GitHub provenance, separate from pinned repo paths", async () => {
    mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, toolLoopEnabled: true });
    mocks.exploreRepository.mockResolvedValue({
      ...mockExploration,
      sources: ["src/lib/prisma.ts"],
      readSources: ["src/lib/prisma.ts"],
      relatedWorkRefs: ["github:pr:org/repo#7"],
      relatedWork: [
        {
          key: "github:pr:org/repo#7",
          kind: "pull_request",
          state: "merged",
          url: "https://github.com/org/repo/pull/7",
          via: "read",
          observedAt: "2026-09-25T00:00:01.000Z",
        },
      ],
    });

    await runHostedGroomer();

    const exploredCall = mocks.prisma.groomingRun.update.mock.calls.find(
      (call) => call[0]?.data?.stage === "explored",
    );
    expect(exploredCall).toBeDefined();
    expect(exploredCall![0].data.contextSummary.evidence.sources).toEqual([
      { path: "src/auth/login.ts", provenance: "repository", via: "read", ref: "abc123" },
      { path: "src/lib/prisma.ts", provenance: "repository", via: "read", ref: "abc123" },
      {
        key: "github:pr:org/repo#7",
        provenance: "github_pull_request",
        state: "merged",
        url: "https://github.com/org/repo/pull/7",
        via: "read",
        observedAt: "2026-09-25T00:00:01.000Z",
        ref: null,
      },
    ]);
  });

  it("records code-search hits as surfaced, unpinned evidence that cannot back a ready plan (dispatch#1062)", async () => {
    mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, toolLoopEnabled: true });
    mocks.collectGroomingEvidenceSnapshot.mockResolvedValue({ ...mockEvidence, sources: [] });
    // login.ts only came back from search_code; session.ts was read.
    mocks.exploreRepository.mockResolvedValue({
      ...mockExploration,
      sources: ["src/auth/login.ts", "src/auth/session.ts"],
      readSources: ["src/auth/session.ts"],
    });

    await expect(runHostedGroomer()).rejects.toThrow(
      /readiness: verdict\.evidenceRefs must cite at least one repository source read at the pinned head SHA/,
    );

    const exploredCall = mocks.prisma.groomingRun.update.mock.calls.find(
      (call) => call[0]?.data?.stage === "explored",
    );
    expect(exploredCall![0].data.contextSummary.evidence.sources).toEqual([
      { path: "src/auth/session.ts", provenance: "repository", via: "read", ref: "abc123" },
      { path: "src/auth/login.ts", provenance: "repository", via: "surfaced", ref: null },
    ]);
    expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
  });

  it("repository context warnings are persisted and returned", async () => {
    mocks.buildRepositoryContext.mockResolvedValue({
      text: "",
      sources: [],
      warnings: ["Failed to fetch repo metadata: timeout"],
      bytes: 0,
      queries: [],
      emptyQueries: [],
    });
    mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, dryRun: true });

    const result = await runHostedGroomer();

    expect(result!.contextWarnings).toEqual(["Failed to fetch repo metadata: timeout"]);
    expect(mocks.prisma.groomingRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "gr-1" },
        data: expect.objectContaining({
          stage: "context_built",
          contextWarnings: ["Failed to fetch repo metadata: timeout"],
        }),
      }),
    );
  });

  describe("evidence snapshot (dispatch#1060)", () => {
    it("captures an evidence snapshot before analysis", async () => {
      mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, dryRun: true });

      const result = await runHostedGroomer();

      expect(result).not.toBeNull();
      expect(mocks.collectGroomingEvidenceSnapshot).toHaveBeenCalledWith({
        repoFullName: "org/repo",
        issueNumber: 42,
        comments: [],
      });
      const contextBuiltCall = mocks.prisma.groomingRun.update.mock.calls.find(
        (call) => call[0]?.data?.stage === "context_built",
      );
      expect(contextBuiltCall).toBeDefined();
      expect(contextBuiltCall![0].data).toMatchObject({
        stage: "context_built",
        contextSummary: expect.objectContaining({
          evidence: expect.objectContaining({
            headSha: "abc123",
            pinnedRef: "abc123",
          }),
        }),
      });
    });

    it("pins repository exploration and file reads to the captured SHA", async () => {
      mocks.getHostedGroomerConfig.mockReturnValue({
        ...mockConfig,
        dryRun: true,
        toolLoopEnabled: true,
      });
      mocks.exploreRepository.mockResolvedValue(mockExploration);

      const result = await runHostedGroomer();

      expect(result).not.toBeNull();
      expect(mocks.exploreRepository).toHaveBeenCalledWith(
        expect.objectContaining({ pinnedRef: "abc123" }),
      );
      expect(mocks.buildRepositoryContext).toHaveBeenCalledWith(
        expect.objectContaining({
          repoFullName: "org/repo",
          ref: "abc123",
        }),
        expect.any(Object),
      );
    });

    it("evidence capture failure does not fail the run", async () => {
      mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, dryRun: true });
      mocks.collectGroomingEvidenceSnapshot.mockRejectedValue(new Error("boom"));
      // With no snapshot the prompt says nothing can be ready; a model that
      // listens parks the issue and the run completes.
      mocks.callGroomerLLM.mockResolvedValue(notReadyDraft("backlog", { verdict: { evidenceRefs: [] } }));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await runHostedGroomer();

        expect(result).not.toBeNull();
        expect(result!.dryRun).toBe(true);
        // The defensive shell is persisted: no pinned ref, capture failure
        // recorded inside the evidence summary (never in contextWarnings).
        // The run stops there (dispatch#1063): no plan can be applied to it.
        const contextBuiltCall = mocks.prisma.groomingRun.update.mock.calls.find(
          (call) => call[0]?.data?.contextSummary !== undefined,
        );
        expect(mocks.callGroomerLLM).not.toHaveBeenCalled();
        expect(contextBuiltCall![0].data).toMatchObject({
          status: "dry_run_completed",
          applyOutcome: "unverifiable",
          contextSummary: expect.objectContaining({
            evidence: expect.objectContaining({
              headSha: null,
              pinnedRef: null,
              warnings: ["evidence: snapshot collection failed"],
            }),
          }),
        });
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it("write mode calls label update when labels change", async () => {
    const result = await runHostedGroomer();

    expect(result).not.toBeNull();
    expect(result!.dryRun).toBe(false);
    expect(mocks.updateIssueLabels).toHaveBeenCalledWith(
      "org/repo",
      42,
      expect.arrayContaining(["status/ready"]),
    );
  });

  it("write mode calls prisma issue update for grooming fields", async () => {
    await runHostedGroomer();

    expect(mocks.prisma.issue.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "issue-42" },
        data: expect.objectContaining({
          groomedAt: expect.any(Date),
          groomedBy: "hosted-groomer",
          groomingSummary: "Ready for work.",
        }),
      }),
    );
  });

  it("write mode creates IssueLane row", async () => {
    await runHostedGroomer();

    expect(mocks.prisma.issueLane.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          issueId: "issue-42",
          lane: "local",
          confidence: "high",
          reason: "clear implementation task",
        }),
      }),
    );
  });

  it("strips NUL and C0 control characters from model text before any write (dispatch#1130)", async () => {
    // A draft whose model-authored text carries NUL and other C0 controls must
    // still validate and apply with those characters removed, so the stored
    // validatedOutput, the issue's groomingSummary, the IssueLane reason and the
    // GitHub comment body all carry the same control-free strings.
    const CONTROL = /[\u0000-\u0008\u000B-\u001F]/;
    mocks.callGroomerLLM.mockResolvedValue(
      planDraft({
        verdict: {
          summary: "Ready\u0000 for\u0007 work.",
          lane: { id: "local", confidence: "high", reason: "clear\u0000 implementation\u0001 task" },
        },
        mutations: { githubComment: "Fixed\u0000 already\u0007 on main." },
      }),
    );

    await runHostedGroomer();

    // validatedOutput: every GroomingRun write of the validated plan is control-free.
    const withOutput = mocks.prisma.groomingRun.update.mock.calls.filter(
      (call) => (call[0] as { data?: { validatedOutput?: unknown } })?.data?.validatedOutput !== undefined,
    );
    expect(withOutput.length).toBeGreaterThan(0);
    for (const call of withOutput) {
      const validated = (call[0] as { data: { validatedOutput: unknown } }).data.validatedOutput;
      expect(hasControlChars(validated)).toBe(false);
      const serialized = JSON.stringify(validated);
      expect(serialized).toContain("Ready for work.");
      expect(serialized).toContain("clear implementation task");
    }

    // The issue's groomingSummary.
    expect(mocks.prisma.issue.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ groomingSummary: "Ready for work." }) }),
    );

    // The IssueLane reason.
    expect(mocks.prisma.issueLane.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reason: "clear implementation task" }) }),
    );

    // The GitHub comment body (sanitized before neutralizeMentions + the marker).
    expect(mocks.addIssueComment).toHaveBeenCalled();
    const commentBody = mocks.addIssueComment.mock.calls.at(-1)![2] as string;
    expect(commentBody).not.toMatch(CONTROL);
    expect(commentBody).toContain("Fixed already on main.");
  });

  it("strips NUL and C0 controls from model-authored exploration findings before the contextSummary write (dispatch#1130)", async () => {
    // Exploration runs before the model plan stage and persists the model's
    // submit_findings (ask/files) and tool-call arguments into contextSummary;
    // a NUL there must not reach the jsonb column either.
    mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, toolLoopEnabled: true });
    mocks.exploreRepository.mockResolvedValue({
      ...mockExploration,
      ask: "why\u0000 does login\u0007 drop the return URL?",
      files: ["src/auth/login.ts\u0000"],
      toolCalls: [{ name: "submit_findings", arguments: { notes: "already\u0001 seen" }, ok: true, bytes: 0, preview: "" }],
    });

    await runHostedGroomer();

    const exploredCall = mocks.prisma.groomingRun.update.mock.calls.find(
      (call) => call[0]?.data?.stage === "explored",
    );
    expect(exploredCall).toBeDefined();
    const summary = exploredCall![0].data.contextSummary;
    expect(hasControlChars(summary)).toBe(false);
    expect(summary.exploration.ask).toBe("why does login drop the return URL?");
    expect(summary.exploration.files).toEqual(["src/auth/login.ts"]);
  });

  it("write mode creates AgentRun row", async () => {
    await runHostedGroomer();

    expect(mocks.prisma.agentRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentName: "hosted-groomer",
          status: "completed",
        }),
      }),
    );
  });

  it("write mode creates AuditLog entry", async () => {
    await runHostedGroomer();

    expect(mocks.prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actor: "hosted-groomer",
          repoFullName: "org/repo",
          issueNumber: 42,
        }),
      }),
    );
  });

  it("write mode cooldown skips duplicate comment", async () => {
    mocks.prisma.groomingRun.findFirst.mockResolvedValue({ id: "gr-previous" });
    mocks.callGroomerLLM.mockResolvedValue(planDraft({ mutations: { githubComment: "Test comment" } }));

    const result = await runHostedGroomer();

    expect(mocks.addIssueComment).not.toHaveBeenCalled();
    expect(result!.appliedMutations?.commentSkippedReason).toBe("cooldown");
  });

  it("write mode stores comment URL when comment is posted", async () => {
    mocks.addIssueComment.mockResolvedValue({ url: "https://github.com/org/repo/issues/42#issuecomment-123" });
    mocks.callGroomerLLM.mockResolvedValue(planDraft({ mutations: { githubComment: "Test comment" } }));

    const result = await runHostedGroomer();

    expect(mocks.addIssueComment).toHaveBeenCalled();
    expect(result!.appliedMutations?.commentUrl).toBe("https://github.com/org/repo/issues/42#issuecomment-123");
  });

  it("write mode neutralizes @-mentions in posted comment", async () => {
    mocks.callGroomerLLM.mockResolvedValue(
      planDraft({
        mutations: {
          githubComment:
            "@reviewer This issue has been groomed and moved to **ready** status. Contact foo@bar.com with questions.",
        },
      }),
    );

    await runHostedGroomer();

    expect(mocks.addIssueComment).toHaveBeenCalledWith(
      "org/repo",
      42,
      expect.stringMatching(
        /^`@reviewer` This issue has been groomed and moved to \*\*ready\*\* status\. Contact foo@bar\.com with questions\.\n\n<!-- dispatch-groomer:apply=[0-9a-f]{64} -->$/,
      ),
    );
  });

  it("failure after groomingRun creation completes run as failed", async () => {
    mocks.callGroomerLLM.mockRejectedValue(new Error("LLM timeout"));

    await expect(runHostedGroomer()).rejects.toThrow(/LLM timeout/);

    expect(mocks.prisma.groomingRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "gr-1" },
        data: expect.objectContaining({
          status: "failed",
          errorMessage: "LLM timeout",
          retryable: true,
        }),
      }),
    );
  });

  it("missing AutomationRepo errors cleanly", async () => {
    mocks.prisma.automationRepo.findUnique.mockResolvedValue(null);

    await expect(runHostedGroomer()).rejects.toThrow(
      "Automation repository not found for org/repo",
    );
  });

  it("throws when validation fails", async () => {
    mocks.callGroomerLLM.mockResolvedValue(planDraft({ verdict: { lane: { id: "gpu", confidence: "high", reason: "r" } } }));

    await expect(runHostedGroomer()).rejects.toThrow(/verdict\.lane\.id: must be a configured lane/);
  });

  it("fails on LLM error", async () => {
    mocks.callGroomerLLM.mockRejectedValue(new Error("LLM timeout"));

    await expect(runHostedGroomer()).rejects.toThrow(/LLM timeout/);
  });

  it("continues with empty comments when comment fetch fails", async () => {
    mocks.fetchIssueComments.mockRejectedValue(new Error("comment API down"));

    await runHostedGroomer();

    expect(mocks.buildIssueContext).toHaveBeenCalledWith(
      expect.objectContaining({ comments: [] }),
    );
    expect(mocks.callGroomerLLM).toHaveBeenCalled();
  });

  it("records failed AgentRun and AuditLog when LLM work fails", async () => {
    mocks.callGroomerLLM.mockRejectedValue(new Error("LLM timeout"));

    await expect(runHostedGroomer()).rejects.toThrow(/LLM timeout/);

    expect(mocks.prisma.agentRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          errorMessage: "LLM timeout",
          issueId: "issue-42",
        }),
      }),
    );
    expect(mocks.prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          success: false,
          errorMessage: "LLM timeout",
        }),
      }),
    );
  });

  it("does not post comment when githubComment is empty", async () => {
    mocks.callGroomerLLM.mockResolvedValue(planDraft({ mutations: { githubComment: "   " } }));

    await runHostedGroomer();

    expect(mocks.addIssueComment).not.toHaveBeenCalled();
  });

  it("posts one comment when githubComment is present", async () => {
    mocks.callGroomerLLM.mockResolvedValue(planDraft({ mutations: { githubComment: "Likely root cause found." } }));

    await runHostedGroomer();

    expect(mocks.addIssueComment).toHaveBeenCalledTimes(1);
    expect(mocks.addIssueComment).toHaveBeenCalledWith(
      "org/repo",
      42,
      expect.stringMatching(/^Likely root cause found\.\n\n<!-- dispatch-groomer:apply=[0-9a-f]{64} -->$/),
    );
  });

  it("truncates githubComment before posting", async () => {
    // Within the plan's 4000-char bound, but neutralized mentions grow it past
    // the 4096-char GitHub cap.
    const longComment = "@a ".repeat(1333);
    mocks.callGroomerLLM.mockResolvedValue(planDraft({ mutations: { githubComment: longComment } }));

    await runHostedGroomer();

    expect(mocks.addIssueComment.mock.calls[0][2]).toHaveLength(4096);
  });

  it("comment posting is best-effort: a persistent addComment failure does not fail the run", async () => {
    mocks.addIssueComment.mockRejectedValue(new Error("GitHub API error adding comment: 504"));
    mocks.callGroomerLLM.mockResolvedValue(planDraft({ mutations: { githubComment: "Likely root cause found." } }));

    const result = await runHostedGroomer();

    expect(result).not.toBeNull();
    expect(result!.dryRun).toBe(false);
    // Essential mutations still applied despite the comment failure.
    expect(mocks.updateIssueLabels).toHaveBeenCalledWith(
      "org/repo",
      42,
      expect.arrayContaining(["status/ready"]),
    );
    expect(mocks.prisma.issue.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ currentLane: "local" }) }),
    );
    // Comment failure recorded but did not fail the run or the GroomingRun record.
    expect(result!.appliedMutations?.commentPosted).toBe(false);
    expect(result!.appliedMutations?.commentError).toMatch(/504/);
    expect(mocks.prisma.groomingRun.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }),
    );
    // Retried once before giving up.
    expect(mocks.addIssueComment).toHaveBeenCalledTimes(2);
  });

  it("comment posting retries once and succeeds on the second attempt", async () => {
    mocks.addIssueComment
      .mockRejectedValueOnce(new Error("GitHub API error adding comment: 504"))
      .mockResolvedValueOnce({ url: "https://github.com/org/repo/issues/42#issuecomment-999" });
    mocks.callGroomerLLM.mockResolvedValue(planDraft({ mutations: { githubComment: "Likely root cause found." } }));

    const result = await runHostedGroomer();

    expect(mocks.addIssueComment).toHaveBeenCalledTimes(2);
    expect(result!.appliedMutations?.commentUrl).toBe(
      "https://github.com/org/repo/issues/42#issuecomment-999",
    );
    expect(result!.appliedMutations?.commentError).toBeUndefined();
  });

  it("passes targeted issue options to selector", async () => {
    await runHostedGroomer({ repoFullName: "org/repo", issueNumber: 42 });

    expect(mocks.selectGroomingCandidate).toHaveBeenCalledWith({
      repoFullName: "org/repo",
      issueNumber: 42,
      freshnessBackfill: true,
      admissionRegroom: true,
    });
  });

  it("returns null without LLM work when another active lease exists", async () => {
    mocks.findActiveLeasesForIssue.mockResolvedValue([{ agentName: "other-agent" }]);

    const result = await runHostedGroomer();

    expect(result).toBeNull();
    expect(mocks.upsertLease).not.toHaveBeenCalled();
    expect(mocks.callGroomerLLM).not.toHaveBeenCalled();
  });

  it("force option overrides another active lease", async () => {
    mocks.findActiveLeasesForIssue.mockResolvedValue([{ agentName: "other-agent" }]);

    await runHostedGroomer({ force: true });

    expect(mocks.upsertLease).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "hosted-groomer",
      issueId: "issue-42",
    }));
    expect(mocks.callGroomerLLM).toHaveBeenCalled();
  });

  it("releases the lease when LLM work fails", async () => {
    mocks.callGroomerLLM.mockRejectedValue(new Error("LLM timeout"));

    await expect(runHostedGroomer()).rejects.toThrow(/LLM timeout/);

    expect(mocks.releaseLease).toHaveBeenCalledWith("lease-1");
  });

  it("sets currentLane on issue update", async () => {
    await runHostedGroomer();

    expect(mocks.prisma.issue.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentLane: "local",
        }),
      }),
    );
  });

  // ─── Title rewriting tests ───

  it("does not rewrite a good title", async () => {
    mocks.callGroomerLLM.mockResolvedValue(planDraft({ mutations: { proposedTitle: "Fix the login bug" } }));

    const result = await runHostedGroomer();

    // "Fix login bug" (13 chars) is a good title — should not be rewritten
    expect(result!.mutationPlan?.titleRewritten).toBe(false);
    expect(mocks.updateIssueTitleAndBody).not.toHaveBeenCalled();
  });

  it("rewrites a bad short title", async () => {
    const badCandidate = { ...mockCandidate, title: "P0" };
    mocks.selectGroomingCandidate.mockResolvedValue(badCandidate);
    mocks.callGroomerLLM.mockResolvedValue(planDraft({ mutations: { proposedTitle: "Fix SSO/OIDC callback state verification mismatch causing 400 errors" } }));

    const result = await runHostedGroomer();

    expect(result!.mutationPlan?.titleRewritten).toBe(true);
    expect(result!.mutationPlan?.originalTitle).toBe("P0");
    expect(mocks.updateIssueTitleAndBody).toHaveBeenCalledWith(
      "org/repo",
      42,
      expect.objectContaining({ title: "Fix SSO/OIDC callback state verification mismatch causing 400 errors" }),
    );
    expect(result!.appliedMutations?.titleUpdated).toBe(true);
  });

  it("rewrites a single-word generic title like TODO", async () => {
    const badCandidate = { ...mockCandidate, title: "TODO" };
    mocks.selectGroomingCandidate.mockResolvedValue(badCandidate);
    mocks.callGroomerLLM.mockResolvedValue(planDraft({ mutations: { proposedTitle: "Implement user authentication flow" } }));

    const result = await runHostedGroomer();

    expect(result!.mutationPlan?.titleRewritten).toBe(true);
    expect(mocks.updateIssueTitleAndBody).toHaveBeenCalled();
  });

  it("rewrites an empty title", async () => {
    const badCandidate = { ...mockCandidate, title: "" };
    mocks.selectGroomingCandidate.mockResolvedValue(badCandidate);
    mocks.callGroomerLLM.mockResolvedValue(planDraft({ mutations: { proposedTitle: "Add missing error handling for database connections" } }));

    const result = await runHostedGroomer();

    expect(result!.mutationPlan?.titleRewritten).toBe(true);
    expect(mocks.updateIssueTitleAndBody).toHaveBeenCalled();
  });

  // ─── Body enrichment tests ───

  it("does not enrich a substantial body", async () => {
    const goodCandidate = {
      ...mockCandidate,
      body: "This is a detailed issue description that explains the problem clearly with enough context and detail for developers to understand what needs to be done.",
    };
    mocks.selectGroomingCandidate.mockResolvedValue(goodCandidate);
    mocks.callGroomerLLM.mockResolvedValue(planDraft({ mutations: { proposedBody: "Enriched body content." } }));

    const result = await runHostedGroomer();

    expect(result!.mutationPlan?.bodyEnriched).toBe(false);
    expect(mocks.updateIssueTitleAndBody).not.toHaveBeenCalled();
  });

  it("enriches a sparse body", async () => {
    const sparseCandidate = { ...mockCandidate, body: "Broken." };
    mocks.selectGroomingCandidate.mockResolvedValue(sparseCandidate);
    const enrichedBody = `## Context
This issue relates to the login flow.

## What's known
- Login fails after password reset

## Suggested approach
Investigate session handling in auth module.`;
    mocks.callGroomerLLM.mockResolvedValue(planDraft({ mutations: { proposedBody: enrichedBody } }));

    const result = await runHostedGroomer();

    expect(result!.mutationPlan?.bodyEnriched).toBe(true);
    // The human text is kept verbatim; the enrichment lands in one managed section.
    expect(mocks.updateIssueTitleAndBody).toHaveBeenCalledWith("org/repo", 42, {
      body: `Broken.\n\n<!-- dispatch-groomer:managed:start -->\n${enrichedBody}\n<!-- dispatch-groomer:managed:end -->`,
    });
    expect(result!.appliedMutations?.bodyUpdated).toBe(true);
  });

  it("enriches a null body", async () => {
    const noBodyCandidate = { ...mockCandidate, body: null };
    mocks.selectGroomingCandidate.mockResolvedValue(noBodyCandidate);
    const enrichedBody = "## Description\nMore detail needed.\n\n## Labels\npriority/p0";
    mocks.callGroomerLLM.mockResolvedValue(planDraft({ mutations: { proposedBody: enrichedBody } }));

    const result = await runHostedGroomer();

    expect(result!.mutationPlan?.bodyEnriched).toBe(true);
    expect(mocks.updateIssueTitleAndBody).toHaveBeenCalled();
  });

  it("applies both title rewrite and body enrichment together", async () => {
    const badCandidate = { ...mockCandidate, title: "P0", body: "Fix." };
    mocks.selectGroomingCandidate.mockResolvedValue(badCandidate);
    const enrichedBody = "## Context\nSSO login is broken.\n\n## What's known\nState verification fails on callback.";
    mocks.callGroomerLLM.mockResolvedValue(
      planDraft({ mutations: { proposedTitle: "Fix SSO callback state mismatch", proposedBody: enrichedBody } }),
    );

    const result = await runHostedGroomer();

    expect(result!.mutationPlan?.titleRewritten).toBe(true);
    expect(result!.mutationPlan?.bodyEnriched).toBe(true);
    expect(mocks.updateIssueTitleAndBody).toHaveBeenCalledWith(
      "org/repo",
      42,
      expect.objectContaining({
        title: "Fix SSO callback state mismatch",
        body: expect.stringContaining(`Fix.\n\n<!-- dispatch-groomer:managed:start -->\n${enrichedBody}\n`),
      }),
    );
    expect(result!.appliedMutations?.titleUpdated).toBe(true);
    expect(result!.appliedMutations?.bodyUpdated).toBe(true);
  });

  it("dry-run includes title/body plan but does not call GitHub API", async () => {
    const badCandidate = { ...mockCandidate, title: "P0" };
    mocks.selectGroomingCandidate.mockResolvedValue(badCandidate);
    mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, dryRun: true });
    mocks.callGroomerLLM.mockResolvedValue(planDraft({ mutations: { proposedTitle: "Fix the thing" } }));

    const result = await runHostedGroomer();

    expect(result!.dryRun).toBe(true);
    expect(result!.mutationPlan?.titleRewritten).toBe(true);
    expect(mocks.updateIssueTitleAndBody).not.toHaveBeenCalled();
  });

  it("skips title/body update when LLM does not propose changes", async () => {
    mocks.callGroomerLLM.mockResolvedValue(planDraft()); // no proposedTitle or proposedBody

    await runHostedGroomer();

    expect(mocks.updateIssueTitleAndBody).not.toHaveBeenCalled();
  });

  it("normalizes explicit LLM nulls to undefined in the legacy output view", async () => {
    const badCandidate = { ...mockCandidate, title: "P0" };
    mocks.selectGroomingCandidate.mockResolvedValue(badCandidate);
    mocks.callGroomerLLM.mockResolvedValue(planDraft({ mutations: { proposedTitle: null, proposedBody: null } }));

    const result = await runHostedGroomer();

    expect(result!.output.proposedTitle).toBeUndefined();
    expect(result!.output.proposedBody).toBeUndefined();
    expect(result!.mutationPlan?.titleRewritten).toBe(false);
    expect(result!.mutationPlan?.bodyEnriched).toBe(false);
    expect(mocks.updateIssueTitleAndBody).not.toHaveBeenCalled();
  });

  describe("not-ready reasons (dispatch#839)", () => {
    // Under the plan contract a backlog verdict always carries a rationale,
    // which becomes notReadyReason, so the run never persists mark_not_ready
    // without a reason.
    const notReadyOutput = notReadyDraft("backlog", {
      verdict: { summary: "Not ready.", rationale: "auditor prioritized it low" },
    });

    it("persists the verdict rationale as notReadyReason", async () => {
      mocks.callGroomerLLM.mockResolvedValue(notReadyOutput);

      const result = await runHostedGroomer();

      expect(result).not.toBeNull();
      expect(mocks.prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            nextGroomingAction: "mark_not_ready",
            notReadyReason: "auditor prioritized it low",
          }),
        }),
      );
    });

    it("maps blocked and needs_info rationales to their own reason fields", async () => {
      mocks.callGroomerLLM.mockResolvedValue(notReadyDraft("blocked", { verdict: { rationale: "waiting on the vendor API" } }));
      await runHostedGroomer();
      expect(mocks.prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ nextGroomingAction: "mark_blocked", blockedReason: "waiting on the vendor API" }),
        }),
      );

      mocks.prisma.issue.update.mockClear();
      mocks.callGroomerLLM.mockResolvedValue(notReadyDraft("needs_info", { verdict: { rationale: "which tenant?" } }));
      await runHostedGroomer();
      expect(mocks.prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ nextGroomingAction: "mark_needs_info", needsInfoReason: "which tenant?" }),
        }),
      );
    });

    it("uses this run's rationale over a prior summary in the dry-run mutation plan", async () => {
      mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, dryRun: true });
      mocks.selectGroomingCandidate.mockResolvedValue({
        ...mockCandidate,
        groomingSummary: "deferred by maintainer",
      });
      mocks.callGroomerLLM.mockResolvedValue(notReadyOutput);

      const result = await runHostedGroomer();

      expect(result!.mutationPlan?.notReadyReason).toBe("auditor prioritized it low");
      expect(mocks.prisma.issue.update).not.toHaveBeenCalled();
    });
  });

  describe("exactly-one-status-label post-condition (dispatch#941)", () => {
    // A parked issue: it carries a status label plus the needs-human park marker.
    const parkedCandidate: GroomingCandidate = {
      ...mockCandidate,
      labels: ["status/backlog", "priority/p2", "needs-human"],
    };

    it("restores status/backlog when a non-ready re-groom drops the status label", async () => {
      mocks.selectGroomingCandidate.mockResolvedValue(parkedCandidate);
      // A non-ready re-groom: status is derived from the verdict, so the
      // pinchflat#81 shape (old status removed, none added) cannot occur.
      mocks.callGroomerLLM.mockResolvedValue(
        notReadyDraft("backlog", {
          verdict: { summary: "Re-groomed.", rationale: "still parked" },
          mutations: { labelsToAdd: ["type/chore"] },
        }),
      );

      const result = await runHostedGroomer();

      // The label set GitHub receives carries exactly the derived status.
      expect(mocks.updateIssueLabels).toHaveBeenCalledTimes(1);
      const written = mocks.updateIssueLabels.mock.calls[0][2] as string[];
      expect(written.filter((l) => l.startsWith("status/"))).toEqual(["status/backlog"]);
      expect(written).toEqual(expect.arrayContaining(["needs-human", "priority/p2", "type/chore"]));
      expect(result!.plannedLabels).toEqual(written);
    });

    it("restores status/ready when a ready re-groom drops the status label", async () => {
      mocks.selectGroomingCandidate.mockResolvedValue(parkedCandidate);
      // Ready re-groom: the old status is replaced by status/ready.
      mocks.callGroomerLLM.mockResolvedValue(planDraft());

      const result = await runHostedGroomer();

      const written = mocks.updateIssueLabels.mock.calls[0][2] as string[];
      const statusLabels = written.filter((l) => l.startsWith("status/"));
      expect(statusLabels).toEqual(["status/ready"]);
      expect(result!.plannedLabels).toEqual(expect.arrayContaining(["status/ready"]));
    });

    it("keeps a single status label when the groom adds none and the issue had one", async () => {
      mocks.selectGroomingCandidate.mockResolvedValue(parkedCandidate);
      // Still backlog: the existing status/backlog survives, not duplicated.
      mocks.callGroomerLLM.mockResolvedValue(notReadyDraft("backlog", { verdict: { summary: "No change." } }));

      const result = await runHostedGroomer();

      // The issue already ends in the target state, so no label write is
      // made at all (no thrash), and the post-condition still holds.
      expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
      const statusLabels = result!.plannedLabels.filter((l) => l.startsWith("status/"));
      expect(statusLabels).toEqual(["status/backlog"]);
    });

    it("collapses multiple status labels to one", async () => {
      mocks.selectGroomingCandidate.mockResolvedValue({
        ...parkedCandidate,
        labels: ["status/backlog", "status/ready", "priority/p2"],
      });
      // The issue already carries two status labels; a ready groom keeps one.
      mocks.callGroomerLLM.mockResolvedValue(planDraft());

      const result = await runHostedGroomer();

      const written = mocks.updateIssueLabels.mock.calls[0][2] as string[];
      const statusLabels = written.filter((l) => l.startsWith("status/"));
      expect(statusLabels).toEqual(["status/ready"]);
      expect(result!.plannedLabels).toEqual(expect.arrayContaining(["status/ready"]));
    });

    it("demotes a status/ready issue when the re-groom verdict is not ready", async () => {
      // Before the plan contract a non-ready re-groom that forgot to remove
      // status/ready left it in place, and ready won the collapse.
      mocks.selectGroomingCandidate.mockResolvedValue({ ...parkedCandidate, labels: ["status/ready", "priority/p2"] });
      mocks.callGroomerLLM.mockResolvedValue(notReadyDraft("blocked"));

      const result = await runHostedGroomer();

      const written = mocks.updateIssueLabels.mock.calls[0][2] as string[];
      expect(written.filter((l) => l.startsWith("status/"))).toEqual(["status/blocked"]);
      expect(result!.plan!.readiness.ready).toBe(false);
    });
  });

  describe("GroomingPlan contract (dispatch#1062)", () => {
    it("persists the validated plan and exposes readiness in the mutation plan", async () => {
      mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, dryRun: true });

      const result = await runHostedGroomer();

      expect(result!.plan).toMatchObject({
        schemaVersion: 1,
        evidence: { evidenceDigest: "digest", headSha: "abc123", issueFingerprint: "fp" },
        readiness: { ready: true, admission: "implementation", lane: "local", evidenceDigest: "digest" },
      });
      expect(result!.output.labelsToAdd).toEqual(["status/ready"]);
      const plannedCall = mocks.prisma.groomingRun.update.mock.calls.find((call) => call[0]?.data?.stage === "planned");
      expect(plannedCall![0].data.validatedOutput).toBe(result!.plan);
      expect(plannedCall![0].data.mutationPlan).toMatchObject({
        planSchemaVersion: 1,
        evidenceDigest: "digest",
        readiness: { ready: true },
        closeRecommendation: null,
      });
    });

    it("gives the model the evidence catalog built from the snapshot", async () => {
      await runHostedGroomer();

      const { evidenceCatalog } = mocks.callGroomerLLM.mock.calls[0][0];
      expect(evidenceCatalog.binding.evidenceDigest).toBe("digest");
      expect(evidenceCatalog.entries.map((e: { id: string }) => e.id)).toEqual(["issue", "repo:src/auth/login.ts"]);
    });

    it("fails closed on an unknown evidence reference and records why", async () => {
      const raw = planDraft({ verdict: { evidenceRefs: ["repo:src/invented.ts"] } });
      mocks.callGroomerLLM.mockResolvedValue(raw);

      await expect(runHostedGroomer()).rejects.toThrow(/unknown evidence reference "repo:src\/invented.ts"/);

      expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
      expect(mocks.closeIssue).not.toHaveBeenCalled();
      // The repair turn (dispatch#1126) returned the same answer: both are kept.
      expect(mocks.prisma.groomingRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rawOutput: { firstAnswer: raw, repairAnswer: raw },
            validationErrors: [
              'first answer: verdict.evidenceRefs[0]: unknown evidence reference "repo:src/invented.ts"',
              'repair: verdict.evidenceRefs[0]: unknown evidence reference "repo:src/invented.ts"',
            ],
          }),
        }),
      );
    });

    it("fails closed on the legacy output shape", async () => {
      mocks.callGroomerLLM.mockResolvedValue({
        labelsToAdd: ["status/ready"],
        labelsToRemove: [],
        lane: { id: "local", confidence: "high", reason: "r" },
      });

      await expect(runHostedGroomer()).rejects.toThrow(/legacy GroomerOutput shape/);
      expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
    });

    it("never asks the model for a plan when the snapshot could not be captured (dispatch#1063)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mocks.collectGroomingEvidenceSnapshot.mockRejectedValue(new Error("boom"));

      // A plan on an uncaptured snapshot could never be ready, close, or pass
      // the apply preconditions, so no model or repository work is spent on it.
      const result = await runHostedGroomer();
      expect(result!.appliedMutations).toMatchObject({ outcome: "unverifiable" });
      expect(mocks.callGroomerLLM).not.toHaveBeenCalled();
      expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("rejects a ready claim with a material uncertainty", async () => {
      mocks.callGroomerLLM.mockResolvedValue(
        planDraft({ verdict: { uncertainties: [{ kind: "scope", question: "Also SSO?", material: true }] } }),
      );

      await expect(runHostedGroomer()).rejects.toThrow(/readiness: material uncertainty remains/);
      expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
    });

    it("does not let a claimable lane promote a non-ready verdict", async () => {
      mocks.callGroomerLLM.mockResolvedValue(
        notReadyDraft("needs_info", { verdict: { lane: { id: "local", confidence: "high", reason: "r" } } }),
      );

      const result = await runHostedGroomer();

      const written = mocks.updateIssueLabels.mock.calls[0][2] as string[];
      expect(written.filter((l) => l.startsWith("status/"))).toEqual(["status/backlog"]);
      expect(mocks.prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ currentLane: "backlog" }) }),
      );
      expect(result!.contextWarnings).toContain("enum:verdict.lane.id: resolved 'local' -> 'backlog' via invariant");
    });

    it("records a duplicate recommendation without closing the issue", async () => {
      mocks.collectGroomingEvidenceSnapshot.mockResolvedValue({
        ...mockEvidence,
        sources: [
          ...mockEvidence.sources,
          { key: "github:issue:org/repo#7", provenance: "github_issue", state: "open", url: null, via: "read", observedAt: "", ref: null },
        ],
      });
      mocks.callGroomerLLM.mockResolvedValue(
        notReadyDraft("backlog", {
          mutations: { close: { reason: "duplicate", rationale: "same as #7", evidenceRefs: ["github:issue:org/repo#7"] } },
          relatedWork: [{ ref: "github:issue:org/repo#7", relation: "duplicate_of", note: "same bug" }],
        }),
      );

      const result = await runHostedGroomer();

      expect(result!.mutationPlan?.closeRecommendation).toMatchObject({ reason: "duplicate" });
      expect(result!.mutationPlan?.willCloseIssue).toBe(false);
      expect(mocks.closeIssue).not.toHaveBeenCalled();
    });

    describe("in-flight issues keep their status (in-progress/in-review)", () => {
      const expectNoGitHubMutation = () => {
        expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
        expect(mocks.updateIssueTitleAndBody).not.toHaveBeenCalled();
        expect(mocks.addIssueComment).not.toHaveBeenCalled();
        expect(mocks.closeIssue).not.toHaveBeenCalled();
        expect(mocks.prisma.issueLane.create).not.toHaveBeenCalled();
      };

      it("records the plan but applies nothing to a status/in-progress issue", async () => {
        const claimed = { ...mockCandidate, labels: ["status/in-progress", "agent/alpha"], currentLane: "local" };
        mocks.selectGroomingCandidate.mockResolvedValue(claimed);
        mocks.callGroomerLLM.mockResolvedValue(
          notReadyDraft("blocked", { mutations: { labelsToAdd: ["priority/p2"], githubComment: "Parking this." } }),
        );

        const result = await runHostedGroomer();

        expectNoGitHubMutation();
        expect(result!.plannedLabels).toEqual(["status/in-progress", "agent/alpha"]);
        expect(result!.plan!.verdict.actionability).toBe("blocked");
        expect(result!.appliedMutations).toEqual({ skipped: "in_flight_status", inFlightStatus: "status/in-progress" });
        // Only the cooldown stamp is written locally: no lane, status reason or summary.
        expect(mocks.prisma.issue.update).toHaveBeenCalledWith({
          where: { id: "issue-42" },
          data: { groomedAt: expect.any(Date), groomedBy: "hosted-groomer" },
        });
        const plannedCall = mocks.prisma.groomingRun.update.mock.calls.find((call) => call[0]?.data?.stage === "planned");
        expect(plannedCall![0].data).toMatchObject({
          validatedOutput: result!.plan,
          labelsToAdd: [],
          labelsToRemove: [],
          labelsAfter: ["status/in-progress", "agent/alpha"],
          laneAfter: "local",
          mutationPlan: expect.objectContaining({ skippedReason: "in_flight_status", willComment: false }),
        });
        expect(mocks.prisma.groomingRun.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: "completed", stage: "skipped" }) }),
        );
      });

      it("leaves a status/in-review issue untouched on a targeted run, even for already_done", async () => {
        const inReview = { ...mockCandidate, labels: ["status/in-review", "priority/p1"] };
        mocks.selectGroomingCandidate.mockResolvedValue(inReview);
        mocks.callGroomerLLM.mockResolvedValue(
          notReadyDraft("already_done", {
            mutations: { close: { reason: "already_done", rationale: "gone", evidenceRefs: ["repo:src/auth/login.ts"], criteria: GROUNDED_CRITERIA } },
          }),
        );

        const result = await runHostedGroomer({ repoFullName: "org/repo", issueNumber: 42 });

        expect(mocks.selectGroomingCandidate).toHaveBeenCalledWith({ repoFullName: "org/repo", issueNumber: 42, freshnessBackfill: true, admissionRegroom: true });
        expectNoGitHubMutation();
        expect(result!.plannedLabels).toEqual(["status/in-review", "priority/p1"]);
        expect(result!.mutationPlan).toMatchObject({ skippedReason: "in_flight_status", inFlightStatus: "status/in-review", willCloseIssue: false });
        expect(mocks.prisma.issue.update).not.toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ state: "closed" }) }),
        );
      });

      it("reports the skip in a dry run", async () => {
        mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, dryRun: true });
        mocks.selectGroomingCandidate.mockResolvedValue({ ...mockCandidate, labels: ["status/in-progress"] });

        const result = await runHostedGroomer();

        expect(result!.mutationPlan).toMatchObject({ skippedReason: "in_flight_status", inFlightStatus: "status/in-progress" });
        expect(result!.plannedLabels).toEqual(["status/in-progress"]);
        expect(mocks.prisma.issue.update).not.toHaveBeenCalled();
      });
    });

    it("routes ready design work to the escalation lane and never the default lane", async () => {
      mocks.callGroomerLLM.mockResolvedValue(
        planDraft({
          verdict: {
            workType: "design",
            lane: { id: "frontier", confidence: "high", reason: "needs a decision" },
            uncertainties: [{ kind: "design_choice", question: "Token or session store?", material: true }],
          },
          implementationBrief: null,
        }),
      );

      const result = await runHostedGroomer();

      expect(result!.plan!.readiness).toMatchObject({ ready: true, admission: "escalation", lane: "frontier" });
      expect(result!.output.nextGroomingAction).toBe("escalate");

      mocks.callGroomerLLM.mockResolvedValue(
        planDraft({ verdict: { workType: "design", lane: { id: "local", confidence: "high", reason: "r" } }, implementationBrief: null }),
      );
      await expect(runHostedGroomer()).rejects.toThrow(/design work must route to the escalation lane/);
    });
  });

  describe("model-stage repair turn and degradation (dispatch#1126)", () => {
    const RELATED = "github:issue:org/repo#7";
    const withRelatedWork = () =>
      mocks.collectGroomingEvidenceSnapshot.mockResolvedValue({
        ...mockEvidence,
        sources: [
          ...mockEvidence.sources,
          { key: RELATED, provenance: "github_issue", state: "open", url: null, via: "read", observedAt: "", ref: null },
        ],
      });
    const badRef = () => planDraft({ relatedWork: [{ ref: "issue", relation: "related", note: "the issue itself" }] });
    const badRefError = 'relatedWork[0].ref: "issue" must be a related-work evidence reference';
    const parseError = (content: string) =>
      Object.assign(new Error(`Failed to parse LLM response as JSON: ${content.slice(0, 200)}`), {
        name: "GroomerOutputParseError",
        content,
      });

    it("gives a plan whose only error is a bad ref one repair turn, and applies the repaired plan", async () => {
      withRelatedWork();
      const repaired = planDraft({ relatedWork: [{ ref: RELATED, relation: "related", note: "same area" }] });
      mocks.callGroomerLLM.mockResolvedValueOnce(badRef()).mockResolvedValueOnce(repaired);

      const result = await runHostedGroomer();

      expect(mocks.callGroomerLLM).toHaveBeenCalledTimes(2);
      const repairCall = mocks.callGroomerLLM.mock.calls[1][0];
      expect(repairCall.repair).toEqual({ previousResponse: JSON.stringify(badRef(), null, 2), errors: [badRefError] });
      expect(repairCall.prompt).toBe("test context");
      expect(repairCall.evidenceCatalog).toBe(mocks.callGroomerLLM.mock.calls[0][0].evidenceCatalog);
      expect(repairCall.timeoutMs).toBe(mockConfig.timeoutMs);
      expect(result!.plan!.relatedWork).toEqual([{ ref: RELATED, relation: "related", note: "same area" }]);
      expect(result!.contextWarnings).toContain(`model: the repair turn fixed the first answer, which failed with: ${badRefError}`);
      expect(mocks.updateIssueLabels).toHaveBeenCalled();
      const planned = mocks.prisma.groomingRun.update.mock.calls.find((call) => call[0]?.data?.stage === "planned");
      expect(planned![0].data.rawOutput).toEqual(repaired);
      expect(planned![0].data.contextWarnings).toEqual(result!.contextWarnings);
    });

    it("fails the run with both error sets when the repair also fails", async () => {
      const first = planDraft({ verdict: { lane: { id: "gpu", confidence: "high", reason: "r" } } });
      const second = planDraft({ verdict: { lane: { id: "gpu2", confidence: "high", reason: "r" } } });
      mocks.callGroomerLLM.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

      await expect(runHostedGroomer()).rejects.toThrow(
        /Groomer output validation failed: first answer: verdict\.lane\.id: .*"gpu", repair: verdict\.lane\.id: .*"gpu2"/,
      );

      expect(mocks.callGroomerLLM).toHaveBeenCalledTimes(2);
      expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
      const failed = mocks.prisma.groomingRun.update.mock.calls.find((call) => call[0]?.data?.validationErrors);
      expect(failed![0].data.rawOutput).toEqual({ firstAnswer: first, repairAnswer: second });
      expect(failed![0].data.validationErrors).toEqual([
        expect.stringMatching(/^first answer: verdict\.lane\.id: must be a configured lane .*"gpu"$/),
        expect.stringMatching(/^repair: verdict\.lane\.id: must be a configured lane .*"gpu2"$/),
      ]);
    });

    it("gives a final answer made of tool-call text a repair turn", async () => {
      const answer = 'Let me read the key files first. <tool_call>{"name":"read_file","arguments":{"path":"src/auth/login.ts"}}</tool_call>';
      mocks.callGroomerLLM.mockRejectedValueOnce(parseError(answer)).mockResolvedValueOnce(mockOutput);

      const result = await runHostedGroomer();

      expect(mocks.callGroomerLLM).toHaveBeenCalledTimes(2);
      expect(mocks.callGroomerLLM.mock.calls[1][0].repair).toEqual({
        previousResponse: answer,
        errors: [`Failed to parse LLM response as JSON: ${answer}`],
      });
      expect(result!.plan!.readiness.ready).toBe(true);
    });

    it("fails with both errors when the repair of a non-JSON answer is not JSON either", async () => {
      mocks.callGroomerLLM.mockRejectedValueOnce(parseError("<tool_call>one</tool_call>")).mockRejectedValueOnce(parseError("<tool_call>two</tool_call>"));

      await expect(runHostedGroomer()).rejects.toThrow(
        /first answer: Failed to parse LLM response as JSON: <tool_call>one.*repair: Failed to parse LLM response as JSON: <tool_call>two/,
      );
      const failed = mocks.prisma.groomingRun.update.mock.calls.find((call) => call[0]?.data?.validationErrors);
      expect(failed![0].data.rawOutput).toEqual({ firstAnswer: "<tool_call>one</tool_call>", repairAnswer: "<tool_call>two</tool_call>" });
    });

    it("stores no NUL or control characters from a model answer (Postgres rejects them)", async () => {
      const unsafe = /[\u0000-\u0008\u000B-\u001F]/;
      mocks.callGroomerLLM
        .mockRejectedValueOnce(parseError("one\u0000<tool_call>\u0007</tool_call>"))
        .mockResolvedValueOnce(planDraft({ verdict: { lane: { id: "g\u0000pu", confidence: "high", reason: "r" } } }));

      const err = await runHostedGroomer().catch((e: Error) => e);

      expect((err as Error).message).not.toMatch(unsafe);
      const failed = mocks.prisma.groomingRun.update.mock.calls.find((call) => call[0]?.data?.validationErrors);
      expect(failed![0].data.rawOutput.firstAnswer).toBe("one<tool_call></tool_call>");
      expect(failed![0].data.rawOutput.repairAnswer.verdict.lane.id).toBe("gpu");
      expect(JSON.stringify(failed![0].data)).not.toContain("\\u0000");
      for (const e of failed![0].data.validationErrors) expect(e).not.toMatch(unsafe);
      // The repair turn still echoed the answer back verbatim.
      expect(mocks.callGroomerLLM.mock.calls[1][0].repair.previousResponse).toBe("one\u0000<tool_call>\u0007</tool_call>");
    });

    it("stores a sanitized copy of an applied plan's raw output", async () => {
      const raw = planDraft({ relatedWork: [{ ref: "iss\u0000ue", relation: "related", note: "n\u0000ote" }] });
      mocks.callGroomerLLM.mockResolvedValue(raw);

      const result = await runHostedGroomer();

      const planned = mocks.prisma.groomingRun.update.mock.calls.find((call) => call[0]?.data?.stage === "planned");
      expect(planned![0].data.rawOutput.relatedWork).toEqual([{ ref: "issue", relation: "related", note: "note" }]);
      expect(raw.relatedWork[0].ref).toBe("iss\u0000ue");
      for (const w of result!.contextWarnings!) expect(w).not.toContain("\u0000");
    });

    it("never repairs a failed model call: timeouts and API errors fail as before", async () => {
      mocks.callGroomerLLM.mockRejectedValue(new Error("LLM API error 400: bad request"));

      await expect(runHostedGroomer()).rejects.toThrow(/LLM API error 400/);
      expect(mocks.callGroomerLLM).toHaveBeenCalledTimes(1);
    });

    it("degrades non-load-bearing fields when the repair leaves only those errors", async () => {
      withRelatedWork();
      const longQuestion = `Should ${"the reset flow ".repeat(30)}also cover SSO?`;
      const longReason = `clear implementation task ${"with a long explanation ".repeat(20)}`;
      const draft = planDraft({
        verdict: {
          lane: { id: "local", confidence: "high", reason: longReason },
          uncertainties: [{ kind: "scope", question: longQuestion, material: false }],
        },
        implementationBrief: {
          ...mockOutput.implementationBrief!,
          dependencies: [
            { ref: "#7", state: "open", evidenceRef: "repo:src/auth/login.ts" },
            { ref: "#7", state: "open", evidenceRef: RELATED },
          ],
        },
        relatedWork: [
          { ref: "issue", relation: "related", note: "the issue itself" },
          { ref: RELATED, relation: "related", note: "same area" },
          { ref: "comment:123", relation: "related", note: "an invented comment" },
        ],
      });
      const original = structuredClone(draft);
      mocks.callGroomerLLM.mockResolvedValue(draft);

      const result = await runHostedGroomer();

      expect(mocks.callGroomerLLM).toHaveBeenCalledTimes(2);
      const plan = result!.plan!;
      expect(plan.relatedWork).toEqual([{ ref: RELATED, relation: "related", note: "same area" }]);
      expect(plan.implementationBrief!.dependencies).toEqual([
        { ref: "#7", state: "open", evidenceRef: null },
        { ref: "#7", state: "open", evidenceRef: RELATED },
      ]);
      expect(plan.verdict.uncertainties[0].question).toHaveLength(300);
      expect(plan.verdict.uncertainties[0].question.endsWith("…")).toBe(true);
      expect(plan.verdict.uncertainties[0]).toMatchObject({ kind: "scope", material: false });
      expect(plan.verdict.lane.reason).toHaveLength(300);
      // Nothing that feeds a mutation moved.
      expect(plan.verdict.lane.id).toBe("local");
      expect(plan.readiness.ready).toBe(true);
      expect(result!.contextWarnings).toEqual(
        expect.arrayContaining([
          "model: the repair turn did not fix every error; degraded the repaired answer",
          'plan: dropped relatedWork[0] (ref "issue"): not a related-work evidence id',
          'plan: dropped relatedWork[2] (ref "comment:123"): not a related-work evidence id',
          'plan: cleared implementationBrief.dependencies[0].evidenceRef ("repo:src/auth/login.ts"): not a related-work evidence id',
          "plan: truncated verdict.uncertainties[0].question to 300 characters",
          "plan: truncated verdict.lane.reason to 300 characters",
        ]),
      );
      // The model's own answer is persisted untouched.
      expect(draft).toEqual(original);
      const planned = mocks.prisma.groomingRun.update.mock.calls.find((call) => call[0]?.data?.stage === "planned");
      expect(planned![0].data.rawOutput).toEqual(original);
      expect(mocks.updateIssueLabels).toHaveBeenCalled();
    });

    it("keeps failing when a dropped repo: ref was the plan's only citation of that file", async () => {
      // The freshness baseline tracks the files a plan cites; dropping the
      // only citation of session.ts would stop re-grooming when it changes.
      mocks.collectGroomingEvidenceSnapshot.mockResolvedValue({
        ...mockEvidence,
        sources: [...mockEvidence.sources, { path: "src/auth/session.ts", provenance: "repository", via: "read", ref: "abc123" }],
      });
      mocks.callGroomerLLM.mockResolvedValue(
        planDraft({ relatedWork: [{ ref: "repo:src/auth/session.ts", relation: "related", note: "session refresh" }] }),
      );

      await expect(runHostedGroomer()).rejects.toThrow(
        /after degrading: repo:src\/auth\/session\.ts is cited only in a field that takes related-work ids/,
      );
      expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
    });

    it("drops a repo: ref from relatedWork when the plan cites that file elsewhere", async () => {
      mocks.callGroomerLLM.mockResolvedValue(
        planDraft({ relatedWork: [{ ref: "repo:src/auth/login.ts", relation: "related", note: "the file to fix" }] }),
      );

      const result = await runHostedGroomer();

      expect(result!.plan!.relatedWork).toEqual([]);
      expect(result!.plan!.citations.map((c) => c.id)).toContain("repo:src/auth/login.ts");
    });

    it("still fails a plan whose bad ref comes with a mutation-affecting error", async () => {
      const draft = planDraft({
        mutations: { labelsToAdd: ["status/ready"] },
        relatedWork: [{ ref: "issue", relation: "related", note: "the issue itself" }],
      });
      mocks.callGroomerLLM.mockResolvedValue(draft);

      await expect(runHostedGroomer()).rejects.toThrow(/status is derived from verdict\.actionability/);
      expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
    });

    it("does not degrade an over-long text field that feeds a mutation", async () => {
      mocks.callGroomerLLM.mockResolvedValue(planDraft({ verdict: { summary: "s".repeat(600) } }));

      await expect(runHostedGroomer()).rejects.toThrow(/verdict\.summary: must be at most 500 characters/);
      expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
    });

    it("never lets a drop hide the related work a close recommendation relied on", async () => {
      mocks.callGroomerLLM.mockResolvedValue(
        notReadyDraft("backlog", {
          mutations: { close: { reason: "duplicate", rationale: "same as this", evidenceRefs: ["issue"] } },
          relatedWork: [{ ref: "issue", relation: "duplicate_of", note: "same bug" }],
        }),
      );

      await expect(runHostedGroomer()).rejects.toThrow(
        /after degrading: mutations\.close\.evidenceRefs: a duplicate recommendation must cite a relatedWork entry/,
      );
      expect(mocks.closeIssue).not.toHaveBeenCalled();
      expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
    });

    describe("the run's time budget", () => {
      const start = Date.parse("2026-09-28T12:00:00.000Z");
      let clock: ReturnType<typeof vi.spyOn>;
      beforeEach(() => {
        clock = vi.spyOn(Date, "now").mockReturnValue(start);
      });
      afterEach(() => {
        clock.mockRestore();
      });

      it("gives the repair turn only what is left before the apply reserve", async () => {
        mocks.callGroomerLLM
          .mockImplementationOnce(async () => {
            // The first call took 8.5 of the lease's 10 minutes; 1 is reserved for applying.
            clock.mockReturnValue(start + 8.5 * 60_000);
            return badRef();
          })
          .mockResolvedValueOnce(mockOutput);

        await runHostedGroomer();

        expect(mocks.callGroomerLLM).toHaveBeenCalledTimes(2);
        expect(mocks.callGroomerLLM.mock.calls[1][0].timeoutMs).toBe(30_000);
      });

      it("skips the repair turn when too little is left, and fails as before", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        mocks.callGroomerLLM.mockImplementationOnce(async () => {
          clock.mockReturnValue(start + 8.75 * 60_000);
          return planDraft({ verdict: { lane: { id: "gpu", confidence: "high", reason: "r" } } });
        });

        await expect(runHostedGroomer()).rejects.toThrow(/^Groomer output validation failed: verdict\.lane\.id: must be a configured lane/);
        expect(mocks.callGroomerLLM).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("skipped the repair turn"));
        warn.mockRestore();
      });

      it("fails with the original parse error when the repair turn is skipped: no draft to degrade, nothing unsafe stored", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        // The real error class, so its storage-safe message is what is tested.
        const { GroomerOutputParseError } = await vi.importActual<typeof import("./llm")>("./llm");
        const original = new GroomerOutputParseError("Let me read the key files.\u0000 <tool_call>\u0007read_file</tool_call>");
        mocks.callGroomerLLM.mockImplementationOnce(async () => {
          clock.mockReturnValue(start + 9.5 * 60_000);
          throw original;
        });

        const err = await runHostedGroomer().catch((e: unknown) => e);

        expect(err).toBe(original);
        expect(original.message).toBe("Failed to parse LLM response as JSON: Let me read the key files. <tool_call>read_file</tool_call>");
        expect(mocks.callGroomerLLM).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("skipped the repair turn"));
        // A parse failure leaves no parsed draft, so there is nothing to degrade
        // and no rawOutput is written: the run fails exactly as before #1126.
        const writes = mocks.prisma.groomingRun.update.mock.calls.map((call) => call[0].data);
        expect(writes.some((data) => "rawOutput" in data || "validationErrors" in data)).toBe(false);
        // What is persisted is the storage-safe message.
        const unsafe = /[\u0000-\u0008\u000B-\u001F]/;
        const failed = writes.find((data) => data.status === "failed");
        expect(failed!.errorMessage).toBe(original.message);
        expect(failed!.errorMessage).not.toMatch(unsafe);
        expect(mocks.prisma.agentRun.create.mock.calls.at(-1)![0].data.errorMessage).not.toMatch(unsafe);
        warn.mockRestore();
      });

      it("still degrades when the repair turn was skipped", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        mocks.callGroomerLLM.mockImplementationOnce(async () => {
          clock.mockReturnValue(start + 9.5 * 60_000);
          return badRef();
        });

        const result = await runHostedGroomer();

        expect(mocks.callGroomerLLM).toHaveBeenCalledTimes(1);
        expect(result!.plan!.relatedWork).toEqual([]);
        expect(result!.contextWarnings).toContain('plan: dropped relatedWork[0] (ref "issue"): not a related-work evidence id');
        warn.mockRestore();
      });
    });
  });

  describe("already_done has an effect (dispatch#957)", () => {
    const alreadyDoneOutput = notReadyDraft("already_done", {
      verdict: {
        lane: { id: "backlog", confidence: "high", reason: "the step is already gone on main" },
        summary: "The Generate Token step no longer exists; closing as already resolved.",
      },
      mutations: {
        githubComment: "Verified on the default branch: the step is gone, so closing as already resolved.",
        close: { reason: "already_done", rationale: "login.ts no longer has the step", evidenceRefs: ["repo:src/auth/login.ts"], criteria: GROUNDED_CRITERIA },
      },
    });

    it("closes the GitHub issue, lands status/done, and mirrors closed state locally", async () => {
      mocks.callGroomerLLM.mockResolvedValue(alreadyDoneOutput);

      const result = await runHostedGroomer();

      expect(result).not.toBeNull();
      expect(mocks.closeIssue).toHaveBeenCalledWith("org/repo", 42);

      const written = mocks.updateIssueLabels.mock.calls[0][2] as string[];
      const statusLabels = written.filter((l) => l.startsWith("status/"));
      expect(statusLabels).toEqual(["status/done"]);
      expect(result!.plannedLabels).toEqual(expect.arrayContaining(["status/done"]));

      // Local mirror of the closed state — selector's state: "open" filter
      // must stop considering the issue on the next pass.
      expect(mocks.prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "issue-42" },
          data: expect.objectContaining({
            state: "closed",
            closedAt: expect.any(Date),
            currentLane: "backlog",
          }),
        }),
      );
      expect(result!.appliedMutations?.issueClosed).toBe(true);
    });

    it("replaces an existing status with status/done (issue#957 invariant)", async () => {
      // The issue was status/ready; already_done must leave exactly status/done
      // so the close step and the selector agree.
      mocks.selectGroomingCandidate.mockResolvedValue({ ...mockCandidate, labels: ["status/ready", "priority/p0"] });
      mocks.callGroomerLLM.mockResolvedValue(alreadyDoneOutput);

      const result = await runHostedGroomer();

      const written = mocks.updateIssueLabels.mock.calls[0][2] as string[];
      const statusLabels = written.filter((l) => l.startsWith("status/"));
      expect(statusLabels).toEqual(["status/done"]);
      expect(result!.plannedLabels).not.toEqual(expect.arrayContaining(["status/ready"]));
      // Still closes the issue despite the inconsistent label set.
      expect(mocks.closeIssue).toHaveBeenCalledWith("org/repo", 42);
    });

    it("records issueClosedError when the GitHub close call fails but does not fail the run", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.closeIssue.mockRejectedValue(new Error("GitHub API error: 502"));
      mocks.callGroomerLLM.mockResolvedValue(alreadyDoneOutput);

      const result = await runHostedGroomer();

      expect(result).not.toBeNull();
      expect(result!.dryRun).toBe(false);
      // The explaining comment landed; status/done did not, because it is
      // only written once the close succeeds. The issue stays open with its
      // previous status, so the selector can retry it.
      expect(mocks.addIssueComment).toHaveBeenCalledTimes(1);
      expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
      expect(result!.appliedMutations?.issueClosedError).toMatch(/502/);
      expect(result!.appliedMutations?.outcome).toBe("partial");
      expect(mocks.prisma.groomingRun.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "partial", retryable: true }) }),
      );
      // Local state is NOT flipped closed when GitHub didn't actually close it,
      // so the issue keeps the chance to be retried.
      expect(mocks.prisma.issue.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ state: "closed" }),
        }),
      );
      errSpy.mockRestore();
    });

    it("dry-run reports willCloseIssue in the mutation plan but does not call GitHub", async () => {
      mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, dryRun: true });
      mocks.callGroomerLLM.mockResolvedValue(alreadyDoneOutput);

      const result = await runHostedGroomer();

      expect(result!.dryRun).toBe(true);
      expect(result!.mutationPlan?.willCloseIssue).toBe(true);
      expect(mocks.closeIssue).not.toHaveBeenCalled();
      expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
      expect(mocks.prisma.issue.update).not.toHaveBeenCalled();
    });

    it("does not close when actionability is anything other than already_done", async () => {
      mocks.callGroomerLLM.mockResolvedValue(planDraft());

      await runHostedGroomer();

      expect(mocks.closeIssue).not.toHaveBeenCalled();
      expect(mocks.prisma.issue.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ state: "closed" }) }),
      );
    });
  });

  describe("grooming freshness (#1064)", () => {
    function issueUpdateData(): Record<string, unknown> {
      const call = mocks.prisma.issue.update.mock.calls.at(-1);
      expect(call).toBeDefined();
      return call![0].data;
    }

    it("records the evidence baseline of an applied groom, and clears staleness", async () => {
      await runHostedGroomer();
      const data = issueUpdateData();
      expect(data).toMatchObject({
        groomedRunId: "gr-1",
        groomedHeadSha: "abc123",
        groomedDefaultBranch: "main",
        groomedEvidenceDigest: "digest",
        groomedEvidenceScope: "paths",
        groomedEvidencePaths: ["src/auth/login.ts"],
        groomingVerifiedSha: "abc123",
        groomingStaleAt: null,
        groomingStaleReasons: [],
      });
      expect(data.groomedEvidenceCapturedAt).toBeInstanceOf(Date);
      // Expected post-apply state: live title/body plus the labels just written.
      expect(data.groomedIssueFingerprint).toBe(
        computeGroomingIssueFingerprint({
          title: mockEvidence.issue.title,
          body: mockEvidence.issue.body,
          state: "open",
          labels: ["priority/p0", "status/ready"],
        }),
      );
    });

    it("relies on the plan's cited read paths, not every path the run read", async () => {
      mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, toolLoopEnabled: true });
      mocks.exploreRepository.mockResolvedValue({ ...mockExploration, sources: ["src/x.ts"], readSources: ["src/x.ts"] });
      await runHostedGroomer();
      expect(issueUpdateData()).toMatchObject({ groomedEvidenceScope: "paths", groomedEvidencePaths: ["src/auth/login.ts"] });
    });

    it("treats a result citing a surfaced-only path as global evidence", async () => {
      mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, toolLoopEnabled: true });
      mocks.exploreRepository.mockResolvedValue({ ...mockExploration, sources: ["src/x.ts"], readSources: [] });
      mocks.callGroomerLLM.mockResolvedValue(notReadyDraft("backlog", { verdict: { evidenceRefs: ["repo:src/x.ts"] } }));
      await runHostedGroomer();
      expect(issueUpdateData()).toMatchObject({ groomedEvidenceScope: "global", groomedEvidencePaths: [] });
    });

    it("saves empty exploration search queries in the freshness baseline (#1091)", async () => {
      mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, toolLoopEnabled: true });
      mocks.exploreRepository.mockResolvedValue({
        ...mockExploration,
        sources: [],
        readSources: [],
        toolCalls: [
          { name: "search_code", arguments: { query: "missing symbol" }, ok: true, bytes: 0, preview: "No matches" },
          { name: "search_code", arguments: { query: "also missing" }, ok: true, bytes: 0, preview: "No matches" },
          { name: "search_code", arguments: { query: "found it" }, ok: true, bytes: 400, preview: "src/a.ts" },
        ],
      });
      await runHostedGroomer();
      expect(issueUpdateData()).toMatchObject({
        groomedEvidenceScope: "global",
        groomedSearchCodeQueries: ["missing symbol", "also missing"],
      });
    });

    it("saves the repository-context empty queries in the freshness baseline for a dispatcher-only run (#1115)", async () => {
      // Dispatcher-only: the repository context searched and came back empty,
      // and the exploration tool loop does not run, so the run read no files
      // and has no negative exploration search. With no read path the scope is
      // a no-read-path global, so the repository-context empty queries are the
      // saved, recheckable negative evidence.
      mocks.buildRepositoryContext.mockResolvedValue({
        text: "",
        sources: [],
        warnings: [],
        bytes: 0,
        queries: ["alpha", "beta"],
        emptyQueries: ["alpha", "beta"],
        files: [],
      });
      // No evidence source adds a repository read path: the snapshot carries
      // no sources, so the (not-ready) plan cites only the issue itself.
      mocks.collectGroomingEvidenceSnapshot.mockResolvedValue({ ...mockEvidence, sources: [] });
      mocks.callGroomerLLM.mockResolvedValue(notReadyDraft("backlog", { verdict: { evidenceRefs: ["issue"] } }));

      await runHostedGroomer();

      const data = issueUpdateData();
      expect(data).toMatchObject({
        groomedEvidenceScope: "global",
        groomedSearchCodeQueries: ["alpha", "beta"],
      });
    });

    it("does not record a baseline for a skipped in-flight run, leaving the prior one untouched", async () => {
      mocks.selectGroomingCandidate.mockResolvedValue({ ...mockCandidate, labels: ["status/in-progress", "priority/p0"] });
      await runHostedGroomer();
      expect(mocks.prisma.issue.update).toHaveBeenCalledTimes(1);
      const data = issueUpdateData();
      expect(Object.keys(data).sort()).toEqual(["groomedAt", "groomedBy"]);
    });

    it("records the open-blocker state of declared dependencies", async () => {
      mocks.collectGroomingEvidenceSnapshot.mockResolvedValue({
        ...mockEvidence,
        issue: { ...mockEvidence.issue, body: "Depends on #5 and #6." },
      });
      mocks.prisma.issue.findMany.mockResolvedValue([{ number: 5, repository: { fullName: "org/repo" } }]);
      await runHostedGroomer();
      expect(issueUpdateData()).toMatchObject({
        groomedDependencyKeys: ["org/repo#5", "org/repo#6"],
        groomedOpenBlockerKeys: ["org/repo#5"],
      });
    });

    it("falls back to unknown freshness when the baseline cannot be built, without failing the run", async () => {
      mocks.collectGroomingEvidenceSnapshot.mockResolvedValue({
        ...mockEvidence,
        issue: { ...mockEvidence.issue, body: "Depends on #5." },
      });
      mocks.prisma.issue.findMany.mockRejectedValue(new Error("db down"));
      const result = await runHostedGroomer();
      expect(result).not.toBeNull();
      expect(issueUpdateData()).toMatchObject({ groomedIssueFingerprint: null, groomingStaleAt: null });
    });

    it("does not record freshness for a dry run", async () => {
      mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, dryRun: true });
      await runHostedGroomer();
      expect(mocks.prisma.issue.update).not.toHaveBeenCalled();
    });

    it("records why a stale candidate was re-groomed on the GroomingRun", async () => {
      mocks.selectGroomingCandidate.mockResolvedValue({
        ...mockCandidate,
        selectionReason: "stale",
        staleReasons: ["human_comment"],
      });
      await runHostedGroomer();
      expect(mocks.prisma.groomingRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ candidateSource: "stale", staleReasons: ["human_comment"] }),
        }),
      );
    });
  });

  describe("apply-time validation and idempotent application (dispatch#1063)", () => {
    const liveEvidence = (patch: Partial<GroomingEvidenceSnapshot> = {}, issue: Partial<GroomingEvidenceSnapshot["issue"]> = {}) => ({
      ...mockEvidence,
      ...patch,
      issue: { ...mockEvidence.issue, ...issue },
    });

    /** The first capture is the snapshot; the second is the apply-time re-read. */
    function liveStateChangesTo(patch: Partial<GroomingEvidenceSnapshot>, issue: Partial<GroomingEvidenceSnapshot["issue"]> = {}) {
      mocks.collectGroomingEvidenceSnapshot
        .mockResolvedValueOnce(liveEvidence())
        .mockResolvedValueOnce(liveEvidence(patch, issue));
    }

    function expectNoGitHubWrites() {
      expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
      expect(mocks.addIssueComment).not.toHaveBeenCalled();
      expect(mocks.updateIssueTitleAndBody).not.toHaveBeenCalled();
      expect(mocks.closeIssue).not.toHaveBeenCalled();
    }

    function completedRun(): Record<string, any> {
      const call = mocks.prisma.groomingRun.update.mock.calls.findLast((c) => "completedAt" in c[0].data);
      expect(call).toBeDefined();
      return call![0].data;
    }

    const withComment = planDraft({ mutations: { githubComment: "Ready: login.ts drops the return URL." } });

    it("applies zero mutations when the issue is edited just before apply, and records which precondition changed", async () => {
      mocks.callGroomerLLM.mockResolvedValue(withComment);
      liveStateChangesTo({}, { body: "Actually, this only happens on Safari." });

      const result = await runHostedGroomer();

      expectNoGitHubWrites();
      expect(mocks.prisma.issue.update).not.toHaveBeenCalled();
      expect(mocks.prisma.issueLane.create).not.toHaveBeenCalled();
      expect(result!.appliedMutations).toMatchObject({ outcome: "stale" });
      expect(completedRun()).toMatchObject({
        status: "stale",
        stage: "validated",
        retryable: true,
        applyOutcome: "stale",
        preconditionFailures: ["issue: issue changed since the evidence snapshot: body"],
        errorMessage: expect.stringContaining("Apply preconditions failed"),
      });
      expect(completedRun().preconditions.checks).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "issue", status: "changed" })]),
      );
    });

    it("applies zero mutations when a claim lands between analysis and apply", async () => {
      liveStateChangesTo({}, { labels: ["agent/coder", "priority/p0", "status/in-progress"] });
      await runHostedGroomer();
      expectNoGitHubWrites();
      expect(completedRun().preconditionFailures[0]).toMatch(/^issue: .*labels \(\+agent\/coder \+status\/in-progress\)/);
    });

    it("applies zero mutations when the branch head moves under the plan's evidence", async () => {
      liveStateChangesTo({ headSha: "def456", pinnedRef: "def456" });
      mocks.compareCommits.mockResolvedValue({ ok: true, status: "ahead", files: ["src/auth/login.ts"], truncated: false });

      await runHostedGroomer();

      expect(mocks.compareCommits).toHaveBeenCalledWith("org/repo", "abc123", "def456");
      expectNoGitHubWrites();
      expect(completedRun()).toMatchObject({ status: "stale" });
      expect(completedRun().preconditionFailures).toEqual([
        "head: head moved abc123...def456 and touched src/auth/login.ts",
      ]);
    });

    it("applies when the head moved without touching the plan's evidence, and records it as verified at the new head", async () => {
      liveStateChangesTo({ headSha: "def456", pinnedRef: "def456" });
      mocks.compareCommits.mockResolvedValue({ ok: true, status: "ahead", files: ["docs/README.md"], truncated: false });

      await runHostedGroomer();

      expect(mocks.updateIssueLabels).toHaveBeenCalled();
      const data = mocks.prisma.issue.update.mock.calls.at(-1)![0].data;
      expect(data).toMatchObject({ groomedHeadSha: "abc123", groomingVerifiedSha: "def456" });
    });

    it("applies zero mutations when the head cannot be re-read", async () => {
      liveStateChangesTo({ headSha: null, pinnedRef: null, warnings: ["evidence: failed to resolve default-branch head SHA: 500"] });
      await runHostedGroomer();
      expectNoGitHubWrites();
      expect(completedRun().preconditionFailures[0]).toMatch(/^head: .*500/);
      expect(completedRun()).toMatchObject({ status: "unverifiable" });
    });

    it("applies zero mutations when a human comments after the evidence was captured", async () => {
      mocks.fetchIssueComments.mockImplementation(async (_repo: string, _n: number, _max?: number, direction?: string) =>
        direction === "desc" ? [{ id: 5, author: "alice", body: "Wait, not yet.", createdAt: new Date(Date.now() + 1000).toISOString() }] : [],
      );
      await runHostedGroomer();
      expectNoGitHubWrites();
      expect(completedRun().preconditionFailures[0]).toMatch(/^comments: new comment by alice/);
    });

    it("never applies a plan built on a snapshot that did not capture the issue, skips the model, and backs off", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, toolLoopEnabled: true, repoContextEnabled: true });
      mocks.collectGroomingEvidenceSnapshot.mockRejectedValueOnce(new Error("boom"));
      mocks.callGroomerLLM.mockResolvedValue(notReadyDraft("backlog", { verdict: { evidenceRefs: [] } }));
      const before = Date.now();
      await runHostedGroomer();
      warnSpy.mockRestore();
      expectNoGitHubWrites();
      expect(mocks.callGroomerLLM).not.toHaveBeenCalled();
      expect(mocks.exploreRepository).not.toHaveBeenCalled();
      expect(mocks.buildRepositoryContext).not.toHaveBeenCalled();
      expect(completedRun()).toMatchObject({ status: "unverifiable", applyOutcome: "unverifiable", retryable: true });
      expect(completedRun().preconditionFailures[0]).toMatch(/^issue: the evidence snapshot did not capture the live issue/);
      // Only the backoff is written: no grooming fields, cooldown stamp or baseline.
      expect(mocks.prisma.issue.update).toHaveBeenCalledTimes(1);
      const data = mocks.prisma.issue.update.mock.calls[0][0].data;
      expect(Object.keys(data)).toEqual(["groomingRetryAfter"]);
      expect((data.groomingRetryAfter as Date).getTime() - before).toBeGreaterThanOrEqual(59 * 60 * 1000);
      expect((data.groomingRetryAfter as Date).getTime() - Date.now()).toBeLessThanOrEqual(UNVERIFIABLE_RETRY_BACKOFF_MINUTES * 60 * 1000);
    });

    it("a dry run on an uncaptured snapshot skips the model but writes no backoff", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, dryRun: true });
      mocks.collectGroomingEvidenceSnapshot.mockRejectedValueOnce(new Error("boom"));
      await runHostedGroomer();
      warnSpy.mockRestore();
      expect(mocks.callGroomerLLM).not.toHaveBeenCalled();
      expect(mocks.prisma.issue.update).not.toHaveBeenCalled();
    });

    it("backs off an issue whose live state cannot be re-read at apply time", async () => {
      liveStateChangesTo({}, { state: "unknown" });
      const before = Date.now();
      const result = await runHostedGroomer();
      expectNoGitHubWrites();
      expect(result!.appliedMutations).toMatchObject({ outcome: "unverifiable", retryAfter: expect.any(String) });
      expect(completedRun()).toMatchObject({ status: "unverifiable", applyOutcome: "unverifiable", retryable: true });
      expect(mocks.prisma.issue.update).toHaveBeenCalledTimes(1);
      const data = mocks.prisma.issue.update.mock.calls[0][0].data;
      expect(Object.keys(data)).toEqual(["groomingRetryAfter"]);
      expect((data.groomingRetryAfter as Date).getTime() - before).toBeGreaterThanOrEqual(59 * 60 * 1000);
      expect((data.groomingRetryAfter as Date).getTime() - Date.now()).toBeLessThanOrEqual(UNVERIFIABLE_RETRY_BACKOFF_MINUTES * 60 * 1000);
    });

    it("still records the unverifiable run when the backoff itself cannot be written", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      liveStateChangesTo({}, { state: "unknown" });
      mocks.prisma.issue.update.mockRejectedValueOnce(new Error("db blip"));
      const result = await runHostedGroomer();
      warnSpy.mockRestore();
      expect(result!.appliedMutations).toMatchObject({ outcome: "unverifiable", retryAfterError: "the retry backoff could not be recorded" });
      expect(JSON.stringify(completedRun())).not.toContain("db blip");
      expect(completedRun()).toMatchObject({ status: "unverifiable", applyOutcome: "unverifiable" });
    });

    it("a dry run whose apply-time read is unverifiable reports it without writing a backoff", async () => {
      mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, dryRun: true });
      liveStateChangesTo({}, { state: "unknown" });
      const result = await runHostedGroomer();
      expect(result!.mutationPlan).toMatchObject({ applyOutcome: "unverifiable", preconditions: { ok: false } });
      expect(completedRun()).toMatchObject({ status: "dry_run_completed", applyOutcome: "unverifiable" });
      expect(mocks.prisma.issue.update).not.toHaveBeenCalled();
    });

    it("explains an uncaptured snapshot only from the issue-fetch warning, bounded", () => {
      expect(
        captureFailureReason([
          "evidence: default-branch head SHA unavailable for org/repo@main; repository reads are unpinned for this run",
          "evidence: failed to fetch live issue state: 404 Not Found",
        ]),
      ).toBe("evidence: failed to fetch live issue state: 404 Not Found");
      expect(captureFailureReason(["evidence: snapshot collection failed"])).toBe("evidence: snapshot collection failed");
      expect(captureFailureReason(["some unrelated issue warning"])).toBe("the live issue could not be read");
      expect(captureFailureReason([`evidence: failed to fetch live issue state: ${"x".repeat(1000)}`])).toHaveLength(300);
    });

    it("backs off when a check is unverifiable even if another one also changed", async () => {
      liveStateChangesTo({ headSha: null, pinnedRef: null }, { body: "edited" });
      await runHostedGroomer();
      expect(completedRun()).toMatchObject({ status: "unverifiable" });
      expect(mocks.prisma.issue.update.mock.calls[0][0].data).toHaveProperty("groomingRetryAfter");
    });

    it("clears any earlier backoff once a groom applies", async () => {
      await runHostedGroomer();
      expect(mocks.prisma.issue.update.mock.calls.at(-1)![0].data).toMatchObject({ groomingRetryAfter: null });
    });

    it("keeps the issue eligible for a fresh groom after a stale abort", async () => {
      liveStateChangesTo({}, { title: "Retitled by a human" });
      await runHostedGroomer();
      // No grooming field, cooldown stamp, backoff or freshness baseline is
      // written: a changed issue is re-groomed promptly on the new evidence.
      expect(completedRun()).toMatchObject({ status: "stale", applyOutcome: "stale" });
      expect(mocks.prisma.issue.update).not.toHaveBeenCalled();
      expect(mocks.prisma.agentRun.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ summary: "No mutations applied: preconditions failed (issue)" }) }),
      );
    });

    it("an exact retry after the comment, body and status writes is a replay: one comment, one label write", async () => {
      mocks.selectGroomingCandidate.mockResolvedValue({ ...mockCandidate, body: "Broken." });
      mocks.callGroomerLLM.mockResolvedValue(
        planDraft({ mutations: { githubComment: "Ready.", proposedBody: "## Context\nlogin.ts drops returnTo." } }),
      );
      let run = 0;
      mocks.prisma.groomingRun.create.mockImplementation(async () => ({ id: `gr-${++run}`, stage: "selected" }));

      const first = await runHostedGroomer();
      const second = await runHostedGroomer();

      expect(first!.appliedMutations).toMatchObject({ outcome: "applied" });
      expect(second!.appliedMutations).toMatchObject({ outcome: "replayed", claimedByRunId: "gr-1" });
      expect(mocks.addIssueComment).toHaveBeenCalledTimes(1);
      expect(mocks.updateIssueLabels).toHaveBeenCalledTimes(1);
      expect(mocks.updateIssueTitleAndBody).toHaveBeenCalledTimes(1);
      // The replay writes no lane history and only the local cooldown stamp.
      expect(mocks.prisma.issueLane.create).toHaveBeenCalledTimes(1);
      expect(Object.keys(mocks.prisma.issue.update.mock.calls.at(-1)![0].data).sort()).toEqual([
        "groomedAt",
        "groomedBy",
        "groomingRetryAfter",
      ]);
      expect(first!.mutationPlan!.applicationKey).toBe(second!.mutationPlan!.applicationKey);
    });

    it("a partial failure then an exact retry completes the application without repeating what landed", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.callGroomerLLM.mockResolvedValue(withComment);
      mocks.addIssueComment.mockRejectedValue(new Error("GitHub API error adding comment: 504"));

      const first = await runHostedGroomer();
      expect(first!.appliedMutations).toMatchObject({ outcome: "partial", commentPosted: false });
      expect(completedRun()).toMatchObject({ status: "partial", retryable: true, applyOutcome: "partial" });

      mocks.addIssueComment.mockReset();
      mocks.addIssueComment.mockResolvedValue({ url: "https://github.com/org/repo/issues/42#issuecomment-7" });
      const second = await runHostedGroomer();
      errSpy.mockRestore();

      expect(second!.appliedMutations).toMatchObject({ outcome: "applied", commentUrl: "https://github.com/org/repo/issues/42#issuecomment-7" });
      expect((second!.appliedMutations!.steps as Record<string, { status: string }>).labels.status).toBe("replayed");
      expect(mocks.updateIssueLabels).toHaveBeenCalledTimes(1);
      expect(mocks.addIssueComment).toHaveBeenCalledTimes(1);
    });

    it("a retry after a partial failure against fresh evidence diffs from current state: no label thrash, one comment", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.callGroomerLLM.mockResolvedValue(withComment);
      mocks.addIssueComment.mockRejectedValueOnce(new Error("504")).mockRejectedValueOnce(new Error("504"));
      await runHostedGroomer();
      const written = mocks.updateIssueLabels.mock.calls[0][2] as string[];

      // The next groom sees the labels the first one wrote: new evidence, so
      // a new evidence digest and a new application key.
      mocks.selectGroomingCandidate.mockResolvedValue({ ...mockCandidate, labels: written });
      mocks.collectGroomingEvidenceSnapshot.mockResolvedValue(
        liveEvidence({ evidenceDigest: "digest-after-labels" }, { labels: [...written].sort() }),
      );
      mocks.addIssueComment.mockResolvedValue({ url: "u" });
      const second = await runHostedGroomer();
      errSpy.mockRestore();

      expect(mocks.updateIssueLabels).toHaveBeenCalledTimes(1);
      expect((second!.appliedMutations!.steps as Record<string, { status: string }>).labels.status).toBe("noop");
      expect(mocks.addIssueComment).toHaveBeenCalledTimes(3);
      expect(second!.appliedMutations).toMatchObject({ outcome: "applied", commentUrl: "u" });
      // The retry's preconditions are checked against its own snapshot, which
      // already includes the first attempt's writes: it is not stale, and
      // nothing misreports those writes as an external change.
      expect(second!.mutationPlan!.preconditions).toMatchObject({ ok: true });
      expect(completedRun()).toMatchObject({ status: "completed", preconditionFailures: [] });
    });

    it("a low-impact failure prevents the destructive step: no close after a failed comment", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.addIssueComment.mockRejectedValue(new Error("GitHub API error adding comment: 504"));
      mocks.callGroomerLLM.mockResolvedValue(
        notReadyDraft("already_done", {
          verdict: { lane: { id: "backlog", confidence: "high", reason: "gone" } },
          mutations: {
            githubComment: "Closing: already fixed on main.",
            close: { reason: "already_done", rationale: "login.ts keeps returnTo", evidenceRefs: ["repo:src/auth/login.ts"], criteria: GROUNDED_CRITERIA },
          },
        }),
      );

      // The pre-close labels already match, so the comment is the first
      // write; it failed and nothing landed, so the run fails (retryable).
      await expect(runHostedGroomer()).rejects.toThrow(/Grooming mutation failed at comment/);
      errSpy.mockRestore();

      expect(mocks.closeIssue).not.toHaveBeenCalled();
      // status/done is never written for an issue left open.
      expect(mocks.updateIssueLabels).not.toHaveBeenCalled();
      expect(mocks.prisma.issue.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ state: "closed" }) }),
      );
    });

    it("a failed label write fails the run with nothing else attempted", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.updateIssueLabels.mockRejectedValue(new Error("GitHub API error: 422"));
      mocks.callGroomerLLM.mockResolvedValue(withComment);

      await expect(runHostedGroomer()).rejects.toThrow(/Grooming mutation failed at labels: GitHub API error: 422/);
      errSpy.mockRestore();

      expect(mocks.addIssueComment).not.toHaveBeenCalled();
      expect(mocks.prisma.groomingRun.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ applyOutcome: "failed", appliedMutations: expect.objectContaining({ outcome: "failed" }) }) }),
      );
      expect(completedRun()).toMatchObject({ status: "failed", retryable: true });
    });

    it("does nothing while another run holds a fresh unfinished claim on the same application", async () => {
      mocks.callGroomerLLM.mockResolvedValue(withComment);
      // Learn this plan's key from a dry run, then plant a live claim on it.
      mocks.getHostedGroomerConfig.mockReturnValueOnce({ ...mockConfig, dryRun: true });
      const dry = await runHostedGroomer();
      const key = dry!.mutationPlan!.applicationKey as string;
      mocks.applications.set(key, {
        applicationKey: key,
        groomingRunId: "gr-other",
        status: "in_progress",
        steps: {},
        attempts: 1,
        updatedAt: new Date(),
      });

      const result = await runHostedGroomer();

      expectNoGitHubWrites();
      expect(result!.appliedMutations).toMatchObject({ outcome: "busy", claimedByRunId: "gr-other" });
      expect(mocks.prisma.issue.update).not.toHaveBeenCalled();
      expect(completedRun()).toMatchObject({ status: "completed", stage: "skipped", applyOutcome: "busy", retryable: true });
    });

    it("does not let a forged marker in someone else's comment suppress the groomer's comment", async () => {
      mocks.callGroomerLLM.mockResolvedValue(withComment);
      mocks.fetchIssueComments.mockImplementation(async (_repo: string, _n: number, _max?: number, direction?: string) =>
        direction === "desc"
          ? [
              {
                id: 9,
                author: "mallory",
                body: `nothing to see\n\n<!-- dispatch-groomer:apply=${"f".repeat(64)} -->`,
                createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
              },
            ]
          : [],
      );
      await runHostedGroomer();
      expect(mocks.addIssueComment).toHaveBeenCalledTimes(1);
    });

    describe("close gating", () => {
      const close = (evidenceRefs: string[], confidence: "high" | "medium" = "high") =>
        notReadyDraft("already_done", {
          verdict: { confidence, lane: { id: "backlog", confidence: "high", reason: "gone" } },
          mutations: { githubComment: "Closing.", close: { reason: "already_done", rationale: "fixed", evidenceRefs, criteria: GROUNDED_CRITERIA } },
        });

      it("rejects a medium-confidence already_done: nothing is closed or written", async () => {
        mocks.callGroomerLLM.mockResolvedValue(close(["repo:src/auth/login.ts"], "medium"));
        await expect(runHostedGroomer()).rejects.toThrow(/already_done closes the issue, which requires high confidence/);
        expectNoGitHubWrites();
      });

      it("rejects an already_done close without current-revision evidence", async () => {
        mocks.collectGroomingEvidenceSnapshot.mockResolvedValue({
          ...mockEvidence,
          comments: [{ id: "c1", author: "alice", createdAt: "2026-09-20T00:00:00Z", body: "fixed", provenance: "human_comment", authoritative: true }],
        });
        mocks.callGroomerLLM.mockResolvedValue(close(["comment:c1"]));
        await expect(runHostedGroomer()).rejects.toThrow(/already_done must cite pinned repository evidence/);
        expectNoGitHubWrites();
      });

      it("closes on high-confidence pinned evidence, only after the comment, then lands status/done", async () => {
        mocks.callGroomerLLM.mockResolvedValue(close(["repo:src/auth/login.ts"]));
        const order: string[] = [];
        mocks.addIssueComment.mockImplementation(async () => {
          order.push("comment");
          return { url: null };
        });
        mocks.closeIssue.mockImplementation(async () => {
          order.push("close");
        });
        mocks.updateIssueLabels.mockImplementation(async (_r: string, _n: number, labels: string[]) => {
          order.push(`labels:${labels.join(",")}`);
        });
        await runHostedGroomer();
        expect(order).toEqual(["comment", "close", "labels:priority/p0,status/done"]);
      });
    });

    describe("dry-run parity", () => {
      beforeEach(() => {
        mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, dryRun: true });
      });

      it("runs the same preconditions and records a stale plan without writing", async () => {
        liveStateChangesTo({}, { title: "Retitled" });
        const result = await runHostedGroomer();
        expectNoGitHubWrites();
        expect(result!.mutationPlan).toMatchObject({ applyOutcome: "stale", preconditions: { ok: false } });
        expect(completedRun()).toMatchObject({
          status: "dry_run_completed",
          applyOutcome: "stale",
          preconditionFailures: ["issue: issue changed since the evidence snapshot: title"],
        });
        expect(mocks.prisma.groomingApplication.create).not.toHaveBeenCalled();
      });

      it("reports the application key and whether it would replay, without claiming it", async () => {
        const first = await runHostedGroomer();
        expect(first!.mutationPlan).toMatchObject({ applyOutcome: "dry_run", preconditions: { ok: true } });

        mocks.getHostedGroomerConfig.mockReturnValue(mockConfig);
        await runHostedGroomer();
        mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, dryRun: true });
        const third = await runHostedGroomer();

        expect(third!.mutationPlan).toMatchObject({ applyOutcome: "would_replay", applicationKey: first!.mutationPlan!.applicationKey });
        expect(mocks.prisma.groomingApplication.create).toHaveBeenCalledTimes(1);
      });
    });

    describe("in-flight skip (dispatch#1090) is unchanged", () => {
      it("skips when only the live snapshot shows the claim (Dispatch's cache has not synced it)", async () => {
        mocks.collectGroomingEvidenceSnapshot.mockResolvedValue(liveEvidence({}, { labels: ["priority/p0", "status/in-progress"] }));
        const result = await runHostedGroomer();
        expectNoGitHubWrites();
        expect(result!.mutationPlan).toMatchObject({ skippedReason: "in_flight_status", inFlightStatus: "status/in-progress" });
        expect(completedRun()).toMatchObject({ status: "completed", stage: "skipped" });
        expect(mocks.prisma.groomingApplication.create).not.toHaveBeenCalled();
      });

      it("does not run apply preconditions for an in-flight issue", async () => {
        mocks.selectGroomingCandidate.mockResolvedValue({ ...mockCandidate, labels: ["status/in-review", "priority/p0"] });
        await runHostedGroomer();
        expect(mocks.collectGroomingEvidenceSnapshot).toHaveBeenCalledTimes(1);
      });
    });

    describe("decomposition child creation (dispatch#1066)", () => {
      const childBrief = (n: number) => ({
        title: `Bounded child ${n}`,
        problem: `Child ${n} problem, as its own bounded change.`,
        designDecision: null,
        verifiedCurrentBehavior: null,
        relevantPaths: [],
        inScope: [`child ${n}`],
        outOfScope: [],
        dependencies: [],
        acceptanceCriteria: [`Child ${n} works end to end`],
        tests: [],
      });

      /** A non-ready (backlog) verdict that splits the issue into `count` bounded children. */
      const decomposingDraft = (count: number) =>
        notReadyDraft("backlog", {
          decomposition: {
            required: true,
            reason: "the issue spans several independent areas",
            childBriefs: Array.from({ length: count }, (_, i) => childBrief(i + 1)),
          },
        });

      it("creates one bounded child per brief, decorates the parent as an umbrella, and records the decomposition", async () => {
        mocks.callGroomerLLM.mockResolvedValue(decomposingDraft(2));
        const result = await runHostedGroomer();

        expect(result!.appliedMutations).toMatchObject({ outcome: "applied" });
        expect(mocks.createIssue).toHaveBeenCalledTimes(2);
        // Each child lands as a backlog issue (not worker-ready).
        expect(mocks.createIssue).toHaveBeenCalledWith(
          "org/repo",
          expect.objectContaining({ labels: ["status/backlog"] }),
        );
        // The umbrella is an additive write by the children step, not part of the labels write.
        expect(mocks.updateIssueLabels).toHaveBeenCalledTimes(1);
        expect(mocks.updateIssueLabels).toHaveBeenCalledWith("org/repo", 42, expect.not.arrayContaining(["umbrella"]));
        expect(mocks.addIssueLabel).toHaveBeenCalledTimes(1);
        expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "umbrella");
        // The parent's decomposition state is persisted with the child URLs as follow-ups.
        expect(mocks.prisma.issue.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ decomposed: true, followUpUrls: expect.any(Array) }),
          }),
        );
        expect(mocks.prisma.auditLog.create).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ action: "issue_decomposed" }) }),
        );
        // The run records the created child links, in brief order.
        expect(result!.appliedMutations!.childrenCreated).toHaveLength(2);
      });

      it("an exact retry is a replay: it creates no new child and re-surfaces the created links", async () => {
        mocks.callGroomerLLM.mockResolvedValue(decomposingDraft(2));

        const first = await runHostedGroomer();
        const second = await runHostedGroomer();

        expect(first!.appliedMutations).toMatchObject({ outcome: "applied" });
        expect(second!.appliedMutations).toMatchObject({ outcome: "replayed" });
        // Only the first attempt created the children; the replay re-surfaces them.
        expect(mocks.createIssue).toHaveBeenCalledTimes(2);
        expect(first!.appliedMutations!.childrenCreated).toHaveLength(2);
        expect(second!.appliedMutations!.childrenCreated).toHaveLength(2);
        // The umbrella is added once, on the first attempt; the replay adds none.
        expect(mocks.addIssueLabel).toHaveBeenCalledTimes(1);
        expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "umbrella");
        // Same application key, so the replay is attributable to the first run.
        expect(first!.mutationPlan!.applicationKey).toBe(second!.mutationPlan!.applicationKey);
      });

      it("a child-creation failure is a partial, retryable run; the retry reuses the landed child and creates only the missing ones", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        mocks.callGroomerLLM.mockResolvedValue(decomposingDraft(3));
        let createCalls = 0;
        mocks.createIssue.mockImplementation(async () => {
          createCalls += 1;
          if (createCalls === 2) throw new Error("GitHub API error creating issue: 502");
          const number = createCalls + 1000;
          return { number, html_url: `https://github.com/org/repo/issues/${number}` };
        });

        const first = await runHostedGroomer();
        expect(first!.appliedMutations).toMatchObject({ outcome: "partial" });
        expect(first!.appliedMutations!.childrenError).toMatch(/502/);
        // A partial decomposition never lands the umbrella.
        expect(mocks.addIssueLabel).not.toHaveBeenCalled();

        // The retry: the failing creation now succeeds.
        mocks.createIssue.mockImplementation(async () => {
          createCalls += 1;
          const number = createCalls + 1000;
          return { number, html_url: `https://github.com/org/repo/issues/${number}` };
        });
        const second = await runHostedGroomer();
        errSpy.mockRestore();

        expect(second!.appliedMutations).toMatchObject({ outcome: "applied" });
        // The child that landed before the failure is reused; only the missing ones are created.
        expect(second!.appliedMutations!.childrenCreated).toHaveLength(2);
        expect(second!.appliedMutations!.childrenReused).toHaveLength(1);
        // The umbrella lands once the decomposition fully converges.
        expect(mocks.addIssueLabel).toHaveBeenCalledTimes(1);
        expect(mocks.addIssueLabel).toHaveBeenCalledWith("org/repo", 42, "umbrella");
        // One claim per distinct child, across both attempts (idempotent child identity).
        expect(mocks.prisma.groomingChildClaim.create).toHaveBeenCalledTimes(3);
      });

      it("creates no children when the split is withheld for low confidence", async () => {
        mocks.callGroomerLLM.mockResolvedValue(
          notReadyDraft("backlog", {
            verdict: { confidence: "low" },
            decomposition: { required: true, reason: "split it", childBriefs: [childBrief(1)] },
          }),
        );
        const result = await runHostedGroomer();

        expect(result!.appliedMutations).toMatchObject({ outcome: "applied" });
        expect(result!.appliedMutations!.withheld).toMatchObject({ decomposition: expect.any(Array) });
        expect(mocks.createIssue).not.toHaveBeenCalled();
        expect(mocks.addIssueLabel).not.toHaveBeenCalled();
        expect(mocks.prisma.groomingChildClaim.create).not.toHaveBeenCalled();
      });

      it("creates no children when a material uncertainty remains", async () => {
        mocks.callGroomerLLM.mockResolvedValue(
          notReadyDraft("backlog", {
            verdict: { uncertainties: [{ kind: "scope", question: "Which child owns the migration?", material: true }] },
            decomposition: { required: true, reason: "split it", childBriefs: [childBrief(1)] },
          }),
        );
        const result = await runHostedGroomer();

        expect(result!.appliedMutations).toMatchObject({ outcome: "applied" });
        expect(result!.appliedMutations!.withheld).toMatchObject({ decomposition: expect.any(Array) });
        expect(mocks.createIssue).not.toHaveBeenCalled();
        expect(mocks.addIssueLabel).not.toHaveBeenCalled();
        expect(mocks.prisma.groomingChildClaim.create).not.toHaveBeenCalled();
      });
    });

    it("strips a status the groomer does not own, so the derived status is the only one", async () => {
      mocks.selectGroomingCandidate.mockResolvedValue({ ...mockCandidate, labels: ["priority/p0", "status/needs-review"] });
      mocks.callGroomerLLM.mockResolvedValue(notReadyDraft("backlog"));
      await runHostedGroomer();
      const written = mocks.updateIssueLabels.mock.calls[0][2] as string[];
      expect(written.filter((l) => l.startsWith("status/"))).toEqual(["status/backlog"]);
    });
  });

  describe("backoff after a failed run (dispatch#1125)", () => {
    const MINUTE = 60 * 1000;

    function backoffWrites(): Array<Record<string, unknown>> {
      return mocks.prisma.issue.update.mock.calls
        .map((c) => c[0].data as Record<string, unknown>)
        .filter((data) => "groomingRetryAfter" in data);
    }

    /** The backoff written by the run, in minutes from now (rounded). */
    function backoffMinutes(): number {
      const writes = backoffWrites();
      expect(writes).toHaveLength(1);
      return Math.round(((writes[0].groomingRetryAfter as Date).getTime() - Date.now()) / MINUTE);
    }

    /**
     * Earlier runs for the issue, newest first. The mock applies the query's
     * status filter and take, as the database would.
     */
    function history(...statuses: string[]) {
      mocks.prisma.groomingRun.findMany.mockImplementation(
        async ({ where, take }: { where: { status?: { not?: string } }; take?: number }) =>
          statuses
            .filter((status) => status !== where.status?.not)
            .slice(0, take)
            .map((status) => ({ status })),
      );
    }

    /** The data the run was completed with. */
    function completedRun(): Record<string, any> {
      const call = mocks.prisma.groomingRun.update.mock.calls.findLast((c) => "completedAt" in c[0].data);
      expect(call).toBeDefined();
      return call![0].data;
    }

    it("backs the issue off after an LLM timeout, writing only the backoff", async () => {
      mocks.callGroomerLLM.mockRejectedValue(new Error("LLM timeout"));
      await expect(runHostedGroomer()).rejects.toThrow(/LLM timeout/);

      expect(mocks.prisma.issue.update).toHaveBeenCalledTimes(1);
      expect(Object.keys(mocks.prisma.issue.update.mock.calls[0][0].data)).toEqual(["groomingRetryAfter"]);
      expect(mocks.prisma.issue.update.mock.calls[0][0].where).toEqual({ id: "issue-42" });
      expect(backoffMinutes()).toBe(30);
      // The streak is read from this issue's earlier write-mode runs.
      expect(mocks.prisma.groomingRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { issueId: "issue-42", dryRun: false, id: { not: "gr-1" }, status: { not: "running" } },
          orderBy: { createdAt: "desc" },
          take: FAILED_RUN_PRIOR_FAILURES_TO_CAP,
        }),
      );
    });

    it("backs the issue off when the plan fails validation or the output is unparseable", async () => {
      mocks.callGroomerLLM.mockResolvedValue(planDraft({ verdict: { lane: { id: "gpu", confidence: "high", reason: "r" } } }));
      await expect(runHostedGroomer()).rejects.toThrow(/Groomer output validation failed/);
      expect(backoffMinutes()).toBe(30);

      mocks.prisma.issue.update.mockClear();
      mocks.callGroomerLLM.mockRejectedValue(new Error("Failed to parse LLM response as JSON: {oops"));
      await expect(runHostedGroomer()).rejects.toThrow(/Failed to parse LLM response as JSON/);
      expect(backoffMinutes()).toBe(30);
    });

    it("lengthens the backoff with each consecutive failure, up to the cap", async () => {
      mocks.callGroomerLLM.mockRejectedValue(new Error("LLM timeout"));
      const cases: Array<[string[], number]> = [
        [[], 30],
        [["failed"], 60],
        [["failed", "failed"], 120],
        [["failed", "failed", "failed"], 240],
        [Array(9).fill("failed"), FAILED_RUN_BACKOFF_MAX_MINUTES],
      ];
      for (const [statuses, minutes] of cases) {
        mocks.prisma.issue.update.mockClear();
        history(...statuses);
        await expect(runHostedGroomer()).rejects.toThrow(/LLM timeout/);
        expect(backoffMinutes()).toBe(minutes);
      }
    });

    it("restarts the streak after any non-failed outcome, and ignores runs interrupted mid-flight", async () => {
      mocks.callGroomerLLM.mockRejectedValue(new Error("LLM timeout"));
      history("completed", "failed", "failed", "failed");
      await expect(runHostedGroomer()).rejects.toThrow(/LLM timeout/);
      expect(backoffMinutes()).toBe(30);

      mocks.prisma.issue.update.mockClear();
      history("running", "failed", "partial", "failed");
      await expect(runHostedGroomer()).rejects.toThrow(/LLM timeout/);
      expect(backoffMinutes()).toBe(60);

      mocks.prisma.issue.update.mockClear();
      history("failed", "running", "running", "unverifiable", "failed", "failed");
      await expect(runHostedGroomer()).rejects.toThrow(/LLM timeout/);
      expect(backoffMinutes()).toBe(60);
    });

    it("does not let interrupted runs truncate the streak (more than 10 raw rows)", async () => {
      mocks.callGroomerLLM.mockRejectedValue(new Error("LLM timeout"));
      const interrupted = Array(4).fill("running");
      history(...interrupted, "failed", ...interrupted, "failed", ...interrupted, "failed", "completed");
      await expect(runHostedGroomer()).rejects.toThrow(/LLM timeout/);
      // The fourth consecutive failure once interrupted runs are skipped: the cap.
      expect(backoffMinutes()).toBe(FAILED_RUN_BACKOFF_MAX_MINUTES);
      const query = mocks.prisma.groomingRun.findMany.mock.calls[0][0];
      expect(query.where.status).toEqual({ not: "running" });
    });

    it("clears the backoff once a later groom applies", async () => {
      mocks.callGroomerLLM.mockRejectedValueOnce(new Error("LLM timeout"));
      await expect(runHostedGroomer()).rejects.toThrow(/LLM timeout/);
      expect(backoffMinutes()).toBe(30);

      mocks.prisma.issue.update.mockClear();
      await runHostedGroomer();
      expect(mocks.prisma.issue.update.mock.calls.at(-1)![0].data).toMatchObject({ groomingRetryAfter: null });
    });

    it("backs off a failure in any stage, and records the stage it failed in", async () => {
      // Repository context, before anything is recorded past selection.
      mocks.buildRepositoryContext.mockRejectedValueOnce(new Error("code search down"));
      await expect(runHostedGroomer()).rejects.toThrow(/code search down/);
      expect(backoffMinutes()).toBe(30);
      expect(completedRun()).toMatchObject({ status: "failed", stage: "selected" });

      // Exploration: a tool loop on the same model, which can time out too.
      mocks.prisma.issue.update.mockClear();
      mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, toolLoopEnabled: true });
      mocks.exploreRepository.mockRejectedValueOnce(new Error("exploration timed out"));
      await expect(runHostedGroomer()).rejects.toThrow(/exploration timed out/);
      expect(backoffMinutes()).toBe(30);
      expect(completedRun()).toMatchObject({ status: "failed", stage: "context_built" });

      // Apply: the first GitHub write did not land.
      mocks.prisma.issue.update.mockClear();
      mocks.getHostedGroomerConfig.mockReturnValue(mockConfig);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.updateIssueLabels.mockRejectedValue(new Error("GitHub API error: 422"));
      mocks.callGroomerLLM.mockResolvedValue(planDraft({ mutations: { githubComment: "Groomed." } }));
      await expect(runHostedGroomer()).rejects.toThrow(/Grooming mutation failed at labels/);
      errSpy.mockRestore();
      expect(backoffMinutes()).toBe(30);
      expect(completedRun()).toMatchObject({ status: "failed", stage: "validated" });
    });

    it("records the stage a validation failure happened in, not \"selected\"", async () => {
      mocks.callGroomerLLM.mockResolvedValue(planDraft({ verdict: { lane: { id: "gpu", confidence: "high", reason: "r" } } }));
      await expect(runHostedGroomer()).rejects.toThrow(/Groomer output validation failed/);
      expect(completedRun()).toMatchObject({ status: "failed", stage: "context_built" });

      mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, toolLoopEnabled: true });
      mocks.exploreRepository.mockResolvedValue(mockExploration);
      await expect(runHostedGroomer()).rejects.toThrow(/Groomer output validation failed/);
      expect(completedRun()).toMatchObject({ status: "failed", stage: "explored" });
    });

    it("keeps only the unreadable-issue backoff when that path then fails", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mocks.collectGroomingEvidenceSnapshot.mockRejectedValueOnce(new Error("boom"));
      mocks.prisma.agentRun.create.mockRejectedValueOnce(new Error("db blip"));
      await expect(runHostedGroomer()).rejects.toThrow(/db blip/);
      warnSpy.mockRestore();
      expect(backoffMinutes()).toBe(UNVERIFIABLE_RETRY_BACKOFF_MINUTES);
      expect(mocks.prisma.groomingRun.findMany).not.toHaveBeenCalled();
    });

    it("a dry run writes no backoff", async () => {
      mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, dryRun: true });
      mocks.callGroomerLLM.mockRejectedValue(new Error("LLM timeout"));
      await expect(runHostedGroomer()).rejects.toThrow(/LLM timeout/);
      mocks.buildRepositoryContext.mockRejectedValueOnce(new Error("code search down"));
      await expect(runHostedGroomer()).rejects.toThrow(/code search down/);
      expect(mocks.prisma.issue.update).not.toHaveBeenCalled();
    });

    it("still fails with the model error, recorded, when the backoff cannot be written", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mocks.callGroomerLLM.mockRejectedValue(new Error("LLM timeout"));
      mocks.prisma.issue.update.mockRejectedValueOnce(new Error("db blip"));
      await expect(runHostedGroomer()).rejects.toThrow(/LLM timeout/);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
      expect(mocks.prisma.agentRun.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "failed", errorMessage: "LLM timeout" }) }),
      );
      expect(mocks.prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ success: false, errorMessage: "LLM timeout" }) }),
      );
    });

    it("schedules 30m, 60m, 120m, then caps at 240m", () => {
      expect([1, 2, 3, 4, 5, 20].map(failedRunBackoffMinutes)).toEqual([30, 60, 120, 240, 240, 240]);
      // Reading this many prior outcomes is exactly enough to reach the cap.
      expect(FAILED_RUN_PRIOR_FAILURES_TO_CAP).toBe(3);
      expect(failedRunBackoffMinutes(FAILED_RUN_PRIOR_FAILURES_TO_CAP)).toBeLessThan(FAILED_RUN_BACKOFF_MAX_MINUTES);
      expect(failedRunBackoffMinutes(FAILED_RUN_PRIOR_FAILURES_TO_CAP + 1)).toBe(FAILED_RUN_BACKOFF_MAX_MINUTES);
    });
  });
});
