import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMockWithSafeEqual, authedRequest } from "@/test/route-helpers";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMockWithSafeEqual(mockToken));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    itemFindUnique: vi.fn(),
    evaluateExternalWaitTrigger: vi.fn().mockResolvedValue("unsatisfied"),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    prFixQueueItem: { findUnique: mocks.itemFindUnique },
  },
}));

vi.mock("@/lib/pr-fix-external-wait", () => ({
  evaluateExternalWaitTrigger: mocks.evaluateExternalWaitTrigger,
  parseStoredExternalWait: (raw: unknown) => (raw && typeof raw === "object" ? raw : null),
}));

import { GET } from "./route";

const item = (overrides: Record<string, unknown> = {}) => ({
  id: "pf1",
  repo: "org/repo",
  pr: 42,
  status: "WAITING_EXTERNAL",
  retryAt: new Date("2026-10-15T18:00:00Z"),
  externalWait: { kind: "upstream_pr", ref: "org/deps#7", evidence: "upstream PR open", trigger: { kind: "merged" } },
  ...overrides,
});

const request = (query = "") => `http://localhost/api/pr-fix-queue/external-wait${query}`;
const BASIC = `Basic ${Buffer.from("op:op-pass").toString("base64")}`;
const operatorRequest = (query = "") => authedRequest(request(query), { headers: { Authorization: BASIC } });

describe("GET /api/pr-fix-queue/external-wait (#1250)", () => {
  beforeEach(() => {
    process.env.DISPATCH_AUTH_USERNAME = "op";
    process.env.DISPATCH_AUTH_PASSWORD = "op-pass";
    process.env.DISPATCH_AUTH_MODE = "basic";
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
    mocks.evaluateExternalWaitTrigger.mockResolvedValue("unsatisfied");
  });

  it("rejects an unauthenticated request", async () => {
    const res = await GET(new Request(request("?repo=org/repo&pr=42")));
    expect(res.status).toBe(401);
  });

  it("rejects agent bearer callers (operator auth required)", async () => {
    const res = await GET(authedRequest(request("?repo=org/repo&pr=42"), { token: mockToken }));
    expect(res.status).toBe(403);
  });

  it("400s without repo and pr", async () => {
    const res = await GET(operatorRequest(""));
    expect(res.status).toBe(400);
  });

  it("404s an unknown item", async () => {
    mocks.itemFindUnique.mockResolvedValue(null);
    const res = await GET(operatorRequest("?repo=org/repo&pr=42"));
    expect(res.status).toBe(404);
  });

  it("409s an item that is not WAITING_EXTERNAL", async () => {
    mocks.itemFindUnique.mockResolvedValue(item({ status: "QUEUED" }));
    const res = await GET(operatorRequest("?repo=org/repo&pr=42"));
    expect(res.status).toBe(409);
  });

  it("flags a legacy free-text wait as unknown, held for operator action", async () => {
    mocks.itemFindUnique.mockResolvedValue(item({ externalWait: null }));
    const res = await GET(operatorRequest("?repo=org/repo&pr=42"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ legacyWait: true, evaluation: "unknown", wait: null });
    expect(body.reason).toContain("legacy");
  });

  it("evaluates a structured wait read-only and never mutates", async () => {
    const stored = item();
    mocks.itemFindUnique.mockResolvedValue(stored);
    const res = await GET(operatorRequest("?repo=org/repo&pr=42"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      legacyWait: false,
      evaluation: "unsatisfied",
      wait: { kind: "upstream_pr", ref: "org/deps#7" },
      recheckAt: "2026-10-15T18:00:00.000Z",
    });
    expect(mocks.evaluateExternalWaitTrigger).toHaveBeenCalledWith(expect.objectContaining({ kind: "upstream_pr" }), "org/repo");
    expect(stored.status).toBe("WAITING_EXTERNAL");
  });
});
