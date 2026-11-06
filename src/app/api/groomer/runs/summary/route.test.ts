import { describe, expect, it, vi, beforeEach } from "vitest";
import { authedRequest } from "@/test/route-helpers";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    authorizeRequest: vi.fn(),
    summarizeObserveRuns: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({
  authorizeRequest: mocks.authorizeRequest,
  authErrorResponse: vi.fn((auth: { forbidden?: boolean }) =>
    new Response(JSON.stringify({ error: auth.forbidden ? "Forbidden" : "Unauthorized" }), {
      status: auth.forbidden ? 403 : 401,
      headers: { "content-type": "application/json" },
    }),
  ),
}));

vi.mock("@/lib/groomer/history", () => ({
  summarizeObserveRuns: mocks.summarizeObserveRuns,
}));

import { GET } from "./route";

function request(url = "/api/groomer/runs/summary", includeAuth = true) {
  return authedRequest(`http://localhost${url}`, { token: "test-token", includeAuth });
}

describe("GET /api/groomer/runs/summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeRequest.mockResolvedValue({ authorized: true, type: "bearer", actor: "test" });
    mocks.summarizeObserveRuns.mockResolvedValue({
      windowMs: 24 * 60 * 60 * 1000,
      since: "2026-11-03T12:00:00.000Z",
      total: 3,
      would_act: 2,
      would_noop: 0,
      would_refuse: 1,
      assessment_unavailable: 0,
    });
  });

  it("returns 401 when unauthorized", async () => {
    mocks.authorizeRequest.mockResolvedValue({ authorized: false });

    const res = await GET(request("/api/groomer/runs/summary", false));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns the observe window summary", async () => {
    const res = await GET(request());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ total: 3, would_act: 2, would_refuse: 1 });
    expect(mocks.summarizeObserveRuns).toHaveBeenCalledWith(
      expect.anything(),
      { windowMs: 24 * 60 * 60 * 1000 },
    );
  });

  it("parses windowHours", async () => {
    await GET(request("/api/groomer/runs/summary?windowHours=72"));

    expect(mocks.summarizeObserveRuns).toHaveBeenCalledWith(
      expect.anything(),
      { windowMs: 72 * 60 * 60 * 1000 },
    );
  });

  it("falls back to the default window on a non-numeric value", async () => {
    await GET(request("/api/groomer/runs/summary?windowHours=abc"));

    expect(mocks.summarizeObserveRuns).toHaveBeenCalledWith(
      expect.anything(),
      { windowMs: 24 * 60 * 60 * 1000 },
    );
  });

  it("clamps an oversized windowHours at 720", async () => {
    await GET(request("/api/groomer/runs/summary?windowHours=99999"));

    expect(mocks.summarizeObserveRuns).toHaveBeenCalledWith(
      expect.anything(),
      { windowMs: 720 * 60 * 60 * 1000 },
    );
  });

  it("returns 500 when the summary throws", async () => {
    mocks.summarizeObserveRuns.mockRejectedValue(new Error("database error"));

    const res = await GET(request());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to summarize observe runs");
  });
});
