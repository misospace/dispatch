import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    authorizeRequest: vi.fn(),
    listGroomingRuns: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({
  authorizeRequest: mocks.authorizeRequest,
}));

vi.mock("@/lib/groomer/history", () => ({
  listGroomingRuns: mocks.listGroomingRuns,
}));

import { GET } from "./route";

function request(url = "/api/groomer/runs", includeAuth = true) {
  const headers: Record<string, string> = {};
  if (includeAuth) headers.Authorization = "Bearer test-token";
  return new Request(`http://localhost${url}`, { method: "GET", headers });
}

describe("GET /api/groomer/runs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeRequest.mockResolvedValue({ authorized: true, type: "bearer", actor: "test" });
    mocks.listGroomingRuns.mockResolvedValue([
      {
        id: "run-1",
        repoFullName: "org/repo",
        issueNumber: 42,
        status: "completed",
        dryRun: false,
        model: "gpt-4o-mini",
        issue: { title: "Fix login", state: "open" },
      },
    ]);
  });

  it("returns 401 when unauthorized", async () => {
    mocks.authorizeRequest.mockResolvedValue({ authorized: false });

    const res = await GET(request("/api/groomer/runs", false));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("parses filter query parameters", async () => {
    await GET(
      new Request("http://localhost/api/groomer/runs?repo=org/repo&status=completed&model=gpt-4o-mini&issueNumber=42&dryRun=true&limit=10", {
        method: "GET",
        headers: { Authorization: "Bearer test-token" },
      }),
    );

    expect(mocks.listGroomingRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        repo: "org/repo",
        status: "completed",
        model: "gpt-4o-mini",
        issueNumber: 42,
        dryRun: true,
        take: 10,
      }),
    );
  });

  it("parses dryRun=false correctly", async () => {
    await GET(
      new Request("http://localhost/api/groomer/runs?dryRun=false", {
        method: "GET",
        headers: { Authorization: "Bearer test-token" },
      }),
    );

    expect(mocks.listGroomingRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dryRun: false }),
    );
  });

  it("returns runs on success", async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].id).toBe("run-1");
  });

  it("returns 500 when list throws", async () => {
    mocks.listGroomingRuns.mockRejectedValue(new Error("database error"));

    const res = await GET(request());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch grooming runs");
  });
});
