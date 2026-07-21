import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  resolveIssueHandler,
  claimIssueHandler,
  unclaimIssueHandler,
  setIssueStatusHandler,
  claimWorkHandler,
  refreshIssueHandler,
  syncRepoHandler,
  createServer,
  warnIfAgentNameUnset,
} from "./server";

const mockToken = "test-agent-token";
const mockBaseUrl = "http://localhost:3000";

process.env.DISPATCH_URL = mockBaseUrl;
process.env.DISPATCH_AGENT_TOKEN = mockToken;

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

const mockResolvedIssue = {
  issueId: "issue-cuid-1",
  repoFullName: "org/repo",
  issueNumber: 42,
  title: "Fix the thing",
  url: "https://github.com/org/repo/issues/42",
  labels: ["priority/p1", "status/backlog"],
  status: "status/backlog",
  lane: "local",
};

function makeArgs(args: Record<string, unknown>) {
  return args;
}

describe("resolveIssueHandler", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns resolved issue as JSON text", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([
        {
          id: "issue-cuid-1",
          number: 42,
          title: "Fix the thing",
          body: null,
          state: "open",
          url: "https://github.com/org/repo/issues/42",
          labels: ["priority/p1", "status/backlog"],
          assignees: [],
          commentsCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          closedAt: null,
          lastSyncedAt: new Date(),
          currentLane: "local",
          repository: { fullName: "org/repo" },
        },
      ]),
    );

    const result = await resolveIssueHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 42 }));

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.issueId).toBe("issue-cuid-1");
    expect(parsed.title).toBe("Fix the thing");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("returns error when issue not found", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]));

    const result = await resolveIssueHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 99 }));

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("Error:");
    expect(result.content[0].text).toContain("not found");
  });
});

describe("claimIssueHandler", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns claim result as JSON text", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "issue-cuid-1",
            number: 42,
            title: "Fix the thing",
            body: null,
            state: "open",
            url: "https://github.com/org/repo/issues/42",
            labels: ["priority/p1"],
            assignees: [],
            commentsCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            closedAt: null,
            lastSyncedAt: new Date(),
            currentLane: "local",
            repository: { fullName: "org/repo" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, labels: ["agent/test-agent", "priority/p1"] }),
      );

    const result = await claimIssueHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 42, agentName: "test-agent" }));

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.success).toBe(true);
  });

  it("returns error on claim failure", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "issue-cuid-1",
            number: 42,
            title: "Fix the thing",
            body: null,
            state: "open",
            url: "https://github.com/org/repo/issues/42",
            labels: [],
            assignees: [],
            commentsCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            closedAt: null,
            lastSyncedAt: new Date(),
            currentLane: "local",
            repository: { fullName: "org/repo" },
          },
        ]),
      )
      .mockResolvedValueOnce(errorResponse("Conflict", 409));

    const result = await claimIssueHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 42, agentName: "test-agent" }));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error:");
  });

  it("uses DISPATCH_AGENT_NAME when agentName is omitted", async () => {
    process.env.DISPATCH_AGENT_NAME = "env-agent";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "issue-cuid-1",
            number: 42,
            title: "Fix the thing",
            body: null,
            state: "open",
            url: "https://github.com/org/repo/issues/42",
            labels: [],
            assignees: [],
            commentsCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            closedAt: null,
            lastSyncedAt: new Date(),
            currentLane: "local",
            repository: { fullName: "org/repo" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, labels: ["agent/env-agent"] }),
      );

    const result = await claimIssueHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 42 }));

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.success).toBe(true);
    // Verify the claim request used env-agent
    const call = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.agentName).toBe("env-agent");
    delete process.env.DISPATCH_AGENT_NAME;
  });

  it("prefers explicit agentName over DISPATCH_AGENT_NAME", async () => {
    process.env.DISPATCH_AGENT_NAME = "env-agent";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "issue-cuid-1",
            number: 42,
            title: "Fix the thing",
            body: null,
            state: "open",
            url: "https://github.com/org/repo/issues/42",
            labels: [],
            assignees: [],
            commentsCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            closedAt: null,
            lastSyncedAt: new Date(),
            currentLane: "local",
            repository: { fullName: "org/repo" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, labels: ["agent/explicit-agent"] }),
      );

    const result = await claimIssueHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 42, agentName: "explicit-agent" }));

    expect(result.isError).toBeUndefined();
    const call = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.agentName).toBe("explicit-agent");
    delete process.env.DISPATCH_AGENT_NAME;
  });

  it("returns error when both agentName and DISPATCH_AGENT_NAME are missing", async () => {
    delete process.env.DISPATCH_AGENT_NAME;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse([
        {
          id: "issue-cuid-1",
          number: 42,
          title: "Fix the thing",
          body: null,
          state: "open",
          url: "https://github.com/org/repo/issues/42",
          labels: [],
          assignees: [],
          commentsCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          closedAt: null,
          lastSyncedAt: new Date(),
          currentLane: "local",
          repository: { fullName: "org/repo" },
        },
      ]),
    );

    const result = await claimIssueHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 42 }));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("agentName is required");
    expect(result.content[0].text).toContain("DISPATCH_AGENT_NAME");
  });
});

