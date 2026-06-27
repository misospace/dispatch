import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    authorizeRequest: vi.fn(),
    getGroomingRunDetail: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({
  authorizeRequest: mocks.authorizeRequest,
}));

vi.mock("@/lib/groomer/history", () => ({
  getGroomingRunDetail: mocks.getGroomingRunDetail,
}));

import { GET } from "./route";

function request(id = "run-1", includeAuth = true) {
  const headers: Record<string, string> = {};
  if (includeAuth) headers.Authorization = "Bearer test-token";
  return new Request(`http://localhost/api/groomer/runs/${id}`, { method: "GET", headers });
}

function params(id = "run-1") {
  return Promise.resolve({ id });
}

describe("GET /api/groomer/runs/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeRequest.mockResolvedValue({ authorized: true, type: "bearer", actor: "test" });
    mocks.getGroomingRunDetail.mockResolvedValue({
      id: "run-1",
      repoFullName: "org/repo",
      issueNumber: 42,
      status: "completed",
      dryRun: false,
      model: "gpt-4o-mini",
      issue: { title: "Fix login", state: "open", repository: { name: "repo" } },
      repo: { name: "repo", fullName: "org/repo" },
      agentRun: { id: "agent-run-1", agentName: "hosted-groomer" },
    });
  });

  it("returns 401 when unauthorized", async () => {
    mocks.authorizeRequest.mockResolvedValue({ authorized: false });

    const res = await GET(request("run-1", false), { params: params("run-1") });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 404 when run not found", async () => {
    mocks.getGroomingRunDetail.mockResolvedValue(null);

    const res = await GET(request("nonexistent"), { params: params("nonexistent") });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Grooming run not found");
  });

  it("returns run detail on success", async () => {
    const res = await GET(request(), { params: params() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("run-1");
    expect(body.repoFullName).toBe("org/repo");
    expect(body.issueNumber).toBe(42);
  });

  it("returns 500 when get throws", async () => {
    mocks.getGroomingRunDetail.mockRejectedValue(new Error("database error"));

    const res = await GET(request(), { params: params() });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch grooming run");
  });
});
