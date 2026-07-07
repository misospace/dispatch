import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mockToken = "test-agent-token";

vi.mock("@/lib/dispatch-env", () => ({
  isAuthorizedAgentToken: vi.fn((token) => token === mockToken),
  isAuthorizedBearerToken: vi.fn((token) => token === mockToken),
  getAcceptedAgentTokens: vi.fn(() => [mockToken]),
  resetCaches: vi.fn(),
  safeEqual: vi.fn((a, b) => a === b),
}));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    runHostedGroomer: vi.fn(),
    getHostedGroomerConfig: vi.fn(),
    prisma: {
      issue: {
        findFirst: vi.fn(),
      },
    },
  },
}));

vi.mock("@/lib/groomer/run", () => ({
  runHostedGroomer: mocks.runHostedGroomer,
}));

vi.mock("@/lib/groomer/config", () => ({
  getHostedGroomerConfig: mocks.getHostedGroomerConfig,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

import { POST } from "./route";
import { resetRateLimits } from "@/lib/rate-limit";

function request(url = "/api/groomer/run", includeAuth = true) {
  const headers: Record<string, string> = {};
  if (includeAuth) headers.Authorization = `Bearer ${mockToken}`;
  return new Request(`http://localhost${url}`, { method: "POST", headers });
}

describe("POST /api/groomer/run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    process.env.DISPATCH_AGENT_TOKEN = mockToken;
    mocks.runHostedGroomer.mockResolvedValue({
      candidateNumber: 42,
      repoFullName: "org/repo",
      dryRun: true,
      output: {},
      plannedLabels: ["status/ready"],
      groomingRunId: "run-1",
      contextWarnings: [],
      mutationPlan: { labelsToAdd: ["status/ready"], labelsToRemove: [] },
      appliedMutations: {},
    });
  });

  afterEach(() => {
    delete process.env.DISPATCH_AGENT_TOKEN;
    delete process.env.DISPATCH_GROOMER_TOKEN;
  });

  it("returns 401 when no authorization header", async () => {
    const res = await POST(request("/api/groomer/run", false));
    expect(res.status).toBe(401);
  });

  it("returns 503 when groomer is disabled", async () => {
    mocks.getHostedGroomerConfig.mockReturnValue({
      enabled: false,
      dryRun: true,
      llmBaseUrl: null,
      apiKey: null,
      model: "gpt-4o-mini",
      timeoutMs: 60000,
      maxContextBytes: 8192,
    });

    const res = await POST(request());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("disabled");
  });

  it("runs groomer and returns result on success", async () => {
    mocks.runHostedGroomer.mockResolvedValue({
      candidateNumber: 42,
      repoFullName: "org/repo",
      dryRun: true,
      output: {},
      plannedLabels: ["status/ready"],
      groomingRunId: "run-1",
      contextWarnings: [],
      mutationPlan: { labelsToAdd: ["status/ready"], labelsToRemove: [] },
      appliedMutations: {},
    });
    mocks.getHostedGroomerConfig.mockReturnValue({
      enabled: true,
      dryRun: true,
      llmBaseUrl: "https://llm.example.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      timeoutMs: 60000,
      maxContextBytes: 8192,
    });

    const res = await POST(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidateNumber).toBe(42);
    expect(body.dryRun).toBe(true);
    expect(body.groomingRunId).toBe("run-1");
    expect(body.contextWarnings).toEqual([]);
    expect(body.mutationPlan).toBeDefined();
    expect(body.appliedMutations).toBeDefined();
  });

  it("passes request options through to groomer", async () => {
    mocks.getHostedGroomerConfig.mockReturnValue({
      enabled: true,
      dryRun: true,
      llmBaseUrl: "https://llm.example.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      timeoutMs: 60000,
      maxContextBytes: 8192,
    });
    // Mock the prisma lookup for the closed-issue guard
    mocks.prisma.issue.findFirst.mockResolvedValue({
      state: "open",
      labels: ["type/bug"],
    });

    await POST(new Request("http://localhost/api/groomer/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${mockToken}` },
      body: JSON.stringify({ dryRun: false, repoFullName: "org/repo", issueNumber: 42, force: true }),
    }));

    expect(mocks.runHostedGroomer).toHaveBeenCalledWith({
      dryRun: false,
      repoFullName: "org/repo",
      issueNumber: 42,
      force: true,
    });
  });

  it("returns 500 when groomer run throws", async () => {
    mocks.getHostedGroomerConfig.mockReturnValue({
      enabled: true,
      dryRun: true,
      llmBaseUrl: "https://llm.example.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      timeoutMs: 60000,
      maxContextBytes: 8192,
    });
    mocks.runHostedGroomer.mockRejectedValue(new Error("LLM error"));

    const res = await POST(request());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Hosted groomer run failed");
  });

  it("returns null result when no candidate available", async () => {
    mocks.getHostedGroomerConfig.mockReturnValue({
      enabled: true,
      dryRun: true,
      llmBaseUrl: "https://llm.example.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      timeoutMs: 60000,
      maxContextBytes: 8192,
    });
    mocks.runHostedGroomer.mockResolvedValue(null);

    const res = await POST(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidateNumber).toBeNull();
  });

  it("accepts DISPATCH_GROOMER_TOKEN bearer auth", async () => {
    process.env.DISPATCH_GROOMER_TOKEN = "groomer-token";
    mocks.getHostedGroomerConfig.mockReturnValue({
      enabled: true,
      dryRun: true,
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
      groomerToken: "groomer-token",
    });

    const res = await POST(new Request("http://localhost/api/groomer/run", {
      method: "POST",
      headers: { Authorization: "Bearer groomer-token" },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidateNumber).toBe(42);
    expect(body.groomingRunId).toBe("run-1");
  });

  // --- Closed issue guards ---

  it("returns 400 when grooming a closed issue", async () => {
    mocks.getHostedGroomerConfig.mockReturnValue({
      enabled: true,
      dryRun: true,
      llmBaseUrl: "https://llm.example.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      timeoutMs: 60000,
      maxContextBytes: 8192,
    });
    mocks.prisma.issue.findFirst.mockResolvedValue({
      state: "closed",
      labels: ["status/done"],
    });

    const res = await POST(new Request("http://localhost/api/groomer/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${mockToken}` },
      body: JSON.stringify({ repoFullName: "org/repo", issueNumber: 460 }),
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Cannot groom a closed issue");
    // Should NOT call the groomer
    expect(mocks.runHostedGroomer).not.toHaveBeenCalled();
  });

  it("returns 400 when grooming an issue with status/done label", async () => {
    mocks.getHostedGroomerConfig.mockReturnValue({
      enabled: true,
      dryRun: true,
      llmBaseUrl: "https://llm.example.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      timeoutMs: 60000,
      maxContextBytes: 8192,
    });
    mocks.prisma.issue.findFirst.mockResolvedValue({
      state: "open",
      labels: ["status/done", "type/bug"],
    });

    const res = await POST(new Request("http://localhost/api/groomer/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${mockToken}` },
      body: JSON.stringify({ repoFullName: "org/repo", issueNumber: 460 }),
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Cannot groom an issue with status/done label");
    // Should NOT call the groomer
    expect(mocks.runHostedGroomer).not.toHaveBeenCalled();
  });

  it("returns 404 when grooming a non-existent issue", async () => {
    mocks.getHostedGroomerConfig.mockReturnValue({
      enabled: true,
      dryRun: true,
      llmBaseUrl: "https://llm.example.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      timeoutMs: 60000,
      maxContextBytes: 8192,
    });
    mocks.prisma.issue.findFirst.mockResolvedValue(null);

    const res = await POST(new Request("http://localhost/api/groomer/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${mockToken}` },
      body: JSON.stringify({ repoFullName: "org/repo", issueNumber: 9999 }),
    }));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Issue #9999 not found");
    // Should NOT call the groomer
    expect(mocks.runHostedGroomer).not.toHaveBeenCalled();
  });

  it("skips closed-issue guard when no issueNumber provided (auto-select mode)", async () => {
    mocks.getHostedGroomerConfig.mockReturnValue({
      enabled: true,
      dryRun: true,
      llmBaseUrl: "https://llm.example.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      timeoutMs: 60000,
      maxContextBytes: 8192,
    });

    const res = await POST(new Request("http://localhost/api/groomer/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${mockToken}` },
      body: JSON.stringify({ dryRun: true }),
    }));

    expect(res.status).toBe(200);
    // The guard should not have been triggered (no issueNumber)
    expect(mocks.prisma.issue.findFirst).not.toHaveBeenCalled();
    expect(mocks.runHostedGroomer).toHaveBeenCalled();
  });

  it("returns 429 with Retry-After after exceeding the rate limit", async () => {
    mocks.getHostedGroomerConfig.mockReturnValue({
      enabled: true,
      dryRun: true,
      llmBaseUrl: "https://llm.example.com",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      timeoutMs: 60000,
      maxContextBytes: 8192,
    });

    // Exhaust the per-actor limit (10/min).
    for (let i = 0; i < 10; i++) {
      const res = await POST(request());
      expect(res.status).toBe(200);
    }

    const res = await POST(request());
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = await res.json();
    expect(body.error).toBe("Rate limit exceeded");
  });
});
