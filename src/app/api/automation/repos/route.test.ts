import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

const { mocks } = vi.hoisted(() => ({
  mocks: {
    createAutomationRepo: vi.fn(),
    upsertRepository: vi.fn(),
    transaction: vi.fn((callback) =>
      callback({
        automationRepo: { create: mocks.createAutomationRepo },
        repository: { upsert: mocks.upsertRepository },
        auditLog: { create: mocks.createAuditLog },
      }),
    ),
    createAuditLog: vi.fn().mockResolvedValue({ id: "log-1" }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    automationRepo: { create: mocks.createAutomationRepo },
    repository: { upsert: mocks.upsertRepository },
    auditLog: { create: mocks.createAuditLog },
  },
}));

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

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

function postRequest(body: unknown, includeAuth = true) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (includeAuth) headers.Authorization = `Bearer ${mockToken}`;
  return POST(
    new Request("http://localhost/api/automation/repos", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/automation/repos — auth", () => {
  it("returns 401 when no authorization header is provided", async () => {
    const res = await postRequest({ fullName: "org/repo" }, false);
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is incorrect", async () => {
    const res = await POST(
      new Request("http://localhost/api/automation/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
        body: JSON.stringify({ fullName: "org/repo" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

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
    mocks.upsertRepository.mockResolvedValue({
      id: "mirror-1",
      fullName: "myorg/myrepo",
      owner: "myorg",
      name: "myrepo",
      enabled: true,
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

  it("creates AutomationRepo and Repository rows, then writes an audit row on success", async () => {
    const res = await postRequest({ fullName: "myorg/myrepo" });
    expect(res.status).toBe(201);

    expect(mocks.createAutomationRepo).toHaveBeenCalledWith({
      data: { fullName: "myorg/myrepo", owner: "myorg", name: "myrepo", source: "user" },
    });
    expect(mocks.upsertRepository).toHaveBeenCalledWith({
      where: { fullName: "myorg/myrepo" },
      create: { fullName: "myorg/myrepo", owner: "myorg", name: "myrepo", enabled: true },
      update: { owner: "myorg", name: "myrepo", enabled: true },
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
