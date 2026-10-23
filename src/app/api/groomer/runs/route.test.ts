import { describe, expect, it, vi, beforeEach } from "vitest";
import { authedRequest } from "@/test/route-helpers";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    authorizeRequest: vi.fn(),
    listGroomingRuns: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({
  authorizeRequest: mocks.authorizeRequest,
  authErrorResponse: vi.fn((auth: { forbidden?: boolean }) =>
    new Response(JSON.stringify({ error: auth.forbidden ? "Forbidden" : "Unauthorized" }), {
      status: auth.forbidden ? 403 : 401,
      headers: { "content-type": "application/json" },
    }),
  ),
}));

vi.mock("@/lib/groomer/history", () => ({
  listGroomingRuns: mocks.listGroomingRuns,
}));

import { GET } from "./route";

function request(url = "/api/groomer/runs", includeAuth = true) {
  return authedRequest(`http://localhost${url}`, { token: "test-token", includeAuth });
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

  it("defaults take to 50 when limit is absent", async () => {
    await GET(request());

    expect(mocks.listGroomingRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ take: 50 }),
    );
  });

  it("clamps an oversized limit at 200", async () => {
    await GET(request("/api/groomer/runs?limit=999999999"));

    expect(mocks.listGroomingRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ take: 200 }),
    );
  });

  it("falls back to the default on a non-numeric limit instead of erroring", async () => {
    const res = await GET(request("/api/groomer/runs?limit=abc"));

    expect(res.status).toBe(200);
    expect(mocks.listGroomingRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ take: 50 }),
    );
  });

  it("falls back to the default on a negative limit", async () => {
    await GET(request("/api/groomer/runs?limit=-5"));

    expect(mocks.listGroomingRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ take: 50 }),
    );
  });

  it("returns runs on success", async () => {
    mocks.listGroomingRuns.mockResolvedValue([
      {
        id: "run-1",
        repoFullName: "org/repo",
        issueNumber: 42,
        status: "completed",
        dryRun: false,
        model: "gpt-4o-mini",
        view: { stage: "applied", evidence: { headSha: "a".repeat(40), pinned: true }, plan: { format: "grooming-plan" } },
        issue: { title: "Fix login", state: "open" },
      },
    ]);
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].id).toBe("run-1");
    expect(body[0].view.evidence.pinned).toBe(true);
    expect(body[0]).not.toHaveProperty("rawOutput");
    expect(body[0]).not.toHaveProperty("contextSummary");
    expect(body[0]).not.toHaveProperty("commentBodyPreview");
    expect(body[0]).not.toHaveProperty("validatedOutput");
  });

  it("returns 500 when list throws", async () => {
    mocks.listGroomingRuns.mockRejectedValue(new Error("database error"));

    const res = await GET(request());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch grooming runs");
  });
});
