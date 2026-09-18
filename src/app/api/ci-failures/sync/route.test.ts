import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock } from "@/test/route-helpers";
import type { CiRun } from "@/lib/ci-failure-ingestion";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

// Mirrors the real (pure) policy so the route's decisions are meaningful in
// every branch below, without needing the real GitHub for the marker format.
const REAL = await import("@/lib/ci-failure-ingestion");
const LOG = "npm ci failed: EUSAGE invalid config";
const SIG = REAL.computeFailureSignature({
  repoFullName: "org/repo",
  workflowName: "Release",
  jobName: "Build",
  logExcerpt: LOG,
});

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getTrackedRepos: vi.fn().mockResolvedValue([]),
    acquireLock: vi.fn().mockResolvedValue({ locked: true, runId: "test-run" }),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    fetchRepositoryMetadata: vi.fn(),
    fetchRecentRunsAllWorkflows: vi.fn().mockResolvedValue([]),
    fetchIssues: vi.fn().mockResolvedValue([]),
    fetchRunJobs: vi.fn().mockResolvedValue([]),
    fetchFailedJobLogExcerpt: vi.fn().mockResolvedValue("log"),
    createIssue: vi.fn().mockResolvedValue({ number: 100, html_url: "https://github.com/org/repo/issues/100" }),
    addIssueComment: vi.fn().mockResolvedValue(undefined),
    closeIssue: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

vi.mock("@/lib/config", () => ({
  getTrackedRepos: mocks.getTrackedRepos,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { automationRepo: { findMany: vi.fn(), upsert: vi.fn() } },
}));

vi.mock("@/lib/sync-lock", () => ({
  acquireLock: mocks.acquireLock,
  releaseLock: mocks.releaseLock,
}));

vi.mock("@/lib/github", () => ({
  fetchRepositoryMetadata: mocks.fetchRepositoryMetadata,
  fetchRecentRunsAllWorkflows: mocks.fetchRecentRunsAllWorkflows,
  fetchIssues: mocks.fetchIssues,
  fetchRunJobs: mocks.fetchRunJobs,
  fetchFailedJobLogExcerpt: mocks.fetchFailedJobLogExcerpt,
  createIssue: mocks.createIssue,
  addIssueComment: mocks.addIssueComment,
  closeIssue: mocks.closeIssue,
}));

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";

function makeRequest(
  opts: { includeAuth?: boolean; token?: string } = {},
): Parameters<typeof POST>[0] {
  const { includeAuth = true, token = mockToken } = opts;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (includeAuth) headers.Authorization = `Bearer ${token}`;
  return new Request("http://localhost/api/ci-failures/sync", {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  }) as unknown as Parameters<typeof POST>[0];
}

function ciRun(over: Partial<CiRun> = {}): CiRun {
  return {
    id: 1,
    name: "Release",
    status: "completed",
    conclusion: "failure",
    head_branch: "main",
    head_sha: "deadbeefcafe",
    html_url: "https://github.com/org/repo/actions/runs/1",
    updated_at: "2026-09-04T02:00:00Z",
    ...over,
  };
}

function githubIssue(number: number, marker: string, state: "open" | "closed" = "open") {
  return {
    number,
    title: `CI: Release failing on the default branch (Build)`,
    body: marker,
    state,
    html_url: `https://github.com/org/repo/issues/${number}`,
    labels: [],
    assignees: [],
    comments: 0,
    created_at: "2026-09-04T02:00:00Z",
    updated_at: "2026-09-04T02:00:00Z",
    closed_at: state === "closed" ? "2026-09-04T03:00:00Z" : null,
  };
}

function stubRepoPass() {
  mocks.getTrackedRepos.mockResolvedValue(["org/repo"]);
  mocks.fetchRepositoryMetadata.mockResolvedValue({
    fullName: "org/repo",
    defaultBranch: "main",
    description: null,
  });
}

describe("POST /api/ci-failures/sync — auth", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
  });

  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(makeRequest({ includeAuth: false }));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(mocks.acquireLock).not.toHaveBeenCalled();
  });

  it("returns 401 when the bearer token is incorrect", async () => {
    const res = await POST(makeRequest({ token: "wrong-token" }));

    expect(res.status).toBe(401);
    expect(mocks.acquireLock).not.toHaveBeenCalled();
  });
});

