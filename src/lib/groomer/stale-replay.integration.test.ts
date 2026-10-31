/**
 * Replayed-application stale-mark clearing (#1472) against a real PostgreSQL.
 *
 * The mocked suite proves the replay's write carries the baseline columns; only
 * a real database proves the other half of the issue's acceptance criterion —
 * "no repeated selection" — because it is a where-clause property: the
 * selector reads `groomingStaleAt` from the row, and a mock of prisma cannot
 * evaluate that clause. The stale branch of the selector bypasses the
 * cooldown and the blocked/not-ready parking, so a mark that survives a
 * replayed application re-offers the row every stale floor, forever.
 *
 * Opt-in via RUN_DB_INTEGRATION=1 (the database-integration CI job), like
 * apply.integration.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { selectGroomingCandidate } from "./selector";
import { runHostedGroomer, type GroomerDeps } from "./run";
import { validateGroomingPlan, type GroomingPlanDraft } from "./plan";
import { computeGroomingIssueFingerprint } from "./freshness";
import type { GroomingEvidenceSnapshot } from "./evidence-snapshot";
import type { HostedGroomerConfig } from "./config";

const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL);
const suite = enabled ? describe : describe.skip;

const REPO = "it-groomer/stale-replay";
const ISSUE_NUMBER = 1;
const HEAD_SHA = "abc123";
const TITLE = "Fix login bug";
const BODY = "Login fails after password reset.";
const LABELS = ["status/ready", "priority/p1", "agent/worker"];
const LOGIN_TS = 'export function redirectAfterLogin(session: Session) {\n  return session.returnTo ?? "/";\n}\n';
/** Older than the 24h grooming cooldown and the 30min stale floor. */
const LONG_AGO = new Date(Date.now() - 25 * 60 * 60 * 1000);
/** Older than the 30min stale floor, but inside the 24h cooldown. */
const PAST_STALE_FLOOR = new Date(Date.now() - 31 * 60 * 1000);

const config: HostedGroomerConfig = {
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
  trustedLogins: [],
  externalReplyPolicy: "pending",
  toolLoopEnabled: false,
  maxRounds: 12,
  maxSearchResults: 10,
  maxDirEntries: 60,
  exploration: { maxTotalBytes: 24576, maxFileBytes: 8192, timeoutMs: 150000, source: "medium" },
};

/** A ready verdict over one pinned repository path. */
const planDraft: GroomingPlanDraft = {
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
    verifiedCurrentBehavior: {
      statement: "The reset path skips the session refresh.",
      evidenceRefs: ["repo:src/auth/login.ts"],
    },
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

function evidenceSnapshot(): GroomingEvidenceSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    repoFullName: REPO,
    defaultBranch: "main",
    headSha: HEAD_SHA,
    pinnedRef: HEAD_SHA,
    issue: {
      number: ISSUE_NUMBER,
      title: TITLE,
      body: BODY,
      labels: [...LABELS],
      state: "open",
      stateReason: null,
      author: "maintainer",
      authorAssociation: "OWNER",
      commentsCount: 0,
      updatedAt: new Date().toISOString(),
      url: `https://github.com/${REPO}/issues/${ISSUE_NUMBER}`,
    },
    issueFingerprint: computeGroomingIssueFingerprint({ title: TITLE, body: BODY, state: "open", labels: LABELS }),
    comments: [],
    evidenceDigest: "digest",
    warnings: [],
    sources: [{ path: "src/auth/login.ts", provenance: "repository", via: "read", ref: HEAD_SHA }],
  };
}

/**
 * The real selector, the real applier and the real prisma; every GitHub and
 * model call is a stub, because the point of the test is the database state
 * the production paths leave behind, not the GitHub writes.
 */
function makeDeps(): GroomerDeps {
  return {
    selectCandidate: selectGroomingCandidate,
    prisma,
    fetchComments: async () => [],
    buildContext: async () => "issue context",
    callLLM: async () => planDraft,
    validateOutput: validateGroomingPlan,
    getConfig: () => config,
    updateLabels: async () => undefined,
    addComment: async () => ({ url: null }),
    updateTitleAndBody: async () => undefined,
    closeIssue: async () => undefined,
    createIssue: async () => ({ number: 900, html_url: `https://github.com/${REPO}/issues/900` }),
    addLabel: async () => undefined,
    findActiveLeases: async () => [],
    upsertLease: async () => ({ created: true, lease: { id: "lease-it" }, mintedToken: true }),
    releaseLeaseIfUnchanged: async () => 1,
    buildRepositoryContext: async () => ({
      text: "",
      sources: [],
      warnings: [],
      bytes: 0,
      queries: [],
      emptyQueries: [],
      files: [{ path: "src/auth/login.ts", ref: HEAD_SHA, content: LOGIN_TS }],
    }),
    exploreRepository: async () => {
      throw new Error("the tool loop is disabled in this test");
    },
    collectEvidence: async () => evidenceSnapshot(),
    acquireGroomerLock: async () => ({ locked: true, token: "lock-it" }),
    heartbeatGroomerLock: async () => undefined,
    releaseGroomerLock: async () => undefined,
    compareCommits: async () => ({ ok: true, status: "ahead", files: [], truncated: false }),
  };
}

