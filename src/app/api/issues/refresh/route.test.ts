import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findMany: vi.fn().mockResolvedValue([{ id: "repo-1", fullName: "org/repo" }]),
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({ id: "issue-1" }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    repository: { findMany: mocks.findMany },
    issue: {
      findUnique: mocks.findUnique,
      update: mocks.update,
      create: mocks.create,
    },
  },
}));

vi.mock("@/lib/config", () => ({
  getSyncRepos: vi.fn().mockResolvedValue([{ id: "repo-1", fullName: "org/repo" }]),
  parseExcludedLabels: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/issue-sync", () => ({
  refreshSingleIssue: vi.fn().mockResolvedValue({
    success: true,
    repo: { id: "repo-1", fullName: "org/repo" },
    issueNumber: 42,
    issueData: {
      repositoryId: "repo-1",
      number: 42,
      title: "Test Issue",
      body: "Body",
      url: "https://example.com",
      labels: [],
      assignees: [],
      commentsCount: 0,
      updatedAt: new Date(),
      closedAt: null,
      state: "open",
      lastSyncedAt: new Date(),
    },
  }),
}));

import { POST } from "./route";
import { getSyncRepos } from "@/lib/config";

function makeRequest(body?: Record<string, unknown>, includeAuth = true) {
  return authedRequest("http://localhost/api/issues/refresh", {
    method: "POST",
    body: body ?? {},
    includeAuth,
  }) as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/issues/refresh — auth", () => {
  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(makeRequest({}, false));
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(makeRequest({ repoFullName: "org/repo", issueNumber: 42 }, false));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/issues/refresh — validation", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 400 when repoFullName is missing", async () => {
    const res = await POST(makeRequest({ issueNumber: 42 }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when issueNumber is missing", async () => {
    const res = await POST(makeRequest({ repoFullName: "org/repo" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when issueNumber is not an integer", async () => {
    const res = await POST(makeRequest({ repoFullName: "org/repo", issueNumber: 3.14 }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when issueNumber is zero", async () => {
    const res = await POST(makeRequest({ repoFullName: "org/repo", issueNumber: 0 }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when issueNumber is negative", async () => {
    const res = await POST(makeRequest({ repoFullName: "org/repo", issueNumber: -1 }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when repo is not tracked", async () => {
    vi.mocked(getSyncRepos).mockResolvedValue([]);
    const res = await POST(makeRequest({ repoFullName: "unknown/repo", issueNumber: 42 }));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/issues/refresh — business logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({ id: "issue-existing" });
    vi.mocked(getSyncRepos).mockResolvedValue([{ id: "repo-1", fullName: "org/repo" }]);
  });

  it("updates an existing issue", async () => {
    const res = await POST(makeRequest({ repoFullName: "org/repo", issueNumber: 42 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.action).toBe("updated");
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "issue-existing" },
      data: expect.objectContaining({ title: "Test Issue" }),
    });
  });

  it("creates a new issue when not found", async () => {
    mocks.findUnique.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({ repoFullName: "org/repo", issueNumber: 99 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toBe("created");
    expect(mocks.create).toHaveBeenCalled();
  });
});
