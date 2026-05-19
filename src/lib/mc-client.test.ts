import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  DispatchClientError,
} from "./mc-client";

const mockToken = "test-agent-token";
const mockBaseUrl = "http://localhost:3000";

function setEnv() {
  process.env.DISPATCH_URL = mockBaseUrl;
  process.env.DISPATCH_AGENT_TOKEN = mockToken;
}

function clearEnv() {
  delete process.env.DISPATCH_URL;
  delete process.env.DISPATCH_AGENT_TOKEN;
}

const mockIssue = {
  id: "issue-cuid-1",
  number: 42,
  title: "Fix the thing",
  body: "This is the body",
  state: "open",
  url: "https://github.com/org/repo/issues/42",
  labels: ["priority/p1", "status/backlog"],
  assignees: [],
  commentsCount: 3,
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-02"),
  closedAt: null,
  lastSyncedAt: new Date("2025-01-02"),
  currentLane: "normal",
  repository: { fullName: "org/repo" },
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getDispatchConfig", () => {
  beforeEach(async () => {
    clearEnv();
    vi.resetModules();
    await import("./mc-client");
  });

  it("returns baseUrl and token when both are set", async () => {
    const { getDispatchConfig } = await import("./mc-client");
    process.env.DISPATCH_URL = mockBaseUrl;
    process.env.DISPATCH_AGENT_TOKEN = mockToken;
    const config = getDispatchConfig();
    expect(config.baseUrl).toBe(mockBaseUrl);
    expect(config.token).toBe(mockToken);
  });

  it("strips trailing slashes from baseUrl", async () => {
    const { getDispatchConfig } = await import("./mc-client");
    process.env.DISPATCH_URL = "http://localhost:3000/";
    process.env.DISPATCH_AGENT_TOKEN = mockToken;
    const config = getDispatchConfig();
    expect(config.baseUrl).toBe("http://localhost:3000");
  });

  it("throws when DISPATCH_URL is missing", async () => {
    const { getDispatchConfig } = await import("./mc-client");
    clearEnv();
    expect(() => getDispatchConfig()).toThrow(/DISPATCH_URL/);
  });

  it("throws when DISPATCH_AGENT_TOKEN is missing", async () => {
    const { getDispatchConfig } = await import("./mc-client");
    clearEnv();
    process.env.DISPATCH_URL = mockBaseUrl;
    expect(() => getDispatchConfig()).toThrow(/DISPATCH_AGENT_TOKEN/);
  });

  it("throws when both are missing", async () => {
    const { getDispatchConfig } = await import("./mc-client");
    clearEnv();
    expect(() => getDispatchConfig()).toThrow(/DISPATCH_URL/);
  });

  it("does not accept MISSION_CONTROL_URL as fallback", async () => {
    const { getDispatchConfig } = await import("./mc-client");
    clearEnv();
    process.env.MISSION_CONTROL_URL = "http://legacy-localhost:3000";
    process.env.MISSION_CONTROL_AGENT_TOKEN = "legacy-agent-token";
    expect(() => getDispatchConfig()).toThrow(/DISPATCH_URL/);
  });

  it("does not include legacy fallback hint in error message", async () => {
    const { getDispatchConfig } = await import("./mc-client");
    clearEnv();
    process.env.DISPATCH_AGENT_TOKEN = mockToken;
    try {
      getDispatchConfig();
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toMatch(/deprecated/i);
      expect((err as Error).message).toMatch(/DISPATCH_URL/);
    }
  });
});

