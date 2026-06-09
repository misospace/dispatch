import { describe, expect, it, vi, beforeEach } from "vitest";

const mockToken = "test-agent-token";
process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => ({
  isAuthorizedAgentToken: vi.fn((token) => token === mockToken),
  isAuthorizedBearerToken: vi.fn((token) => token === mockToken),
  getAcceptedAgentTokens: vi.fn(() => [mockToken]),
  resetCaches: vi.fn(),
  safeEqual: vi.fn((a: string, b: string) => a === b),
}));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({ id: "issue-1" }),
    auth: vi.fn(),
    syncLockFindUnique: vi.fn().mockResolvedValue(null),
    syncLockDelete: vi.fn().mockResolvedValue(undefined),
    syncLockDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    issueSyncRunUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
    transactionFn: vi.fn(async (fn: any) => {
      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return runId;
    }),
  },
}));

vi.mock("@/lib/auth-next", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      findUnique: mocks.findUnique,
      update: mocks.update,
      create: mocks.create,
    },
    syncLock: {
      findUnique: mocks.syncLockFindUnique,
      delete: mocks.syncLockDelete,
      deleteMany: mocks.syncLockDeleteMany,
    },
    issueSyncRun: {
      updateMany: mocks.issueSyncRunUpdateMany,
    },
    $transaction: mocks.transactionFn,
  },
}));

vi.mock("@/lib/config", () => ({
  getSyncRepos: vi.fn().mockResolvedValue([{ id: "repo-1", fullName: "org/repo" }]),
  parseExcludedLabels: vi.fn().mockReturnValue([]),
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
import { resetAuthCaches } from "@/lib/auth";

function makeRequest(
  body?: Record<string, unknown> | string,
  includeAuth = true,
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = {};
  if (includeAuth) headers.Authorization = `Bearer ${mockToken}`;
  Object.assign(headers, extraHeaders);
  const bodyValue = typeof body === "string" ? body : JSON.stringify(body ?? {});
  if (typeof body === "string" || body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  return new Request("http://localhost/api/sync", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : body !== undefined ? JSON.stringify(body) : undefined,
  }) as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/sync — auth", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.auth.mockReset();
  });

  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(makeRequest({}, false));
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(makeRequest({}, false));
    expect(res.status).toBe(401);
  });

  it("accepts valid Basic Auth in basic mode", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    resetAuthCaches();

    const res = await POST(makeRequest({}, false, { Authorization: "Basic b3BlcmF0b3I6czNjcmV0" }));

    expect(res.status).toBe(200);
  });

  it("accepts valid Bearer auth in basic mode", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    resetAuthCaches();

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(200);
  });

  it("accepts valid OIDC session cookies in oidc mode", async () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    resetAuthCaches();
    mocks.auth.mockResolvedValue({ user: { email: "operator@example.com" } });

    const res = await POST(makeRequest({}, false));

    expect(res.status).toBe(200);
  });

  it("accepts valid Bearer auth in oidc mode", async () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    resetAuthCaches();

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(200);
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});

describe("POST /api/sync — validation", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
  });

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

  it("succeeds with no body (truly empty request)", async () => {
    const res = await POST(makeRequest(undefined));
    expect(res.status).toBe(200);
  });

  it("returns 400 when body is malformed JSON", async () => {
    const res = await POST(makeRequest("{bad json}"));
    expect(res.status).toBe(400);
  });
});