describe("setIssueStatusHandler", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns status update result as JSON text", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "issue-cuid-1",
            number: 42,
            title: "Fix the thing",
            body: null,
            state: "open",
            url: "https://github.com/org/repo/issues/42",
            labels: ["agent/test-agent"],
            assignees: [],
            commentsCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            closedAt: null,
            lastSyncedAt: new Date(),
            currentLane: "local",
            repository: { fullName: "org/repo" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, status: "status/in-progress", labels: ["agent/test-agent", "status/in-progress"] }),
      );

    const result = await setIssueStatusHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 42, status: "in-progress" }));

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.success).toBe(true);
    expect(parsed.status).toBe("status/in-progress");
  });
});

describe("claimWorkHandler", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns claim work result with task contract", async () => {
    const issue = {
      id: "issue-cuid-1",
      number: 42,
      title: "Fix the thing",
      body: null,
      state: "open",
      url: "https://github.com/org/repo/issues/42",
      labels: ["priority/p1", "status/backlog"],
      assignees: [],
      commentsCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      closedAt: null,
      lastSyncedAt: new Date(),
      currentLane: "local",
      repository: { fullName: "org/repo" },
    };

    // claimWork calls resolveIssue 3 times + POST claim + POST status = 5 fetch calls
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce(jsonResponse([issue])) // resolve (claimWork)
      .mockResolvedValueOnce(jsonResponse([issue])) // resolve (claimIssue -> resolveIssue)
      .mockResolvedValueOnce(jsonResponse({ success: true, labels: [] }))       // POST claim
      .mockResolvedValueOnce(jsonResponse([issue])); // resolve (setIssueStatus)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ success: true, status: "status/in-progress", labels: [] }),
    ); // POST status

    const result = await claimWorkHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 42, agentName: "test-agent" }));

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.issueId).toBe("issue-cuid-1");
    expect(parsed.repoFullName).toBe("org/repo");
    expect(parsed.issueNumber).toBe(42);
    expect(parsed.title).toBe("Fix the thing");
    expect(parsed.status).toBe("in-progress");
    expect(parsed.taskContract).toContain("[Task Contract]");
    expect(parsed.taskContract).toContain("#42");
  });

  it("uses custom status when provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "issue-cuid-1",
            number: 42,
            title: "Fix the thing",
            body: null,
            state: "open",
            url: "https://github.com/org/repo/issues/42",
            labels: [],
            assignees: [],
            commentsCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            closedAt: null,
            lastSyncedAt: new Date(),
            currentLane: "local",
            repository: { fullName: "org/repo" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "issue-cuid-1",
            number: 42,
            title: "Fix the thing",
            body: null,
            state: "open",
            url: "https://github.com/org/repo/issues/42",
            labels: [],
            assignees: [],
            commentsCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            closedAt: null,
            lastSyncedAt: new Date(),
            currentLane: "local",
            repository: { fullName: "org/repo" },
          },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, labels: [] }))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "issue-cuid-1",
            number: 42,
            title: "Fix the thing",
            body: null,
            state: "open",
            url: "https://github.com/org/repo/issues/42",
            labels: [],
            assignees: [],
            commentsCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            closedAt: null,
            lastSyncedAt: new Date(),
            currentLane: "local",
            repository: { fullName: "org/repo" },
          },
        ]),
      );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ success: true, status: "status/in-review", labels: [] }),
    );

    const result = await claimWorkHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 42, agentName: "test-agent", status: "in-review" }));

    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.status).toBe("in-review");
  });

  it("passes force flag through", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "issue-cuid-1",
            number: 42,
            title: "Fix the thing",
            body: null,
            state: "open",
            url: "https://github.com/org/repo/issues/42",
            labels: [],
            assignees: [],
            commentsCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            closedAt: null,
            lastSyncedAt: new Date(),
            currentLane: "local",
            repository: { fullName: "org/repo" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "issue-cuid-1",
            number: 42,
            title: "Fix the thing",
            body: null,
            state: "open",
            url: "https://github.com/org/repo/issues/42",
            labels: [],
            assignees: [],
            commentsCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            closedAt: null,
            lastSyncedAt: new Date(),
            currentLane: "local",
            repository: { fullName: "org/repo" },
          },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, labels: [] }))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "issue-cuid-1",
            number: 42,
            title: "Fix the thing",
            body: null,
            state: "open",
            url: "https://github.com/org/repo/issues/42",
            labels: [],
            assignees: [],
            commentsCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            closedAt: null,
            lastSyncedAt: new Date(),
            currentLane: "local",
            repository: { fullName: "org/repo" },
          },
        ]),
      );
    fetchSpy.mockResolvedValueOnce(jsonResponse({ success: true, status: "", labels: [] }));

    await claimWorkHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 42, agentName: "test-agent", force: true }));

    const call = (vi.mocked(fetch).mock.calls[2] as [string, RequestInit])[1];
    const body = JSON.parse(call.body as string) as Record<string, unknown>;
    expect(body.force).toBe(true);
  });

  it("passes refreshBeforeClaim through to client", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "issue-cuid-1",
            number: 42,
            title: "Fix the thing",
            body: null,
            state: "open",
            url: "https://github.com/org/repo/issues/42",
            labels: [],
            assignees: [],
            commentsCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            closedAt: null,
            lastSyncedAt: new Date(),
            currentLane: "local",
            repository: { fullName: "org/repo" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "issue-cuid-1",
            number: 42,
            title: "Fix the thing",
            body: null,
            state: "open",
            url: "https://github.com/org/repo/issues/42",
            labels: [],
            assignees: [],
            commentsCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            closedAt: null,
            lastSyncedAt: new Date(),
            currentLane: "local",
            repository: { fullName: "org/repo" },
          },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, labels: [] }))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "issue-cuid-1",
            number: 42,
            title: "Fix the thing",
            body: null,
            state: "open",
            url: "https://github.com/org/repo/issues/42",
            labels: [],
            assignees: [],
            commentsCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            closedAt: null,
            lastSyncedAt: new Date(),
            currentLane: "local",
            repository: { fullName: "org/repo" },
          },
        ]),
      );
    fetchSpy.mockResolvedValueOnce(jsonResponse({ success: true, status: "", labels: [] }));

    await claimWorkHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 42, agentName: "test-agent", refreshBeforeClaim: false }));

    // With refreshBeforeClaim: false and issue already found, should complete without refresh calls
    // Total calls: resolve + resolve(inside claim) + claim POST + resolve(inside setStatus) + status POST = 5
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it("returns error when agentName is missing and DISPATCH_AGENT_NAME not set", async () => {
    delete process.env.DISPATCH_AGENT_NAME;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse([
        {
          id: "issue-cuid-1",
          number: 42,
          title: "Fix the thing",
          body: null,
          state: "open",
          url: "https://github.com/org/repo/issues/42",
          labels: [],
          assignees: [],
          commentsCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          closedAt: null,
          lastSyncedAt: new Date(),
          currentLane: "local",
          repository: { fullName: "org/repo" },
        },
      ]),
    );

    const result = await claimWorkHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 42 }));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("agentName is required");
    expect(result.content[0].text).toContain("DISPATCH_AGENT_NAME");
  });

  it("uses DISPATCH_AGENT_NAME when agentName is omitted", async () => {
    process.env.DISPATCH_AGENT_NAME = "env-agent";
    const issue = {
      id: "issue-cuid-1",
      number: 42,
      title: "Fix the thing",
      body: null,
      state: "open",
      url: "https://github.com/org/repo/issues/42",
      labels: ["priority/p1"],
      assignees: [],
      commentsCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      closedAt: null,
      lastSyncedAt: new Date(),
      currentLane: "local",
      repository: { fullName: "org/repo" },
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce(jsonResponse([issue])) // resolve (claimWork)
      .mockResolvedValueOnce(jsonResponse([issue])) // resolve (claimIssue -> resolveIssue)
      .mockResolvedValueOnce(jsonResponse({ success: true, labels: [] }))       // POST claim
      .mockResolvedValueOnce(jsonResponse([issue])); // resolve (setIssueStatus)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ success: true, status: "status/in-progress", labels: [] }),
    ); // POST status

    const result = await claimWorkHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 42 }));

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.resolvedAgentName).toBe("env-agent");
    expect(parsed.taskContract).toContain("Agent: env-agent");
    // Verify the claim request used env-agent
    const call = vi.mocked(fetch).mock.calls[2] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.agentName).toBe("env-agent");
    delete process.env.DISPATCH_AGENT_NAME;
  });
});

