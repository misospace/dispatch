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
    signOut: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/auth-next", () => ({
  signOut: mocks.signOut,
}));

import { POST } from "./route";

describe("POST /api/auth/logout", () => {
  // NOTE: This route is intentionally unauthenticated. It clears the session
  // and is designed to be called by logged-in users to end their session.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls signOut without redirect", async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("passes redirect: false to signOut", async () => {
    await POST();

    expect(mocks.signOut).toHaveBeenCalledWith({ redirect: false });
  });
});
