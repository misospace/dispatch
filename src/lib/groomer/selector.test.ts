import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { selectGroomingCandidate } from "./selector";
import { computeGroomingIssueFingerprint } from "./freshness";

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
    issueFindMany: vi.fn(),
    groomingRunFindMany: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.issueFindMany },
    groomingRun: { findMany: mocks.groomingRunFindMany },
  },
}));

describe("selectGroomingCandidate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.issueFindMany.mockResolvedValue([]);
  });

  it("returns null when no issues exist", async () => {
    mocks.issueFindMany.mockResolvedValue([]);
    const result = await selectGroomingCandidate();
    expect(result).toBeNull();
  });

  it("returns null when all issues are fully labeled and fresh (or not backfilled)", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        number: 10,
        title: "Fully labeled",
        url: "https://github.com/org/repo/issues/10",
        labels: ["status/ready", "priority/p0", "agent/alice"],
        currentLane: "local",
        blockedReason: null,
        groomedIssueFingerprint: "fp",
        groomingStaleAt: null,
        repository: { fullName: "org/repo" },
      },
    ]);
    const result = await selectGroomingCandidate();
    expect(result).toBeNull();
  });

  it("returns unlabeled issue as highest priority", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        number: 20,
        title: "Missing status",
        url: "https://github.com/org/repo/issues/20",
        labels: ["priority/p1"],
        currentLane: "local",
        repository: { fullName: "org/repo" },
      },
      {
        number: 10,
        title: "Unlabeled issue",
        url: "https://github.com/org/repo/issues/10",
        labels: [],
        currentLane: null,
        repository: { fullName: "org/repo" },
      },
    ]);
    const result = await selectGroomingCandidate();
    expect(result).not.toBeNull();
    expect(result!.number).toBe(10);
  });

  it("prefers missing status over missing priority", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        number: 30,
        title: "Missing priority",
        url: "https://github.com/org/repo/issues/30",
        labels: ["status/ready"],
        currentLane: "local",
        repository: { fullName: "org/repo" },
      },
      {
        number: 20,
        title: "Missing status",
        url: "https://github.com/org/repo/issues/20",
        labels: ["priority/p1"],
        currentLane: "local",
        repository: { fullName: "org/repo" },
      },
    ]);
    const result = await selectGroomingCandidate();
    expect(result!.number).toBe(20);
  });

  it("prefers lowest issue number as tie breaker", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        number: 30,
        title: "Also unlabeled",
        url: "https://github.com/org/repo/issues/30",
        labels: [],
        currentLane: null,
        repository: { fullName: "org/repo" },
      },
      {
        number: 10,
        title: "Unlabeled issue",
        url: "https://github.com/org/repo/issues/10",
        labels: [],
        currentLane: null,
        repository: { fullName: "org/repo" },
      },
    ]);
    const result = await selectGroomingCandidate();
    expect(result!.number).toBe(10);
  });

  it("returns candidate with expected shape", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        id: "issue-10",
        number: 10,
        title: "Unlabeled issue",
        body: "Needs details",
        url: "https://github.com/org/repo/issues/10",
        labels: [],
        currentLane: null,
        repository: { fullName: "org/repo" },
      },
    ]);
    const result = await selectGroomingCandidate();
    expect(result).toMatchObject({
      id: "issue-10",
      number: 10,
      title: "Unlabeled issue",
      body: "Needs details",
      url: "https://github.com/org/repo/issues/10",
      repoFullName: "org/repo",
      labels: [],
    });
    expect(result!.currentLane).toBe("backlog");
  });

  it("can target a specific repository and issue number", async () => {
    mocks.issueFindMany.mockResolvedValue([]);

    await selectGroomingCandidate({ repoFullName: "org/repo", issueNumber: 42 });

    expect(mocks.issueFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          number: 42,
          repository: { enabled: true, fullName: "org/repo" },
        }),
      }),
    );
  });

  it("excludes closed issues", async () => {
    mocks.issueFindMany.mockResolvedValue([]);
    await selectGroomingCandidate();
    expect(mocks.issueFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ state: "open" }),
      }),
    );
  });

  it("excludes disabled repo issues", async () => {
    mocks.issueFindMany.mockResolvedValue([]);
    await selectGroomingCandidate();
    expect(mocks.issueFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ repository: { enabled: true } }),
      }),
    );
  });

  it("returns backlog lane issue as eligible", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        number: 40,
        title: "Backlog issue",
        url: "https://github.com/org/repo/issues/40",
        labels: ["status/backlog", "priority/p2"],
        currentLane: "backlog",
        repository: { fullName: "org/repo" },
      },
    ]);
    const result = await selectGroomingCandidate();
    expect(result!.number).toBe(40);
  });

  it("selects a blocked issue with no reason for routine grooming", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        number: 35,
        title: "Unexplained blocked issue",
        url: "https://github.com/org/repo/issues/35",
        labels: ["status/blocked", "priority/p1", "agent/alice"],
        currentLane: "local",
        blockedReason: null,
        repository: { fullName: "org/repo" },
      },
    ]);
    const result = await selectGroomingCandidate();
    expect(result).not.toBeNull();
    expect(result!.number).toBe(35);
  });

  it("keeps a blocked issue with a reason excluded from routine grooming", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        number: 36,
        title: "Explained blocked issue",
        url: "https://github.com/org/repo/issues/36",
        labels: ["status/blocked", "priority/p1", "agent/alice"],
        currentLane: "local",
        blockedReason: "Waiting on an external dependency",
        repository: { fullName: "org/repo" },
      },
    ]);
    const result = await selectGroomingCandidate();
    expect(result).toBeNull();
  });

  it("returns missing priority issue as eligible", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        number: 30,
        title: "Missing priority",
        url: "https://github.com/org/repo/issues/30",
        labels: ["status/ready"],
        currentLane: "local",
        repository: { fullName: "org/repo" },
      },
    ]);
    const result = await selectGroomingCandidate();
    expect(result!.number).toBe(30);
  });

  it("returns missing agent label issue as eligible", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        number: 50,
        title: "Missing agent",
        url: "https://github.com/org/repo/issues/50",
        labels: ["status/ready", "priority/p1"],
        currentLane: "local",
        repository: { fullName: "org/repo" },
      },
    ]);
    const result = await selectGroomingCandidate();
    expect(result!.number).toBe(50);
  });

  it("selects fully classified issue with status/backlog label even when currentLane is claimable", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        number: 70,
        title: "Backlog-labeled but frontier lane",
        url: "https://github.com/org/repo/issues/70",
        labels: ["status/backlog", "priority/p1", "agent/alice"],
        currentLane: "frontier",
        repository: { fullName: "org/repo" },
      },
    ]);
    const result = await selectGroomingCandidate();
    expect(result).not.toBeNull();
    expect(result!.number).toBe(70);
    expect(result!.currentLane).toBe("frontier");
  });

  it("returns missing lane issue as eligible", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        number: 60,
        title: "Missing lane",
        url: "https://github.com/org/repo/issues/60",
        labels: ["status/ready", "priority/p1", "agent/alice"],
        currentLane: null,
        repository: { fullName: "org/repo" },
      },
    ]);
    const result = await selectGroomingCandidate();
    expect(result!.number).toBe(60);
  });

  // Regression for #793/#862: a parked or fully classified issue must remain
  // reachable by a targeted re-groom. Without both bypasses, the exclusion was
  // applied after the issueNumber filter and the eligibility check rejected
  // fully classified issues — a one-way door.
  it("targeted issueNumber bypasses eligibility and the blocked/not-ready grooming-state exclusion", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        number: 36,
        title: "Alert triage parking deadlock",
        url: "https://github.com/alert-triage/repo/issues/36",
        labels: ["status/blocked", "priority/p1", "agent/alice"],
        currentLane: "local",
        blockedReason: "Blocked by unresolved dependencies and validation gate ...",
        notReadyReason: null,
        groomedAt: new Date("2026-08-13T05:58:37Z"),
        repository: { fullName: "alert-triage/repo" },
      },
    ]);
    const result = await selectGroomingCandidate({ issueNumber: 36 });
    expect(result).not.toBeNull();
    expect(result!.number).toBe(36);

    // Verify the exclusions were actually skipped — the findMany call must NOT
    // contain the { blockedReason: null } / { notReadyReason: null } predicates
    // when issueNumber is supplied.
    const callArgs = mocks.issueFindMany.mock.calls[0][0];
    const serialized = JSON.stringify(callArgs);
    expect(serialized).not.toContain('"blockedReason":null');
    expect(serialized).not.toContain('"notReadyReason":null');
  });

  it("without issueNumber, blocked issues are still excluded from the candidate pool", async () => {
    mocks.issueFindMany.mockResolvedValue([]);
    await selectGroomingCandidate();
    const callArgs = mocks.issueFindMany.mock.calls[0][0];
    const serialized = JSON.stringify(callArgs);
    // The default pool run still applies the exclusion — the bypass is targeted only.
    expect(serialized).toContain('"blockedReason":null');
    expect(serialized).toContain('"notReadyReason":null');
  });

  describe("grooming freshness (#1064)", () => {
    const fullyClassified = {
      title: "Ready issue",
      url: "https://github.com/org/repo/issues/1",
      labels: ["status/ready", "priority/p1", "agent/alice"],
      currentLane: "local",
      blockedReason: null,
      groomedIssueFingerprint: "fp",
      groomingStaleAt: null,
      groomingStaleReasons: [],
      commentsCount: 3,
      repository: { fullName: "org/repo" },
    };

    it("selects a stale fully classified ready issue and says why", async () => {
      mocks.issueFindMany.mockResolvedValue([
        { ...fullyClassified, number: 1 },
        {
          ...fullyClassified,
          number: 2,
          groomingStaleAt: new Date(),
          groomingStaleReasons: ["evidence_path_changed"],
        },
      ]);
      const result = await selectGroomingCandidate();
      expect(result).toMatchObject({
        number: 2,
        selectionReason: "stale",
        staleReasons: ["evidence_path_changed"],
        commentsCount: 3,
      });
    });

    it("selects a stale blocked deferral whose blocker changed", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          ...fullyClassified,
          number: 3,
          labels: ["status/blocked", "priority/p1", "agent/alice"],
          blockedReason: "Blocked by open #5",
          groomingStaleAt: new Date(),
          groomingStaleReasons: ["dependency_changed"],
        },
      ]);
      const result = await selectGroomingCandidate();
      expect(result).toMatchObject({ number: 3, selectionReason: "stale" });
    });

    it("never re-grooms a stale issue a worker owns", async () => {
      mocks.issueFindMany.mockResolvedValue([
        {
          ...fullyClassified,
          number: 4,
          labels: ["status/in-progress", "priority/p1", "agent/alice"],
          groomingStaleAt: new Date(),
          groomingStaleReasons: ["human_comment"],
        },
      ]);
      expect(await selectGroomingCandidate()).toBeNull();
    });

    it("ranks stale below missing classification", async () => {
      mocks.issueFindMany.mockResolvedValue([
        { ...fullyClassified, number: 5, groomingStaleAt: new Date() },
        { ...fullyClassified, number: 6, labels: ["status/ready", "agent/alice"] },
      ]);
      const result = await selectGroomingCandidate();
      expect(result).toMatchObject({ number: 6, selectionReason: "classification" });
    });

    it("backfills a baseline-less fully classified issue only when asked and nothing else is eligible", async () => {
      const backfill = { freshnessBackfill: true };
      const unknown = { ...fullyClassified, number: 7, groomedIssueFingerprint: null };
      mocks.issueFindMany.mockResolvedValue([unknown, { ...fullyClassified, number: 8, groomingStaleAt: new Date() }]);
      expect((await selectGroomingCandidate(backfill))!.number).toBe(8);

      mocks.issueFindMany.mockResolvedValue([unknown]);
      expect(await selectGroomingCandidate(backfill)).toMatchObject({ number: 7, selectionReason: "freshness_unknown" });
      // External groomers (next-task) never get backfill work.
      expect(await selectGroomingCandidate()).toBeNull();

      // A deliberately blocked issue without a baseline stays parked.
      mocks.issueFindMany.mockResolvedValue([
        { ...unknown, labels: ["status/blocked", "priority/p1", "agent/alice"], blockedReason: "External" },
      ]);
      expect(await selectGroomingCandidate(backfill)).toBeNull();
    });

    it("lets stale issues bypass the cooldown and parking, behind a short floor", async () => {
      mocks.issueFindMany.mockResolvedValue([]);
      await selectGroomingCandidate();
      const where = mocks.issueFindMany.mock.calls[0][0].where;
      const clause = where.AND.find((c: Record<string, unknown>) => Array.isArray(c.OR) && (c.OR as unknown[]).length === 2);
      expect(clause).toBeDefined();
      const [parked, stale] = clause.OR;
      expect(JSON.stringify(parked)).toContain('"blockedReason":null');
      expect(stale.groomingStaleAt).toEqual({ not: null });
      const floor = stale.OR[1].groomedAt.lt as Date;
      expect(Date.now() - floor.getTime()).toBeGreaterThanOrEqual(29 * 60 * 1000);
    });

    it("targeted runs report the targeted reason", async () => {
      mocks.issueFindMany.mockResolvedValue([{ ...fullyClassified, number: 9 }]);
      expect(await selectGroomingCandidate({ issueNumber: 9 })).toMatchObject({ selectionReason: "targeted" });
    });
  });

  describe("backoff after unreadable GitHub state (dispatch#1063)", () => {
    const backoffClause = (where: { AND?: Array<Record<string, unknown>> }) =>
      where.AND?.find((c) => JSON.stringify(c).includes("groomingRetryAfter"));

    /** findMany that applies only the backoff predicate, so the next tick can be simulated. */
    function withBackoffApplied(rows: Array<Record<string, unknown>>) {
      mocks.issueFindMany.mockImplementation(async ({ where }: { where: { AND?: Array<Record<string, unknown>> } }) => {
        const clause = backoffClause(where) as { OR: [unknown, { groomingRetryAfter: { lte: Date } }] } | undefined;
        if (!clause) return rows;
        const now = clause.OR[1].groomingRetryAfter.lte.getTime();
        return rows.filter((row) => row.groomingRetryAfter == null || (row.groomingRetryAfter as Date).getTime() <= now);
      });
    }

    const unlabeled = (number: number, extra: Record<string, unknown> = {}) => ({
      number,
      title: `Issue ${number}`,
      url: `https://github.com/org/repo/issues/${number}`,
      labels: [],
      currentLane: null,
      blockedReason: null,
      groomingRetryAfter: null,
      repository: { fullName: "org/repo" },
      ...extra,
    });

    it("an unverifiable abort is not re-selected on the next tick; a stale abort still is", async () => {
      // #5 outranks #7 on number alone. #5's last run was unverifiable (backed
      // off an hour); #7's was a stale abort, which writes no backoff.
      withBackoffApplied([
        unlabeled(5, { groomingRetryAfter: new Date(Date.now() + 60 * 60 * 1000) }),
        unlabeled(7),
      ]);
      expect((await selectGroomingCandidate())!.number).toBe(7);
    });

    it("re-selects a backed-off issue once its backoff has passed", async () => {
      withBackoffApplied([unlabeled(5, { groomingRetryAfter: new Date(Date.now() - 1000) }), unlabeled(7)]);
      expect((await selectGroomingCandidate())!.number).toBe(5);
    });

    it("skips an issue backed off after a failed run until the backoff expires (dispatch#1125)", async () => {
      // The first failed run backs off 30 minutes (run.ts).
      const failed = unlabeled(5, { groomingRetryAfter: new Date(Date.now() + 30 * 60 * 1000) });
      withBackoffApplied([failed, unlabeled(7)]);
      expect((await selectGroomingCandidate())!.number).toBe(7);

      vi.useFakeTimers({ now: Date.now() + 31 * 60 * 1000 });
      try {
        expect((await selectGroomingCandidate())!.number).toBe(5);
      } finally {
        vi.useRealTimers();
      }
    });

    it("applies the backoff to the stale path too, but not to targeted runs", async () => {
      mocks.issueFindMany.mockResolvedValue([]);
      await selectGroomingCandidate();
      const clause = backoffClause(mocks.issueFindMany.mock.calls[0][0].where);
      expect(clause).toEqual({ OR: [{ groomingRetryAfter: null }, { groomingRetryAfter: { lte: expect.any(Date) } }] });

      mocks.issueFindMany.mockClear();
      await selectGroomingCandidate({ issueNumber: 5 });
      expect(JSON.stringify(mocks.issueFindMany.mock.calls[0][0].where)).not.toContain("groomingRetryAfter");
    });
  });

  describe("admission-withheld work stays groomable (#1065)", () => {
    const fingerprint = computeGroomingIssueFingerprint({
      title: "Ready issue",
      body: "Body",
      state: "open",
      labels: ["status/ready", "priority/p1", "agent/alice"],
    });
    const fresh = {
      title: "Ready issue",
      body: "Body",
      state: "open",
      url: "https://github.com/org/repo/issues/1",
      labels: ["status/ready", "priority/p1", "agent/alice"],
      currentLane: "local",
      blockedReason: null,
      groomedRunId: "run-1",
      groomedIssueFingerprint: fingerprint,
      groomedEvidenceDigest: "d",
      groomedEvidenceScope: "paths",
      groomingStaleAt: null,
      groomingStaleReasons: [],
      groomingVerifiedSha: "a".repeat(40),
      admissionOverrideId: null,
      commentsCount: 0,
      repository: { fullName: "org/repo" },
    };
    const readyRun = (over: Record<string, unknown> = {}) => ({
      id: "run-1",
      status: "completed",
      stage: "applied",
      dryRun: false,
      validatedOutput: { readiness: { ready: true, admission: "implementation", lane: "local", evidenceDigest: "d", reasons: [] } },
      ...over,
    });
    const hosted = { freshnessBackfill: true, admissionRegroom: true };

    afterEach(() => {
      delete process.env.DISPATCH_QUEUE_ADMISSION_MODE;
    });

    it("off: a fresh fully classified ready issue is not re-selected, and no admission query runs", async () => {
      mocks.issueFindMany.mockResolvedValue([{ ...fresh, id: "i1", number: 1 }]);
      mocks.groomingRunFindMany.mockResolvedValue([readyRun({ status: "partial" })]);
      expect(await selectGroomingCandidate(hosted)).toBeNull();
      expect(mocks.groomingRunFindMany).not.toHaveBeenCalled();
      expect(mocks.issueFindMany.mock.calls[0][0].select).not.toHaveProperty("admissionOverrideId");
    });

    it("re-selects a fresh result the gate withholds", async () => {
      process.env.DISPATCH_QUEUE_ADMISSION_MODE = "enforce";
      mocks.issueFindMany.mockResolvedValue([{ ...fresh, id: "i1", number: 1 }]);
      mocks.groomingRunFindMany.mockResolvedValue([readyRun({ status: "partial" })]);
      expect(await selectGroomingCandidate(hosted)).toMatchObject({ number: 1, selectionReason: "admission_withheld" });
    });

    it("leaves an admitted fresh result alone", async () => {
      process.env.DISPATCH_QUEUE_ADMISSION_MODE = "audit";
      mocks.issueFindMany.mockResolvedValue([{ ...fresh, id: "i1", number: 1 }]);
      mocks.groomingRunFindMany.mockResolvedValue([readyRun()]);
      expect(await selectGroomingCandidate(hosted)).toBeNull();
    });

    it("only for the hosted groomer (an external groomer records no baseline)", async () => {
      process.env.DISPATCH_QUEUE_ADMISSION_MODE = "enforce";
      mocks.issueFindMany.mockResolvedValue([{ ...fresh, id: "i1", number: 1 }]);
      mocks.groomingRunFindMany.mockResolvedValue([readyRun({ status: "partial" })]);
      expect(await selectGroomingCandidate()).toBeNull();
    });

    it("backfills a baseline-less ready issue ahead of routine backlog work", async () => {
      process.env.DISPATCH_QUEUE_ADMISSION_MODE = "enforce";
      mocks.issueFindMany.mockResolvedValue([
        { ...fresh, id: "i2", number: 2, labels: ["status/backlog", "priority/p1", "agent/alice"], groomedIssueFingerprint: "x" },
        { ...fresh, id: "i3", number: 3, groomedRunId: null, groomedIssueFingerprint: null },
      ]);
      mocks.groomingRunFindMany.mockResolvedValue([]);
      expect(await selectGroomingCandidate(hosted)).toMatchObject({ number: 3, selectionReason: "freshness_unknown" });
    });
  });
});