describe("resolveIssue", () => {
  beforeEach(async () => {
    clearEnv();
    setEnv();
    vi.resetModules();
    await import("./mc-client");
    vi.restoreAllMocks();
  });

  it("returns issue data when found", async () => {
    const { resolveIssue } = await import("./mc-client");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([mockIssue]),
    );

    const result = await resolveIssue("org/repo", 42);

    expect(result.issueId).toBe("issue-cuid-1");
    expect(result.repoFullName).toBe("org/repo");
    expect(result.issueNumber).toBe(42);
    expect(result.title).toBe("Fix the thing");
    expect(result.url).toBe("https://github.com/org/repo/issues/42");
    expect(result.labels).toEqual(["priority/p1", "status/backlog"]);
    expect(result.status).toBe("status/backlog");
    expect(result.lane).toBe("normal");
  });

  it("returns null status when no status label exists", async () => {
    const { resolveIssue } = await import("./mc-client");
    const issueNoStatus = { ...mockIssue, labels: ["priority/p1"] };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([issueNoStatus]),
    );

    const result = await resolveIssue("org/repo", 42);
    expect(result.status).toBeNull();
  });

  it("returns null lane when currentLane is undefined", async () => {
    const { resolveIssue } = await import("./mc-client");
    const issueNoLane = { ...mockIssue, currentLane: undefined };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([issueNoLane]),
    );

    const result = await resolveIssue("org/repo", 42);
    expect(result.lane).toBeNull();
  });

  it("throws 404 when issue not found in repo", async () => {
    const { resolveIssue } = await import("./mc-client");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([]),
    );

    await expect(resolveIssue("org/repo", 99)).rejects.toThrow(/not found/);
  });

  it("throws 404 with correct message when issue not found", async () => {
    const { resolveIssue } = await import("./mc-client");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([]),
    );

    await expect(resolveIssue("org/repo", 99)).rejects.toThrow("not found");
  });

  it("throws when API returns error", async () => {
    const { resolveIssue } = await import("./mc-client");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse("Internal server error", 500),
    );

    await expect(resolveIssue("org/repo", 42)).rejects.toThrow(/Internal server error/);
  });

  it("passes repo filter in query params", async () => {
    const { resolveIssue } = await import("./mc-client");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([mockIssue]),
    );

    await resolveIssue("my-org/my-repo", 42);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("repo=my-org%2Fmy-repo"),
      expect.any(Object),
    );
  });
});

describe("claimIssue", () => {
  beforeEach(async () => {
    clearEnv();
    setEnv();
    vi.resetModules();
    await import("./mc-client");
    vi.restoreAllMocks();
  });

  it("calls resolve then POST /api/issues/claim", async () => {
    const { claimIssue } = await import("./mc-client");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(jsonResponse([mockIssue])) // resolve
      .mockResolvedValueOnce(jsonResponse({ success: true, labels: ["agent/test-agent", "priority/p1", "status/backlog"] })); // claim

    const result = await claimIssue("org/repo", 42, "test-agent");

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/api/issues/claim"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          issueId: "issue-cuid-1",
          repoFullName: "org/repo",
          issueNumber: 42,
          agentName: "test-agent",
          force: false,
        }),
      }),
    );
  });

  it("passes force=true when specified", async () => {
    const { claimIssue } = await import("./mc-client");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([mockIssue]))
      .mockResolvedValueOnce(jsonResponse({ success: true, labels: [] }));

    await claimIssue("org/repo", 42, "test-agent", true);

    const call = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.force).toBe(true);
  });

  it("throws when resolve fails", async () => {
    const { claimIssue } = await import("./mc-client");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse([]));

    await expect(claimIssue("org/repo", 99, "test-agent")).rejects.toThrow(/not found/);
  });

  it("throws when claim API returns error", async () => {
    const { claimIssue } = await import("./mc-client");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([mockIssue]))
      .mockResolvedValueOnce(errorResponse("Conflict", 409));

    await expect(claimIssue("org/repo", 42, "test-agent")).rejects.toThrow(/Conflict/);
  });
});

describe("setIssueStatus", () => {
  beforeEach(async () => {
    clearEnv();
    setEnv();
    vi.resetModules();
    await import("./mc-client");
    vi.restoreAllMocks();
  });

  it("calls resolve then POST /api/issues/status", async () => {
    const { setIssueStatus } = await import("./mc-client");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([mockIssue]))
      .mockResolvedValueOnce(
        jsonResponse({ success: true, status: "status/in-progress", labels: ["agent/test-agent", "status/in-progress"] }),
      );

    const result = await setIssueStatus("org/repo", 42, "in-progress", "test-agent");

    expect(result.success).toBe(true);
    expect(result.status).toBe("status/in-progress");
  });

  it("includes agentName in request when provided", async () => {
    const { setIssueStatus } = await import("./mc-client");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([mockIssue]))
      .mockResolvedValueOnce(jsonResponse({ success: true, status: "", labels: [] }));

    await setIssueStatus("org/repo", 42, "done", "worker-1");

    const call = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.agentName).toBe("worker-1");
  });

  it("omits agentName when not provided", async () => {
    const { setIssueStatus } = await import("./mc-client");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([mockIssue]))
      .mockResolvedValueOnce(jsonResponse({ success: true, status: "", labels: [] }));

    await setIssueStatus("org/repo", 42, "done");

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[1] as [string, RequestInit])[1].body as string,
    );
    expect(body.agentName).toBeUndefined();
  });
});