describe("refreshIssueHandler", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns refresh result as JSON text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ success: true, repo: "org/repo", issueNumber: 42, action: "created", error: null }),
    );

    const result = await refreshIssueHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 42 }));

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.success).toBe(true);
    expect(parsed.action).toBe("created");
    expect(parsed.repo).toBe("org/repo");
    expect(parsed.issueNumber).toBe(42);
  });

  it("returns error when refresh fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse("Issue not found on GitHub", 404),
    );

    const result = await refreshIssueHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 99 }));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error:");
    expect(result.content[0].text).toContain("not found");
  });
});

describe("syncRepoHandler", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns sync result as JSON text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        success: true,
        repos: 1,
        syncedCount: 5,
        results: [{ repo: "org/repo", synced: 5, error: null }],
      }),
    );

    const result = await syncRepoHandler(makeArgs({ repoFullName: "org/repo" }));

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.success).toBe(true);
    expect(parsed.repos).toBe(1);
    expect(parsed.syncedCount).toBe(5);
  });

  it("returns error when repo is not tracked", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse("Repo not tracked", 404),
    );

    const result = await syncRepoHandler(makeArgs({ repoFullName: "unknown/repo" }));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error:");
    expect(result.content[0].text).toContain("not tracked");
  });
});

describe("createServer", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("creates a server without throwing (tool registration)", () => {
    expect(() => createServer()).not.toThrow();
  });

  it("returns an McpServer instance", () => {
    const server = createServer();
    expect(server).toBeDefined();
    // McpServer has a `server` property that is the underlying Server
    expect((server as unknown as { server: unknown }).server).toBeDefined();
  });
});

