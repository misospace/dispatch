import { describe, expect, it, vi, beforeEach } from "vitest";
import type { GroomingCandidate } from "./selector";
import type { GroomerOutput } from "./schema";
import type { HostedGroomerConfig } from "./config";

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
    validateGroomerOutput: vi.fn(),
    getHostedGroomerConfig: vi.fn(),
    updateIssueLabels: vi.fn(),
    addIssueComment: vi.fn(),
    updateIssueTitleAndBody: vi.fn(),
    findActiveLeasesForIssue: vi.fn(),
    upsertLease: vi.fn(),
    releaseLease: vi.fn(),
    addIssueLabel: vi.fn(),
    removeIssueLabel: vi.fn(),
    buildRepositoryContext: vi.fn(),
    acquireGroomerLock: vi.fn(),
    releaseGroomerLock: vi.fn(),
    prisma: {
      automationRepo: { findUnique: vi.fn() },
      groomingRun: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
      issue: { update: vi.fn() },
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

vi.mock("./context", () => ({
  fetchIssueComments: mocks.fetchIssueComments,
  buildIssueContext: mocks.buildIssueContext,
}));

vi.mock("./schema", () => ({
  validateGroomerOutput: mocks.validateGroomerOutput,
}));

vi.mock("./config", () => ({
  getHostedGroomerConfig: mocks.getHostedGroomerConfig,
}));

vi.mock("@/lib/github", () => ({
  updateIssueLabels: mocks.updateIssueLabels,
  addIssueComment: mocks.addIssueComment,
  updateIssueTitleAndBody: mocks.updateIssueTitleAndBody,
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
}));

vi.mock("./groomer-lock", () => ({
  acquireGroomerLock: mocks.acquireGroomerLock,
  releaseGroomerLock: mocks.releaseGroomerLock,
}));

import { runHostedGroomer } from "./run";

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

const mockOutput: GroomerOutput = {
  labelsToAdd: ["status/ready"],
  labelsToRemove: [],
  lane: { id: "local", confidence: "high", reason: "clear implementation task" },
  summary: "Ready for work.",
};

const mockConfig: HostedGroomerConfig = {
  enabled: true,
  dryRun: false,
  llmBaseUrl: "https://llm.example.com",
  apiKey: "sk-test",
  model: "gpt-4o-mini",
  timeoutMs: 60000,
  maxContextBytes: 8192,
  repoContextEnabled: false,
  maxContextFiles: 5,
  maxSearches: 3,
  maxFileBytes: 4096,
  commentCooldownHours: 24,
  groomerToken: null,
};

const mockAutomationRepo = { id: "repo-1", fullName: "org/repo", enabled: true };
const mockGroomingRun = { id: "gr-1", stage: "selected" };

describe("runHostedGroomer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectGroomingCandidate.mockResolvedValue(mockCandidate);
    mocks.fetchIssueComments.mockResolvedValue([]);
    mocks.buildIssueContext.mockResolvedValue("test context");
    mocks.validateGroomerOutput.mockReturnValue({ valid: true, parsed: mockOutput });
    mocks.getHostedGroomerConfig.mockReturnValue(mockConfig);
    mocks.callGroomerLLM.mockResolvedValue(mockOutput);
    mocks.updateIssueLabels.mockResolvedValue(undefined);
    mocks.updateIssueTitleAndBody.mockResolvedValue(undefined);
    mocks.addIssueComment.mockResolvedValue({ url: null });
    mocks.findActiveLeasesForIssue.mockResolvedValue([]);
    mocks.upsertLease.mockResolvedValue({ created: true, lease: { id: "lease-1" } });
    mocks.releaseLease.mockResolvedValue({ id: "lease-1" });
    mocks.acquireGroomerLock.mockResolvedValue({ locked: true, token: "lock-token" });
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
    mocks.validateGroomerOutput.mockReturnValue({
      valid: true,
      parsed: { ...mockOutput, githubComment: "Test comment" },
    });

    const result = await runHostedGroomer();

    expect(mocks.addIssueComment).not.toHaveBeenCalled();
    expect(result!.appliedMutations?.commentSkippedReason).toBe("cooldown");
  });

  it("write mode stores comment URL when comment is posted", async () => {
    mocks.addIssueComment.mockResolvedValue({ url: "https://github.com/org/repo/issues/42#issuecomment-123" });
    mocks.validateGroomerOutput.mockReturnValue({
      valid: true,
      parsed: { ...mockOutput, githubComment: "Test comment" },
    });

    const result = await runHostedGroomer();

    expect(mocks.addIssueComment).toHaveBeenCalled();
    expect(result!.appliedMutations?.commentUrl).toBe("https://github.com/org/repo/issues/42#issuecomment-123");
  });

  it("write mode neutralizes @-mentions in posted comment", async () => {
    mocks.validateGroomerOutput.mockReturnValue({
      valid: true,
      parsed: {
        ...mockOutput,
        githubComment: "@reviewer This issue has been groomed and moved to **ready** status. Contact foo@bar.com with questions.",
      },
    });

    await runHostedGroomer();

    expect(mocks.addIssueComment).toHaveBeenCalledWith(
      "org/repo",
      42,
      "`@reviewer` This issue has been groomed and moved to **ready** status. Contact foo@bar.com with questions.",
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
    mocks.validateGroomerOutput.mockReturnValue({ valid: false, errors: ["invalid lane"] });

    await expect(runHostedGroomer()).rejects.toThrow(/invalid lane/);
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
    const outputWithoutComment: GroomerOutput = {
      ...mockOutput,
      githubComment: undefined,
    };
    mocks.validateGroomerOutput.mockReturnValue({ valid: true, parsed: outputWithoutComment });

    await runHostedGroomer();

    expect(mocks.addIssueComment).not.toHaveBeenCalled();
  });

  it("posts one comment when githubComment is present", async () => {
    mocks.validateGroomerOutput.mockReturnValue({
      valid: true,
      parsed: { ...mockOutput, githubComment: "Likely root cause found." },
    });

    await runHostedGroomer();

    expect(mocks.addIssueComment).toHaveBeenCalledWith(
      "org/repo",
      42,
      "Likely root cause found.",
    );
  });

  it("truncates githubComment before posting", async () => {
    const longComment = "x".repeat(5000);
    mocks.validateGroomerOutput.mockReturnValue({
      valid: true,
      parsed: { ...mockOutput, githubComment: longComment },
    });

    await runHostedGroomer();

    expect(mocks.addIssueComment.mock.calls[0][2]).toHaveLength(4096);
  });

  it("comment posting is best-effort: a persistent addComment failure does not fail the run", async () => {
    mocks.addIssueComment.mockRejectedValue(new Error("GitHub API error adding comment: 504"));
    mocks.validateGroomerOutput.mockReturnValue({
      valid: true,
      parsed: { ...mockOutput, githubComment: "Likely root cause found." },
    });

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
    mocks.validateGroomerOutput.mockReturnValue({
      valid: true,
      parsed: { ...mockOutput, githubComment: "Likely root cause found." },
    });

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
    mocks.validateGroomerOutput.mockReturnValue({
      valid: true,
      parsed: { ...mockOutput, proposedTitle: "Fix the login bug" },
    });

    const result = await runHostedGroomer();

    // "Fix login bug" (13 chars) is a good title — should not be rewritten
    expect(result!.mutationPlan?.titleRewritten).toBe(false);
    expect(mocks.updateIssueTitleAndBody).not.toHaveBeenCalled();
  });

  it("rewrites a bad short title", async () => {
    const badCandidate = { ...mockCandidate, title: "P0" };
    mocks.selectGroomingCandidate.mockResolvedValue(badCandidate);
    mocks.validateGroomerOutput.mockReturnValue({
      valid: true,
      parsed: {
        ...mockOutput,
        proposedTitle: "Fix SSO/OIDC callback state verification mismatch causing 400 errors",
      },
    });

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
    mocks.validateGroomerOutput.mockReturnValue({
      valid: true,
      parsed: { ...mockOutput, proposedTitle: "Implement user authentication flow" },
    });

    const result = await runHostedGroomer();

    expect(result!.mutationPlan?.titleRewritten).toBe(true);
    expect(mocks.updateIssueTitleAndBody).toHaveBeenCalled();
  });

  it("rewrites an empty title", async () => {
    const badCandidate = { ...mockCandidate, title: "" };
    mocks.selectGroomingCandidate.mockResolvedValue(badCandidate);
    mocks.validateGroomerOutput.mockReturnValue({
      valid: true,
      parsed: { ...mockOutput, proposedTitle: "Add missing error handling for database connections" },
    });

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
    mocks.validateGroomerOutput.mockReturnValue({
      valid: true,
      parsed: { ...mockOutput, proposedBody: "Enriched body content." },
    });

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
    mocks.validateGroomerOutput.mockReturnValue({
      valid: true,
      parsed: { ...mockOutput, proposedBody: enrichedBody },
    });

    const result = await runHostedGroomer();

    expect(result!.mutationPlan?.bodyEnriched).toBe(true);
    expect(mocks.updateIssueTitleAndBody).toHaveBeenCalledWith(
      "org/repo",
      42,
      expect.objectContaining({ body: enrichedBody }),
    );
    expect(result!.appliedMutations?.bodyUpdated).toBe(true);
  });

  it("enriches a null body", async () => {
    const noBodyCandidate = { ...mockCandidate, body: null };
    mocks.selectGroomingCandidate.mockResolvedValue(noBodyCandidate);
    const enrichedBody = "## Description\nMore detail needed.\n\n## Labels\npriority/p0";
    mocks.validateGroomerOutput.mockReturnValue({
      valid: true,
      parsed: { ...mockOutput, proposedBody: enrichedBody },
    });

    const result = await runHostedGroomer();

    expect(result!.mutationPlan?.bodyEnriched).toBe(true);
    expect(mocks.updateIssueTitleAndBody).toHaveBeenCalled();
  });

  it("applies both title rewrite and body enrichment together", async () => {
    const badCandidate = { ...mockCandidate, title: "P0", body: "Fix." };
    mocks.selectGroomingCandidate.mockResolvedValue(badCandidate);
    const enrichedBody = "## Context\nSSO login is broken.\n\n## What's known\nState verification fails on callback.";
    mocks.validateGroomerOutput.mockReturnValue({
      valid: true,
      parsed: {
        ...mockOutput,
        proposedTitle: "Fix SSO callback state mismatch",
        proposedBody: enrichedBody,
      },
    });

    const result = await runHostedGroomer();

    expect(result!.mutationPlan?.titleRewritten).toBe(true);
    expect(result!.mutationPlan?.bodyEnriched).toBe(true);
    expect(mocks.updateIssueTitleAndBody).toHaveBeenCalledWith(
      "org/repo",
      42,
      expect.objectContaining({
        title: "Fix SSO callback state mismatch",
        body: enrichedBody,
      }),
    );
    expect(result!.appliedMutations?.titleUpdated).toBe(true);
    expect(result!.appliedMutations?.bodyUpdated).toBe(true);
  });

  it("dry-run includes title/body plan but does not call GitHub API", async () => {
    const badCandidate = { ...mockCandidate, title: "P0" };
    mocks.selectGroomingCandidate.mockResolvedValue(badCandidate);
    mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, dryRun: true });
    mocks.validateGroomerOutput.mockReturnValue({
      valid: true,
      parsed: { ...mockOutput, proposedTitle: "Fix the thing" },
    });

    const result = await runHostedGroomer();

    expect(result!.dryRun).toBe(true);
    expect(result!.mutationPlan?.titleRewritten).toBe(true);
    expect(mocks.updateIssueTitleAndBody).not.toHaveBeenCalled();
  });

  it("skips title/body update when LLM does not propose changes", async () => {
    mocks.validateGroomerOutput.mockReturnValue({
      valid: true,
      parsed: mockOutput, // no proposedTitle or proposedBody
    });

    await runHostedGroomer();

    expect(mocks.updateIssueTitleAndBody).not.toHaveBeenCalled();
  });

  it("normalizes explicit LLM nulls to undefined through the real schema validator", async () => {
    const { validateGroomerOutput } = await vi.importActual<typeof import("./schema")>("./schema");
    mocks.validateGroomerOutput.mockImplementation(validateGroomerOutput);
    const badCandidate = { ...mockCandidate, title: "P0" };
    mocks.selectGroomingCandidate.mockResolvedValue(badCandidate);
    mocks.callGroomerLLM.mockResolvedValue({
      ...mockOutput,
      proposedTitle: null,
      proposedBody: null,
    });

    const result = await runHostedGroomer();

    expect(result!.output.proposedTitle).toBeUndefined();
    expect(result!.output.proposedBody).toBeUndefined();
    expect(result!.mutationPlan?.titleRewritten).toBe(false);
    expect(result!.mutationPlan?.bodyEnriched).toBe(false);
    expect(mocks.updateIssueTitleAndBody).not.toHaveBeenCalled();
  });

  describe("mark_not_ready notReadyReason degradation (dispatch#839)", () => {
    const notReadyOutput: GroomerOutput = {
      labelsToAdd: ["status/backlog"],
      labelsToRemove: [],
      lane: { id: "backlog", confidence: "medium", reason: "not ready yet" },
      summary: "Not ready.",
      nextGroomingAction: "mark_not_ready",
    };

    it("persists the model-supplied notReadyReason in the normal case", async () => {
      mocks.validateGroomerOutput.mockReturnValue({
        valid: true,
        parsed: { ...notReadyOutput, notReadyReason: "auditor prioritized it low" },
      });

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

    it("uses this run's summary when the model omits notReadyReason (first-groom path)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      // No prior groomingSummary on the candidate (first-time groom) and no
      // model reason, but the run produced a summary — the content that is
      // about to be written to groomingSummary anyway.
      mocks.validateGroomerOutput.mockReturnValue({ valid: true, parsed: notReadyOutput });

      const result = await runHostedGroomer();

      expect(result).not.toBeNull();
      expect(mocks.prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            nextGroomingAction: "mark_not_ready",
            notReadyReason: "Not ready.",
          }),
        }),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("used this run's summary"),
      );
      warnSpy.mockRestore();
    });

    it("falls back to the existing groomingSummary when the model omits notReadyReason and produced no summary", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mocks.selectGroomingCandidate.mockResolvedValue({
        ...mockCandidate,
        groomingSummary: "auditor prioritized it low and moved to backlog",
      });
      mocks.validateGroomerOutput.mockReturnValue({
        valid: true,
        parsed: { ...notReadyOutput, summary: undefined },
      });

      const result = await runHostedGroomer();

      expect(result).not.toBeNull();
      expect(mocks.prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            nextGroomingAction: "mark_not_ready",
            notReadyReason: "auditor prioritized it low and moved to backlog",
          }),
        }),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("fell back to existing groomingSummary"),
      );
      warnSpy.mockRestore();
    });

    it("persists the action without a reason and warns when nothing is available", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mocks.validateGroomerOutput.mockReturnValue({
        valid: true,
        parsed: { ...notReadyOutput, summary: undefined },
      });

      const result = await runHostedGroomer();

      expect(result).not.toBeNull();
      expect(mocks.prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ nextGroomingAction: "mark_not_ready" }),
        }),
      );
      expect(mocks.prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({ notReadyReason: expect.anything() }),
        }),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("persisting the action without a reason"),
      );
      warnSpy.mockRestore();
    });

    it("prefers this run's summary over a prior one in the dry-run mutation plan", async () => {
      mocks.getHostedGroomerConfig.mockReturnValue({ ...mockConfig, dryRun: true });
      mocks.selectGroomingCandidate.mockResolvedValue({
        ...mockCandidate,
        groomingSummary: "deferred by maintainer",
      });
      mocks.validateGroomerOutput.mockReturnValue({ valid: true, parsed: notReadyOutput });

      const result = await runHostedGroomer();

      // notReadyOutput.summary ("Not ready.") outranks the prior
      // groomingSummary ("deferred by maintainer").
      expect(result!.mutationPlan?.notReadyReason).toBe("Not ready.");
      expect(mocks.prisma.issue.update).not.toHaveBeenCalled();
    });
  });
});