describe("POST /api/ci-failures/sync — rate limit", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
    mocks.getTrackedRepos.mockResolvedValue([]);
  });

  it("returns 429 with Retry-After after exceeding the rate limit (10/min)", async () => {
    for (let i = 0; i < 10; i++) {
      const ok = await POST(makeRequest());
      expect(ok.status).toBe(200);
    }

    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = await res.json();
    expect(body.error).toBe("Rate limit exceeded");

    // The limiter must reject before any sync work happens.
    expect(mocks.acquireLock).toHaveBeenCalledTimes(10);
  });
});

describe("POST /api/ci-failures/sync — lock", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
  });

  it("returns 409 when another ci-failures sync holds the lock", async () => {
    mocks.acquireLock.mockResolvedValue({ locked: false });

    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ locked: true });
    expect(mocks.acquireLock).toHaveBeenCalledWith("ci-failures");
    expect(mocks.getTrackedRepos).not.toHaveBeenCalled();
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });
});

describe("POST /api/ci-failures/sync — ingestion", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
    mocks.acquireLock.mockResolvedValue({ locked: true, runId: "test-run" });
    mocks.releaseLock.mockResolvedValue(undefined);
    stubRepoPass();
    mocks.fetchRecentRunsAllWorkflows.mockResolvedValue([]);
    mocks.fetchIssues.mockResolvedValue([]);
    mocks.fetchRunJobs.mockResolvedValue([
      { id: 7, name: "Build", status: "completed", conclusion: "failure", started_at: null, completed_at: null },
    ]);
    // Same log for every job → the route's signature matches the marker in
    // the seeded issues (both computed from LOG above).
    mocks.fetchFailedJobLogExcerpt.mockResolvedValue(LOG);
    mocks.createIssue.mockResolvedValue({ number: 100, html_url: "https://github.com/org/repo/issues/100" });
  });

  it("files an issue for a workflow that failed twice in a row", async () => {
    const latest = ciRun({ id: 2, updated_at: "2026-09-04T03:00:00Z" });
    const previous = ciRun({ id: 1, updated_at: "2026-09-04T02:00:00Z" });
    mocks.fetchRecentRunsAllWorkflows.mockResolvedValue([latest, previous]);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.filed).toEqual([{ repo: "org/repo", number: 100, workflow: "Release" }]);
    expect(body.closed).toEqual([]);
    expect(body.skipped).toEqual([]);
    expect(body.errors).toEqual([]);

    // Only the repeated-failure path is allowed to fetch jobs and logs.
    expect(mocks.fetchRunJobs).toHaveBeenCalledWith("org/repo", 2);
    expect(mocks.fetchFailedJobLogExcerpt).toHaveBeenCalledWith("org/repo", 7);
    expect(mocks.addIssueComment).not.toHaveBeenCalled();
    expect(mocks.closeIssue).not.toHaveBeenCalled();

    const created = mocks.createIssue.mock.calls[0];
    expect(created[0]).toBe("org/repo");
    expect(created[1].title).toBe("CI: Release failing on the default branch (Build)");
    expect(created[1].labels).toEqual(["type/bug", "status/ready"]);
    // The marker lets the next pass tell "already filed" without local state.
    expect(created[1].body).toContain(REAL.buildFailureMarker(SIG, "Release"));

    // The lock is always released, and only the acquirer releases it.
    expect(mocks.releaseLock).toHaveBeenCalledWith("test-run");
  });

  it("does not file for a first failure (waits for a second)", async () => {
    mocks.fetchRecentRunsAllWorkflows.mockResolvedValue([ciRun({ id: 2 })]);

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(body.skipped).toEqual([
      {
        repo: "org/repo",
        workflow: "Release",
        reason: "first failure; waiting for a second to rule out a transient",
      },
    ]);
    expect(mocks.createIssue).not.toHaveBeenCalled();
    expect(mocks.fetchRunJobs).not.toHaveBeenCalled();
  });

  it("does not file when an open issue already carries the signature (dedup)", async () => {
    const latest = ciRun({ id: 2, updated_at: "2026-09-04T03:00:00Z" });
    const previous = ciRun({ id: 1, updated_at: "2026-09-04T02:00:00Z" });
    mocks.fetchRecentRunsAllWorkflows.mockResolvedValue([latest, previous]);
    // Same excerpt → same signature as the existing open issue.
    mocks.fetchIssues.mockResolvedValue([githubIssue(42, REAL.buildFailureMarker(SIG, "Release"))]);

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(body.filed).toEqual([]);
    expect(body.skipped).toEqual([
      { repo: "org/repo", workflow: "Release", reason: `already filed as #42` },
    ]);
    expect(mocks.createIssue).not.toHaveBeenCalled();
  });

  it("skips filing on re-verify when the fresh listing shows a duplicate", async () => {
    const latest = ciRun({ id: 2, updated_at: "2026-09-04T03:00:00Z" });
    const previous = ciRun({ id: 1, updated_at: "2026-09-04T02:00:00Z" });
    mocks.fetchRecentRunsAllWorkflows.mockResolvedValue([latest, previous]);
    // First listing is clean; the fresh re-listing before creating the issue
    // surfaces the duplicate the first listing missed.
    mocks.fetchIssues.mockResolvedValueOnce([]).mockResolvedValue([
      githubIssue(43, REAL.buildFailureMarker(SIG, "Release")),
    ]);

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(body.filed).toEqual([]);
    expect(body.skipped).toEqual([
      { repo: "org/repo", workflow: "Release", reason: "already filed as #43 (caught on re-verify)" },
    ]);
    expect(mocks.createIssue).not.toHaveBeenCalled();
  });

  it("skips filing when the re-verify listing itself fails (fail closed)", async () => {
    const latest = ciRun({ id: 2, updated_at: "2026-09-04T03:00:00Z" });
    const previous = ciRun({ id: 1, updated_at: "2026-09-04T02:00:00Z" });
    mocks.fetchRecentRunsAllWorkflows.mockResolvedValue([latest, previous]);
    mocks.fetchIssues.mockResolvedValueOnce([]).mockRejectedValue(new Error("rate limited"));

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(body.filed).toEqual([]);
    expect(body.skipped[0].reason).toContain("could not re-verify before filing");
    expect(mocks.createIssue).not.toHaveBeenCalled();
  });

  it("skips filing when the run failed but no job reported a failure", async () => {
    const latest = ciRun({ id: 2, updated_at: "2026-09-04T03:00:00Z" });
    const previous = ciRun({ id: 1, updated_at: "2026-09-04T02:00:00Z" });
    mocks.fetchRecentRunsAllWorkflows.mockResolvedValue([latest, previous]);
    mocks.fetchRunJobs.mockResolvedValue([{ id: 7, name: "Build", status: "completed", conclusion: "success", started_at: null, completed_at: null }]);

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(body.skipped).toEqual([
      { repo: "org/repo", workflow: "Release", reason: "run failed but no job reported failure" },
    ]);
    expect(mocks.createIssue).not.toHaveBeenCalled();
  });

  it("closes the matching open issue when the workflow went green twice in a row", async () => {
    const green = ciRun({
      id: 2,
      updated_at: "2026-09-04T04:00:00Z",
      conclusion: "success",
    });
    const olderGreen = ciRun({
      id: 1,
      updated_at: "2026-09-04T03:00:00Z",
      conclusion: "success",
    });
    mocks.fetchRecentRunsAllWorkflows.mockResolvedValue([green, olderGreen]);
    mocks.fetchIssues.mockResolvedValue([githubIssue(42, REAL.buildFailureMarker(SIG, "Release"))]);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.closed).toEqual([{ repo: "org/repo", number: 42, workflow: "Release" }]);
    expect(body.filed).toEqual([]);
    expect(body.skipped).toEqual([]);

    expect(mocks.addIssueComment).toHaveBeenCalledWith("org/repo", 42, expect.stringContaining("Closing"));
    expect(mocks.closeIssue).toHaveBeenCalledWith("org/repo", 42);
    expect(mocks.createIssue).not.toHaveBeenCalled();
    // The healthy path never touches jobs or logs.
    expect(mocks.fetchRunJobs).not.toHaveBeenCalled();
    expect(mocks.fetchFailedJobLogExcerpt).not.toHaveBeenCalled();
  });

  it("does not close on a single green after a red (flapping, #953)", async () => {
    mocks.fetchRecentRunsAllWorkflows.mockResolvedValue([
      ciRun({ id: 2, updated_at: "2026-09-04T04:00:00Z", conclusion: "success" }),
      ciRun({ id: 1, updated_at: "2026-09-04T03:00:00Z", conclusion: "failure" }),
    ]);
    mocks.fetchIssues.mockResolvedValue([githubIssue(42, REAL.buildFailureMarker(SIG, "Release"))]);

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(body.closed).toEqual([]);
    expect(body.skipped).toEqual([
      {
        repo: "org/repo",
        workflow: "Release",
        reason: "green after a red; waiting for a second green to rule out a flapping workflow",
      },
    ]);
    expect(mocks.closeIssue).not.toHaveBeenCalled();
  });

  it("does not close an issue owned by a different workflow", async () => {
    const green = ciRun({ id: 2, updated_at: "2026-09-04T04:00:00Z", conclusion: "success" });
    const olderGreen = ciRun({ id: 1, updated_at: "2026-09-04T03:00:00Z", conclusion: "success" });
    mocks.fetchRecentRunsAllWorkflows.mockResolvedValue([green, olderGreen]);
    // The open issue is for a different workflow, so it must be left alone.
    const otherSig = REAL.computeFailureSignature({
      repoFullName: "org/repo",
      workflowName: "Vulnerability Scan",
      jobName: "scan",
      logExcerpt: "3 vulnerabilities found",
    });
    mocks.fetchIssues.mockResolvedValue([githubIssue(42, REAL.buildFailureMarker(otherSig, "Vulnerability Scan"))]);

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(body.closed).toEqual([]);
    expect(body.skipped).toEqual([
      { repo: "org/repo", workflow: "Release", reason: "workflow is green and nothing is open for it" },
    ]);
    expect(mocks.closeIssue).not.toHaveBeenCalled();
  });

  it("re-files a fresh issue, superseding the closed one, when the failure returns", async () => {
    const latest = ciRun({ id: 2, updated_at: "2026-09-04T03:00:00Z" });
    const previous = ciRun({ id: 1, updated_at: "2026-09-04T02:00:00Z" });
    mocks.fetchRecentRunsAllWorkflows.mockResolvedValue([latest, previous]);
    mocks.fetchIssues.mockResolvedValue([githubIssue(41, REAL.buildFailureMarker(SIG, "Release"), "closed")]);

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(body.filed).toEqual([{ repo: "org/repo", number: 100, workflow: "Release" }]);
    const created = mocks.createIssue.mock.calls[0];
    expect(created[1].body).toContain("filed before as #41");
    // A closed predecessor must not block the re-filing.
    expect(mocks.closeIssue).not.toHaveBeenCalled();
  });

  it("scopes work per workflow in a multi-workflow pass (file for one, close for another)", async () => {
    const runs = [
      // Vulnerability Scan: two consecutive failures → files.
      { ...ciRun({ id: 2, name: "Vulnerability Scan", updated_at: "2026-09-04T04:00:00Z" }) },
      { ...ciRun({ id: 1, name: "Vulnerability Scan", updated_at: "2026-09-04T03:00:00Z" }) },
      // Release: two consecutive greens → closes its own open issue.
      { ...ciRun({ id: 4, name: "Release", updated_at: "2026-09-04T02:00:00Z", conclusion: "success" }) },
      { ...ciRun({ id: 3, name: "Release", updated_at: "2026-09-04T01:00:00Z", conclusion: "success" }) },
    ];
    mocks.fetchRecentRunsAllWorkflows.mockResolvedValue(runs);
    // Only the repeated-failure workflow asks for jobs.
    mocks.fetchRunJobs.mockResolvedValue([
      { id: 7, name: "Build", status: "completed", conclusion: "failure", started_at: null, completed_at: null },
    ]);
    // The open issue belongs to Release, not Vulnerability Scan.
    const releaseSig = REAL.computeFailureSignature({
      repoFullName: "org/repo",
      workflowName: "Release",
      jobName: "Build",
      logExcerpt: "release build failed",
    });
    mocks.fetchIssues.mockResolvedValue([githubIssue(42, REAL.buildFailureMarker(releaseSig, "Release"))]);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    // Release closes; the Vulnerability Scan failure files even though an
    // open issue exists for a *different* workflow.
    expect(body.closed).toEqual([{ repo: "org/repo", number: 42, workflow: "Release" }]);
    expect(body.filed).toEqual([{ repo: "org/repo", number: 100, workflow: "Vulnerability Scan" }]);
    expect(mocks.closeIssue).toHaveBeenCalledWith("org/repo", 42);
    expect(mocks.createIssue).toHaveBeenCalledTimes(1);
    expect(mocks.createIssue.mock.calls[0][1].title).toBe("CI: Vulnerability Scan failing on the default branch (Build)");
  });

  it("releases the lock even when a repo pass throws", async () => {
    mocks.getTrackedRepos.mockResolvedValue(["org/broken"]);
    mocks.fetchRepositoryMetadata.mockRejectedValue(new Error("network down"));

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.errors).toEqual([{ repo: "org/broken", error: "Error: network down" }]);
    expect(mocks.releaseLock).toHaveBeenCalledWith("test-run");
  });

  it("returns an empty summary when no repos are tracked", async () => {
    mocks.getTrackedRepos.mockResolvedValue([]);

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ filed: [], closed: [], skipped: [], errors: [] });
  });
});
