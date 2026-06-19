import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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
    findManyIssues: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.findManyIssues },
  },
}));

import { GET } from "./route";
import { resetAuthCaches } from "@/lib/auth";

function makeRequest(urlString: string, includeAuth = true) {
  const headers: Record<string, string> = {};
  if (includeAuth) headers.Authorization = `Bearer ${mockToken}`;
  return GET(new Request(urlString, { headers }));
}

describe("GET /api/issues — auth", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    delete process.env.DISPATCH_DONE_RETENTION_DAYS;
    mocks.findManyIssues.mockResolvedValue([]);
  });

  it("returns 401 when no auth header is present", async () => {
    const res = await makeRequest("http://localhost/api/issues", false);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 for bad bearer token", async () => {
    const headers: Record<string, string> = { Authorization: "Bearer wrong-token" };
    const res = await GET(new Request("http://localhost/api/issues", { headers }));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("authorized request preserves existing issue listing behavior", async () => {
    mocks.findManyIssues.mockResolvedValue([
      { id: "1", title: "Test", state: "open" },
    ]);

    const res = await makeRequest("http://localhost/api/issues");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("1");
  });

  it("unauthorized request does not call prisma.issue.findMany", async () => {
    await makeRequest("http://localhost/api/issues", false);

    expect(mocks.findManyIssues).not.toHaveBeenCalled();
  });

  it("authorized invalid lane still returns 400", async () => {
    const res = await makeRequest("http://localhost/api/issues?lane=unknown-lane");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid lane: "unknown-lane"');
  });
});

describe("GET /api/issues — visible issue filtering", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    delete process.env.DISPATCH_DONE_RETENTION_DAYS;
    mocks.findManyIssues.mockResolvedValue([]);
  });

  it("defaults to open issues + recently closed Done issues (7-day retention)", async () => {
    await makeRequest("http://localhost/api/issues");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.OR).toBeDefined();
    expect(Array.isArray(call.where.OR)).toBe(true);
    expect(call.where.OR.length).toBe(2);
    expect(call.where.OR[0]).toEqual({ state: "open" });
    expect(call.where.OR[1].state).toBe("closed");
    expect(call.where.OR[1].labels.has).toBe("status/done");
    expect(call.where.OR[1].closedAt.gte).toBeDefined();
  });

  it("includes all issues when includeClosed=true", async () => {
    await makeRequest("http://localhost/api/issues?includeClosed=true");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.OR).toBeUndefined();
    expect(call.where.state).toBeUndefined();
  });

  it("respects DISPATCH_DONE_RETENTION_DAYS environment variable", async () => {
    process.env.DISPATCH_DONE_RETENTION_DAYS = "30";
    await makeRequest("http://localhost/api/issues");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.OR).toBeDefined();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    expect(call.where.OR[1].closedAt.gte).toBeTruthy();
  });

  it("filters by repository", async () => {
    await makeRequest("http://localhost/api/issues?repo=myorg/myrepo");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.repository).toEqual({ enabled: true, fullName: "myorg/myrepo" });
  });

  it("filters by agent label", async () => {
    await makeRequest("http://localhost/api/issues?agent=agent/alpha");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.labels).toEqual({ has: "agent/alpha" });
  });

  it("filters by owner label", async () => {
    await makeRequest("http://localhost/api/issues?owner=owner/alice");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.labels).toEqual({ has: "owner/alice" });
  });

  it("filters by priority label", async () => {
    await makeRequest("http://localhost/api/issues?priority=priority/p1");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.labels).toEqual({ has: "priority/p1" });
  });

  it("filters by project label", async () => {
    await makeRequest("http://localhost/api/issues?project=api");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.labels).toEqual({ has: "project/api" });
  });

  it("filters by decomposed status", async () => {
    await makeRequest("http://localhost/api/issues?decomposed=true");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.decomposed).toBe(true);
  });

  it("filters for untriaged issues (no status label) when untriaged=true", async () => {
    await makeRequest("http://localhost/api/issues?untriaged=true");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.AND).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          NOT: { labels: { hasSome: expect.arrayContaining([
            "status/backlog",
            "status/ready",
            "status/in-progress",
            "status/in-review",
            "status/done",
          ]) } },
        }),
      ]),
    );
  });

  it("does not add no-status filter when untriaged is not true", async () => {
    await makeRequest("http://localhost/api/issues?untriaged=false");

    const call = mocks.findManyIssues.mock.calls[0][0];
    const andClauses = call.where.AND ?? [];
    expect(andClauses).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ NOT: { labels: { hasSome: expect.arrayContaining(["status/ready"]) } } }),
      ]),
    );
  });

  it("combines untriaged filter with agent filter", async () => {
    await makeRequest("http://localhost/api/issues?untriaged=true&agent=agent/alpha");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.labels.has).toBe("agent/alpha");
    expect(call.where.AND).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          NOT: { labels: { hasSome: expect.arrayContaining(["status/ready"]) } },
        }),
      ]),
    );
  });

  it("orders by updatedAt descending", async () => {
    await makeRequest("http://localhost/api/issues");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.orderBy).toEqual({ updatedAt: "desc" });
  });

  it("includes repository relation", async () => {
    await makeRequest("http://localhost/api/issues");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.include).toEqual({ repository: true });
  });

  it("combines agent, owner, and priority label filters", async () => {
    await makeRequest(
      "http://localhost/api/issues?agent=agent/alpha&owner=owner/alice&priority=priority/p1"
    );

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.labels).toEqual({ hasEvery: ["agent/alpha", "owner/alice", "priority/p1"] });
  });

  it("returns JSON array of issues", async () => {
    const expectedIssues = [
      { id: "1", title: "Test", state: "open" },
      { id: "2", title: "Another", state: "closed" },
    ];
    mocks.findManyIssues.mockResolvedValueOnce(expectedIssues);

    const res = await makeRequest("http://localhost/api/issues");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(expectedIssues);
  });

  it("returns 500 on database error", async () => {
    mocks.findManyIssues.mockRejectedValueOnce(new Error("db connection failed"));

    const res = await makeRequest("http://localhost/api/issues");
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to fetch issues");
  });

  it("returns 400 for invalid lane filter", async () => {
    const res = await makeRequest("http://localhost/api/issues?lane=unknown-lane");
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('Invalid lane: "unknown-lane"');
  });

  it("filters by valid configured lane", async () => {
    await makeRequest("http://localhost/api/issues?lane=normal");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.currentLane).toEqual({ in: ["normal"] });
  });

  it("filters by backlog lane", async () => {
    await makeRequest("http://localhost/api/issues?lane=backlog");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.currentLane).toEqual({ in: ["backlog"] });
  });

  it("excludes Renovate issues from API results", async () => {
    await makeRequest("http://localhost/api/issues");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.AND).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          NOT: expect.objectContaining({
            OR: expect.arrayContaining([
              { labels: { hasSome: ["renovate", "dependencies", "automated"] } },
            ]),
          }),
        }),
      ]),
    );
  });
});

