import { describe, expect, it, vi, beforeEach } from "vitest";
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
    prisma: {
      automationRepo: { findUnique: vi.fn() },
      groomingRun: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
      groomingApplication: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
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

import { runHostedGroomer } from "./run";
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
  toolCalls: [],
  bytes: 0,
  warnings: [],
  relatedWorkQueries: [],
  relatedWorkRefs: [],
  relatedWork: [],
};

describe("runHostedGroomer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectGroomingCandidate.mockResolvedValue(mockCandidate);
    mocks.fetchIssueComments.mockResolvedValue([]);
    mocks.buildIssueContext.mockResolvedValue("test context");
    mocks.getHostedGroomerConfig.mockReturnValue(mockConfig);
    mocks.callGroomerLLM.mockResolvedValue(mockOutput);
    mocks.updateIssueLabels.mockResolvedValue(undefined);
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
      async ({ where, data }: { where: { applicationKey: string; status: string }; data: Record<string, any> }) => {
        const row = mocks.applications.get(where.applicationKey);
        if (!row || row.status !== where.status) return { count: 0 };
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
        const contextBuiltCall = mocks.prisma.groomingRun.update.mock.calls.find(
          (call) => call[0]?.data?.stage === "context_built",
        );
        expect(contextBuiltCall![0].data).toMatchObject({
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
      expect(mocks.prisma.groomingRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rawOutput: raw,
            validationErrors: [expect.stringContaining('unknown evidence reference "repo:src/invented.ts"')],
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

    it("rejects a ready claim when the snapshot could not be captured", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mocks.collectGroomingEvidenceSnapshot.mockRejectedValue(new Error("boom"));

      // The fallback shell has no sources, so the repository refs a ready
      // plan needs are not even citable.
      await expect(runHostedGroomer()).rejects.toThrow(/unknown evidence reference "repo:src\/auth\/login.ts"/);
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
            mutations: { close: { reason: "already_done", rationale: "gone", evidenceRefs: ["repo:src/auth/login.ts"] } },
          }),
        );

        const result = await runHostedGroomer({ repoFullName: "org/repo", issueNumber: 42 });

        expect(mocks.selectGroomingCandidate).toHaveBeenCalledWith({ repoFullName: "org/repo", issueNumber: 42, freshnessBackfill: true });
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

  describe("already_done has an effect (dispatch#957)", () => {
    const alreadyDoneOutput = notReadyDraft("already_done", {
      verdict: {
        lane: { id: "backlog", confidence: "high", reason: "the step is already gone on main" },
        summary: "The Generate Token step no longer exists; closing as already resolved.",
      },
      mutations: {
        githubComment: "Verified on the default branch: the step is gone, so closing as already resolved.",
        close: { reason: "already_done", rationale: "login.ts no longer has the step", evidenceRefs: ["repo:src/auth/login.ts"] },
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
    });

    it("applies zero mutations when a human comments after the evidence was captured", async () => {
      mocks.fetchIssueComments.mockImplementation(async (_repo: string, _n: number, _max?: number, direction?: string) =>
        direction === "desc" ? [{ id: 5, author: "alice", body: "Wait, not yet.", createdAt: new Date(Date.now() + 1000).toISOString() }] : [],
      );
      await runHostedGroomer();
      expectNoGitHubWrites();
      expect(completedRun().preconditionFailures[0]).toMatch(/^comments: new comment by alice/);
    });

    it("never applies a plan built on a snapshot that did not capture the issue", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mocks.collectGroomingEvidenceSnapshot.mockRejectedValueOnce(new Error("boom"));
      mocks.callGroomerLLM.mockResolvedValue(notReadyDraft("backlog", { verdict: { evidenceRefs: [] } }));
      await runHostedGroomer();
      warnSpy.mockRestore();
      expectNoGitHubWrites();
      expect(completedRun().preconditionFailures[0]).toMatch(/^issue: the evidence snapshot did not capture the live issue/);
    });

    it("keeps the issue eligible for a fresh groom after a stale abort", async () => {
      liveStateChangesTo({}, { title: "Retitled by a human" });
      await runHostedGroomer();
      // No grooming field, cooldown stamp or freshness baseline is written.
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
      expect(Object.keys(mocks.prisma.issue.update.mock.calls.at(-1)![0].data).sort()).toEqual(["groomedAt", "groomedBy"]);
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
            close: { reason: "already_done", rationale: "login.ts keeps returnTo", evidenceRefs: ["repo:src/auth/login.ts"] },
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
          mutations: { githubComment: "Closing.", close: { reason: "already_done", rationale: "fixed", evidenceRefs } },
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

    it("strips a status the groomer does not own, so the derived status is the only one", async () => {
      mocks.selectGroomingCandidate.mockResolvedValue({ ...mockCandidate, labels: ["priority/p0", "status/needs-review"] });
      mocks.callGroomerLLM.mockResolvedValue(notReadyDraft("backlog"));
      await runHostedGroomer();
      const written = mocks.updateIssueLabels.mock.calls[0][2] as string[];
      expect(written.filter((l) => l.startsWith("status/"))).toEqual(["status/backlog"]);
    });
  });
});