suite("replayed application and the stale mark against a real PostgreSQL", () => {
  let repositoryId: string;

  async function seedIssue(extra: Record<string, unknown> = {}) {
    return prisma.issue.create({
      data: {
        number: ISSUE_NUMBER,
        repositoryId,
        title: TITLE,
        body: BODY,
        state: "open",
        url: `https://github.com/${REPO}/issues/${ISSUE_NUMBER}`,
        labels: [...LABELS],
        assignees: [],
        commentsCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        currentLane: "local",
        ...extra,
      },
    });
  }

  async function row() {
    return prisma.issue.findFirstOrThrow({ where: { repositoryId, number: ISSUE_NUMBER } });
  }

  beforeEach(async () => {
    // The admission gate is a separate lane; this test is about the stale
    // branch, so the gate is off and the row's eligibility is the stale mark
    // alone.
    process.env.DISPATCH_QUEUE_ADMISSION_MODE = "off";
    await prisma.groomingApplication.deleteMany({ where: { repoFullName: REPO } });
    await prisma.groomingRun.deleteMany({ where: { repoFullName: REPO } });
    await prisma.issue.deleteMany({ where: { repository: { fullName: REPO } } });
    await prisma.automationRepo.deleteMany({ where: { fullName: REPO } });
    await prisma.repository.deleteMany({ where: { fullName: REPO } });
    const repository = await prisma.repository.create({
      data: { fullName: REPO, name: "stale-replay", owner: "it-groomer", enabled: true },
    });
    repositoryId = repository.id;
    await prisma.automationRepo.create({
      data: { fullName: REPO, name: "stale-replay", owner: "it-groomer" },
    });
  });

  afterAll(async () => {
    await prisma.groomingApplication.deleteMany({ where: { repoFullName: REPO } });
    await prisma.groomingRun.deleteMany({ where: { repoFullName: REPO } });
    await prisma.issue.deleteMany({ where: { repository: { fullName: REPO } } });
    await prisma.automationRepo.deleteMany({ where: { fullName: REPO } });
    await prisma.repository.deleteMany({ where: { fullName: REPO } });
    await prisma.$disconnect();
  });

  it("re-offers a stale row, and the replay that re-grooms it clears the mark", async () => {
    // 1. The first groom: a fully classified row with no baseline is
    // backfilled, and the applied verdict records the freshness baseline.
    await seedIssue();
    const deps = makeDeps();
    const first = await runHostedGroomer({ repoFullName: REPO }, deps);
    expect(first!.appliedMutations!.outcome).toBe("noop");
    const afterFirst = await row();
    expect(afterFirst.groomedIssueFingerprint).toBeTruthy();
    expect(afterFirst.groomingStaleAt).toBeNull();

    // 2. The freshness pass marks the row stale: the issue changed since the
    // baseline was recorded.
    await prisma.issue.update({
      where: { id: afterFirst.id },
      data: {
        groomingStaleAt: new Date(Date.now() - 60 * 60 * 1000),
        groomingStaleReasons: ["issue_changed"],
        groomingStaleDetail: "the issue changed since the baseline was recorded",
        groomedAt: PAST_STALE_FLOOR,
      },
    });

    // 3. The control: the stale branch of the selector bypasses the cooldown
    // and the parking, so the stale row is offered for a re-groom.
    const offered = await selectGroomingCandidate({ repoFullName: REPO });
    expect(offered?.number).toBe(ISSUE_NUMBER);
    expect(offered?.selectionReason).toBe("stale");

    // 4. The re-groom reaches the same verdict, so the same application key
    // replays instead of applying again.
    const second = await runHostedGroomer({ repoFullName: REPO }, deps);
    expect(second!.appliedMutations!.outcome).toBe("replayed");

    // 5. The replay settles the row: the stale mark is cleared and the
    // baseline is re-anchored to this run.
    const afterReplay = await row();
    expect(afterReplay.groomingStaleAt).toBeNull();
    expect(afterReplay.groomingStaleReasons).toEqual([]);
    expect(afterReplay.groomingStaleDetail).toBeNull();
    expect(afterReplay.groomedRunId).toBe(second!.groomingRunId);
    expect(afterReplay.groomedIssueFingerprint).toBeTruthy();
    expect(afterReplay.groomedRunId).not.toBe(afterFirst.groomedRunId);

    // 6. No repeated selection: a day later the cooldown has expired, so
    // nothing but the stale mark could re-offer the row. The mark is gone, so
    // the selector leaves it alone. With the mark still set (the regression),
    // the same query would hand the row back for another replay.
    await prisma.issue.update({ where: { id: afterReplay.id }, data: { groomedAt: LONG_AGO } });
    expect(await selectGroomingCandidate({ repoFullName: REPO })).toBeNull();
  });

  it("keeps re-offering a row whose stale mark survived the replay", async () => {
    // The control for the assertion above: with the mark still set, the
    // selector hands the row back even though the cooldown has expired. This
    // is the loop the replay has to break, and it is why the cleared mark is
    // the thing the regression test asserts.
    await seedIssue({ groomingStaleAt: new Date(Date.now() - 60 * 60 * 1000), groomedAt: LONG_AGO });
    const offered = await selectGroomingCandidate({ repoFullName: REPO });
    expect(offered?.number).toBe(ISSUE_NUMBER);
    expect(offered?.selectionReason).toBe("stale");
  });
});
