import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUniqueAutomationRepo: vi.fn(),
    deleteAutomationRepo: vi.fn().mockResolvedValue(undefined),
    updateManyRepository: vi.fn().mockResolvedValue({ count: 1 }),
    createAuditLog: vi.fn().mockResolvedValue({ id: "log-1" }),

    githubWorkflowRunCount: vi.fn().mockResolvedValue(0),
    automationSyncRunFindFirst: vi.fn().mockResolvedValue(null),
    automationEventFindMany: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    automationRepo: {
      findUnique: mocks.findUniqueAutomationRepo,
      delete: mocks.deleteAutomationRepo,
    },
    repository: {
      updateMany: mocks.updateManyRepository,
    },
    auditLog: { create: mocks.createAuditLog },

    githubWorkflowRun: { count: mocks.githubWorkflowRunCount },
    automationSyncRun: { findFirst: mocks.automationSyncRunFindFirst },
    automationEvent: { findMany: mocks.automationEventFindMany },
  },
}));

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => ({
  isAuthorizedAgentToken: vi.fn((token) => token === mockToken),
}));

import { GET, DELETE } from "./route";

function deleteRequest(repoSegments: string[], includeAuth = true) {
  const headers: Record<string, string> = {};
  if (includeAuth) headers.Authorization = `Bearer ${mockToken}`;
  return DELETE(
    new Request(`http://localhost/api/automation/repos/${repoSegments.join("/")}`, { method: "DELETE", headers }),
    { params: Promise.resolve({ repo: repoSegments }) },
  );
}


function getRequest(repoSegments: string[], searchParams?: Record<string, string>) {
  const url = new URL(`http://localhost/api/automation/repos/${repoSegments.join("/")}`);
  if (searchParams) {
    Object.entries(searchParams).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  return GET(new Request(url.toString()), { params: Promise.resolve({ repo: repoSegments }) });
}

describe("GET /api/automation/repos/[...repo]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findUniqueAutomationRepo.mockResolvedValue({
      id: "repo-1",
      fullName: "myorg/myrepo",
      name: "myrepo",
      owner: "myorg",
      defaultBranch: "main",
      latestCommitSha: "abc123",
      openPRCount: 3,
      lastSyncedAt: new Date().toISOString(),
      syncError: null,
      workflows: [],
      releases: [],
      packages: [],
      _count: { workflows: 0, releases: 0 },
    });
    mocks.githubWorkflowRunCount.mockResolvedValue(0);
    mocks.automationSyncRunFindFirst.mockResolvedValue(null);
    mocks.automationEventFindMany.mockResolvedValue([]);
  });

  it("returns 400 when no repo parameter is provided", async () => {
    const res = await getRequest([]);
    expect(res.status).toBe(400);
  });

  it("returns 404 for an untracked repo", async () => {
    mocks.findUniqueAutomationRepo.mockResolvedValueOnce(null);
    const res = await getRequest(["myorg", "missing"]);
    expect(res.status).toBe(404);
  });

  it("returns repo data for a tracked repo", async () => {
    const res = await getRequest(["myorg", "myrepo"]);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.fullName).toBe("myorg/myrepo");
  });

  it("uses the query 'repo' param over the path segments", async () => {
    mocks.findUniqueAutomationRepo.mockClear();
    const res = await getRequest(["wrong", "repo"], { repo: "query/org/queryrepo" });
    expect(res.status).toBe(200);
    expect(mocks.findUniqueAutomationRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { fullName: "query/org/queryrepo" },
      }),
    );
  });

  it("decodes URL-encoded repo names in the path", async () => {
    const res = await getRequest(["myorg", "my%20repo"]);
    expect(res.status).toBe(200);
    expect(mocks.findUniqueAutomationRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { fullName: "myorg/my repo" },
      }),
    );
  });
});

describe("DELETE /api/automation/repos/[...repo] — auth", () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it("returns 401 when no authorization header is provided", async () => {
    const res = await DELETE(
      new Request(`http://localhost/api/automation/repos/myorg/myrepo`, { method: "DELETE" }),
      { params: Promise.resolve({ repo: ["myorg", "myrepo"] }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await DELETE(
      new Request(`http://localhost/api/automation/repos/myorg/myrepo`, {
        method: "DELETE",
        headers: { Authorization: "Bearer wrong-token" },
      }),
      { params: Promise.resolve({ repo: ["myorg", "myrepo"] }) },
    );
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/automation/repos/[...repo]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findUniqueAutomationRepo.mockResolvedValue({ id: "repo-1", source: "user" });
    mocks.deleteAutomationRepo.mockResolvedValue(undefined);
    mocks.updateManyRepository.mockResolvedValue({ count: 1 });
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  it("returns 404 when the repo is not tracked", async () => {
    mocks.findUniqueAutomationRepo.mockResolvedValueOnce(null);
    const res = await deleteRequest(["myorg", "missing"]);
    expect(res.status).toBe(404);
    expect(mocks.deleteAutomationRepo).not.toHaveBeenCalled();
  });

  it("deletes the AutomationRepo, soft-disables Repository, and writes an audit row", async () => {
    const res = await deleteRequest(["myorg", "myrepo"]);
    expect(res.status).toBe(200);

    expect(mocks.deleteAutomationRepo).toHaveBeenCalledWith({
      where: { fullName: "myorg/myrepo" },
    });
    expect(mocks.updateManyRepository).toHaveBeenCalledWith({
      where: { fullName: "myorg/myrepo" },
      data: { enabled: false },
    });
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "remove_tracked_repo",
        repoFullName: "myorg/myrepo",
        success: true,
        beforeLabels: ["user"],
      }),
    });
  });

  it("writes a failure audit row when delete throws", async () => {
    mocks.deleteAutomationRepo.mockRejectedValueOnce(new Error("db down"));
    const res = await deleteRequest(["myorg", "myrepo"]);
    expect(res.status).toBe(500);

    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "remove_tracked_repo",
        repoFullName: "myorg/myrepo",
        success: false,
        errorMessage: "db down",
      }),
    });
  });
});




