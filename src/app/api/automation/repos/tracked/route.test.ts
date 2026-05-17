import { describe, expect, it, vi, beforeEach } from "vitest";

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

import { GET } from "./route";

function getRequest() {
  return GET(new Request("http://localhost/api/automation/repos/tracked"));
}

describe("GET /api/automation/repos/tracked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only enabled repos, sorted by fullName", async () => {
    // Mock returns the full set; the route applies `where: { enabled: true }`
    mocks.repositoryFindMany.mockImplementation((opts) => {
      let repos = [
        { fullName: "org/b", owner: "org", name: "b", enabled: true },
        { fullName: "org/a", owner: "org", name: "a", enabled: true },
        { fullName: "org/c", owner: "org", name: "c", enabled: false },
      ];
      if (opts?.where?.enabled === true) {
        repos = repos.filter((r) => r.enabled);
      }
      return Promise.resolve(
        repos.sort((a, b) => a.fullName.localeCompare(b.fullName)),
      );
    });
    mocks.automationRepoFindMany.mockResolvedValue([
      { fullName: "org/a", source: "user", lastSyncedAt: new Date("2026-01-01") },
      { fullName: "org/b", source: "env", lastSyncedAt: null },
    ]);

    const res = await getRequest();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].fullName).toBe("org/a");
    expect(body[1].fullName).toBe("org/b");

    // disabled repo should not be included
    expect(body.every((r: { fullName: string }) => r.fullName !== "org/c")).toBe(true);
  });

  it("includes source and lastSyncedAt from AutomationRepo when available", async () => {
    mocks.repositoryFindMany.mockResolvedValue([
      { fullName: "org/x", owner: "org", name: "x", enabled: true },
    ]);
    mocks.automationRepoFindMany.mockResolvedValue([
      { fullName: "org/x", source: "user", lastSyncedAt: new Date("2026-05-17") },
    ]);

    const res = await getRequest();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body[0]).toEqual({
      fullName: "org/x",
      owner: "org",
      name: "x",
      enabled: true,
      source: "user",
      lastSyncedAt: "2026-05-17T00:00:00.000Z",
    });
  });

  it("falls back to source 'unknown' and null lastSyncedAt when no AutomationRepo exists", async () => {
    mocks.repositoryFindMany.mockResolvedValue([
      { fullName: "org/y", owner: "org", name: "y", enabled: true },
    ]);
    mocks.automationRepoFindMany.mockResolvedValue([]);

    const res = await getRequest();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body[0]).toEqual({
      fullName: "org/y",
      owner: "org",
      name: "y",
      enabled: true,
      source: "unknown",
      lastSyncedAt: null,
    });
  });

  it("returns empty array when no repos are enabled", async () => {
    mocks.repositoryFindMany.mockResolvedValue([]);
    mocks.automationRepoFindMany.mockResolvedValue([]);

    const res = await getRequest();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns 500 on database error", async () => {
    mocks.repositoryFindMany.mockRejectedValue(new Error("db down"));

    const res = await getRequest();
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body).toEqual({ error: "Failed to fetch tracked repositories" });
  });
});
