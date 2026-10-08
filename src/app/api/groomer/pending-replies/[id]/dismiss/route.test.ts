import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    authorizeRequest: vi.fn(),
    getAuthorizedActor: vi.fn(() => "operator@example.com"),
    findUnique: vi.fn(),
    dismissPendingReply: vi.fn(),
    auditCreate: vi.fn(),
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
  getAuthorizedActor: mocks.getAuthorizedActor,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    groomerPendingReply: { findUnique: mocks.findUnique },
    auditLog: { create: mocks.auditCreate },
  },
}));
vi.mock("@/lib/groomer/pending-reply", () => ({ dismissPendingReply: mocks.dismissPendingReply }));

import { POST } from "./route";

const context = { params: Promise.resolve({ id: "reply-1" }) };
function request() {
  return new Request("http://localhost/api/groomer/pending-replies/reply-1/dismiss", { method: "POST" });
}

describe("POST /api/groomer/pending-replies/[id]/dismiss", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeRequest.mockResolvedValue({ authorized: true, type: "basic", actor: "operator" });
    mocks.findUnique.mockResolvedValue({
      id: "reply-1",
      applicationKey: "application-1",
      repoFullName: "org/repo",
      issueNumber: 42,
      issueId: "issue-1",
    });
    mocks.dismissPendingReply.mockResolvedValue({ ok: true });
    mocks.auditCreate.mockResolvedValue({});
  });

  it("rejects agent bearer tokens", async () => {
    mocks.authorizeRequest.mockResolvedValue({ authorized: true, type: "bearer", actor: "worker", tier: "maintainer" });
    const response = await POST(request(), context);
    expect(response.status).toBe(403);
    expect(mocks.dismissPendingReply).not.toHaveBeenCalled();
  });

  it("dismisses and writes an audit row", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, status: "dismissed" });
    expect(mocks.dismissPendingReply).toHaveBeenCalledWith(expect.anything(), { id: "reply-1", actor: "operator@example.com" });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actor: "operator@example.com",
        action: "groomer_reply_dismissed",
        repoFullName: "org/repo",
        issueNumber: 42,
      }),
    });
  });

  it.each([
    ["not_found", 404],
    ["not_pending", 409],
  ] as const)("maps %s to HTTP %i", async (code, status) => {
    mocks.dismissPendingReply.mockResolvedValue({ ok: false, code });
    const response = await POST(request(), context);
    expect(response.status).toBe(status);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
