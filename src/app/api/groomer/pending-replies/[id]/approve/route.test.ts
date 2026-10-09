import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    authorizeRequest: vi.fn(),
    approvePendingReply: vi.fn(),
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
  getAuthorizedActor: vi.fn(() => "operator@example.com"),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/groomer/pending-reply", () => ({ approvePendingReply: mocks.approvePendingReply }));

import { POST } from "./route";

const context = { params: Promise.resolve({ id: "reply-1" }) };
function request(body: unknown = {}) {
  return new Request("http://localhost/api/groomer/pending-replies/reply-1/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/groomer/pending-replies/[id]/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeRequest.mockResolvedValue({ authorized: true, type: "basic", actor: "operator" });
    mocks.approvePendingReply.mockResolvedValue({ ok: true, status: "posted", url: "https://github.com/org/repo/issues/42#issuecomment-1" });
  });

  it("rejects agent bearer tokens", async () => {
    mocks.authorizeRequest.mockResolvedValue({ authorized: true, type: "bearer", actor: "worker", tier: "maintainer" });
    const response = await POST(request(), context);
    expect(response.status).toBe(403);
    expect(mocks.approvePendingReply).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", 404],
    ["not_pending", 409],
    ["in_progress", 409],
    ["too_long", 400],
    ["post_failed", 502],
  ] as const)("maps %s to HTTP %i", async (code, status) => {
    mocks.approvePendingReply.mockResolvedValue({ ok: false, code, message: "problem" });
    const response = await POST(request(), context);
    expect(response.status).toBe(status);
    expect((await response.json()).error).toBe("problem");
  });

  it("approves and returns the posted URL", async () => {
    const response = await POST(request({ reason: "reviewed" }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "posted", url: "https://github.com/org/repo/issues/42#issuecomment-1" });
    expect(mocks.approvePendingReply).toHaveBeenCalledWith(expect.anything(), {
      id: "reply-1",
      actor: "operator@example.com",
      authType: "basic",
    });
  });
});
