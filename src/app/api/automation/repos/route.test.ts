import { describe, expect, it, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    createAutomationRepo: vi.fn(),
    createAuditLog: vi.fn().mockResolvedValue({ id: "log-1" }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    automationRepo: { create: mocks.createAutomationRepo },
    auditLog: { create: mocks.createAuditLog },
  },
}));

// Real Prisma error shape so the `instanceof` check in the route triggers.
vi.mock("@prisma/client", () => ({
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code: string;
      clientVersion: string;
      constructor(message: string, opts: { code: string; clientVersion?: string }) {
        super(message);
        this.code = opts.code;
        this.clientVersion = opts.clientVersion ?? "test";
      }
    },
  },
}));

import { POST } from "./route";
import { Prisma } from "@prisma/client";

function postRequest(body: unknown) {
  return POST(
    new Request("http://localhost/api/automation/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/automation/repos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAutomationRepo.mockResolvedValue({
      id: "repo-1",
      fullName: "myorg/myrepo",
      owner: "myorg",
      name: "myrepo",
      source: "user",
    });
    mocks.createAuditLog.mockResolvedValue({ id: "log-1" });
  });

  it("returns 400 on malformed JSON", async () => {
    const res = await postRequest("not-json");
    expect(res.status).toBe(400);
  });

  it("returns 400 when fullName is missing", async () => {
    const res = await postRequest({});
    expect(res.status).toBe(400);
  });

  it("returns 400 when fullName is not owner/repo", async () => {
    const res = await postRequest({ fullName: "no-slash" });
    expect(res.status).toBe(400);
  });

  it("creates an AutomationRepo with source=user and writes an audit row on success", async () => {
    const res = await postRequest({ fullName: "myorg/myrepo" });
    expect(res.status).toBe(201);

    expect(mocks.createAutomationRepo).toHaveBeenCalledWith({
      data: { fullName: "myorg/myrepo", owner: "myorg", name: "myrepo", source: "user" },
    });

    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "add_tracked_repo",
        repoFullName: "myorg/myrepo",
        success: true,
      }),
    });
  });

  it("returns 409 when the repository is already tracked (P2002 unique violation)", async () => {
    mocks.createAutomationRepo.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" }),
    );

    const res = await postRequest({ fullName: "myorg/myrepo" });
    expect(res.status).toBe(409);
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("writes an audit row with success=false on unexpected failure", async () => {
    mocks.createAutomationRepo.mockRejectedValueOnce(new Error("boom"));

    const res = await postRequest({ fullName: "myorg/myrepo" });
    expect(res.status).toBe(500);

    expect(mocks.createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "add_tracked_repo",
        repoFullName: "myorg/myrepo",
        success: false,
        errorMessage: "boom",
      }),
    });
  });
});
