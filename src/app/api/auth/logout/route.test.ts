import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

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
