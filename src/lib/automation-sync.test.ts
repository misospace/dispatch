import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    automationRepo: {
      upsert: vi.fn(),
      update: vi.fn(),
    },
    automationSyncRun: {
      create: vi.fn(),
      update: vi.fn(),
    },
    automationEvent: {
      create: vi.fn(),
    },
    githubWorkflow: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    githubWorkflowRun: {
      upsert: vi.fn(),
    },
    githubWorkflowJob: {
      upsert: vi.fn(),
    },
    githubRelease: {
      upsert: vi.fn(),
    },
    githubPullRequest: {
      upsert: vi.fn(),
    },
    githubPackage: {
      upsert: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/github", () => ({
  fetchRepo: vi.fn(),
  fetchWorkflows: vi.fn(),
  fetchRecentRunsAllWorkflows: vi.fn(),
  fetchReleases: vi.fn(),
  fetchPullRequests: vi.fn(),
  fetchLatestCommit: vi.fn(),
  fetchPackages: vi.fn(),
  fetchRunJobs: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import * as github from "@/lib/github";

import { syncAutomationRepo } from "./automation-sync";

const upsertRepo = prisma.automationRepo.upsert as ReturnType<typeof vi.fn>;
const updateRepo = prisma.automationRepo.update as ReturnType<typeof vi.fn>;
const createSyncRun = prisma.automationSyncRun.create as ReturnType<typeof vi.fn>;
const updateSyncRun = prisma.automationSyncRun.update as ReturnType<typeof vi.fn>;
const createEvent = prisma.automationEvent.create as ReturnType<typeof vi.fn>;
const findManyWorkflows = prisma.githubWorkflow.findMany as ReturnType<typeof vi.fn>;
const upsertPackage = prisma.githubPackage.upsert as ReturnType<typeof vi.fn>;
const transaction = prisma.$transaction as ReturnType<typeof vi.fn>;

const fetchRepoMock = github.fetchRepo as ReturnType<typeof vi.fn>;
const fetchWorkflowsMock = github.fetchWorkflows as ReturnType<typeof vi.fn>;
const fetchRunsMock = github.fetchRecentRunsAllWorkflows as ReturnType<typeof vi.fn>;
const fetchReleasesMock = github.fetchReleases as ReturnType<typeof vi.fn>;
const fetchPRsMock = github.fetchPullRequests as ReturnType<typeof vi.fn>;
const fetchCommitMock = github.fetchLatestCommit as ReturnType<typeof vi.fn>;
const fetchPackagesMock = github.fetchPackages as ReturnType<typeof vi.fn>;
const fetchRunJobsMock = github.fetchRunJobs as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: $transaction just runs the array of promises immediately,
  // matching Prisma's behavior for our purposes.
  transaction.mockImplementation(async (input: unknown) => {
    if (typeof input === "function") {
      return (input as (tx: typeof prisma) => Promise<unknown>)(prisma);
    }
    return Promise.all(input as Promise<unknown>[]);
  });
  // Both repo.update and syncRun.update are awaited (the repo update is
  // additionally chained with .catch()). Resolve to a no-op by default
  // so individual tests only need to set up the calls they care about.
  updateRepo.mockResolvedValue({});
  updateSyncRun.mockResolvedValue({});
});

function repoStub(overrides: Partial<{ id: string; fullName: string }> = {}) {
  return {
    id: overrides.id ?? "repo-1",
    fullName: overrides.fullName ?? "octocat/hello-world",
  };
}

function syncRunStub(overrides: Partial<{ id: string }> = {}) {
  return { id: overrides.id ?? "run-1" };
}

