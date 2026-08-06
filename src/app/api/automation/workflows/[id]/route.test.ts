import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  authorizeRequest: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    githubWorkflow: {
      findUnique: vi.fn(),
    },
  },
}));

import { GET } from "./route";
import { prisma } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";

const mockFindUnique = prisma.githubWorkflow.findUnique as any;
const mockAuthorizeRequest = vi.mocked(authorizeRequest);

describe("GET /api/automation/workflows/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizeRequest.mockResolvedValue({ authorized: true, type: "disabled", actor: "test-agent" });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthorizeRequest.mockResolvedValue({ authorized: false });

    const response = await GET(new Request("http://localhost/api/automation/workflows/123?id=123"));

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 when id is missing", async () => {
    const response = await GET(new Request("http://localhost/api/automation/workflows/123"));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Workflow ID required");
  });

  it("returns workflow with runs and jobs", async () => {
    mockFindUnique.mockResolvedValue({
      id: "123",
      name: "ci",
      repo: { fullName: "owner/repo" },
      runs: [{ id: "run-1", jobs: [] }],
    });

    const response = await GET(
      new Request("http://localhost/api/automation/workflows/123?id=123")
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.name).toBe("ci");
  });

  it("returns 404 when workflow not found", async () => {
    mockFindUnique.mockResolvedValue(null);

    const response = await GET(
      new Request("http://localhost/api/automation/workflows/123?id=123")
    );

    expect(response.status).toBe(404);
  });

  it("returns 500 on database error", async () => {
    mockFindUnique.mockRejectedValue(new Error("DB down"));

    const response = await GET(
      new Request("http://localhost/api/automation/workflows/123?id=123")
    );

    expect(response.status).toBe(500);
  });
});
