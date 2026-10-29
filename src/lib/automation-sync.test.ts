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
  // The closed listing is additive data (#1313); default it to empty so only
  // the tests that care about merge persistence stub it explicitly.
  fetchClosedPullRequests: vi.fn().mockResolvedValue([]),
  fetchLatestCommit: vi.fn(),
  fetchCompare: vi.fn(),
  fetchStableBaselineRelease: vi.fn(),
  fetchPackages: vi.fn(),
  fetchRunJobs: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import * as github from "@/lib/github";

import { computeReleaseDelta, syncAutomationRepo } from "./automation-sync";

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
const fetchClosedPRsMock = github.fetchClosedPullRequests as ReturnType<typeof vi.fn>;
const upsertPR = prisma.githubPullRequest.upsert as ReturnType<typeof vi.fn>;
const fetchCommitMock = github.fetchLatestCommit as ReturnType<typeof vi.fn>;
const fetchPackagesMock = github.fetchPackages as ReturnType<typeof vi.fn>;
const fetchRunJobsMock = github.fetchRunJobs as ReturnType<typeof vi.fn>;
const fetchStableBaselineReleaseMock = github.fetchStableBaselineRelease as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Every sync resolves the baseline through the authoritative latest-stable
  // search; default to the stable v1.0.0 release so common sync tests persist
  // the same delta shape unless a test stubs a different authoritative answer.
  fetchStableBaselineReleaseMock.mockResolvedValue({
    id: 1,
    tag_name: "v1.0.0",
    name: "Release",
    draft: false,
    prerelease: false,
    target_commitish: "main",
    html_url: "https://github.com/o/r/releases/tag/v1.0.0",
    published_at: "2024-01-01T00:00:00Z",
  });
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
      expect(fetchClosedPRsMock).toHaveBeenCalledWith("octocat/hello-world", 50);
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

  describe("merged PR persistence (#1313)", () => {
    function fixturePr(overrides: Record<string, unknown> & { number: number }) {
      return {
        url: `https://github.com/o/r/pull/${overrides.number}`,
        title: `PR ${overrides.number}`,
        state: "open",
        user: { login: "u" },
        head: { ref: `branch-${overrides.number}` },
        base: { ref: "main" },
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        merged_at: null,
        draft: false,
        ...overrides,
      };
    }

    function stubFetches(
      {
        open = [],
        closed = [],
        closedError,
      }: {
        open?: ReturnType<typeof fixturePr>[];
        closed?: ReturnType<typeof fixturePr>[];
        closedError?: Error;
      } = {},
    ) {
      upsertRepo.mockResolvedValueOnce(repoStub());
      createSyncRun.mockResolvedValueOnce(syncRunStub());
      fetchRepoMock.mockResolvedValueOnce({ name: "r", owner: { login: "o" }, default_branch: "main" });
      fetchWorkflowsMock.mockResolvedValueOnce([]);
      fetchRunsMock.mockResolvedValueOnce([]);
      fetchReleasesMock.mockResolvedValueOnce([]);
      fetchPRsMock.mockResolvedValueOnce(open);
      if (closedError) {
        fetchClosedPRsMock.mockRejectedValueOnce(closedError);
      } else {
        fetchClosedPRsMock.mockResolvedValueOnce(closed);
      }
      fetchPackagesMock.mockResolvedValueOnce([]);
      fetchCommitMock.mockResolvedValueOnce(null);
      updateSyncRun.mockResolvedValue({});
      updateRepo.mockResolvedValue({});
      createEvent.mockResolvedValue({});
    }

    it("persists the merge time of a merged PR the open listing no longer carries", async () => {
      stubFetches({
        closed: [fixturePr({ number: 7, state: "closed", merged_at: "2024-02-03T04:05:06Z" })],
      });

      const result = await syncAutomationRepo("o/r");

      expect(result.success).toBe(true);
      expect(upsertPR).toHaveBeenCalledTimes(1);
      expect(upsertPR).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { repoId_number: { repoId: "repo-1", number: 7 } },
          create: expect.objectContaining({
            number: 7,
            state: "closed",
            mergedAt: new Date("2024-02-03T04:05:06Z"),
          }),
          update: expect.objectContaining({
            state: "closed",
            mergedAt: new Date("2024-02-03T04:05:06Z"),
          }),
        }),
      );
    });

    it("refreshes a closed-unmerged PR to state closed with mergedAt null (#1321)", async () => {
      // The stale-open failure of #1321: after the PR closes without
      // merging, its row must stop reporting state "open".
      stubFetches({
        closed: [fixturePr({ number: 2, state: "closed", merged_at: null })],
      });

      const result = await syncAutomationRepo("o/r");

      expect(result.success).toBe(true);
      expect(upsertPR).toHaveBeenCalledTimes(1);
      expect(upsertPR).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { repoId_number: { repoId: "repo-1", number: 2 } },
          create: expect.objectContaining({
            state: "closed",
            mergedAt: null,
          }),
          update: expect.objectContaining({
            state: "closed",
            mergedAt: null,
          }),
        }),
      );
    });

    it("keeps a not-merged PR's mergedAt null while upserting both listings' rows", async () => {
      // The open listing keeps its row; the unmerged closed row never gains
      // a merge time — mergedAt stays null for both.
      stubFetches({
        open: [fixturePr({ number: 1 })],
        closed: [fixturePr({ number: 2, state: "closed", merged_at: null })],
      });

      const result = await syncAutomationRepo("o/r");

      expect(result.success).toBe(true);
      expect(upsertPR).toHaveBeenCalledTimes(2);
      expect(upsertPR).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { repoId_number: { repoId: "repo-1", number: 2 } },
          create: expect.objectContaining({ mergedAt: null }),
          update: expect.objectContaining({ mergedAt: null }),
        }),
      );
      expect(upsertPR).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { repoId_number: { repoId: "repo-1", number: 1 } },
          create: expect.objectContaining({ mergedAt: null }),
          update: expect.objectContaining({ mergedAt: null }),
        }),
      );
    });

    it("drops an open-listing duplicate of a closed-unmerged PR in favor of the closed row", async () => {
      // A PR closing between the two concurrent listings can be served as
      // open by one snapshot and closed by the other; the closed reading is
      // the newer state and must not be overwritten by the open duplicate.
      stubFetches({
        open: [fixturePr({ number: 5 })],
        closed: [fixturePr({ number: 5, state: "closed", merged_at: null })],
      });

      const result = await syncAutomationRepo("o/r");

      expect(result.success).toBe(true);
      expect(upsertPR).toHaveBeenCalledTimes(1);
      expect(upsertPR).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { repoId_number: { repoId: "repo-1", number: 5 } },
          create: expect.objectContaining({ state: "closed", mergedAt: null }),
          update: expect.objectContaining({ state: "closed", mergedAt: null }),
        }),
      );
    });

    it("upserts a PR present in both listings once, with the merged row winning", async () => {
      // A PR merging between the two concurrent listings can be served as
      // open by one call and as merged by the other; the open duplicate must
      // not write mergedAt back to null.
      stubFetches({
        open: [fixturePr({ number: 3 })],
        closed: [fixturePr({ number: 3, state: "closed", merged_at: "2024-05-05T00:00:00Z" })],
      });

      const result = await syncAutomationRepo("o/r");

      expect(result.success).toBe(true);
      expect(upsertPR).toHaveBeenCalledTimes(1);
      expect(upsertPR).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { repoId_number: { repoId: "repo-1", number: 3 } },
          update: expect.objectContaining({
            state: "closed",
            mergedAt: new Date("2024-05-05T00:00:00Z"),
          }),
        }),
      );
    });

    it("degrades to the open-only sync when the closed listing fails", async () => {
      stubFetches({ open: [fixturePr({ number: 4 })], closedError: new Error("closed listing 403") });

      const result = await syncAutomationRepo("o/r");

      expect(result.success).toBe(true);
      expect(upsertPR).toHaveBeenCalledTimes(1);
      expect(upsertPR).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { repoId_number: { repoId: "repo-1", number: 4 } },
        }),
      );
    });
  });
});
describe("release delta (#1480)", () => {
  const upsertRepo2 = prisma.automationRepo.upsert as ReturnType<typeof vi.fn>;
  const fetchCompareMock = github.fetchCompare as ReturnType<typeof vi.fn>;

  function rel(overrides: Partial<{
    id: number;
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    published_at: string;
  }> = {}) {
    return {
      id: overrides.id ?? 1,
      tag_name: overrides.tag_name ?? "v1.0.0",
      name: "Release",
      draft: overrides.draft ?? false,
      prerelease: overrides.prerelease ?? false,
      target_commitish: "main",
      html_url: "https://github.com/o/r/releases/tag/v1.0.0",
      published_at: overrides.published_at ?? "2024-01-01T00:00:00Z",
    };
  }

  function deltaDeps(
    {
      resolvedSha = "basesha1",
      comparison = { status: "ahead", aheadBy: 3, behindBy: 0, mergeBaseCommitSha: "basesha1" },
      resolveError,
      compareError,
      stable,
      stableSearchError,
    }: {
      resolvedSha?: string | null;
      comparison?: { status: string; aheadBy: number; behindBy: number; mergeBaseCommitSha: string | null } | null;
      resolveError?: Error;
      compareError?: Error;
      // Authoritative latest-stable search result (null = verified absence).
      stable?: ReturnType<typeof rel> | null;
      stableSearchError?: Error;
    } = {},
  ) {
    return {
      resolveRef: resolveError
        ? vi.fn().mockRejectedValue(resolveError)
        : vi.fn().mockResolvedValue(resolvedSha === null ? null : { sha: resolvedSha }),
      compare: compareError
        ? vi.fn().mockRejectedValue(compareError)
        : vi.fn().mockResolvedValue(comparison),
      findStableRelease:
        stableSearchError !== undefined
          ? vi.fn().mockRejectedValue(stableSearchError)
          : vi.fn().mockResolvedValue(stable === undefined ? rel() : stable),
    };
  }

  it("reports identical with 0 unreleased when head sits on the release commit", async () => {
    const deps = deltaDeps({
      resolvedSha: "same123",
      comparison: { status: "identical", aheadBy: 0, behindBy: 0, mergeBaseCommitSha: "same123" },
    });

    const delta = await computeReleaseDelta("o/r", "same123", deps);

    expect(delta.releaseState).toBe("identical");
    expect(delta.releaseAheadBy).toBe(0);
    expect(delta.releaseBaselineSha).toBe("same123");
    expect(delta.releaseHeadSha).toBe("same123");
    expect(delta.releaseError).toBeNull();
  });

  it("reports N ahead with the exact pinned baseline and head SHAs", async () => {
    const deps = deltaDeps();

    const delta = await computeReleaseDelta("o/r", "headsha9", deps);

    expect(delta.releaseState).toBe("ahead");
    expect(delta.releaseAheadBy).toBe(3);
    expect(deps.compare).toHaveBeenCalledWith("o/r", "basesha1", "headsha9");
    expect(delta.releaseBaselineSha).toBe("basesha1");
    expect(delta.releaseHeadSha).toBe("headsha9");
    expect(delta.releaseBaselinePublishedAt).toEqual(new Date("2024-01-01T00:00:00Z"));
    // The baseline is decided exclusively by the authoritative stable search.
    expect(deps.findStableRelease).toHaveBeenCalledWith("o/r");
  });

  it("resolves an older stable beyond the persisted window via the authoritative search", async () => {
    const deps = deltaDeps({
      stable: rel({ id: 9, tag_name: "v0.9.0", published_at: "2023-06-01T00:00:00Z" }),
    });

    const delta = await computeReleaseDelta("o/r", "headsha9", deps);

    expect(delta.releaseState).toBe("ahead");
    expect(delta.releaseBaselineTag).toBe("v0.9.0");
    expect(delta.releaseBaselinePublishedAt).toEqual(new Date("2023-06-01T00:00:00Z"));
    expect(deps.findStableRelease).toHaveBeenCalledWith("o/r");
    expect(deps.resolveRef).toHaveBeenCalledWith("o/r", "v0.9.0");
  });

  it("reports a distinct no-baseline state on verified absence (no stable release)", async () => {
    const deps = deltaDeps({ stable: null });

    const delta = await computeReleaseDelta("o/r", "headsha9", deps);

    expect(delta.releaseState).toBe("no-baseline");
    expect(delta.releaseAheadBy).toBeNull();
    expect(delta.releaseError).toBeNull();
    expect(delta.releaseHeadSha).toBe("headsha9");
    expect(deps.resolveRef).not.toHaveBeenCalled();
    expect(deps.compare).not.toHaveBeenCalled();
  });

  it("fails closed to unknown when no authoritative baseline source is available", async () => {
    // Legacy "@/lib/github" mocks predate the findStableRelease export; a
    // missing source must degrade to `unknown`, never manufacture
    // `no-baseline` — absence was never verified.
    const delta = await computeReleaseDelta("o/r", "headsha9", {
      resolveRef: vi.fn(),
      compare: vi.fn(),
    });

    expect(delta.releaseState).toBe("unknown");
    expect(delta.releaseBaselineTag).toBeNull();
    expect(delta.releaseHeadSha).toBe("headsha9");
    expect(delta.releaseError).toContain("baseline source unavailable");
  });

  it("fails closed to unknown when the authoritative search throws", async () => {
    const deps = deltaDeps({ stableSearchError: new Error("latest release 502") });

    const delta = await computeReleaseDelta("o/r", "headsha9", deps);

    expect(delta.releaseState).toBe("unknown");
    expect(delta.releaseAheadBy).toBeNull();
    expect(delta.releaseError).toContain("latest release 502");
  });

  it("reports unknown when the release tag cannot be resolved", async () => {
    const deps = deltaDeps({ resolvedSha: null, stable: rel({ tag_name: "v9.9.9" }) });

    const delta = await computeReleaseDelta("o/r", "headsha9", deps);

    expect(delta.releaseState).toBe("unknown");
    expect(delta.releaseAheadBy).toBeNull();
    expect(delta.releaseBaselineTag).toBe("v9.9.9");
    expect(delta.releaseBaselineSha).toBeNull();
    expect(delta.releaseError).toContain("v9.9.9");
    expect(deps.compare).not.toHaveBeenCalled();
  });

  it("fails closed to unknown with a bounded error when the forge read throws", async () => {
    const deps = deltaDeps({ resolveError: new Error("boom ".repeat(400)) });

    const delta = await computeReleaseDelta("o/r", "headsha9", deps);

    expect(delta.releaseState).toBe("unknown");
    expect(delta.releaseAheadBy).toBeNull();
    expect(delta.releaseError!.length).toBeLessThanOrEqual(500);
  });

  it("fails closed to unknown when the compare call fails or is unavailable", async () => {
    const thrown = await computeReleaseDelta("o/r", "headsha9", deltaDeps({ compareError: new Error("502 upstream") }));
    expect(thrown.releaseState).toBe("unknown");
    expect(thrown.releaseError).toContain("502 upstream");

    const unavailable = await computeReleaseDelta("o/r", "headsha9", deltaDeps({ comparison: null }));
    expect(unavailable.releaseState).toBe("unknown");
    expect(unavailable.releaseAheadBy).toBeNull();
  });

  it("surfaces diverged and behind comparisons as divergence without an ahead count", async () => {
    for (const status of ["diverged", "behind"] as const) {
      const delta = await computeReleaseDelta(
        "o/r",
        "headsha9",
        deltaDeps({ comparison: { status, aheadBy: 12, behindBy: 4, mergeBaseCommitSha: "mb" } }),
      );
      expect(delta.releaseState).toBe("diverged");
      expect(delta.releaseAheadBy).toBeNull();
      expect(delta.releaseBaselineSha).toBe("basesha1");
    }
  });

  it("reports unknown when the default-branch head itself is unresolved", async () => {
    const deps = deltaDeps();

    const delta = await computeReleaseDelta("o/r", null, deps);

    expect(delta.releaseState).toBe("unknown");
    expect(delta.releaseHeadSha).toBeNull();
    expect(delta.releaseError).toContain("head SHA unresolved");
    expect(deps.compare).not.toHaveBeenCalled();
  });

  it("is idempotent for repeated syncs of the same baseline/head", async () => {
    const first = await computeReleaseDelta("o/r", "headsha9", deltaDeps());
    const second = await computeReleaseDelta("o/r", "headsha9", deltaDeps());
    expect(second).toEqual(first);
  });

  function stubDeltaSync(
    {
      releases = [rel()],
      headSha = "headsha1",
      baselineSha = "basesha1",
      comparison = { status: "ahead", aheadBy: 7, behindBy: 0, mergeBaseCommitSha: "basesha1" },
      compareError,
    }: {
      releases?: ReturnType<typeof rel>[];
      headSha?: string | null;
      baselineSha?: string | null;
      comparison?: unknown;
      compareError?: Error;
    } = {},
  ) {
    // This describe sits outside the outer beforeEach (clearAllMocks), so
    // drop queued Once values from earlier suites before stubbing.
    for (const mock of [
      upsertRepo2, createSyncRun, fetchRepoMock, fetchWorkflowsMock, fetchRunsMock,
      fetchReleasesMock, fetchPRsMock, fetchClosedPRsMock, fetchPackagesMock,
      fetchCommitMock, fetchCompareMock, updateSyncRun, updateRepo, createEvent,
    ]) {
      mock.mockReset();
    }
    upsertRepo2.mockResolvedValue(repoStub());
    createSyncRun.mockResolvedValue(syncRunStub());
    fetchRepoMock.mockResolvedValue({ name: "r", owner: { login: "o" }, default_branch: "main" });
    fetchWorkflowsMock.mockResolvedValue([]);
    fetchRunsMock.mockResolvedValue([]);
    fetchReleasesMock.mockResolvedValue(releases);
    fetchPRsMock.mockResolvedValue([]);
    fetchClosedPRsMock.mockResolvedValue([]);
    fetchPackagesMock.mockResolvedValue([]);
    fetchCommitMock.mockImplementation(async (_repo: string, ref: string) => {
      if (ref === "main") return headSha === null ? null : { sha: headSha };
      return baselineSha === null ? null : { sha: baselineSha };
    });
    if (compareError) {
      fetchCompareMock.mockRejectedValue(compareError);
    } else {
      fetchCompareMock.mockResolvedValue(comparison);
    }
    updateSyncRun.mockResolvedValue({});
    updateRepo.mockResolvedValue({});
    createEvent.mockResolvedValue({});
  }
  it("deepens the baseline read beyond the persisted window when it holds no stable release", async () => {
    stubDeltaSync({
      releases: [rel({ id: 1, tag_name: "v2.0.0-rc1", prerelease: true })],
      baselineSha: "basesha0",
    });
    fetchStableBaselineReleaseMock.mockResolvedValue(
      rel({ id: 9, tag_name: "v0.9.0", published_at: "2023-06-01T00:00:00Z" })
    );

    const result = await syncAutomationRepo("o/r");

    expect(result.success).toBe(true);
    expect(fetchStableBaselineReleaseMock).toHaveBeenCalledWith("o/r");
    expect(updateRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          releaseState: "ahead",
          releaseBaselineTag: "v0.9.0",
          releaseBaselineSha: "basesha0",
          releaseAheadBy: 7,
        }),
      }),
    );
  });

  it("persists the authoritative latest stable even when the persisted window already holds an older stable", async () => {
    // The persisted ≤50-release window holds stable v1.0.0, but the
    // authoritative latest-release search reports v2.0.0 published later.
    // Release listings are ordered by release creation, not `published_at`,
    // so a window that already holds a stable can never prove which stable
    // release is newest — the authoritative search wins.
    stubDeltaSync({
      releases: [rel({ id: 1, tag_name: "v1.0.0", published_at: "2024-01-01T00:00:00Z" })],
      baselineSha: "basesha0",
    });
    fetchStableBaselineReleaseMock.mockResolvedValue(
      rel({ id: 9, tag_name: "v2.0.0", published_at: "2024-06-01T00:00:00Z" })
    );

    const result = await syncAutomationRepo("o/r");

    expect(result.success).toBe(true);
    expect(fetchStableBaselineReleaseMock).toHaveBeenCalledWith("o/r");
    expect(updateRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          releaseState: "ahead",
          releaseBaselineTag: "v2.0.0",
          releaseBaselinePublishedAt: new Date("2024-06-01T00:00:00Z"),
          releaseBaselineSha: "basesha0",
          releaseAheadBy: 7,
        }),
      }),
    );
  });

  it("persists the delta snapshot alongside the sync head", async () => {
    stubDeltaSync();
    const result = await syncAutomationRepo("o/r");

    expect(result.success).toBe(true);
    expect(updateRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          latestCommitSha: "headsha1",
          releaseState: "ahead",
          releaseBaselineTag: "v1.0.0",
          releaseBaselineSha: "basesha1",
          releaseBaselinePublishedAt: new Date("2024-01-01T00:00:00Z"),
          releaseHeadSha: "headsha1",
          releaseAheadBy: 7,
          releaseError: null,
        }),
      }),
    );
    const data = updateRepo.mock.calls.find(
      (call) => (call[0] as { data?: Record<string, unknown> }).data?.releaseState !== undefined,
    )?.[0] as { data: Record<string, unknown> };
    expect(data.data.releaseDeltaSyncedAt).toBeInstanceOf(Date);
  });

  it("keeps the sync successful when the compare read fails (fail-closed snapshot)", async () => {
    stubDeltaSync({ compareError: new Error("compare 503 unavailable") });

    const result = await syncAutomationRepo("o/r");

    expect(result.success).toBe(true);
    expect(updateRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          latestCommitSha: "headsha1",
          releaseState: "unknown",
          releaseAheadBy: null,
          releaseError: expect.stringContaining("503"),
        }),
      }),
    );
  });

  it("resets the baseline to the newer stable release on the next sync", async () => {
    stubDeltaSync({ releases: [rel({ id: 1, tag_name: "v1.0.0" })] });
    await syncAutomationRepo("o/r");
    expect(updateRepo).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ releaseBaselineTag: "v1.0.0" }),
      }),
    );

    stubDeltaSync({
      releases: [
        rel({ id: 2, tag_name: "v2.0.0", published_at: "2024-07-01T00:00:00Z" }),
        rel({ id: 1, tag_name: "v1.0.0" }),
      ],
      baselineSha: "basesha2",
      comparison: { status: "ahead", aheadBy: 1, behindBy: 0, mergeBaseCommitSha: "basesha2" },
    });
    fetchStableBaselineReleaseMock.mockResolvedValue(
      rel({ id: 2, tag_name: "v2.0.0", published_at: "2024-07-01T00:00:00Z" })
    );
    await syncAutomationRepo("o/r");
    expect(updateRepo).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          releaseBaselineTag: "v2.0.0",
          releaseBaselineSha: "basesha2",
          releaseAheadBy: 1,
        }),
      }),
    );
  });

  it("downgrades a stale delta to unknown when the sync fails before it is computed", async () => {
    stubDeltaSync();
    fetchRepoMock.mockRejectedValue(new Error("repo metadata 500"));

    const result = await syncAutomationRepo("o/r");

    expect(result.success).toBe(false);
    const lastData = updateRepo.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(lastData.data.syncError).toContain("repo metadata 500");
    expect(lastData.data.releaseState).toBe("unknown");
    expect(lastData.data.releaseAheadBy).toBeNull();
    expect(lastData.data.releaseError).toContain("sync failed before delta persisted");
  });

  it("keeps a delta persisted by the current pass when a later stage fails", async () => {
    stubDeltaSync();
    fetchWorkflowsMock.mockResolvedValue([
      { id: 1, name: "ci", path: ".github/workflows/ci.yml", state: "active", created_at: "2024-01-01", updated_at: "2024-01-02", last_run: null },
    ]);
    transaction.mockRejectedValueOnce(new Error("workflow upsert timeout"));

    const result = await syncAutomationRepo("o/r");

    expect(result.success).toBe(false);
    const deltaCall = updateRepo.mock.calls.find(
      (call) => (call[0] as { data?: Record<string, unknown> }).data?.releaseState === "ahead",
    );
    expect(deltaCall).toBeDefined();
    const lastData = updateRepo.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(lastData.data.syncError).toContain("workflow upsert timeout");
    // The snapshot this pass completed stays untouched — no downgrade write.
    expect(lastData.data.releaseState).toBeUndefined();
    expect(lastData.data.releaseAheadBy).toBeUndefined();
  });
});
