import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildIssueContext, fetchIssueComments } from "./context";

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
    fetchGitHubIssueComments: vi.fn(),
  },
}));

vi.mock("@/lib/github", () => ({
  fetchIssueComments: mocks.fetchGitHubIssueComments,
}));

describe("buildIssueContext", () => {
  it("returns context with title, body, and labels from DB issue", async () => {
    const result = await buildIssueContext({
      number: 42,
      title: "Fix login bug",
      body: "Users cannot log in after password reset.",
      labels: ["priority/p0", "status/ready"],
      currentLane: "local",
      comments: [],
    });

    expect(result).toContain("#42: Fix login bug");
    expect(result).toContain("body:");
    expect(result).toContain("Users cannot log in after password reset");
    expect(result).toContain("labels: priority/p0, status/ready");
  });

  it("handles null body gracefully", async () => {
    const result = await buildIssueContext({
      number: 42,
      title: "No body issue",
      body: null,
      labels: [],
      currentLane: null,
      comments: [],
    });

    expect(result).toContain("#42: No body issue");
    expect(result).toContain("(no body)");
  });

  it("includes recent comments in context", async () => {
    const result = await buildIssueContext({
      number: 42,
      title: "Fix bug",
      body: "Something is broken.",
      labels: ["priority/p1"],
      currentLane: "local",
      comments: [
        { author: "alice", body: "I can reproduce this.", createdAt: "2026-01-01T00:00:00Z" },
        { author: "bob", body: "Found the root cause.", createdAt: "2026-01-02T00:00:00Z" },
      ],
    });

    expect(result).toContain("alice");
    expect(result).toContain("I can reproduce this");
    expect(result).toContain("bob");
    expect(result).toContain("Found the root cause");
  });

  it("truncates body to maxContextBytes", async () => {
    const longBody = "x".repeat(20000);
    const result = await buildIssueContext({
      number: 42,
      title: "Long body issue",
      body: longBody,
      labels: [],
      currentLane: null,
      comments: [],
      maxContextBytes: 1024,
    });

    expect(result.length).toBeLessThan(2000);
  });

  it("includes lane info when available", async () => {
    const result = await buildIssueContext({
      number: 42,
      title: "Test issue",
      body: "test",
      labels: ["status/backlog"],
      currentLane: "backlog",
      comments: [],
    });

    expect(result).toContain("lane: backlog");
  });
});

describe("fetchIssueComments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches comments bounded to max 5", async () => {
    const mockComments = Array.from({ length: 10 }, (_, i) => ({
      user: { login: `user${i}` },
      body: `Comment ${i}`,
      created_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }));

    mocks.fetchGitHubIssueComments.mockResolvedValue(mockComments);

    const result = await fetchIssueComments("org/repo", 42);
    expect(result.length).toBeLessThanOrEqual(5);
    expect(mocks.fetchGitHubIssueComments).toHaveBeenCalledWith("org/repo", 42, 5);
  });

  it("propagates comment fetch failures so the run can fail cleanly", async () => {
    mocks.fetchGitHubIssueComments.mockRejectedValue(new Error("network error"));

    await expect(fetchIssueComments("org/repo", 42)).rejects.toThrow("network error");
  });
});
