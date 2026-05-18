import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  getMcConfig,
  resolveIssue,
  claimIssue,
  setIssueStatus,
  claimWork,
  McClientError,
} from "./mc-client";

const mockToken = "test-agent-token";
const mockBaseUrl = "http://localhost:3000";

function setEnv() {
  process.env.MISSION_CONTROL_URL = mockBaseUrl;
  process.env.MISSION_CONTROL_AGENT_TOKEN = mockToken;
}

function clearEnv() {
  delete process.env.MISSION_CONTROL_URL;
  delete process.env.MISSION_CONTROL_AGENT_TOKEN;
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

describe("getMcConfig", () => {
  beforeEach(() => { clearEnv(); vi.restoreAllMocks(); });

  it("returns baseUrl and token when both are set", () => {
    setEnv();
    const config = getMcConfig();
    expect(config.baseUrl).toBe(mockBaseUrl);
    expect(config.token).toBe(mockToken);
  });

  it("strips trailing slashes from baseUrl", () => {
    process.env.MISSION_CONTROL_URL = "http://localhost:3000/";
    process.env.MISSION_CONTROL_AGENT_TOKEN = mockToken;
    const config = getMcConfig();
    expect(config.baseUrl).toBe("http://localhost:3000");
  });

  it("throws when MISSION_CONTROL_URL is missing", () => {
    clearEnv();
    expect(() => getMcConfig()).toThrow(McClientError);
    expect(() => getMcConfig()).toThrow("MISSION_CONTROL_URL");
  });

  it("throws when MISSION_CONTROL_AGENT_TOKEN is missing", () => {
    process.env.MISSION_CONTROL_URL = mockBaseUrl;
    clearEnv();
    process.env.MISSION_CONTROL_URL = mockBaseUrl;
    expect(() => getMcConfig()).toThrow(McClientError);
    expect(() => getMcConfig()).toThrow("MISSION_CONTROL_AGENT_TOKEN");
  });
});

describe("resolveIssue", () => {
  beforeEach(() => {
    setEnv();
    vi.restoreAllMocks();
  });

  it("returns issue data when found", async () => {
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
    const issueNoStatus = { ...mockIssue, labels: ["priority/p1"] };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([issueNoStatus]),
    );

    const result = await resolveIssue("org/repo", 42);
    expect(result.status).toBeNull();
  });

  it("returns null lane when currentLane is undefined", async () => {
    const issueNoLane = { ...mockIssue, currentLane: undefined };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([issueNoLane]),
    );

    const result = await resolveIssue("org/repo", 42);
    expect(result.lane).toBeNull();
  });

  it("throws 404 when issue not found in repo", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([]),
    );

    await expect(resolveIssue("org/repo", 99)).rejects.toThrow(McClientError);
  });

  it("throws 404 with correct message when issue not found", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([]),
    );

    await expect(resolveIssue("org/repo", 99)).rejects.toThrow("not found");
  });

  it("throws when API returns error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse("Internal server error", 500),
    );

    await expect(resolveIssue("org/repo", 42)).rejects.toThrow(McClientError);
  });

  it("passes repo filter in query params", async () => {
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
  beforeEach(() => {
    setEnv();
    vi.restoreAllMocks();
  });

  it("calls resolve then POST /api/issues/claim", async () => {
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
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([mockIssue]))
      .mockResolvedValueOnce(jsonResponse({ success: true, labels: [] }));

    await claimIssue("org/repo", 42, "test-agent", true);

    const call = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.force).toBe(true);
  });

  it("throws McClientError when resolve fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse([]));

    await expect(claimIssue("org/repo", 99, "test-agent")).rejects.toThrow(McClientError);
  });

  it("throws McClientError when claim API returns error", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([mockIssue]))
      .mockResolvedValueOnce(errorResponse("Conflict", 409));

    await expect(claimIssue("org/repo", 42, "test-agent")).rejects.toThrow(McClientError);
  });
});

describe("setIssueStatus", () => {
  beforeEach(() => {
    setEnv();
    vi.restoreAllMocks();
  });

  it("calls resolve then POST /api/issues/status", async () => {
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
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([mockIssue]))
      .mockResolvedValueOnce(jsonResponse({ success: true, status: "", labels: [] }));

    await setIssueStatus("org/repo", 42, "done", "worker-1");

    const call = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.agentName).toBe("worker-1");
  });

  it("omits agentName when not provided", async () => {
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
  beforeEach(() => {
    setEnv();
    vi.restoreAllMocks();
  });

  it("resolves, claims, and sets status in sequence", async () => {
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

describe("McClientError", () => {
  it("stores message and statusCode", () => {
    const err = new McClientError("something failed", 500);
    expect(err.message).toBe("something failed");
    expect(err.statusCode).toBe(500);
    expect(err.name).toBe("McClientError");
  });

  it("defaults statusCode to null", () => {
    const err = new McClientError("oops");
    expect(err.statusCode).toBeNull();
  });
});
