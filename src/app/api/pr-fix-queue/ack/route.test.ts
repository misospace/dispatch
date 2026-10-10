import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  TEST_AGENT_TOKEN as mockToken,
  makeDispatchEnvMockWithSafeEqual,
  authedRequest,
} from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMockWithSafeEqual());

const { mocks } = vi.hoisted(() => ({
  mocks: {
    parseAckPrFixHandoutInput: vi.fn(),
    ackPrFixHandout: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  asPrFixQueueClient: (x: unknown) => x,
}));

vi.mock("@/lib/pr-fix-queue", () => ({
  parseAckPrFixHandoutInput: mocks.parseAckPrFixHandoutInput,
  ackPrFixHandout: mocks.ackPrFixHandout,
}));

vi.mock("@/lib/auth-next", () => ({
  auth: vi.fn(),
}));

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";

// Cast Request as NextRequest for type compatibility in tests
function asNextRequest(r: Request): any { return r; }

// The route derives `agentName` from the authenticated actor (the x-agent-name
// header). The default for these tests is "courier", matching the existing
// fixture's stamped agent in `agentHandouts`.
const ACTOR = "courier";

function postRequest(body: unknown, includeAuth = true, headers: Record<string, string> = {}) {
  return POST(
    asNextRequest(
      authedRequest("http://localhost/api/pr-fix-queue/ack", {
        method: "POST",
        body,
        includeAuth,
        headers: { "x-agent-name": ACTOR, ...headers },
      }),
    ),
  );
}

describe("POST /api/pr-fix-queue/ack", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
    mocks.parseAckPrFixHandoutInput.mockReturnValue({
      repo: "org/repo",
      pr: 42,
      generation: 2,
      agentName: ACTOR,
    });
    mocks.ackPrFixHandout.mockResolvedValue({ acknowledged: true, item: { id: "fix-1", generation: 2 } });
  });

  it("returns 401 when no auth header is present", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 2 }, false);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 for bad bearer token", async () => {
    const res = await POST(
      asNextRequest(
        new Request("http://localhost/api/pr-fix-queue/ack", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer wrong-token",
            "x-agent-name": ACTOR,
          },
          body: JSON.stringify({ repo: "org/repo", pr: 42, generation: 2, agentName: ACTOR }),
        }),
      ),
    );

    expect(res.status).toBe(401);
  });

  it("returns 403 for a basic-auth session (bearer-only ack)", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "operator-pass";
    resetAuthCaches();
    try {
      const basic = Buffer.from("operator:operator-pass").toString("base64");
      const res = await POST(
        asNextRequest(
          new Request("http://localhost/api/pr-fix-queue/ack", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Basic ${basic}`,
              "x-agent-name": ACTOR,
            },
            body: JSON.stringify({ repo: "org/repo", pr: 42, generation: 2, agentName: ACTOR }),
          }),
        ),
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/bearer token/i);
      expect(mocks.ackPrFixHandout).not.toHaveBeenCalled();
    } finally {
      delete process.env.DISPATCH_AUTH_MODE;
      delete process.env.DISPATCH_AUTH_USERNAME;
      delete process.env.DISPATCH_AUTH_PASSWORD;
      resetAuthCaches();
    }
  });

  it("returns 403 for an OIDC session (bearer-only ack, no session-bearer bypass)", async () => {
    // (#1211 review) An OIDC-authenticated browser user must not be able
    // to forge an ack for any (repo, pr, generation) by submitting a body.
    // The route checks `auth.type !== "bearer"` BEFORE the OIDC session
    // can be treated as a substitute.
    process.env.DISPATCH_AUTH_MODE = "oidc";
    resetAuthCaches();
    const { auth } = await import("@/lib/auth-next");
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: "operator@example.com", name: "Operator" },
    });
    try {
      const res = await POST(
        asNextRequest(
          new Request("http://localhost/api/pr-fix-queue/ack", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repo: "org/repo", pr: 42, generation: 2, agentName: ACTOR }),
          }),
        ),
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/bearer token/i);
      expect(mocks.ackPrFixHandout).not.toHaveBeenCalled();
    } finally {
      delete process.env.DISPATCH_AUTH_MODE;
      resetAuthCaches();
    }
  });

  it("returns 400 when the body's agentName disagrees with the authenticated actor", async () => {
    mocks.parseAckPrFixHandoutInput.mockReturnValue({
      repo: "org/repo",
      pr: 42,
      generation: 2,
      agentName: "foreign-agent",
    });

    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 2, agentName: "foreign-agent" });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/does not match the authenticated actor/);
    expect(mocks.ackPrFixHandout).not.toHaveBeenCalled();
  });

  it("returns 400 on malformed JSON", async () => {
    const res = await POST(
      asNextRequest(
        new Request("http://localhost/api/pr-fix-queue/ack", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${mockToken}`,
            "x-agent-name": ACTOR,
          },
          body: "not-json",
        }),
      ),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON body");
  });

  it("delegates validation errors from parseAckPrFixHandoutInput", async () => {
    mocks.parseAckPrFixHandoutInput.mockReturnValue({ error: "generation must be an integer >= 1" });

    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 0 });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("generation must be an integer >= 1");
    expect(mocks.ackPrFixHandout).not.toHaveBeenCalled();
  });

  it("acknowledges the hand-out and returns the item", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 2 });

    expect(res.status).toBe(200);
    expect(mocks.ackPrFixHandout).toHaveBeenCalledWith(expect.anything(), {
      repo: "org/repo",
      pr: 42,
      generation: 2,
      agentName: ACTOR,
    });
    const body = await res.json();
    expect(body).toEqual({ acknowledged: true, item: { id: "fix-1", generation: 2 } });
  });

  it("is idempotent on a repeated acknowledgement (200, no error)", async () => {
    mocks.ackPrFixHandout.mockResolvedValue({ acknowledged: false, reason: "already-acknowledged" });

    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 2 });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ acknowledged: true, alreadyAcknowledged: true });
  });

  it("returns 404 when the item is not found", async () => {
    mocks.ackPrFixHandout.mockResolvedValue({ acknowledged: false, reason: "not-found" });

    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 2 });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("pr-fix item not found");
  });

  it("returns 409 on a generation mismatch", async () => {
    mocks.ackPrFixHandout.mockResolvedValue({ acknowledged: false, reason: "generation-mismatch" });

    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 2 });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("PR fix queue item generation mismatch");
    expect(body.reason).toBe("generation-mismatch");
  });

  it("returns 409 when the item is not QUEUED", async () => {
    mocks.ackPrFixHandout.mockResolvedValue({ acknowledged: false, reason: "not-queued" });

    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 2 });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("PR fix queue item is not QUEUED");
    expect(body.reason).toBe("not-queued");
  });

  it("returns 409 when the generation was never handed out", async () => {
    mocks.ackPrFixHandout.mockResolvedValue({ acknowledged: false, reason: "not-stamped" });

    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 2 });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("PR fix queue item has no live hand-out at that generation");
    expect(body.reason).toBe("not-stamped");
  });

  it("returns 403 when the item was not handed to the authenticated agent", async () => {
    // (#1211 review) A bare ack from a token that never received the hand-out
    // must be rejected — a forged token can't pin a future reclaim against a
    // worker that actually has the item.
    mocks.ackPrFixHandout.mockResolvedValue({ acknowledged: false, reason: "not-handed" });

    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 2 });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("not-handed");
  });

  it("returns 500 when the acknowledgement throws", async () => {
    mocks.ackPrFixHandout.mockRejectedValue(new Error("db connection lost"));

    const res = await postRequest({ repo: "org/repo", pr: 42, generation: 2 });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to acknowledge pr-fix hand-out");
  });

  it("unauthorized request does not call ackPrFixHandout", async () => {
    await postRequest({ repo: "org/repo", pr: 42, generation: 2 }, false);

    expect(mocks.ackPrFixHandout).not.toHaveBeenCalled();
  });
});