describe("claimWork", () => {
  beforeEach(async () => {
    clearEnv();
    setEnv();
    vi.resetModules();
    await import("./mc-client");
    vi.restoreAllMocks();
  });

  it("resolves, claims, and sets status in sequence", async () => {
    const { claimWork } = await import("./mc-client");
    // claimWork calls resolveIssue 3 times (once directly + once inside claimIssue + once inside setIssueStatus)
    // plus one POST to /api/issues/claim and one POST to /api/issues/status = 5 fetch calls total
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(jsonResponse([mockIssue]))  // resolve (claimWork)
      .mockResolvedValueOnce(jsonResponse([mockIssue]))  // resolve (claimIssue -> resolveIssue)
      .mockResolvedValueOnce(jsonResponse({ success: true, labels: [] }))         // POST /api/issues/claim
      .mockResolvedValueOnce(jsonResponse([mockIssue])); // resolve (setIssueStatus -> resolveIssue)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, status: "status/in-progress", labels: [] }),
    ); // POST /api/issues/status

    const result = await claimWork("org/repo", 42, "test-agent");

    expect(result.issueId).toBe("issue-cuid-1");
    expect(result.repoFullName).toBe("org/repo");
    expect(result.issueNumber).toBe(42);
    expect(result.title).toBe("Fix the thing");
    expect(result.url).toBe("https://github.com/org/repo/issues/42");
    expect(result.labels).toEqual(["priority/p1", "status/backlog"]);
    expect(result.lane).toBe("normal");
    expect(result.status).toBe("in-progress");
    expect(result.taskContract).toContain("[Task Contract]");
    expect(result.taskContract).toContain("#42");
    expect(result.taskContract).toContain("org/repo");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("uses custom status when provided", async () => {
    const { claimWork } = await import("./mc-client");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce(jsonResponse([mockIssue]))  // resolve
      .mockResolvedValueOnce(jsonResponse([mockIssue]))  // resolve (inside claimIssue)
      .mockResolvedValueOnce(jsonResponse({ success: true, labels: [] }))         // claim
      .mockResolvedValueOnce(jsonResponse([mockIssue])); // resolve (inside setIssueStatus)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ success: true, status: "status/in-review", labels: [] }),
    ); // set status

    const result = await claimWork("org/repo", 42, "test-agent", { status: "in-review" });

    expect(result.status).toBe("in-review");
    const call = vi.mocked(fetch).mock.calls[4] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.status).toBe("in-review");
  });

  it("passes force to claimIssue", async () => {
    const { claimWork } = await import("./mc-client");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce(jsonResponse([mockIssue]))  // resolve
      .mockResolvedValueOnce(jsonResponse([mockIssue]))  // resolve (inside claimIssue)
      .mockResolvedValueOnce(jsonResponse({ success: true, labels: [] }))         // claim
      .mockResolvedValueOnce(jsonResponse([mockIssue])); // resolve (inside setIssueStatus)
    fetchSpy.mockResolvedValueOnce(jsonResponse({ success: true, status: "", labels: [] })); // set status

    await claimWork("org/repo", 42, "test-agent", { force: true });

    const call = vi.mocked(fetch).mock.calls[2] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.force).toBe(true);
  });

  it("includes lane in task contract", async () => {
    const { claimWork } = await import("./mc-client");
    const escalatedIssue = { ...mockIssue, currentLane: "escalated" };
    // claimWork calls resolveIssue 3 times + POST claim + POST status = 5 fetch calls
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce(jsonResponse([escalatedIssue]))  // resolve
      .mockResolvedValueOnce(jsonResponse([escalatedIssue])); // resolve (inside claimIssue)
    fetchSpy.mockResolvedValueOnce(jsonResponse({ success: true, labels: [] })); // claim
    fetchSpy.mockResolvedValueOnce(jsonResponse([escalatedIssue])); // resolve (inside setIssueStatus)
    fetchSpy.mockResolvedValueOnce(jsonResponse({ success: true, status: "", labels: [] })); // set status

    const result = await claimWork("org/repo", 42, "test-agent");
    expect(result.taskContract).toContain("escalated");
  });
});

