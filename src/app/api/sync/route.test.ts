import { describe, expect, it, vi, beforeEach } from "vitest";

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => ({
  isAuthorizedAgentToken: vi.fn((token) => token === mockToken),
}));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({ id: "issue-1" }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      findUnique: mocks.findUnique,
      update: mocks.update,
      create: mocks.create,
    },
  },
}));

vi.mock("@/lib/config", () => ({
  getSyncRepos: vi.fn().mockResolvedValue([{ id: "repo-1", fullName: "org/repo" }]),
}));

vi.mock("@/lib/github", () => ({
  fetchIssues: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/issue-sync", () => ({
  syncIssuesForRepos: vi.fn().mockResolvedValue({
    success: true,
    issues: { repos: 1, created: 0, updated: 0, deleted: 0 },
  }),
  mergeLabels: vi.fn((a) => a),
}));

import { POST } from "./route";

function makeRequest(body?: Record<string, unknown>, includeAuth = true) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (includeAuth) headers.Authorization = `Bearer ${mockToken}`;
  return new Request("http://localhost/api/sync", {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  }) as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/sync — auth", () => {
  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(makeRequest({}, false));
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(makeRequest({}, false));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/sync — validation", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("syncs all repos by default", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(200);
  });

  it("syncs a specific repo when repoFullName is provided", async () => {
    const res = await POST(makeRequest({ repoFullName: "org/repo" }));
    expect(res.status).toBe(200);
  });

  it("returns 404 when specified repo is not tracked", async () => {
    vi.mocked(await import("@/lib/config")).getSyncRepos.mockResolvedValue([]);
    const res = await POST(makeRequest({ repoFullName: "unknown/repo" }));
    expect(res.status).toBe(404);
  });
});
