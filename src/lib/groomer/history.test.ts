import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
}));

// Mock Prisma-like groomingRun delegate
const mockPrisma = {
  groomingRun: {
    create: mocks.create,
    update: mocks.update,
    findMany: mocks.findMany,
    findUnique: mocks.findUnique,
  },
};

vi.doMock("@prisma/client", () => ({
  PrismaClient: class {},
}));

import {
  createGroomingRunRecord,
  completeGroomingRunRecord,
  listGroomingRuns,
  getGroomingRunDetail,
  updateGroomingRunRecord,
} from "./history";

describe("createGroomingRunRecord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({
      id: "run-1",
      status: "running",
      stage: "selected",
      dryRun: false,
    });
  });

  it("creates a running grooming run with all required fields", async () => {
    const input = {
      issueId: "issue-42",
      repoId: "repo-1",
      repoFullName: "org/repo",
      issueNumber: 42,
      issueUrl: "https://github.com/org/repo/issues/42",
      dryRun: false,
      labelsBefore: ["priority/p0"],
      laneBefore: "backlog",
      model: "gpt-4o-mini",
      provider: "openai",
      timeoutMs: 60000,
      maxContextBytes: 8192,
    };

    const result = await createGroomingRunRecord(mockPrisma, input);

    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        issueId: "issue-42",
        repoId: "repo-1",
        repoFullName: "org/repo",
        issueNumber: 42,
        issueUrl: "https://github.com/org/repo/issues/42",
        status: "running",
        dryRun: false,
        stage: "selected",
        labelsBefore: ["priority/p0"],
        labelsAfter: ["priority/p0"],
        laneBefore: "backlog",
        laneAfter: "backlog",
        model: "gpt-4o-mini",
        provider: "openai",
        timeoutMs: 60000,
        maxContextBytes: 8192,
      },
    });
    expect(result.status).toBe("running");
    expect(result.stage).toBe("selected");
    expect(result.dryRun).toBe(false);
  });

  it("creates a dry-run grooming run", async () => {
    const input = {
      issueId: "issue-42",
      repoId: "repo-1",
      repoFullName: "org/repo",
      issueNumber: 42,
      issueUrl: "https://github.com/org/repo/issues/42",
      dryRun: true,
      labelsBefore: [],
      laneBefore: null,
      model: null,
      provider: null,
      timeoutMs: null,
      maxContextBytes: null,
    };

    await createGroomingRunRecord(mockPrisma, input);

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dryRun: true,
          labelsBefore: [],
          laneBefore: null,
          model: null,
          provider: null,
          timeoutMs: null,
          maxContextBytes: null,
        }),
      }),
    );
  });

  it("mirrors labelsBefore into labelsAfter", async () => {
    const input = {
      issueId: "issue-42",
      repoId: "repo-1",
      repoFullName: "org/repo",
      issueNumber: 42,
      issueUrl: "https://github.com/org/repo/issues/42",
      dryRun: false,
      labelsBefore: ["priority/p0"],
      laneBefore: null,
      model: null,
      provider: null,
      timeoutMs: null,
      maxContextBytes: null,
    };

    await createGroomingRunRecord(mockPrisma, input);

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          labelsAfter: ["priority/p0"],
        }),
      }),
    );
  });

  it("mirrors laneBefore into laneAfter", async () => {
    const input = {
      issueId: "issue-42",
      repoId: "repo-1",
      repoFullName: "org/repo",
      issueNumber: 42,
      issueUrl: "https://github.com/org/repo/issues/42",
      dryRun: false,
      labelsBefore: [],
      laneBefore: "backlog",
      model: null,
      provider: null,
      timeoutMs: null,
      maxContextBytes: null,
    };

    await createGroomingRunRecord(mockPrisma, input);

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          laneAfter: "backlog",
        }),
      }),
    );
  });
});

describe("updateGroomingRunRecord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockResolvedValue({ id: "run-1", stage: "llm" });
  });

  it("updates a grooming run with partial data", async () => {
    const result = await updateGroomingRunRecord(mockPrisma, "run-1", {
      stage: "llm",
      model: "gpt-4o-mini",
    });

    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: { stage: "llm", model: "gpt-4o-mini" },
    });
    expect(result.stage).toBe("llm");
  });
});

describe("completeGroomingRunRecord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockResolvedValue({
      id: "run-1",
      status: "completed",
      stage: "applied",
      completedAt: new Date("2025-01-01T00:00:00Z"),
    });
  });

  it("updates status, stage and sets completedAt", async () => {
    const result = await completeGroomingRunRecord(mockPrisma, "run-1", {
      status: "completed",
      stage: "applied",
      labelsAfter: ["status/ready"],
      laneAfter: "normal",
    });

    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: {
        status: "completed",
        stage: "applied",
        labelsAfter: ["status/ready"],
        laneAfter: "normal",
        completedAt: expect.any(Date),
      },
    });
    expect(result.status).toBe("completed");
    expect(result.completedAt).toBeInstanceOf(Date);
  });

  it("allows partial data without labels or lane", async () => {
    await completeGroomingRunRecord(mockPrisma, "run-1", {
      status: "failed",
      stage: "error",
      errorMessage: "LLM timeout",
    });

    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: {
        status: "failed",
        stage: "error",
        errorMessage: "LLM timeout",
        completedAt: expect.any(Date),
      },
    });
  });
});

