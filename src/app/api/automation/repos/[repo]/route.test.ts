import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUnique: vi.fn(),
    count: vi.fn(),
    findFirst: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    automationRepo: { findUnique: mocks.findUnique },
    githubWorkflowRun: { count: mocks.count },
    automationSyncRun: { findFirst: mocks.findFirst },
  },
}));

import { GET } from "./route";

function makeRequest(repoName: string) {
  return GET(
    new Request(`http://localhost/api/automation/repos/${repoName}`),
    { params: Promise.resolve({ repo: repoName }) },
  );
}

describe("GET /api/automation/repos/[repo]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when the repository is not found", async () => {
    mocks.findUnique.mockResolvedValueOnce(null);

    const res = await makeRequest("owner/nonexistent");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body).toEqual({ error: "Repository not found" });
  });

  it("returns repo detail with nested data on success", async () => {
    mocks.findUnique.mockResolvedValueOnce({
      id: "repo-1",
      fullName: "owner/test-repo",
      name: "test-repo",
      owner: "owner",
      defaultBranch: "main",
      latestCommitSha: "abc123",
      openPRCount: 3,
      lastSyncedAt: new Date("2025-01-01"),
      syncError: null,
      source: "env",
      workflows: [],
      releases: [],
      packages: [],
      _count: { workflows: 0, releases: 0, packages: 0 },
    });
    mocks.count.mockResolvedValueOnce(2); // failingRuns
    mocks.count.mockResolvedValueOnce(1); // runningRuns
    mocks.findFirst.mockResolvedValueOnce(null);

    const res = await makeRequest("owner/test-repo");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.fullName).toBe("owner/test-repo");
    expect(body.failingRuns).toBe(2);
    expect(body.runningRuns).toBe(1);
  });

  it("serializes BigInt fields safely via jsonSafe", async () => {
    mocks.findUnique.mockResolvedValueOnce({
      id: "repo-1",
      fullName: "owner/bigint-repo",
      name: "bigint-repo",
      owner: "owner",
      defaultBranch: "main",
      latestCommitSha: null,
      openPRCount: 0,
      lastSyncedAt: new Date(),
      syncError: null,
      source: "env",
      workflows: [
        {
          id: "wf-1",
          repoId: "repo-1",
          workflowId: BigInt(12345),
          name: "CI",
          path: ".github/workflows/ci.yml",
          state: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
          lastRunAt: null,
          runs: [
            {
              id: "run-1",
              workflowId: "wf-1",
              runId: BigInt(98765),
              name: "CI #42",
              status: "completed",
              conclusion: "success",
              branch: "main",
              headSha: "def456",
              actor: "test-bot",
              runStartedAt: new Date(),
              updatedAt: new Date(),
              durationSecs: 120,
              jobs: [
                { id: "job-1", runId: "run-1", jobId: BigInt(111), name: "build", status: "completed", conclusion: "success", startedAt: new Date(), completedAt: new Date() },
              ],
            },
          ],
        },
      ],
      releases: [
        { id: "rel-1", repoId: "repo-1", releaseId: BigInt(54321), tagName: "v1.0.0", name: "v1.0.0", draft: false, prerelease: false, targetCommit: "abc", url: "https://example.com", publishedAt: new Date(), createdAt: new Date() },
      ],
      packages: [],
      _count: { workflows: 1, releases: 1, packages: 0 },
    });
    mocks.count.mockResolvedValueOnce(0);
    mocks.count.mockResolvedValueOnce(0);
    mocks.findFirst.mockResolvedValueOnce(null);

    const res = await makeRequest("owner/bigint-repo");
    expect(res.status).toBe(200);

    const body = await res.json();
    // BigInt fields should be serialized as strings, not throw
    expect(body.workflows[0].workflowId).toBe("12345");
    expect(body.workflows[0].runs[0].runId).toBe("98765");
    expect(body.workflows[0].runs[0].jobs[0].jobId).toBe("111");
    expect(body.releases[0].releaseId).toBe("54321");
  });

  it("returns 500 on unexpected errors", async () => {
    mocks.findUnique.mockRejectedValueOnce(new Error("database connection lost"));

    const res = await makeRequest("owner/test-repo");
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body).toEqual({ error: "Failed to fetch repository details" });
  });
});
