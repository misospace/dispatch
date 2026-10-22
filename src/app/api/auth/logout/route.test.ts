import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock } from "@/test/route-helpers";
import { resetRateLimits } from "@/lib/rate-limit";

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

function makeLogoutRequest(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/auth/logout", { method: "POST", headers });
}

describe("POST /api/auth/logout", () => {
  // NOTE: This route is intentionally unauthenticated. It clears the session
  // and is designed to be called by logged-in users to end their session.
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
  });

  it("calls signOut without redirect", async () => {
    const res = await POST(makeLogoutRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("passes redirect: false to signOut", async () => {
    await POST(makeLogoutRequest());

    expect(mocks.signOut).toHaveBeenCalledWith({ redirect: false });
  });
});

describe("POST /api/auth/logout — rate limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
  });

  it("returns 429 after exceeding the rate limit (10 per 60s per IP) without signing out", async () => {
    // All requests share the "unknown" fallback key when no
    // x-forwarded-for header is present.
    for (let i = 0; i < 10; i++) {
      const res = await POST(makeLogoutRequest());
      expect(res.status).toBe(200);
    }

    const res = await POST(makeLogoutRequest());
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: "Rate limit exceeded" });
    // The rejected request signed nothing out.
    expect(mocks.signOut).toHaveBeenCalledTimes(10);
  });

  it("keys the window per client IP", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await POST(makeLogoutRequest({ "x-forwarded-for": "203.0.113.7" }));
      expect(res.status).toBe(200);
    }

    // A different client IP has its own window.
    const otherIp = await POST(makeLogoutRequest({ "x-forwarded-for": "198.51.100.9" }));
    expect(otherIp.status).toBe(200);

    const res = await POST(makeLogoutRequest({ "x-forwarded-for": "203.0.113.7" }));
    expect(res.status).toBe(429);
  });

  it("uses the rightmost (trusted) x-forwarded-for entry, so rotating the forged leftmost value does not reset the window", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await POST(
        makeLogoutRequest({ "x-forwarded-for": `forged-${i}, 203.0.113.5` })
      );
      expect(res.status).toBe(200);
    }

    // Same trusted peer IP despite a fresh forged leftmost entry: still limited.
    const res = await POST(
      makeLogoutRequest({ "x-forwarded-for": "forged-final, 203.0.113.5" })
    );
    expect(res.status).toBe(429);
    expect(mocks.signOut).toHaveBeenCalledTimes(10);
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await POST(makeLogoutRequest({ "x-real-ip": "192.0.2.44" }));
      expect(res.status).toBe(200);
    }

    const limited = await POST(makeLogoutRequest({ "x-real-ip": "192.0.2.44" }));
    expect(limited.status).toBe(429);

    // No headers at all uses the separate "unknown" bucket.
    const unknown = await POST(makeLogoutRequest());
    expect(unknown.status).toBe(200);
  });
});
