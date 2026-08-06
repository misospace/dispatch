import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock auth before importing the route
vi.mock("@/lib/auth", () => ({
  authorizeRequest: vi.fn(),
}));

// Mock prisma after auth to avoid import order issues
vi.mock("@/lib/prisma", () => ({
  prisma: {
    automationEvent: {
      findMany: vi.fn(),
    },
  },
}));

import { GET } from "./route";
import { prisma } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";

const mockFetch = prisma.automationEvent.findMany as any;
const mockAuthorizeRequest = vi.mocked(authorizeRequest);

describe("GET /api/automation/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizeRequest.mockResolvedValue({ authorized: true, type: "disabled", actor: "test-agent" });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthorizeRequest.mockResolvedValue({ authorized: false });

    const response = await GET(new Request("http://localhost/api/automation/events"));

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns events with default limit", async () => {
    mockFetch.mockResolvedValue([
      { id: "1", eventType: "push", repoId: "repo-1", createdAt: new Date(), repo: { fullName: "owner/repo" } },
    ]);

    const response = await GET(new Request("http://localhost/api/automation/events"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].eventType).toBe("push");
  });

  it("filters by repo and type", async () => {
    mockFetch.mockResolvedValue([]);

    const response = await GET(
      new Request("http://localhost/api/automation/events?repo=repo-1&type=push")
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith({
      where: { repoId: "repo-1", eventType: "push" },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { repo: true },
    });
  });

  it("respects custom limit", async () => {
    mockFetch.mockResolvedValue([]);

    await GET(new Request("http://localhost/api/automation/events?limit=10"));

    expect(mockFetch).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { repo: true },
    });
  });

  it("returns 500 on database error", async () => {
    mockFetch.mockRejectedValue(new Error("DB down"));

    const response = await GET(new Request("http://localhost/api/automation/events"));

    expect(response.status).toBe(500);
  });
});
