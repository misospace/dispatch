import { describe, it, expect, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

const { mocks } = vi.hoisted(() => ({
  mocks: {
    repositoryFindMany: vi.fn(),
    automationRepoFindMany: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    repository: { findMany: mocks.repositoryFindMany },
    automationRepo: { findMany: mocks.automationRepoFindMany },
  },
}));

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

import { GET } from "./route";
import { resetAuthCaches } from "@/lib/auth";

const URL = "http://localhost/api/automation/repos/tracked";

describe("GET /api/automation/repos/tracked — auth", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
  });

  it("returns 401 when no authorization header is provided", async () => {
    const res = await GET(authedRequest(URL, { includeAuth: false }));

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
    expect(mocks.repositoryFindMany).not.toHaveBeenCalled();
  });

  it("returns 401 when the bearer token is incorrect", async () => {
    const res = await GET(authedRequest(URL, { token: "wrong-token" }));

    expect(res.status).toBe(401);
    expect(mocks.repositoryFindMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/automation/repos/tracked", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.repositoryFindMany.mockResolvedValue([]);
    mocks.automationRepoFindMany.mockResolvedValue([]);
  });

  it("queries only enabled repositories ordered by fullName asc", async () => {
    const res = await GET(authedRequest(URL));

    expect(res.status).toBe(200);
    expect(mocks.repositoryFindMany).toHaveBeenCalledWith({
      where: { enabled: true },
      orderBy: { fullName: "asc" },
    });
    expect(mocks.automationRepoFindMany).toHaveBeenCalledWith({
      select: { fullName: true, defaultBranch: true, source: true, lastSyncedAt: true },
    });
  });

  it("joins AutomationRepo metadata onto each repository and preserves query order", async () => {
    mocks.repositoryFindMany.mockResolvedValue([
      { id: "r1", fullName: "alpha/one", owner: "alpha", name: "one", enabled: true },
      { id: "r2", fullName: "beta/two", owner: "beta", name: "two", enabled: true },
    ]);
    mocks.automationRepoFindMany.mockResolvedValue([
      {
        fullName: "beta/two",
        defaultBranch: "develop",
        source: "env",
        lastSyncedAt: new Date("2026-01-02T03:04:05.000Z"),
      },
      {
        fullName: "alpha/one",
        defaultBranch: "main",
        source: "user",
        lastSyncedAt: null,
      },
    ]);

    const res = await GET(authedRequest(URL));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        fullName: "alpha/one",
        owner: "alpha",
        name: "one",
        enabled: true,
        defaultBranch: "main",
        source: "user",
        lastSyncedAt: null,
      },
      {
        fullName: "beta/two",
        owner: "beta",
        name: "two",
        enabled: true,
        defaultBranch: "develop",
        source: "env",
        lastSyncedAt: "2026-01-02T03:04:05.000Z",
      },
    ]);
  });

  it("defaults defaultBranch to main and source to unknown when no AutomationRepo row exists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.repositoryFindMany.mockResolvedValue([
      { id: "r1", fullName: "owner/repo", owner: "owner", name: "repo", enabled: true },
    ]);

    const res = await GET(authedRequest(URL));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        fullName: "owner/repo",
        owner: "owner",
        name: "repo",
        enabled: true,
        defaultBranch: "main",
        source: "unknown",
        lastSyncedAt: null,
      },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no AutomationRepo row for owner/repo"));
    warn.mockRestore();
  });

  it("returns 500 when the repository query fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.repositoryFindMany.mockRejectedValue(new Error("DB down"));

    const res = await GET(authedRequest(URL));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to fetch tracked repositories");
    error.mockRestore();
  });

  it("returns 500 when the AutomationRepo query fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.repositoryFindMany.mockResolvedValue([
      { id: "r1", fullName: "owner/repo", owner: "owner", name: "repo", enabled: true },
    ]);
    mocks.automationRepoFindMany.mockRejectedValue(new Error("DB down"));

    const res = await GET(authedRequest(URL));

    expect(res.status).toBe(500);
    error.mockRestore();
  });
});
