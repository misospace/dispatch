import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  resolveIssueHandler,
  claimIssueHandler,
  setIssueStatusHandler,
  claimWorkHandler,
  createServer,
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
  lane: "normal",
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
          currentLane: "normal",
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
            currentLane: "normal",
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
            currentLane: "normal",
            repository: { fullName: "org/repo" },
          },
        ]),
      )
      .mockResolvedValueOnce(errorResponse("Conflict", 409));

    const result = await claimIssueHandler(makeArgs({ repoFullName: "org/repo", issueNumber: 42, agentName: "test-agent" }));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error:");
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
            currentLane: "normal",
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
      currentLane: "normal",
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
            currentLane: "normal",
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
            currentLane: "normal",
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
            currentLane: "normal",
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
            currentLane: "normal",
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
            currentLane: "normal",
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
            currentLane: "normal",
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
