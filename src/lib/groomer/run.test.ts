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
    findActiveLeasesForIssue: vi.fn(),
    upsertLease: vi.fn(),
    releaseLease: vi.fn(),
    addIssueLabel: vi.fn(),
    removeIssueLabel: vi.fn(),
    buildRepositoryContext: vi.fn(),
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
    mocks.addIssueComment.mockResolvedValue({ url: null });
    mocks.findActiveLeasesForIssue.mockResolvedValue([]);
    mocks.upsertLease.mockResolvedValue({ created: true, lease: { id: "lease-1" } });
    mocks.releaseLease.mockResolvedValue({ id: "lease-1" });
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
});
