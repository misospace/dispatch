import { describe, expect, it, vi, beforeEach } from "vitest";
import { selectGroomingCandidate } from "./selector";

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
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.issueFindMany },
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

  it("returns null when all issues are fully labeled", async () => {
    mocks.issueFindMany.mockResolvedValue([
      {
        number: 10,
        title: "Fully labeled",
        url: "https://github.com/org/repo/issues/10",
        labels: ["status/ready", "priority/p0", "agent/alice"],
        currentLane: "local",
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
});
