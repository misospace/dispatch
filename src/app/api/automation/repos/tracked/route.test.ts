import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  authorizeRequest: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    repository: {
      findMany: vi.fn(),
    },
    automationRepo: {
      findMany: vi.fn(),
    },
  },
}));

import { GET } from "./route";
import { prisma } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";

const mockRepoFindMany = prisma.repository.findMany as any;
const mockAutomationRepoFindMany = prisma.automationRepo.findMany as any;
const mockAuthorizeRequest = vi.mocked(authorizeRequest);

describe("GET /api/automation/repos/tracked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizeRequest.mockResolvedValue({ authorized: true, type: "disabled", actor: "test-agent" });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthorizeRequest.mockResolvedValue({ authorized: false });

    const response = await GET(new Request("http://localhost/api/automation/repos/tracked"));

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns tracked repos with automation metadata", async () => {
    mockRepoFindMany.mockResolvedValue([
      { fullName: "owner/repo", owner: "owner", name: "repo", enabled: true },
    ]);
    mockAutomationRepoFindMany.mockResolvedValue([
      {
        fullName: "owner/repo",
        defaultBranch: "main",
        source: "user",
        lastSyncedAt: new Date("2024-01-01"),
      },
    ]);

    const response = await GET(new Request("http://localhost/api/automation/repos/tracked"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      fullName: "owner/repo",
      owner: "owner",
      name: "repo",
      enabled: true,
      defaultBranch: "main",
      source: "user",
    });
  });

  it("defaults to main branch when no automation repo exists", async () => {
    mockRepoFindMany.mockResolvedValue([
      { fullName: "owner/repo", owner: "owner", name: "repo", enabled: true },
    ]);
    mockAutomationRepoFindMany.mockResolvedValue([]);

    const response = await GET(new Request("http://localhost/api/automation/repos/tracked"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body[0].defaultBranch).toBe("main");
    expect(body[0].source).toBe("unknown");
  });

  it("returns 500 on database error", async () => {
    mockRepoFindMany.mockRejectedValue(new Error("DB down"));

    const response = await GET(new Request("http://localhost/api/automation/repos/tracked"));

    expect(response.status).toBe(500);
  });
});
