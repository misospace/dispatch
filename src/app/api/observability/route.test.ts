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
    groomingRun: delegate({ findMany: vi.fn().mockResolvedValue([]) }),
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

describe("GET /api/observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mocks.issueSyncRun.findMany.mockResolvedValue([]);
    mocks.issueSyncRun.findFirst.mockResolvedValue(null);
    mocks.issueSyncRun.count.mockResolvedValue(0);
    mocks.automationRepo.findMany.mockResolvedValue([]);
  });

  it("401s an unauthenticated request", async () => {
    const res = await GET(authedRequest("http://localhost/api/observability", { includeAuth: false }));
    expect(res.status).toBe(401);
  });

  it("403s a worker-tier token", async () => {
    const res = await GET(authedRequest("http://localhost/api/observability", { token: "worker-token" }));
    expect(res.status).toBe(403);
  });

  it("returns the read-only snapshot to a maintainer caller", async () => {
    process.env.DISPATCH_QUEUE_ADMISSION_MODE = "off";

    const res = await GET(authedRequest("http://localhost/api/observability"));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(typeof body.generatedAt).toBe("string");
    expect(body.source).toBe("dispatch-cache");
    expect(body.windows.failures).toEqual([900, 3600]);
    expect(body.windows.activity).toEqual([1800, 3600]);
    expect(body.config.admissionMode).toBe("off");
    for (const write of writes) {
      expect(write).not.toHaveBeenCalled();
    }
  });
});
