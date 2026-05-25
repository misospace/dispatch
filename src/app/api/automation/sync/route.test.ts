import { describe, expect, it, vi, beforeEach } from "vitest";

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => ({
  isAuthorizedAgentToken: vi.fn((token) => token === mockToken),
  isAuthorizedBearerToken: vi.fn((token) => token === mockToken),
  getAcceptedAgentTokens: vi.fn(() => [mockToken]),
  resetCaches: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  getTrackedRepos: vi.fn().mockResolvedValue([]),
}));

import { POST } from "./route";

describe("POST /api/automation/sync — auth", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(new Request("http://localhost/api/automation/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(new Request("http://localhost/api/automation/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(401);
  });

  it("returns 200 when valid token is provided (no repos to sync)", async () => {
    const res = await POST(new Request("http://localhost/api/automation/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(200);
  });
});
