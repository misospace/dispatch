import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  authorizeRequest: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    githubWorkflow: {
      findMany: vi.fn(),
    },
  },
}));

import { GET } from "./route";
import { prisma } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";

const mockFindMany = prisma.githubWorkflow.findMany as any;
const mockAuthorizeRequest = vi.mocked(authorizeRequest);

describe("GET /api/automation/workflows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizeRequest.mockResolvedValue({ authorized: true, type: "disabled", actor: "test-agent" });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthorizeRequest.mockResolvedValue({ authorized: false });

    const response = await GET(new Request("http://localhost/api/automation/workflows"));

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns workflows", async () => {
    mockFindMany.mockResolvedValue([
      { id: "1", name: "ci", _count: { runs: 5 }, runs: [] },
    ]);

    const response = await GET(new Request("http://localhost/api/automation/workflows"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("ci");
  });

  it("filters by repo", async () => {
    mockFindMany.mockResolvedValue([]);

    await GET(new Request("http://localhost/api/automation/workflows?repo=owner/repo"));

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { repo: { fullName: "owner/repo" } },
      include: {
        _count: { select: { runs: true } },
        runs: { take: 1, orderBy: { runStartedAt: "desc" } },
      },
      orderBy: { name: "asc" },
    });
  });

  it("returns 500 on database error", async () => {
    mockFindMany.mockRejectedValue(new Error("DB down"));

    const response = await GET(new Request("http://localhost/api/automation/workflows"));

    expect(response.status).toBe(500);
  });
});
