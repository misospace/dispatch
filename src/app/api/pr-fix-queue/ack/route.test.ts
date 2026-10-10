import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  TEST_AGENT_TOKEN as mockToken,
  authedRequest,
} from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

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
// header for maintainer / legacy unbound callers; the token for bound callers).
// The default for these tests is "courier", matching the existing fixture's
// stamped agent in `agentHandouts`.
const ACTOR = "courier";

function postRequest(
  body: unknown,
  includeAuth = true,
  headers: Record<string, string> = {},
) {
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

function clearAll() {
  delete process.env.DISPATCH_AUTH_MODE;
  delete process.env.DISPATCH_AUTH_USERNAME;
  delete process.env.DISPATCH_AUTH_PASSWORD;
  delete process.env.DISPATCH_AGENT_TOKEN;
  delete process.env.DISPATCH_MAINTAINER_TOKEN;
  delete process.env.DISPATCH_WORKER_TOKEN;
  delete process.env.DISPATCH_WORKER_TOKENS;
}

describe("POST /api/pr-fix-queue/ack", () => {
  beforeEach(() => {
    clearAll();
    process.env.DISPATCH_AGENT_TOKEN = mockToken;
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

  afterEach(() => {
    clearAll();
    resetAuthCaches();
    resetRateLimits();
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

  it("acknowledges the hand-out and returns the item (maintainer bearer)", async () => {
    // The default `mockToken` is set as DISPATCH_AGENT_TOKEN → maintainer
    // tier. Maintainer-bearer acks are allowed for any agent the hand-out
    // table actually stamped (the operator escape hatch for the reclaimer
    // sweep); the body/actor check below already pins the agent.
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

// (#1207 review) The legacy unbound DISPATCH_WORKER_TOKEN has no agent
// identity — the route must refuse it for any agent so a holder of the
// shared legacy token cannot spoof an ack for another agent and strand
// the real worker's attempt by pinning `handoutAcks` against it.
describe("POST /api/pr-fix-queue/ack — legacy unbound worker (#1207 review)", () => {
  const LEGACY_WORKER_TOKEN = "legacy-unbound-token";

  beforeEach(() => {
    clearAll();
    // No bound credentials; only the legacy shared worker token.
    process.env.DISPATCH_WORKER_TOKEN = LEGACY_WORKER_TOKEN;
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
    mocks.parseAckPrFixHandoutInput.mockReturnValue({
      repo: "org/repo",
      pr: 42,
      generation: 2,
      agentName: ACTOR,
    });
  });

  afterEach(() => {
    clearAll();
    resetAuthCaches();
    resetRateLimits();
  });

  it("returns 403 when a legacy unbound worker token tries to ack for any agent", async () => {
    // Repro from review: a holder of the shared legacy token sets
    // `x-agent-name: courier` and a matching body. The token itself is
    // accepted (worker tier, allowlisted route) but has no bound agent
    // identity, so `enforceWorkerAgentScope` must 403 before any DB read.
    const res = await POST(
      asNextRequest(
        new Request("http://localhost/api/pr-fix-queue/ack", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${LEGACY_WORKER_TOKEN}`,
            "x-agent-name": ACTOR,
          },
          body: JSON.stringify({ repo: "org/repo", pr: 42, generation: 2, agentName: ACTOR }),
        }),
      ),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/not bound to an agent/i);
    // The lib function was never called — the bound-identity gate catches
    // the spoof before any DB read.
    expect(mocks.ackPrFixHandout).not.toHaveBeenCalled();
  });
});

// (#1207 review) The hand-out ack is identity-scoped under #1129: only
// the bound credential for the agent that actually owns the hand-out may
// ack it. A bound token must 403 when it tries to ack for a different
// agent.
describe("POST /api/pr-fix-queue/ack — bound worker identity (#1207 review)", () => {
  const ALPHA_TOKEN = "alpha-bound-token";
  const BRAVO_TOKEN = "bravo-bound-token";

  beforeEach(() => {
    clearAll();
    process.env.DISPATCH_WORKER_TOKENS = `alpha:${ALPHA_TOKEN},bravo:${BRAVO_TOKEN}`;
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearAll();
    resetAuthCaches();
    resetRateLimits();
  });

  it("allows a bound worker to ack for its own agent", async () => {
    mocks.parseAckPrFixHandoutInput.mockReturnValue({
      repo: "org/repo",
      pr: 42,
      generation: 2,
      agentName: "alpha",
    });
    mocks.ackPrFixHandout.mockResolvedValue({ acknowledged: true, item: { id: "fix-1", generation: 2 } });

    const res = await POST(
      asNextRequest(
        new Request("http://localhost/api/pr-fix-queue/ack", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ALPHA_TOKEN}`,
            "x-agent-name": "alpha",
          },
          body: JSON.stringify({ repo: "org/repo", pr: 42, generation: 2, agentName: "alpha" }),
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(mocks.ackPrFixHandout).toHaveBeenCalledWith(expect.anything(), {
      repo: "org/repo",
      pr: 42,
      generation: 2,
      agentName: "alpha",
    });
  });

  it("denies a bound worker trying to ack for a different agent", async () => {
    // Repro from review: alpha-bound tries to ack for bravo (or for an
    // arbitrary agent the token does not own). The bound gate is the
    // single point that catches this — the body/actor mismatch check
    // alone would also fire, but the scope gate runs first and is
    // authoritative.
    mocks.parseAckPrFixHandoutInput.mockReturnValue({
      repo: "org/repo",
      pr: 42,
      generation: 2,
      agentName: "bravo",
    });

    const res = await POST(
      asNextRequest(
        new Request("http://localhost/api/pr-fix-queue/ack", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ALPHA_TOKEN}`,
            // Attacker-controlled header; the bound gate must override it.
            "x-agent-name": "bravo",
          },
          body: JSON.stringify({ repo: "org/repo", pr: 42, generation: 2, agentName: "bravo" }),
        }),
      ),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("alpha");
    expect(body.error).toContain("bravo");
    expect(mocks.ackPrFixHandout).not.toHaveBeenCalled();
  });

  it("denies a bound worker trying to ack for a third agent via the body alone", async () => {
    // Even with the `x-agent-name` header agreeing with the bound agent,
    // a body `agentName` that disagrees with the bound identity is a
    // forgery attempt. The bound-agent gate is authoritative and runs
    // before the body/actor check, so the route returns the scope
    // denial (403) — the lib is never called.
    mocks.parseAckPrFixHandoutInput.mockReturnValue({
      repo: "org/repo",
      pr: 42,
      generation: 2,
      agentName: "gamma",
    });

    const res = await POST(
      asNextRequest(
        new Request("http://localhost/api/pr-fix-queue/ack", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ALPHA_TOKEN}`,
            "x-agent-name": "alpha",
          },
          body: JSON.stringify({ repo: "org/repo", pr: 42, generation: 2, agentName: "gamma" }),
        }),
      ),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("alpha");
    expect(body.error).toContain("gamma");
    expect(mocks.ackPrFixHandout).not.toHaveBeenCalled();
  });

  it("ignores a self-reported x-agent-name that disagrees with the bound agent", async () => {
    // The bound agent is alpha. A misconfigured transport sending
    // `x-agent-name: bravo` must still ack as alpha (the bound identity
    // is authoritative), not be downgraded to bravo. The bound-agent
    // gate fires first (alpha != bravo) and returns 403 with both
    // names mentioned; the underlying write is never attempted.
    mocks.parseAckPrFixHandoutInput.mockReturnValue({
      repo: "org/repo",
      pr: 42,
      generation: 2,
      agentName: "bravo",
    });

    const res = await POST(
      asNextRequest(
        new Request("http://localhost/api/pr-fix-queue/ack", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ALPHA_TOKEN}`,
            "x-agent-name": "bravo",
          },
          body: JSON.stringify({ repo: "org/repo", pr: 42, generation: 2, agentName: "bravo" }),
        }),
      ),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("alpha");
    expect(body.error).toContain("bravo");
    expect(mocks.ackPrFixHandout).not.toHaveBeenCalled();
  });
});

// (#1207 review) Maintainer-tier bearers may ack for any agent the
// hand-out table actually stamped — they are the operator escape hatch
// for the reclaimer sweep. The body/actor check is the only line of
// defense; the bound-agent gate is a no-op for maintainer callers.
describe("POST /api/pr-fix-queue/ack — maintainer bearer acks for any agent", () => {
  beforeEach(() => {
    clearAll();
    process.env.DISPATCH_AGENT_TOKEN = mockToken;
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearAll();
    resetAuthCaches();
    resetRateLimits();
  });

  it("lets the maintainer ack for an agent the bound worker owns", async () => {
    // Repro from review: an operator-driven maintainer token (the
    // reclaimer / sweep operator path) acks an arbitrary agent. The
    // bound-agent gate is skipped (tier !== worker), and the lib is
    // called with the body agent.
    mocks.parseAckPrFixHandoutInput.mockReturnValue({
      repo: "org/repo",
      pr: 42,
      generation: 2,
      agentName: "courier",
    });
    mocks.ackPrFixHandout.mockResolvedValue({ acknowledged: true, item: { id: "fix-1", generation: 2 } });

    const res = await POST(
      asNextRequest(
        new Request("http://localhost/api/pr-fix-queue/ack", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${mockToken}`,
            "x-agent-name": "courier",
          },
          body: JSON.stringify({ repo: "org/repo", pr: 42, generation: 2, agentName: "courier" }),
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(mocks.ackPrFixHandout).toHaveBeenCalled();
  });
});
