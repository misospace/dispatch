import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks } = vi.hoisted(() => ({
  mocks: {
    queryRaw: vi.fn().mockResolvedValue([{ "1": 1 }]),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
  },
}));

vi.mock("@/lib/version", () => ({
  getAppVersion: vi.fn(() => "0.1.0"),
}));

import { GET } from "./route";

describe("GET /api/health", () => {
  // NOTE: This route is intentionally public. It does not require authentication
  // and is designed to be used by load balancers, health check probes, etc.
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DISPATCH_AUTH_MODE;
    mocks.queryRaw.mockResolvedValue([{ "1": 1 }]);
  });

  it("returns ok status without authentication", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.database).toBe("ok");
    expect(body.version).toBe("0.1.0");
  });

  it("includes authMode in response", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authMode).toBeDefined();
  });

  it("returns 503 when database is unreachable", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("connection refused"));

    const res = await GET();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.database).toBe("error");
    expect(body.version).toBe("0.1.0");
  });
});
