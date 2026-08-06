import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

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
  return GET(authedRequest(urlString, { includeAuth }));
}

describe("GET /api/issues/claimed", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.findManyIssues.mockResolvedValue([]);
  });

  it("returns 401 when no auth header is present", async () => {
    const res = await makeRequest("http://localhost/api/issues/claimed?agentName=bot", false);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 for bad bearer token", async () => {
    const res = await GET(
      authedRequest("http://localhost/api/issues/claimed?agentName=bot", {
        headers: { Authorization: "Bearer wrong-token" },
      }),
    );

    expect(res.status).toBe(401);
  });

  it("unauthorized request does not call prisma", async () => {
    await makeRequest("http://localhost/api/issues/claimed?agentName=bot", false);

    expect(mocks.findManyIssues).not.toHaveBeenCalled();
  });

  it("returns 400 when agentName is missing", async () => {
    const res = await makeRequest("http://localhost/api/issues/claimed");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("agentName");
    expect(mocks.findManyIssues).not.toHaveBeenCalled();
  });

  it("returns 400 when agentName is blank", async () => {
    const res = await makeRequest("http://localhost/api/issues/claimed?agentName=   ");

    expect(res.status).toBe(400);
    expect(mocks.findManyIssues).not.toHaveBeenCalled();
  });

  it("queries Prisma with correct where clause for enabled repos, open state, and both labels", async () => {
    await makeRequest("http://localhost/api/issues/claimed?agentName=opencode");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where).toEqual({
      repository: { enabled: true },
      state: "open",
      labels: { hasEvery: ["status/in-progress", "agent/opencode"] },
    });
  });

  // The stuck-claim shape: still holding its agent label while back at
  // status/ready, invisible to every reaper because this endpoint only ever
  // returned in-progress. Two p0s sat like that for 20 days.
  it("lists ready+claimed issues when status=ready", async () => {
    await makeRequest("http://localhost/api/issues/claimed?agentName=opencode&status=ready");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.labels).toEqual({ hasEvery: ["status/ready", "agent/opencode"] });
  });

  it("defaults to in-progress when status is omitted", async () => {
    await makeRequest("http://localhost/api/issues/claimed?agentName=opencode");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.where.labels).toEqual({ hasEvery: ["status/in-progress", "agent/opencode"] });
  });

  it("rejects a status outside the allow-list", async () => {
    const res = await makeRequest("http://localhost/api/issues/claimed?agentName=opencode&status=done");
    expect(res.status).toBe(400);
    expect(mocks.findManyIssues).not.toHaveBeenCalled();
  });

  it("includes repository relation", async () => {
    await makeRequest("http://localhost/api/issues/claimed?agentName=opencode");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.include).toEqual({ repository: true });
  });

  it("orders by updatedAt descending", async () => {
    await makeRequest("http://localhost/api/issues/claimed?agentName=opencode");

    const call = mocks.findManyIssues.mock.calls[0][0];
    expect(call.orderBy).toEqual({ updatedAt: "desc" });
  });

  it("maps response shape correctly with hasOpenPr true", async () => {
    mocks.findManyIssues.mockResolvedValue([
      {
        id: "issue-1",
        number: 42,
        currentLane: "local",
        labels: ["status/in-progress", "agent/opencode"],
        linkedPrNumber: 99,
        linkedPrUrl: "https://github.com/org/repo/pull/99",
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await makeRequest("http://localhost/api/issues/claimed?agentName=opencode");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      {
        issueId: "issue-1",
        number: 42,
        repoFullName: "org/repo",
        currentLane: "local",
        labels: ["status/in-progress", "agent/opencode"],
        hasOpenPr: true,
      },
    ]);
  });

  it("maps hasOpenPr false when linkedPrNumber is null", async () => {
    mocks.findManyIssues.mockResolvedValue([
      {
        id: "issue-2",
        number: 10,
        currentLane: null,
        labels: ["status/in-progress", "agent/opencode"],
        linkedPrNumber: null,
        linkedPrUrl: "https://github.com/org/repo/pull/5",
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await makeRequest("http://localhost/api/issues/claimed?agentName=opencode");
    const body = await res.json();

    expect(body[0].hasOpenPr).toBe(false);
  });

  it("maps hasOpenPr false when linkedPrUrl is null", async () => {
    mocks.findManyIssues.mockResolvedValue([
      {
        id: "issue-3",
        number: 11,
        currentLane: "escalated",
        labels: ["status/in-progress", "agent/opencode"],
        linkedPrNumber: 5,
        linkedPrUrl: null,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await makeRequest("http://localhost/api/issues/claimed?agentName=opencode");
    const body = await res.json();

    expect(body[0].hasOpenPr).toBe(false);
  });

  it("maps hasOpenPr false when both linkedPr fields are null", async () => {
    mocks.findManyIssues.mockResolvedValue([
      {
        id: "issue-4",
        number: 12,
        currentLane: "local",
        labels: ["status/in-progress", "agent/opencode"],
        linkedPrNumber: null,
        linkedPrUrl: null,
        repository: { fullName: "org/repo" },
      },
    ]);

    const res = await makeRequest("http://localhost/api/issues/claimed?agentName=opencode");
    const body = await res.json();

    expect(body[0].hasOpenPr).toBe(false);
  });

  it("returns 500 on database error", async () => {
    mocks.findManyIssues.mockRejectedValueOnce(new Error("db connection failed"));

    const res = await makeRequest("http://localhost/api/issues/claimed?agentName=opencode");
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to fetch claimed issues");
  });

  it("returns empty array when no issues match", async () => {
    mocks.findManyIssues.mockResolvedValue([]);

    const res = await makeRequest("http://localhost/api/issues/claimed?agentName=opencode");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });
});