describe("startup DISPATCH_AGENT_NAME warning", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("emits warning when DISPATCH_AGENT_NAME is unset", () => {
    delete process.env.DISPATCH_AGENT_NAME;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnIfAgentNameUnset();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("DISPATCH_AGENT_NAME is not set"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("agentName argument"),
    );
  });

  it("does NOT emit warning when DISPATCH_AGENT_NAME is set", () => {
    process.env.DISPATCH_AGENT_NAME = "test-agent";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnIfAgentNameUnset();

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("DISPATCH_AGENT_NAME is not set"),
    );
    delete process.env.DISPATCH_AGENT_NAME;
  });
});

describe("unclaimIssueHandler", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("resolves then POSTs /api/issues/unclaim and returns the result", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "issue-cuid-1",
            number: 42,
            title: "Fix the thing",
            body: null,
            state: "open",
            url: "https://github.com/org/repo/issues/42",
            labels: ["agent/test-agent", "priority/p1", "status/in-progress"],
            assignees: [],
            commentsCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            closedAt: null,
            lastSyncedAt: new Date(),
            currentLane: "local",
            repository: { fullName: "org/repo" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, labels: ["priority/p1", "status/ready"] }),
      );

    const result = await unclaimIssueHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 42, agentName: "test-agent" }));

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.success).toBe(true);
    expect(parsed.labels).toContain("status/ready");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/api/issues/unclaim"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          issueId: "issue-cuid-1",
          repoFullName: "org/repo",
          issueNumber: 42,
          agentName: "test-agent",
        }),
      }),
    );
  });

  it("errors when agentName is missing and DISPATCH_AGENT_NAME is unset", async () => {
    const saved = process.env.DISPATCH_AGENT_NAME;
    delete process.env.DISPATCH_AGENT_NAME;
    try {
      const result = await unclaimIssueHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 42 }));
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.error).toMatch(/agentName is required/);
    } finally {
      if (saved !== undefined) process.env.DISPATCH_AGENT_NAME = saved;
    }
  });

  it("returns error when the unclaim API rejects", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "issue-cuid-1",
            number: 42,
            title: "Fix the thing",
            body: null,
            state: "open",
            url: "https://github.com/org/repo/issues/42",
            labels: ["priority/p1", "status/ready"],
            assignees: [],
            commentsCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            closedAt: null,
            lastSyncedAt: new Date(),
            currentLane: "local",
            repository: { fullName: "org/repo" },
          },
        ]),
      )
      .mockResolvedValueOnce(errorResponse("Issue is not assigned to test-agent", 400));

    const result = await unclaimIssueHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 42, agentName: "test-agent" }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not assigned/);
  });
});
