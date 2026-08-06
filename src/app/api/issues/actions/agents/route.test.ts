import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    parseAgentList: vi.fn().mockReturnValue(["worker", "reviewer"]),
    findMany: vi.fn().mockResolvedValue([
      { labels: ["status/backlog", "agent/handler", "type/feature"] },
      { labels: ["agent/discovered-agent", "priority/p1"] },
    ]),
  },
}));

vi.mock("@/lib/auth", () => ({
  authorizeRequest: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  parseAgentList: mocks.parseAgentList,
  parseExcludedLabels: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.findMany },
  },
}));

import { GET } from "./route";
import { authorizeRequest } from "@/lib/auth";

const mockAuthorizeRequest = vi.mocked(authorizeRequest);

describe("GET /api/issues/actions/agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizeRequest.mockResolvedValue({ authorized: true, type: "disabled", actor: "test-agent" });
    mocks.parseAgentList.mockReturnValue(["worker", "reviewer"]);
    mocks.findMany.mockResolvedValue([
      { labels: ["status/backlog", "agent/handler", "type/feature"] },
      { labels: ["agent/discovered-agent", "priority/p1"] },
    ]);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthorizeRequest.mockResolvedValue({ authorized: false });

    const res = await GET(new Request("http://localhost/api/issues/actions/agents"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns configured and discovered agents combined", async () => {
    const res = await GET(new Request("http://localhost/api/issues/actions/agents"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.agents)).toBe(true);

    // Configured agents should be present
    expect(body.agents).toContain("worker");
    expect(body.agents).toContain("reviewer");
    // Discovered agents should be present
    expect(body.agents).toContain("handler");
    expect(body.agents).toContain("discovered-agent");
  });

  it("deduplicates configured and discovered agents", async () => {
    mocks.parseAgentList.mockReturnValue(["worker", "handler"]);
    // handler is both configured and discovered

    const res = await GET(new Request("http://localhost/api/issues/actions/agents"));
    expect(res.status).toBe(200);
    const body = await res.json();

    // handler should appear only once
    const handlerCount = body.agents.filter((a: string) => a === "handler").length;
    expect(handlerCount).toBe(1);
  });

  it("returns agents sorted alphabetically", async () => {
    mocks.parseAgentList.mockReturnValue(["zebra-agent", "alpha-agent"]);
    mocks.findMany.mockResolvedValue([]);

    const res = await GET(new Request("http://localhost/api/issues/actions/agents"));
    expect(res.status).toBe(200);
    const body = await res.json();

    const alphaIdx = body.agents.indexOf("alpha-agent");
    const zebraIdx = body.agents.indexOf("zebra-agent");
    expect(alphaIdx).toBeLessThan(zebraIdx);
  });

  it("handles empty agent lists gracefully", async () => {
    mocks.parseAgentList.mockReturnValue([]);
    mocks.findMany.mockResolvedValue([]);

    const res = await GET(new Request("http://localhost/api/issues/actions/agents"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toEqual([]);
  });

  it("ignores non-agent labels when discovering agents", async () => {
    mocks.parseAgentList.mockReturnValue([]);
    mocks.findMany.mockResolvedValue([
      { labels: ["status/backlog", "owner/alice", "priority/p1"] },
    ]);

    const res = await GET(new Request("http://localhost/api/issues/actions/agents"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toEqual([]);
  });

  it("returns 500 on prisma error", async () => {
    mocks.findMany.mockRejectedValueOnce(new Error("db connection failed"));

    const res = await GET(new Request("http://localhost/api/issues/actions/agents"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch agent list");
  });
});