describe("claimWork with refreshBeforeClaim", () => {
  beforeEach(async () => {
    clearEnv();
    setEnv();
    vi.resetModules();
    await import("./mc-client");
    vi.restoreAllMocks();
  });

  it("refreshes issue when not found and refreshBeforeClaim is true (default)", async () => {
    const { claimWork } = await import("./mc-client");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    // First call fails (issue not in cache)
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    // Refresh succeeds
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, repo: "org/repo", issueNumber: 42, action: "created", error: null }),
    );
    // Resolve after refresh succeeds
    fetchMock.mockResolvedValueOnce(jsonResponse([mockIssue]));
    // Resolve inside claimIssue
    fetchMock.mockResolvedValueOnce(jsonResponse([mockIssue]));
    // Claim POST
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, labels: [] }));
    // Resolve inside setIssueStatus
    fetchMock.mockResolvedValueOnce(jsonResponse([mockIssue]));
    // Set status POST
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, status: "status/in-progress", labels: [] }));

    const result = await claimWork("org/repo", 42, "test-agent");

    expect(result.issueId).toBe("issue-cuid-1");
    expect(result.taskContract).toContain("was not in cache");
  });

  it("does not refresh when refreshBeforeClaim is false", async () => {
    const { claimWork } = await import("./mc-client");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]));

    await expect(claimWork("org/repo", 42, "test-agent", { refreshBeforeClaim: false })).rejects.toThrow(/not found/);
  });

  it("throws clear error when refresh also fails", async () => {
    const { claimWork } = await import("./mc-client");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([])) // resolve fails
      .mockResolvedValueOnce(errorResponse("Issue not found on GitHub", 404)); // refresh fails

    await expect(claimWork("org/repo", 42, "test-agent")).rejects.toThrow(/not found in.*after refresh/);
  });

  it("includes refresh note in task contract when issue was refreshed", async () => {
    const { claimWork } = await import("./mc-client");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(jsonResponse([])) // resolve fails
      .mockResolvedValueOnce(
        jsonResponse({ success: true, repo: "org/repo", issueNumber: 42, action: "created", error: null }),
      ); // refresh succeeds
    fetchMock.mockResolvedValueOnce(jsonResponse([mockIssue])); // resolve after refresh
    fetchMock.mockResolvedValueOnce(jsonResponse([mockIssue])); // resolve inside claimIssue
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, labels: [] })); // claim
    fetchMock.mockResolvedValueOnce(jsonResponse([mockIssue])); // resolve inside setIssueStatus
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, status: "", labels: [] })); // set status

    const result = await claimWork("org/repo", 42, "test-agent");
    expect(result.taskContract).toContain("was refreshed from GitHub");
  });
});

describe("refreshIssue", () => {
  beforeEach(async () => {
    clearEnv();
    setEnv();
    vi.resetModules();
    await import("./mc-client");
    vi.restoreAllMocks();
  });

  it("calls POST /api/issues/refresh with correct body", async () => {
    const { refreshIssue } = await import("./mc-client");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ success: true, repo: "org/repo", issueNumber: 42, action: "created", error: null }),
    );

    const result = await refreshIssue("org/repo", 42);

    expect(result.success).toBe(true);
    expect(result.action).toBe("created");
    expect(result.repo).toBe("org/repo");
    expect(result.issueNumber).toBe(42);
    expect(result.error).toBeNull();

    const call = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain("/api/issues/refresh");
    expect(call[1].method).toBe("POST");
    const body = JSON.parse(call[1].body as string);
    expect(body.repoFullName).toBe("org/repo");
    expect(body.issueNumber).toBe(42);
  });

  it("throws when refresh API returns error", async () => {
    const { refreshIssue } = await import("./mc-client");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse("Issue not found on GitHub", 404),
    );

    await expect(refreshIssue("org/repo", 99)).rejects.toThrow(/not found/);
  });
});

describe("syncRepo", () => {
  beforeEach(async () => {
    clearEnv();
    setEnv();
    vi.resetModules();
    await import("./mc-client");
    vi.restoreAllMocks();
  });

  it("calls POST /api/sync with repoFullName body", async () => {
    const { syncRepo } = await import("./mc-client");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        success: true,
        repos: 1,
        syncedCount: 5,
        results: [{ repo: "org/repo", synced: 5, error: null }],
      }),
    );

    const result = await syncRepo("org/repo");

    expect(result.success).toBe(true);
    expect(result.repos).toBe(1);
    expect(result.syncedCount).toBe(5);

    const call = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain("/api/sync");
    expect(call[1].method).toBe("POST");
    const body = JSON.parse(call[1].body as string);
    expect(body.repoFullName).toBe("org/repo");
  });

  it("throws when sync API returns error", async () => {
    const { syncRepo } = await import("./mc-client");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse("Repo not tracked", 404),
    );

    await expect(syncRepo("unknown/repo")).rejects.toThrow(/not tracked/);
  });
});

describe("DispatchClientError", () => {
  it("stores message and statusCode", () => {
    const err = new DispatchClientError("something failed", 500);
    expect(err.message).toBe("something failed");
    expect(err.statusCode).toBe(500);
    expect(err.name).toBe("DispatchClientError");
  });

  it("defaults statusCode to null", () => {
    const err = new DispatchClientError("oops");
    expect(err.statusCode).toBeNull();
  });
});
