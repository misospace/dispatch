import { describe, expect, it, vi, beforeEach } from "vitest";

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
    runHostedGroomer: vi.fn(),
    getHostedGroomerConfig: vi.fn(),
  },
}));

vi.mock("@/lib/groomer/run", () => ({
  runHostedGroomer: mocks.runHostedGroomer,
}));

vi.mock("@/lib/groomer/config", () => ({
  getHostedGroomerConfig: mocks.getHostedGroomerConfig,
}));

import { POST } from "./route";

function request(url = "/api/groomer/run", includeAuth = true) {
  const headers: Record<string, string> = {};
  if (includeAuth) headers.Authorization = `Bearer ${mockToken}`;
  return new Request(`http://localhost${url}`, { method: "POST", headers });
}

describe("POST /api/groomer/run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runHostedGroomer.mockResolvedValue({
      candidateNumber: 42,
      repoFullName: "org/repo",
      dryRun: true,
      output: {},
    });
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
    expect(body.error).toBeDefined();
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
});
