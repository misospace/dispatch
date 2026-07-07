import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, authedRequest } from "@/test/route-helpers";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUnique: vi.fn(),
    createLane: vi.fn(),
    updateIssue: vi.fn(),
    findFirstLane: vi.fn(),
  },
}));

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findUnique: mocks.findUnique, update: mocks.updateIssue },
    issueLane: { findFirst: mocks.findFirstLane, create: mocks.createLane },
    $transaction: vi.fn((ops) => Promise.all(ops)),
  },
}));

import { POST, GET } from "./route";

function makeIssue(overrides = {}) {
  return {
    id: "issue-1",
    state: "open",
    labels: [] as string[],
    title: "Fix login bug",
    body: "Login fails when password is wrong.",
    repository: { fullName: "org/repo" },
    ...overrides,
  };
}

function makePayload(o = {}) {
  return { issueId: "issue-1", ...o };
}

function makeRequest(method = "POST", overrides = {}, extraHeaders = {}) {
  const payload = typeof overrides === "object" && !Array.isArray(overrides) ? { ...makePayload(), ...overrides } : overrides;
  return authedRequest("http://localhost/api/issues/issue-1/lane", {
    method,
    body: method === "POST" ? payload : undefined,
    headers: extraHeaders,
  }) as unknown as Parameters<typeof POST>[0];
}

// Helper to create context params
function makeContext(overrides = {}) {
  return {
    params: Promise.resolve({ issueId: "issue-1", ...overrides }),
  };
}

describe("POST /api/issues/[issueId]/lane — auth", () => {
  it("returns 401 when no authorization header is provided", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/issue-1/lane", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makePayload()),
      }) as unknown as Parameters<typeof POST>[0],
      makeContext(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(makeRequest("POST", {}, { Authorization: "Bearer wrong-token" }), makeContext());
    expect(res.status).toBe(401);
  });
});

describe("POST /api/issues/[issueId]/lane — validation", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.findUnique.mockResolvedValue(null); });

  it("returns 400 for invalid JSON body", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/issue-1/lane", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
        body: "not-json",
      }) as unknown as Parameters<typeof POST>[0],
      makeContext(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-object body", async () => {
    const res = await POST(
      new Request("http://localhost/api/issues/issue-1/lane", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mockToken}` },
        body: JSON.stringify([1, 2, 3]),
      }) as unknown as Parameters<typeof POST>[0],
      makeContext(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when classification has invalid lane", async () => {
    mocks.findUnique.mockResolvedValue(makeIssue());
    const res = await POST(makeRequest("POST", { classification: { lane: "invalid", confidence: "high", reason: "test" } }), makeContext());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("invalid lane");
  });

  it("returns 400 when classification has invalid confidence", async () => {
    mocks.findUnique.mockResolvedValue(makeIssue());
    const res = await POST(makeRequest("POST", { classification: { lane: "local", confidence: "extreme", reason: "test" } }), makeContext());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("invalid confidence");
  });

  it("returns 400 when classification has empty reason", async () => {
    mocks.findUnique.mockResolvedValue(makeIssue());
    const res = await POST(makeRequest("POST", { classification: { lane: "local", confidence: "high", reason: "" } }), makeContext());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("reason is required");
  });
});

describe("POST /api/issues/[issueId]/lane — business logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue(makeIssue());
    mocks.createLane.mockResolvedValue({ id: "lane-1" });
    mocks.updateIssue.mockResolvedValue({ id: "issue-1" });
    mocks.findFirstLane.mockResolvedValue(null);
  });

  it("classifies using provided classification when model is given", async () => {
    const res = await POST(
      makeRequest("POST", { classification: { lane: "local", confidence: "high", reason: "Concrete bug fix" } }),
      makeContext(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.lane).toBe("local");
    expect(body.confidence).toBe("high");
    expect(mocks.createLane).toHaveBeenCalledWith({
      data: expect.objectContaining({ lane: "local", confidence: "high", reason: "Concrete bug fix" }),
    });
    expect(mocks.updateIssue).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: { currentLane: "local" },
    });
  });

  it("uses heuristic fallback when no classification provided and no current lane", async () => {
    const res = await POST(makeRequest("POST", {}), makeContext());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.model).toBe("heuristic");
    expect(mocks.createLane).toHaveBeenCalled();
    expect(mocks.updateIssue).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: expect.objectContaining({ currentLane: expect.any(String) }),
    });
  });

  it("returns current lane when no force and classification exists", async () => {
    mocks.findFirstLane.mockResolvedValue({
      id: "lane-1",
      issueId: "issue-1",
      lane: "frontier",
      confidence: "medium",
      reason: "Architecture decision needed",
      model: "model-v1",
      judgedAt: new Date("2026-05-15"),
    });
    const res = await POST(makeRequest("POST", {}), makeContext());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lane).toBe("frontier");
    expect(body.confidence).toBe("medium");
    expect(body.reason).toBe("Architecture decision needed");
    expect(mocks.createLane).not.toHaveBeenCalled();
  });

  it("reclassifies when force=true even if lane exists", async () => {
    mocks.findFirstLane.mockResolvedValue({
      id: "lane-1",
      issueId: "issue-1",
      lane: "backlog",
      confidence: "low",
      reason: "Not actionable",
      model: "heuristic",
      judgedAt: new Date("2026-05-15"),
    });
    const res = await POST(makeRequest("POST", { force: true }), makeContext());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mocks.createLane).toHaveBeenCalled();
  });

  it("returns 404 when issue not found", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const res = await POST(makeRequest("POST", {}), makeContext());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Issue not found in local cache");
  });

  it("truncates reason to 500 chars", async () => {
    const longReason = "a".repeat(600);
    const res = await POST(
      makeRequest("POST", { classification: { lane: "local", confidence: "high", reason: longReason } }),
      makeContext(),
    );
    expect(res.status).toBe(200);
    expect(mocks.createLane).toHaveBeenCalledWith({
      data: expect.objectContaining({ reason: expect.stringMatching(/^a{500}$/) }),
    });
  });
});

describe("GET /api/issues/[issueId]/lane", () => {
  it("returns current lane classification with full history", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", currentLane: "local", lastSyncedAt: new Date() });
    mocks.findFirstLane.mockResolvedValue({
      id: "lane-1",
      issueId: "issue-1",
      lane: "local",
      confidence: "high",
      reason: "Concrete implementation work",
      model: "heuristic",
      judgedAt: new Date("2026-05-15"),
    });
    const res = await GET(makeRequest("GET"), makeContext());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lane).toBe("local");
    expect(body.confidence).toBe("high");
    expect(body.reason).toBe("Concrete implementation work");
  });

  it("returns currentLane field when no history exists", async () => {
    mocks.findUnique.mockResolvedValue({ id: "issue-1", currentLane: "backlog", lastSyncedAt: new Date() });
    mocks.findFirstLane.mockResolvedValue(null);
    const res = await GET(makeRequest("GET"), makeContext());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lane).toBe("backlog");
    expect(body.confidence).toBeNull();
  });

  it("returns 404 when no lane classification exists", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const res = await GET(makeRequest("GET"), makeContext());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Issue not found in local cache");
  });

  it("returns 401 when unauthorized", async () => {
    const res = await GET(
      new Request("http://localhost/api/issues/issue-1/lane", {
        method: "GET",
        headers: { Authorization: "Bearer wrong-token" },
      }) as unknown as Parameters<typeof GET>[0],
      makeContext(),
    );
    expect(res.status).toBe(401);
  });
});