describe("GET /api/issues — lane aliases", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    delete process.env.DISPATCH_DONE_RETENTION_DAYS;
    mocks.findManyIssues.mockResolvedValue([]);
  });

  afterEach(async () => {
    // Reset lane config after each test
    const { resetLaneConfig } = await import("@/lib/lane-config");
    resetLaneConfig();
  });

  it("resolves aliased lane filter to configured lane with OR query", async () => {
    const { setLaneConfig } = await import("@/lib/lane-config");
    setLaneConfig({
      lanes: [
        { id: "local", title: "Local", claimable: true, role: "default" },
        { id: "parking-lot", title: "Parking Lot", claimable: false },
      ],
      laneAliases: { normal: "local", backlog: "parking-lot" },
    });

    await makeRequest("http://localhost/api/issues?lane=normal");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.currentLane).toEqual({ in: ["local", "normal"] });
  });

  it("resolves aliased lane filter when requesting by configured lane name", async () => {
    const { setLaneConfig } = await import("@/lib/lane-config");
    setLaneConfig({
      lanes: [
        { id: "local", title: "Local", claimable: true },
        { id: "parking-lot", title: "Parking Lot", claimable: false },
      ],
      laneAliases: { normal: "local" },
    });

    await makeRequest("http://localhost/api/issues?lane=local");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.currentLane).toEqual({ in: ["local", "normal"] });
  });

  it("returns 400 for unknown lane filter even with aliases configured", async () => {
    const { setLaneConfig } = await import("@/lib/lane-config");
    setLaneConfig({
      lanes: [
        { id: "local", title: "Local", claimable: true },
      ],
      laneAliases: { normal: "local" },
    });

    const res = await makeRequest("http://localhost/api/issues?lane=unknown-lane");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid lane: "unknown-lane"');
  });

  it("multiple aliases to same lane are all included in query", async () => {
    const { setLaneConfig } = await import("@/lib/lane-config");
    setLaneConfig({
      lanes: [
        { id: "local", title: "Local", claimable: true, role: "default" },
        { id: "parking-lot", title: "Parking Lot", claimable: false },
      ],
      laneAliases: {
        normal: "local",
        escalated: "local",
        backlog: "parking-lot",
      },
    });

    await makeRequest("http://localhost/api/issues?lane=local");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.currentLane.in).toContain("local");
    expect(call.where.currentLane.in).toContain("normal");
    expect(call.where.currentLane.in).toContain("escalated");
  });
});