describe("listGroomingRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([
      {
        id: "run-1",
        repoFullName: "org/repo",
        issueNumber: 42,
        status: "completed",
        dryRun: false,
        model: "gpt-4o-mini",
        issue: { title: "Fix login", state: "open" },
      },
    ]);
  });

  it("passes repo filter as repoFullName", async () => {
    await listGroomingRuns(mockPrisma, { repo: "org/repo" });

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ repoFullName: "org/repo" }),
      }),
    );
  });

  it("passes issueNumber filter", async () => {
    await listGroomingRuns(mockPrisma, { issueNumber: 42 });

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ issueNumber: 42 }),
      }),
    );
  });

  it("passes status filter", async () => {
    await listGroomingRuns(mockPrisma, { status: "completed" });

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "completed" }),
      }),
    );
  });

  it("passes dryRun filter", async () => {
    await listGroomingRuns(mockPrisma, { dryRun: true });

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ dryRun: true }),
      }),
    );
  });

  it("passes model filter", async () => {
    await listGroomingRuns(mockPrisma, { model: "gpt-4o-mini" });

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ model: "gpt-4o-mini" }),
      }),
    );
  });

  it("orders desc by createdAt", async () => {
    await listGroomingRuns(mockPrisma, {});

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: "desc" },
      }),
    );
  });

  it("clamps take to minimum 1", async () => {
    await listGroomingRuns(mockPrisma, { take: 0 });

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1 }),
    );
  });

  it("clamps take to maximum 200", async () => {
    await listGroomingRuns(mockPrisma, { take: 500 });

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });

  it("uses default take of 50", async () => {
    await listGroomingRuns(mockPrisma, {});

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });

  it("includes issue title/state, agentRun, application count and latest application", async () => {
    await listGroomingRuns(mockPrisma, {});

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          issue: { select: { title: true, state: true } },
          agentRun: true,
          _count: { select: { applications: true } },
          applications: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
        },
      }),
    );
  });

  it("strips heavy debug fields and attaches the operator view", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "run-1",
        repoFullName: "org/repo",
        issueNumber: 42,
        status: "completed",
        stage: "applied",
        dryRun: false,
        model: "gpt-4o-mini",
        rawOutput: { RAW: "output" },
        contextSummary: { evidence: { headSha: "a".repeat(40) } },
        commentBodyPreview: "comment body text",
        validatedOutput: { schemaVersion: 1, verdict: { actionability: "ready" } },
        mutationPlan: { applicationKey: "key-1" },
        appliedMutations: { outcome: "applied" },
        issue: { title: "Fix login", state: "open" },
        _count: { applications: 2 },
        applications: [{ createdAt: new Date("2026-10-09T00:00:00.000Z") }],
      },
    ]);

    const rows = (await listGroomingRuns(mockPrisma, {})) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).not.toHaveProperty("rawOutput");
    expect(row).not.toHaveProperty("contextSummary");
    expect(row).not.toHaveProperty("commentBodyPreview");
    expect(row).not.toHaveProperty("validatedOutput");
    expect(row).not.toHaveProperty("mutationPlan");
    expect(row).not.toHaveProperty("appliedMutations");
    expect(row).not.toHaveProperty("applications");
    const view = row.view as {
      evidence: { headSha: string | null };
      plan: { format: string };
      application: { applicationCount: number | null; lastApplicationAt: string | null };
    };
    expect(view.evidence.headSha).toBe("a".repeat(40));
    expect(view.plan.format).toBe("grooming-plan");
    expect(view.application.applicationCount).toBe(2);
    expect(view.application.lastApplicationAt).toBe("2026-10-09T00:00:00.000Z");
  });

  it("combines multiple filters", async () => {
    await listGroomingRuns(mockPrisma, {
      repo: "org/repo",
      status: "completed",
      dryRun: false,
      take: 10,
    });

    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        repoFullName: "org/repo",
        status: "completed",
        dryRun: false,
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: {
        issue: { select: { title: true, state: true } },
        agentRun: true,
        _count: { select: { applications: true } },
        applications: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
      },
    });
  });
});

describe("getGroomingRunDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({
      id: "run-1",
      repoFullName: "org/repo",
      issueNumber: 42,
      status: "completed",
      issue: { title: "Fix login", state: "open", repository: { name: "repo" } },
      repo: { name: "repo", fullName: "org/repo" },
      agentRun: { id: "agent-run-1", agentName: "hosted-groomer" },
      applications: [
        { id: "app-1", status: "applied", attempts: 1, createdAt: new Date("2026-10-09T00:00:00.000Z"), updatedAt: new Date("2026-10-09T00:00:00.000Z") },
      ],
    });
  });

  it("calls findUnique by id with applications included", async () => {
    await getGroomingRunDetail(mockPrisma, "run-1");

    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: "run-1" },
      include: {
        issue: { include: { repository: true } },
        repo: true,
        agentRun: true,
        applications: {
          orderBy: { createdAt: "desc" },
          select: { id: true, status: true, attempts: true, createdAt: true, updatedAt: true },
        },
      },
    });
  });

  it("returns null when run not found", async () => {
    mocks.findUnique.mockResolvedValue(null);

    const result = await getGroomingRunDetail(mockPrisma, "nonexistent");

    expect(result).toBeNull();
  });

  it("returns the full detail object with the operator view attached", async () => {
    const result = (await getGroomingRunDetail(mockPrisma, "run-1")) as unknown as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result.id).toBe("run-1");
    expect(result.issue).toBeDefined();
    expect(result.repo).toBeDefined();
    expect(result.applications).toHaveLength(1);
    const view = result.view as { application: { applicationCount: number | null } };
    expect(view.application.applicationCount).toBe(1);
  });
});
