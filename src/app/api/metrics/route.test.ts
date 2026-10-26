import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock(mockToken, { "worker-token": "worker" }));

const { mocks, writes } = vi.hoisted(() => {
  const writeMethodNames = ["create", "update", "updateMany", "upsert", "delete", "deleteMany"] as const;
  type MockFn = ReturnType<typeof vi.fn>;
  const writes: Array<MockFn> = [];
  const delegate = (reads: Record<string, MockFn>) => {
    const out: Record<string, MockFn> = { ...reads };
    for (const name of writeMethodNames) {
      const fn = vi.fn().mockRejectedValue(new Error(`write attempted: ${name}`));
      out[name] = fn;
      writes.push(fn);
    }
    return out;
  };
  const mocks = {
    issue: delegate({
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    }),
    lease: delegate({ findMany: vi.fn().mockResolvedValue([]) }),
    agentWork: delegate({ findMany: vi.fn().mockResolvedValue([]) }),
    prFixQueueItem: delegate({ findMany: vi.fn().mockResolvedValue([]) }),
    prFixHistory: delegate({ findMany: vi.fn().mockResolvedValue([]) }),
    agentRun: delegate({ findMany: vi.fn().mockResolvedValue([]) }),
    auditLog: delegate({ findMany: vi.fn().mockResolvedValue([]) }),
    groomingRun: delegate({
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    }),
    issueSyncRun: delegate({
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    }),
    automationRepo: delegate({ findMany: vi.fn().mockResolvedValue([]) }),
  };
  return { mocks, writes };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks }));

import { GET } from "./route";

describe("GET /api/metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DISPATCH_METRICS_ENABLED;
    mocks.issue.findMany.mockResolvedValue([]);
    mocks.issue.findFirst.mockResolvedValue(null);
    mocks.issue.count.mockResolvedValue(0);
    mocks.lease.findMany.mockResolvedValue([]);
    mocks.agentWork.findMany.mockResolvedValue([]);
    mocks.prFixQueueItem.findMany.mockResolvedValue([]);
    mocks.prFixHistory.findMany.mockResolvedValue([]);
    mocks.agentRun.findMany.mockResolvedValue([]);
    mocks.auditLog.findMany.mockResolvedValue([]);
    mocks.groomingRun.findMany.mockResolvedValue([]);
    mocks.groomingRun.findFirst.mockResolvedValue(null);
    mocks.issueSyncRun.findMany.mockResolvedValue([]);
    mocks.issueSyncRun.findFirst.mockResolvedValue(null);
    mocks.issueSyncRun.count.mockResolvedValue(0);
    mocks.automationRepo.findMany.mockResolvedValue([]);
  });

  it("404s while the export is disabled (fail-closed default)", async () => {
    const res = await GET(authedRequest("http://localhost/api/metrics"));
    expect(res.status).toBe(404);
  });

  it("404s before auth even for unauthenticated callers while disabled", async () => {
    const res = await GET(authedRequest("http://localhost/api/metrics", { includeAuth: false }));
    expect(res.status).toBe(404);
  });

  it("401s an unauthenticated request when enabled", async () => {
    process.env.DISPATCH_METRICS_ENABLED = "true";
    const res = await GET(authedRequest("http://localhost/api/metrics", { includeAuth: false }));
    expect(res.status).toBe(401);
  });

  it("403s a worker-tier token when enabled", async () => {
    process.env.DISPATCH_METRICS_ENABLED = "true";
    const res = await GET(authedRequest("http://localhost/api/metrics", { token: "worker-token" }));
    expect(res.status).toBe(403);
  });

  it("renders the exposition to a maintainer caller without writing anything", async () => {
    process.env.DISPATCH_METRICS_ENABLED = "true";
    const res = await GET(authedRequest("http://localhost/api/metrics"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("# TYPE dispatch_health_up gauge");
    expect(body).toContain("dispatch_health_up 1");
    for (const write of writes) {
      expect(write).not.toHaveBeenCalled();
    }
  });
});