describe("syncAutomationRepo", () => {
  describe("input validation", () => {
    it("rejects a single-segment name with a clear error", async () => {
      const result = await syncAutomationRepo("just-a-name");

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid repo full name/);
      expect(result.syncRunId).toBeNull();
      expect(upsertRepo).not.toHaveBeenCalled();
      expect(createSyncRun).not.toHaveBeenCalled();
    });

    it("rejects a name with too many segments", async () => {
      const result = await syncAutomationRepo("a/b/c");

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid repo full name/);
      expect(upsertRepo).not.toHaveBeenCalled();
    });

    it("rejects a name with an empty owner", async () => {
      const result = await syncAutomationRepo("/repo");

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid repo full name/);
    });

    it("rejects a name with an empty repo segment", async () => {
      const result = await syncAutomationRepo("owner/");

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid repo full name/);
    });
  });

  describe("happy path", () => {
    it("upserts the repo and creates a sync run with running status", async () => {
      upsertRepo.mockResolvedValueOnce(repoStub());
      createSyncRun.mockResolvedValueOnce(syncRunStub());

      fetchRepoMock.mockResolvedValueOnce({
        name: "hello-world",
        owner: { login: "octocat" },
        default_branch: "main",
      });
      fetchWorkflowsMock.mockResolvedValueOnce([]);
      fetchRunsMock.mockResolvedValueOnce([]);
      fetchReleasesMock.mockResolvedValueOnce([]);
      fetchPRsMock.mockResolvedValueOnce([]);
      fetchPackagesMock.mockResolvedValueOnce([]);
      fetchCommitMock.mockResolvedValueOnce({ sha: "abc123" });

      updateSyncRun.mockResolvedValue({});
      updateRepo.mockResolvedValue({});
      createEvent.mockResolvedValue({});

      const result = await syncAutomationRepo("octocat/hello-world");

      expect(result.success).toBe(true);
      expect(result.syncRunId).toBe("run-1");

      expect(upsertRepo).toHaveBeenCalledWith({
        where: { fullName: "octocat/hello-world" },
        create: expect.objectContaining({
          fullName: "octocat/hello-world",
          name: "hello-world",
          owner: "octocat",
          defaultBranch: "main",
        }),
        update: {},
      });

      expect(createSyncRun).toHaveBeenCalledWith({
        data: expect.objectContaining({ repoId: "repo-1", status: "running" }),
      });
    });

    it("fetches all GitHub data in parallel", async () => {
      upsertRepo.mockResolvedValueOnce(repoStub());
      createSyncRun.mockResolvedValueOnce(syncRunStub());

      fetchRepoMock.mockResolvedValueOnce({
        name: "hello-world",
        owner: { login: "octocat" },
        default_branch: "main",
      });
      fetchWorkflowsMock.mockResolvedValueOnce([]);
      fetchRunsMock.mockResolvedValueOnce([]);
      fetchReleasesMock.mockResolvedValueOnce([]);
      fetchPRsMock.mockResolvedValueOnce([]);
      fetchPackagesMock.mockResolvedValueOnce([]);
      fetchCommitMock.mockResolvedValueOnce({ sha: "abc123" });

      updateSyncRun.mockResolvedValue({});
      updateRepo.mockResolvedValue({});
      createEvent.mockResolvedValue({});

      await syncAutomationRepo("octocat/hello-world");

      expect(fetchRepoMock).toHaveBeenCalledWith("octocat/hello-world");
      expect(fetchWorkflowsMock).toHaveBeenCalledWith("octocat/hello-world");
      expect(fetchRunsMock).toHaveBeenCalledWith("octocat/hello-world", 20);
      expect(fetchReleasesMock).toHaveBeenCalledWith("octocat/hello-world", 10);
      expect(fetchPRsMock).toHaveBeenCalledWith("octocat/hello-world", 20);
      expect(fetchPackagesMock).toHaveBeenCalledWith("octocat/hello-world");
    });

    it("treats a packages-fetch failure as an empty list (does not fail the sync)", async () => {
      upsertRepo.mockResolvedValueOnce(repoStub());
      createSyncRun.mockResolvedValueOnce(syncRunStub());

      fetchRepoMock.mockResolvedValueOnce({
        name: "r",
        owner: { login: "o" },
        default_branch: "main",
      });
      fetchWorkflowsMock.mockResolvedValueOnce([]);
      fetchRunsMock.mockResolvedValueOnce([]);
      fetchReleasesMock.mockResolvedValueOnce([]);
      fetchPRsMock.mockResolvedValueOnce([]);
      // packages rejects, but the implementation catches it.
      fetchPackagesMock.mockRejectedValueOnce(new Error("packages 403"));
      fetchCommitMock.mockResolvedValueOnce(null);

      updateSyncRun.mockResolvedValue({});
      updateRepo.mockResolvedValue({});
      createEvent.mockResolvedValue({});

      const result = await syncAutomationRepo("o/r");

      expect(result.success).toBe(true);
    });

    it("upserts each returned package via the package repo in a single transaction", async () => {
      upsertRepo.mockResolvedValueOnce(repoStub());
      createSyncRun.mockResolvedValueOnce(syncRunStub());

      fetchRepoMock.mockResolvedValueOnce({
        name: "r",
        owner: { login: "o" },
        default_branch: "main",
      });
      fetchWorkflowsMock.mockResolvedValueOnce([]);
      fetchRunsMock.mockResolvedValueOnce([]);
      fetchReleasesMock.mockResolvedValueOnce([]);
      fetchPRsMock.mockResolvedValueOnce([]);
      fetchPackagesMock.mockResolvedValueOnce([
        {
          id: 1,
          name: "pkg-a",
          package_type: "npm",
          visibility: "public",
          html_url: "https://example.com/a",
          updated_at: "2024-01-01T00:00:00Z",
          metadata: {},
        },
        {
          id: 2,
          name: "pkg-b",
          package_type: "container",
          visibility: "private",
          html_url: "https://example.com/b",
          updated_at: "2024-02-02T00:00:00Z",
          metadata: { container: { tags: ["v0.2.3", "latest"] } },
        },
      ]);
      fetchCommitMock.mockResolvedValueOnce(null);

      upsertPackage.mockResolvedValue({});
      updateSyncRun.mockResolvedValue({});
      updateRepo.mockResolvedValue({});
      createEvent.mockResolvedValue({});

      const result = await syncAutomationRepo("o/r");

      expect(result.success).toBe(true);
      expect(upsertPackage).toHaveBeenCalledTimes(2);
      expect(upsertPackage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: { repoId_name: { repoId: "repo-1", name: "pkg-a" } },
          create: expect.objectContaining({
            repoId: "repo-1",
            name: "pkg-a",
            packageType: "npm",
            url: "https://example.com/a",
            latestTag: null,
          }),
        }),
      );
      expect(upsertPackage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { repoId_name: { repoId: "repo-1", name: "pkg-b" } },
          create: expect.objectContaining({
            repoId: "repo-1",
            name: "pkg-b",
            packageType: "container",
            visibility: "private",
            latestTag: "v0.2.3",
          }),
        }),
      );
    });

    it("updates the repo with latest commit sha and open PR count", async () => {
      upsertRepo.mockResolvedValueOnce(repoStub());
      createSyncRun.mockResolvedValueOnce(syncRunStub());

      fetchRepoMock.mockResolvedValueOnce({
        name: "r",
        owner: { login: "o" },
        default_branch: "main",
      });
      fetchWorkflowsMock.mockResolvedValueOnce([]);
      fetchRunsMock.mockResolvedValueOnce([]);
      fetchReleasesMock.mockResolvedValueOnce([]);
      fetchPRsMock.mockResolvedValueOnce([
        { state: "open", user: { login: "u" }, head: { ref: "x" }, base: { ref: "main" } },
        { state: "open", user: { login: "u" }, head: { ref: "y" }, base: { ref: "main" } },
        { state: "closed", user: { login: "u" }, head: { ref: "z" }, base: { ref: "main" } },
      ]);
      fetchPackagesMock.mockResolvedValueOnce([]);
      fetchCommitMock.mockResolvedValueOnce({ sha: "deadbeef" });

      updateSyncRun.mockResolvedValue({});
      updateRepo.mockResolvedValue({});
      createEvent.mockResolvedValue({});

      await syncAutomationRepo("o/r");

      expect(updateRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            latestCommitSha: "deadbeef",
            openPRCount: 2,
          }),
        }),
      );
    });

    it("handles a null latest commit by clearing the sha", async () => {
      upsertRepo.mockResolvedValueOnce(repoStub());
      createSyncRun.mockResolvedValueOnce(syncRunStub());

      fetchRepoMock.mockResolvedValueOnce({
        name: "r",
        owner: { login: "o" },
        default_branch: "main",
      });
      fetchWorkflowsMock.mockResolvedValueOnce([]);
      fetchRunsMock.mockResolvedValueOnce([]);
      fetchReleasesMock.mockResolvedValueOnce([]);
      fetchPRsMock.mockResolvedValueOnce([]);
      fetchPackagesMock.mockResolvedValueOnce([]);
      fetchCommitMock.mockResolvedValueOnce(null);

      updateSyncRun.mockResolvedValue({});
      updateRepo.mockResolvedValue({});
      createEvent.mockResolvedValue({});

      await syncAutomationRepo("o/r");

      expect(updateRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ latestCommitSha: null }),
        }),
      );
    });

    it("creates a sync_completed event summarizing the fetched counts", async () => {
      upsertRepo.mockResolvedValueOnce(repoStub());
      createSyncRun.mockResolvedValueOnce(syncRunStub());

      fetchRepoMock.mockResolvedValueOnce({
        name: "r",
        owner: { login: "o" },
        default_branch: "main",
      });
      fetchWorkflowsMock.mockResolvedValueOnce([
        { id: 1, name: "ci", path: ".github/workflows/ci.yml", state: "active", created_at: "2024-01-01", updated_at: "2024-01-02", last_run: null },
      ]);
      fetchRunsMock.mockResolvedValueOnce([]);
      fetchReleasesMock.mockResolvedValueOnce([
        { id: 1, tag_name: "v1.0", name: "v1.0", draft: false, prerelease: false, target_commitish: "main", html_url: "https://x", published_at: "2024-01-01" },
      ]);
      fetchPRsMock.mockResolvedValueOnce([]);
      fetchPackagesMock.mockResolvedValueOnce([]);
      fetchCommitMock.mockResolvedValueOnce(null);

      updateSyncRun.mockResolvedValue({});
      updateRepo.mockResolvedValue({});
      createEvent.mockResolvedValue({});

      await syncAutomationRepo("o/r");

      expect(createEvent).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: "sync_completed",
          actor: "system",
          title: expect.stringContaining("o/r"),
          description: expect.stringMatching(/1 workflows.*0 runs.*1 releases/),
        }),
      });
    });

    it("marks the sync run as completed with a timestamp", async () => {
      upsertRepo.mockResolvedValueOnce(repoStub());
      createSyncRun.mockResolvedValueOnce(syncRunStub());

      fetchRepoMock.mockResolvedValueOnce({
        name: "r",
        owner: { login: "o" },
        default_branch: "main",
      });
      fetchWorkflowsMock.mockResolvedValueOnce([]);
      fetchRunsMock.mockResolvedValueOnce([]);
      fetchReleasesMock.mockResolvedValueOnce([]);
      fetchPRsMock.mockResolvedValueOnce([]);
      fetchPackagesMock.mockResolvedValueOnce([]);
      fetchCommitMock.mockResolvedValueOnce(null);

      updateSyncRun.mockResolvedValue({});
      updateRepo.mockResolvedValue({});
      createEvent.mockResolvedValue({});

      await syncAutomationRepo("o/r");

      const finalUpdate = updateSyncRun.mock.calls.at(-1)?.[0];
      expect(finalUpdate).toMatchObject({
        data: expect.objectContaining({
          status: "completed",
          completedAt: expect.any(Date),
        }),
      });
    });

    it("skips the workflow transaction when there are no workflows", async () => {
      upsertRepo.mockResolvedValueOnce(repoStub());
      createSyncRun.mockResolvedValueOnce(syncRunStub());

      fetchRepoMock.mockResolvedValueOnce({
        name: "r",
        owner: { login: "o" },
        default_branch: "main",
      });
      fetchWorkflowsMock.mockResolvedValueOnce([]);
      fetchRunsMock.mockResolvedValueOnce([]);
      fetchReleasesMock.mockResolvedValueOnce([]);
      fetchPRsMock.mockResolvedValueOnce([]);
      fetchPackagesMock.mockResolvedValueOnce([]);
      fetchCommitMock.mockResolvedValueOnce(null);

      const txCallsBefore = transaction.mock.calls.length;
      updateSyncRun.mockResolvedValue({});
      updateRepo.mockResolvedValue({});
      createEvent.mockResolvedValue({});

      await syncAutomationRepo("o/r");

      // No workflow upsert → no transaction call beyond default setup.
      expect(transaction.mock.calls.length).toBe(txCallsBefore);
    });
  });

  describe("error path", () => {
    it("marks the sync run as failed and records the error message", async () => {
      upsertRepo.mockResolvedValueOnce(repoStub());
      createSyncRun.mockResolvedValueOnce(syncRunStub());

      // Make fetchRepo throw — anything in the try block will surface here.
      const boom = new Error("github unreachable");
      fetchRepoMock.mockRejectedValueOnce(boom);

      // The other fetchers must return real promises so .catch chains in
      // Promise.all don't blow up on undefined.
      fetchWorkflowsMock.mockResolvedValueOnce([]);
      fetchRunsMock.mockResolvedValueOnce([]);
      fetchReleasesMock.mockResolvedValueOnce([]);
      fetchPRsMock.mockResolvedValueOnce([]);
      fetchPackagesMock.mockResolvedValueOnce([]);
      fetchCommitMock.mockResolvedValueOnce(null);

      updateSyncRun.mockResolvedValue({});
      updateRepo.mockResolvedValue({});

      const result = await syncAutomationRepo("o/r");

      expect(result.success).toBe(false);
      expect(result.error).toBe("github unreachable");
      expect(result.syncRunId).toBe("run-1");

      expect(updateSyncRun).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "failed",
            errorMessage: "github unreachable",
            completedAt: expect.any(Date),
          }),
        }),
      );
    });

    it("records a non-Error thrown value as 'Unknown error'", async () => {
      upsertRepo.mockResolvedValueOnce(repoStub());
      createSyncRun.mockResolvedValueOnce(syncRunStub());

      fetchRepoMock.mockRejectedValueOnce("plain string error");
      fetchWorkflowsMock.mockResolvedValueOnce([]);
      fetchRunsMock.mockResolvedValueOnce([]);
      fetchReleasesMock.mockResolvedValueOnce([]);
      fetchPRsMock.mockResolvedValueOnce([]);
      fetchPackagesMock.mockResolvedValueOnce([]);
      fetchCommitMock.mockResolvedValueOnce(null);

      updateSyncRun.mockResolvedValue({});
      updateRepo.mockResolvedValue({});

      const result = await syncAutomationRepo("o/r");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Unknown error");
      expect(updateSyncRun).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ errorMessage: "Unknown error" }),
        }),
      );
    });

    it("writes the error onto the repo even if the repo-update fails", async () => {
      upsertRepo.mockResolvedValueOnce(repoStub());
      createSyncRun.mockResolvedValueOnce(syncRunStub());

      const boom = new Error("github 500");
      fetchRepoMock.mockRejectedValueOnce(boom);
      fetchWorkflowsMock.mockResolvedValueOnce([]);
      fetchRunsMock.mockResolvedValueOnce([]);
      fetchReleasesMock.mockResolvedValueOnce([]);
      fetchPRsMock.mockResolvedValueOnce([]);
      fetchPackagesMock.mockResolvedValueOnce([]);
      fetchCommitMock.mockResolvedValueOnce(null);

      // The repo update is wrapped in .catch(() => {}), so a rejection here
      // must NOT escape — the function should still return gracefully.
      updateRepo.mockRejectedValueOnce(new Error("db down"));
      updateSyncRun.mockResolvedValue({});

      const result = await syncAutomationRepo("o/r");

      expect(result.success).toBe(false);
      expect(result.error).toBe("github 500");
      expect(result.syncRunId).toBe("run-1");
      // The run is still recorded as failed even when the repo update blows up.
      expect(updateSyncRun).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "failed" }),
        }),
      );
    });
  });

  describe("run upserts and workflow resolution", () => {
    it("does not create placeholder workflows when all run names map to existing workflows", async () => {
      upsertRepo.mockResolvedValueOnce(repoStub());
      createSyncRun.mockResolvedValueOnce(syncRunStub());

      fetchRepoMock.mockResolvedValueOnce({
        name: "r",
        owner: { login: "o" },
        default_branch: "main",
      });
      fetchWorkflowsMock.mockResolvedValueOnce([]);
      fetchReleasesMock.mockResolvedValueOnce([]);
      fetchPRsMock.mockResolvedValueOnce([]);
      fetchPackagesMock.mockResolvedValueOnce([]);
      fetchCommitMock.mockResolvedValueOnce(null);

      // A single run whose workflow is already in the DB.
      fetchRunsMock.mockResolvedValueOnce([
        {
          id: 100,
          name: "ci",
          status: "queued",
          conclusion: null,
          head_branch: "main",
          head_sha: "abc",
          actor: { login: "saffron" },
          run_started_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          pull_requests: [],
        },
      ]);
      findManyWorkflows.mockResolvedValueOnce([{ id: "wf-1", name: "ci" }]);

      updateSyncRun.mockResolvedValue({});
      updateRepo.mockResolvedValue({});
      createEvent.mockResolvedValue({});

      await syncAutomationRepo("o/r");

      // The placeholder-creation branch only runs when there are unknown names.
      expect(prisma.githubWorkflow.create).not.toHaveBeenCalled();
    });

    it("creates placeholder workflows for runs whose names are not in the workflow list", async () => {
      upsertRepo.mockResolvedValueOnce(repoStub());
      createSyncRun.mockResolvedValueOnce(syncRunStub());

      fetchRepoMock.mockResolvedValueOnce({
        name: "r",
        owner: { login: "o" },
        default_branch: "main",
      });
      // The workflow list API returns one workflow, but a run below references
      // a name that isn't in the list — exercise the placeholder branch.
      fetchWorkflowsMock.mockResolvedValueOnce([
        { name: "ci", path: ".github/workflows/ci.yml", state: "active" },
      ]);
      fetchReleasesMock.mockResolvedValueOnce([]);
      fetchPRsMock.mockResolvedValueOnce([]);
      fetchPackagesMock.mockResolvedValueOnce([]);
      fetchCommitMock.mockResolvedValueOnce(null);
      fetchRunsMock.mockResolvedValueOnce([
        {
          id: 101,
          name: "legacy-job",
          status: "completed",
          conclusion: "success",
          head_branch: "main",
          head_sha: "deadbeef",
          actor: { login: "ghost" },
          run_started_at: "2024-03-01T00:00:00Z",
          updated_at: "2024-03-01T00:00:00Z",
          pull_requests: [],
        },
        {
          id: 102,
          name: "ci",
          status: "completed",
          conclusion: "success",
          head_branch: "main",
          head_sha: "beefdead",
          actor: { login: "saffron" },
          run_started_at: "2024-03-02T00:00:00Z",
          updated_at: "2024-03-02T00:00:00Z",
          pull_requests: [],
        },
      ]);
      // The implementation looks up existing workflow ids by name via findMany.
      // `ci` is present; `legacy-job` is not — forcing the placeholder branch.
      findManyWorkflows.mockResolvedValueOnce([
        { id: "wf-1", name: "ci" },
      ]);

      updateSyncRun.mockResolvedValue({});
      updateRepo.mockResolvedValue({});
      createEvent.mockResolvedValue({});

      await syncAutomationRepo("o/r");

      expect(prisma.githubWorkflow.create).toHaveBeenCalledTimes(1);
      expect(prisma.githubWorkflow.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            repoId: "repo-1",
            name: "legacy-job",
            path: "unknown",
            state: "unknown",
          }),
        }),
      );
    });

    it("fetches jobs only for completed runs", async () => {
      upsertRepo.mockResolvedValueOnce(repoStub());
      createSyncRun.mockResolvedValueOnce(syncRunStub());

      fetchRepoMock.mockResolvedValueOnce({
        name: "r",
        owner: { login: "o" },
        default_branch: "main",
      });
      fetchWorkflowsMock.mockResolvedValueOnce([]);
      fetchReleasesMock.mockResolvedValueOnce([]);
      fetchPRsMock.mockResolvedValueOnce([]);
      fetchPackagesMock.mockResolvedValueOnce([]);
      fetchCommitMock.mockResolvedValueOnce(null);

      fetchRunsMock.mockResolvedValueOnce([
        {
          id: 200,
          name: "ci",
          status: "in_progress",
          conclusion: null,
          head_branch: "main",
          head_sha: "abc",
          actor: { login: "u" },
          run_started_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          pull_requests: [],
        },
        {
          id: 201,
          name: "ci",
          status: "completed",
          conclusion: "success",
          head_branch: "main",
          head_sha: "abc",
          actor: { login: "u" },
          run_started_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:05:00Z",
          pull_requests: [],
        },
      ]);
      findManyWorkflows.mockResolvedValueOnce([{ id: "wf-1", name: "ci" }]);

      updateSyncRun.mockResolvedValue({});
      updateRepo.mockResolvedValue({});
      createEvent.mockResolvedValue({});

      // Return an upserted run row per run.
      (
        prisma.githubWorkflowRun.upsert as ReturnType<typeof vi.fn>
      ).mockImplementation(async () => ({ id: `saved-${Math.random()}` }));

      fetchRunJobsMock.mockResolvedValueOnce([
        { id: 1, name: "build", status: "completed", conclusion: "success", started_at: "x", completed_at: "y" },
      ]);

      await syncAutomationRepo("o/r");

      // Only the completed run (#201) triggers a job fetch.
      expect(fetchRunJobsMock).toHaveBeenCalledTimes(1);
      expect(fetchRunJobsMock).toHaveBeenCalledWith("o/r", 201);
    });
  });
});