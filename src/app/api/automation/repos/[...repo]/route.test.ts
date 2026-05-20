import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUniqueAutomationRepo: vi.fn(),
    deleteAutomationRepo: vi.fn().mockResolvedValue(undefined),
    updateManyRepository: vi.fn().mockResolvedValue({ count: 1 }),
    createAuditLog: vi.fn().mockResolvedValue({ id: "log-1" }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    automationRepo: {
      findUnique: mocks.findUniqueAutomationRepo,
      delete: mocks.deleteAutomationRepo,
    },
    repository: {
      updateMany: mocks.updateManyRepository,
    },
    auditLog: { create: mocks.createAuditLog },
  },
}));

import { DELETE } from "./route";

function deleteRequest(repoSegments: string[]) {
  return DELETE(
    new Request(`http://localhost/api/automation/repos/${repoSegments.join("/")}`, { method: "DELETE" }),
    { params: Promise.resolve({ repo: repoSegments }) },
  );
}

describe("DELETE /api/automation/repos/[...repo]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUniqueAutomationRepo.mockResolvedValue({ id: "repo-1", source: "user" });
    mocks.deleteAutomationRepo.mockResolvedValue(undefined);
    mocks.updateManyRepository.mockResolvedValue({ count: 1 });
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  it("returns 404 when the repo is not tracked", async () => {
    mocks.findUniqueAutomationRepo.mockResolvedValueOnce(null);
    const res = await deleteRequest(["myorg", "missing"]);
    expect(res.status).toBe(404);
    expect(mocks.deleteAutomationRepo).not.toHaveBeenCalled();
  });

  it("deletes the AutomationRepo, soft-disables Repository, and writes an audit row", async () => {
    const res = await deleteRequest(["myorg", "myrepo"]);
    expect(res.status).toBe(200);

    expect(mocks.deleteAutomationRepo).toHaveBeenCalledWith({
      where: { fullName: "myorg/myrepo" },
    });
    expect(mocks.updateManyRepository).toHaveBeenCalledWith({
      where: { fullName: "myorg/myrepo" },
      data: { enabled: false },
    });
    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "remove_tracked_repo",
        repoFullName: "myorg/myrepo",
        success: true,
        beforeLabels: ["user"],
      }),
    });
  });

  it("writes a failure audit row when delete throws", async () => {
    mocks.deleteAutomationRepo.mockRejectedValueOnce(new Error("db down"));
    const res = await deleteRequest(["myorg", "myrepo"]);
    expect(res.status).toBe(500);

    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "remove_tracked_repo",
        repoFullName: "myorg/myrepo",
        success: false,
        errorMessage: "db down",
      }),
    });
  });
});
