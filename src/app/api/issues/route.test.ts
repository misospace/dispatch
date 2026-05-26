import { describe, expect, it, vi, beforeEach } from "vitest";

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

function makeRequest(urlString: string) {
  return GET(new Request(urlString));
}

describe("GET /api/issues — visible issue filtering", () => {
  beforeEach(() => {
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
});
