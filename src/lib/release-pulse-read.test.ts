import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eventFindMany: vi.fn(),
  issueFindMany: vi.fn(),
  workflowRunCount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issueLifecycleEvent: { findMany: mocks.eventFindMany },
    issue: { findMany: mocks.issueFindMany },
    githubWorkflowRun: { count: mocks.workflowRunCount },
  },
}));

const { asReleaseDeltaState, collectReleasePulse, collectRepoReleaseHealth } =
  await import("./release-pulse-read");

const BASELINE_PUBLISHED_AT = "2026-11-01T00:00:00.000Z";

function repo(overrides: Partial<Parameters<typeof collectReleasePulse>[0]> = {}) {
  return {
    fullName: "owner/repo",
    releaseState: "ahead" as const,
    releaseBaselineTag: "v1.0.0",
    releaseBaselineSha: "a".repeat(40),
    releaseBaselinePublishedAt: BASELINE_PUBLISHED_AT,
    releaseHeadSha: "b".repeat(40),
    releaseAheadBy: 1,
    ...overrides,
  };
}

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    kind: "issue_closed",
    source: "github",
    actor: "alice",
    agentName: null,
    fromStatus: null,
    toStatus: "status/done",
    sourceEventId: "evt-1",
    occurredAt: new Date("2026-11-02T00:00:00.000Z"),
    observedAt: new Date("2026-11-02T00:00:00.000Z"),
    metadata: { prNumber: 5 },
    issueNumber: 7,
    ...overrides,
  };
}

describe("asReleaseDeltaState", () => {
  it("passes through the persisted delta states", () => {
    expect(asReleaseDeltaState("identical")).toBe("identical");
    expect(asReleaseDeltaState("ahead")).toBe("ahead");
    expect(asReleaseDeltaState("diverged")).toBe("diverged");
    expect(asReleaseDeltaState("no-baseline")).toBe("no-baseline");
  });

  it("narrows any unrecognized value to unknown", () => {
    expect(asReleaseDeltaState("unknown")).toBe("unknown");
    expect(asReleaseDeltaState("")).toBe("unknown");
    expect(asReleaseDeltaState("AHEAD")).toBe("unknown");
  });
});

describe("collectReleasePulse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the repo-row-only snapshot without any database reads when the gate is closed", async () => {
    const snapshot = await collectReleasePulse(repo({ releaseState: "diverged" }));
    expect(mocks.eventFindMany).not.toHaveBeenCalled();
    expect(mocks.issueFindMany).not.toHaveBeenCalled();
    expect(snapshot.pulseState).toBe("unknown");
    expect(snapshot.baseline).toBeNull();
    expect(snapshot.deliveredIssueCount).toBe(0);
  });

  it("returns the repo-row-only snapshot when the baseline has no publication time", async () => {
    const snapshot = await collectReleasePulse(repo({ releaseBaselinePublishedAt: null }));
    expect(mocks.eventFindMany).not.toHaveBeenCalled();
    expect(mocks.issueFindMany).not.toHaveBeenCalled();
    expect(snapshot.pulseState).toBe("unknown");
  });

  it("reads baseline-scoped close/reopen events plus unbounded pr_merged evidence", async () => {
    mocks.eventFindMany.mockResolvedValue([]);
    mocks.issueFindMany.mockResolvedValue([]);
    await collectReleasePulse(repo());
    expect(mocks.eventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          repoFullName: "owner/repo",
          OR: [
            { kind: "pr_merged" },
            {
              kind: { in: ["completed", "issue_closed", "issue_reopened"] },
              occurredAt: { gte: new Date(BASELINE_PUBLISHED_AT) },
            },
          ],
        },
        orderBy: { occurredAt: "asc" },
      }),
    );
  });

  it("drops the issue-number arm from the issue read when no events matched", async () => {
    mocks.eventFindMany.mockResolvedValue([]);
    mocks.issueFindMany.mockResolvedValue([]);
    await collectReleasePulse(repo());
    expect(mocks.issueFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          repository: { fullName: "owner/repo" },
          OR: [{ state: "closed" }, { decomposed: true, followUpUrls: { isEmpty: false } }],
        },
      }),
    );
  });

  it("includes the issue-number arm when merge or lifecycle events matched", async () => {
    mocks.eventFindMany.mockResolvedValue([eventRow(), eventRow({ issueNumber: 9, kind: "pr_merged" })]);
    mocks.issueFindMany.mockResolvedValue([]);
    await collectReleasePulse(repo());
    const call = mocks.issueFindMany.mock.calls[0][0];
    expect(call.where.OR).toContainEqual({ number: { in: [7, 9] } });
    expect(call.where.OR).toContainEqual({ state: "closed" });
  });

  it("maps event rows into the pure pulse and keeps non-object metadata out", async () => {
    mocks.eventFindMany.mockResolvedValue([eventRow({ metadata: "garbage" })]);
    mocks.issueFindMany.mockResolvedValue([]);
    const snapshot = await collectReleasePulse(repo());
    expect(snapshot.schema).toBe("dispatch.release-pulse/v1");
    expect(snapshot.repoFullName).toBe("owner/repo");
    expect(snapshot.pulseState).toBe("ready");
    expect(snapshot.baseline).toEqual({
      tag: "v1.0.0",
      sha: "a".repeat(40),
      publishedAt: BASELINE_PUBLISHED_AT,
    });
    expect(mocks.issueFindMany).toHaveBeenCalled();
  });
});

describe("collectRepoReleaseHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventFindMany.mockResolvedValue([]);
    mocks.issueFindMany.mockResolvedValue([]);
  });

  function automationRepo() {
    return { id: "repo-1", ...repo() };
  }

  it("counts the workflow runs for this repo row and folds them into the readiness context", async () => {
    mocks.workflowRunCount.mockImplementation(
      async ({ where }: { where: { conclusion?: string; status?: string } }) => {
        if (where.conclusion === "failure") return 2;
        if (where.status === "in_progress") return 1;
        return 4;
      },
    );

    const health = await collectRepoReleaseHealth(automationRepo());

    expect(mocks.workflowRunCount).toHaveBeenCalledWith({
      where: { workflow: { repoId: "repo-1" }, conclusion: "failure" },
    });
    expect(health).toMatchObject({ failingRuns: 2, runningRuns: 1, succeededRuns: 4 });
    expect(health.pulse.pulseState).toBe("ready");
    expect(health.readiness.ci).toBe("failing");
  });

  it("reports green CI only from positive success evidence", async () => {
    mocks.workflowRunCount.mockImplementation(
      async ({ where }: { where: { conclusion?: string } }) =>
        where.conclusion === "success" ? 3 : 0,
    );

    const health = await collectRepoReleaseHealth(automationRepo());

    expect(health.readiness.ci).toBe("green");
  });

  it("reports unknown CI when the repo has no run evidence", async () => {
    mocks.workflowRunCount.mockResolvedValue(0);

    const health = await collectRepoReleaseHealth(automationRepo());

    expect(health.readiness.ci).toBe("unknown");
    expect(health.pulse).toMatchObject({ schema: "dispatch.release-pulse/v1" });
  });
});
