import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  TEST_AGENT_TOKEN as mockToken,
  makeDispatchEnvMock,
  authedRequest,
} from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

// `mockToken` resolves to the maintainer tier; `WORKER_TOKEN` resolves to the
// worker tier so the tier gate can be exercised — the route is intentionally
// absent from `WORKER_ALLOWLIST` (src/lib/auth.ts), so `requiredTierForRoute`
// defaults it to maintainer and a worker-tier bearer must 403. Hoisted because
// the `vi.mock` factory below references it.
const { WORKER_TOKEN, mocks } = vi.hoisted(() => ({
  WORKER_TOKEN: "worker-tier-token-1569",
  mocks: {
    setPrFixClaimant: vi.fn(),
    clearPrFixClaimant: vi.fn(),
    transferPrFixClaimant: vi.fn(),
    // Faithful stand-in for the real `normalizeQueueRepo` (trim + lowercase).
    normalizeQueueRepo: vi.fn((repo: string) => repo.trim().toLowerCase()),
  },
}));

vi.mock("@/lib/dispatch-env", () =>
  makeDispatchEnvMock(mockToken, { [WORKER_TOKEN]: "worker" }),
);

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  asPrFixQueueClient: (x: unknown) => x,
}));

vi.mock("@/lib/pr-fix-queue", () => ({
  setPrFixClaimant: mocks.setPrFixClaimant,
  clearPrFixClaimant: mocks.clearPrFixClaimant,
  transferPrFixClaimant: mocks.transferPrFixClaimant,
  normalizeQueueRepo: mocks.normalizeQueueRepo,
}));

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";

const ROUTE_URL = "http://localhost/api/pr-fix-queue/claimant";

function postRequest(body: unknown, includeAuth = true, token?: string) {
  return POST(
    authedRequest(ROUTE_URL, {
      method: "POST",
      body,
      includeAuth,
      ...(token ? { token } : {}),
    }),
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

describe("POST /api/pr-fix-queue/claimant", () => {
  beforeEach(() => {
    clearAll();
    process.env.DISPATCH_AGENT_TOKEN = mockToken;
    resetAuthCaches();
    resetRateLimits();
    vi.clearAllMocks();
    mocks.setPrFixClaimant.mockResolvedValue({ updated: true });
    mocks.clearPrFixClaimant.mockResolvedValue({ updated: true, previousClaimant: null, previousSource: null });
    mocks.transferPrFixClaimant.mockResolvedValue({ updated: true, previousClaimant: null, previousSource: null });
  });

  afterEach(() => {
    clearAll();
    resetAuthCaches();
    resetRateLimits();
  });

  it("returns 401 when no auth header is present", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, claimant: "alpha" }, false);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(mocks.setPrFixClaimant).not.toHaveBeenCalled();
  });

  it("returns 401 for a bad bearer token", async () => {
    const res = await POST(
      new Request(ROUTE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ repo: "org/repo", pr: 42, claimant: "alpha" }),
      }),
    );

    expect(res.status).toBe(401);
    expect(mocks.setPrFixClaimant).not.toHaveBeenCalled();
  });

  it("returns 403 for a worker-tier token (maintainer-only route, #1569)", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, claimant: "alpha" }, true, WORKER_TOKEN);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/maintainer/i);
    expect(mocks.setPrFixClaimant).not.toHaveBeenCalled();
  });

  it("returns 400 on malformed JSON", async () => {
    const res = await POST(
      new Request(ROUTE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mockToken}`,
        },
        body: "not-json",
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON body");
    expect(mocks.setPrFixClaimant).not.toHaveBeenCalled();
  });

  it("returns 400 when repo is missing", async () => {
    const res = await postRequest({ pr: 42, claimant: "alpha" });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required field: repo");
    expect(mocks.setPrFixClaimant).not.toHaveBeenCalled();
  });

  it("returns 400 when pr is missing", async () => {
    const res = await postRequest({ repo: "org/repo", claimant: "alpha" });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("pr must be an integer >= 1");
    expect(mocks.setPrFixClaimant).not.toHaveBeenCalled();
  });

  it("returns 400 when pr is not an integer", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 4.5, claimant: "alpha" });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("pr must be an integer >= 1");
    expect(mocks.setPrFixClaimant).not.toHaveBeenCalled();
  });

  it("returns 400 when pr is below 1", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 0, claimant: "alpha" });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("pr must be an integer >= 1");
    expect(mocks.setPrFixClaimant).not.toHaveBeenCalled();
  });

  it("returns 400 when claimant is empty", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, claimant: "" });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required field: claimant");
    expect(mocks.setPrFixClaimant).not.toHaveBeenCalled();
  });

  it("returns 400 when claimant is whitespace-only", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, claimant: "   " });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing required field: claimant");
    expect(mocks.setPrFixClaimant).not.toHaveBeenCalled();
  });

  it("returns 400 when claimant exceeds 200 characters", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, claimant: "a".repeat(201) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("claimant must be at most 200 characters");
    expect(mocks.setPrFixClaimant).not.toHaveBeenCalled();
  });

  it("stamps the trimmed claimant and returns 200 on success", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, claimant: "  alpha-7  " });

    expect(res.status).toBe(200);
    expect(mocks.setPrFixClaimant).toHaveBeenCalledWith(expect.anything(), {
      repo: "org/repo",
      pr: 42,
      claimant: "alpha-7",
    });
    const body = await res.json();
    expect(body).toEqual({ ok: true, updated: true, repo: "org/repo", pr: 42, claimant: "alpha-7" });
  });

  it("stores a bare identity string verbatim — no agent/ prefix or special-casing (#1569)", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, claimant: "octocat" });

    expect(res.status).toBe(200);
    expect(mocks.setPrFixClaimant).toHaveBeenCalledWith(expect.anything(), {
      repo: "org/repo",
      pr: 42,
      claimant: "octocat",
    });
    const stamped = mocks.setPrFixClaimant.mock.calls[0][1];
    expect(stamped.claimant).toBe("octocat");
    expect(stamped.claimant).not.toMatch(/^agent\//);
  });

  it("accepts a 200-character claimant (boundary)", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, claimant: "a".repeat(200) });

    expect(res.status).toBe(200);
    expect(mocks.setPrFixClaimant).toHaveBeenCalledWith(expect.anything(), {
      repo: "org/repo",
      pr: 42,
      claimant: "a".repeat(200),
    });
  });

  it("normalizes the repo through normalizeQueueRepo before the stamp", async () => {
    const res = await postRequest({ repo: "Org/Repo", pr: 42, claimant: "alpha" });

    expect(res.status).toBe(200);
    expect(mocks.normalizeQueueRepo).toHaveBeenCalledWith("Org/Repo");
    expect(mocks.setPrFixClaimant).toHaveBeenCalledWith(expect.anything(), {
      repo: "org/repo",
      pr: 42,
      claimant: "alpha",
    });
    const body = await res.json();
    expect(body.repo).toBe("org/repo");
  });

  it("returns 400 when repo contains a NUL byte (PostgreSQL text cannot store it)", async () => {
    const res = await postRequest({ repo: "org\u0000/repo", pr: 42, claimant: "alpha" });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("repo must not contain control characters");
    expect(mocks.setPrFixClaimant).not.toHaveBeenCalled();
  });

  it("returns 400 when claimant contains a NUL byte", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, claimant: "alpha\u0000" });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("claimant must not contain control characters");
    expect(mocks.setPrFixClaimant).not.toHaveBeenCalled();
  });

  it("returns 400 when claimant contains another control character", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, claimant: "alpha\u0007-7" });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("claimant must not contain control characters");
    expect(mocks.setPrFixClaimant).not.toHaveBeenCalled();
  });

  it("returns 404 when no queue row matches (updated: false)", async () => {
    mocks.setPrFixClaimant.mockResolvedValue({ updated: false, reason: "not_found" });

    const res = await postRequest({ repo: "org/repo", pr: 42, claimant: "alpha" });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("pr-fix item not found");
  });

  it("returns 409 when the row already has a recorded claimant (#1569 preservation rule)", async () => {
    mocks.setPrFixClaimant.mockResolvedValue({ updated: false, reason: "already_set" });

    const res = await postRequest({ repo: "org/repo", pr: 42, claimant: "alpha" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already has a recorded claimant/);
  });

  it("clears and transfers through the operator helpers", async () => {
    const cleared = await postRequest({ repo: "org/repo", pr: 42, action: "clear" });
    expect(cleared.status).toBe(200);
    expect(mocks.clearPrFixClaimant).toHaveBeenCalledWith(expect.anything(), { repo: "org/repo", pr: 42 });
    expect(await cleared.json()).toEqual({ ok: true, action: "clear", repo: "org/repo", pr: 42, previousClaimant: null, previousSource: null });

    const transferred = await postRequest({ repo: "org/repo", pr: 42, action: "transfer", claimant: " operator-x " });
    expect(transferred.status).toBe(200);
    expect(mocks.transferPrFixClaimant).toHaveBeenCalledWith(expect.anything(), { repo: "org/repo", pr: 42, claimant: "operator-x" });
    expect(await transferred.json()).toEqual({ ok: true, action: "transfer", repo: "org/repo", pr: 42, claimant: "operator-x", previousClaimant: null, previousSource: null });
  });

  it("validates clear, transfer, and unknown actions", async () => {
    expect((await postRequest({ repo: "org/repo", pr: 42, action: "clear", claimant: "smurf" })).status).toBe(400);
    expect((await postRequest({ repo: "org/repo", pr: 42, action: "transfer" })).status).toBe(400);
    expect((await postRequest({ repo: "org/repo", pr: 42, action: "transfer", claimant: "   " })).status).toBe(400);
    expect((await postRequest({ repo: "org/repo", pr: 42, action: "unknown", claimant: "smurf" })).status).toBe(400);
    expect((await postRequest({ repo: "org/repo", pr: 42, action: "transfer", claimant: "smurf\n" })).status).toBe(400);
  });

  it("maps missing and contended clear/transfer results", async () => {
    mocks.clearPrFixClaimant.mockResolvedValue({ updated: false, reason: "not_found", previousClaimant: null, previousSource: null });
    expect((await postRequest({ repo: "org/repo", pr: 42, action: "clear" })).status).toBe(404);
    mocks.transferPrFixClaimant.mockResolvedValue({ updated: false, reason: "not_found", previousClaimant: null, previousSource: null });
    expect((await postRequest({ repo: "org/repo", pr: 42, action: "transfer", claimant: "smurf" })).status).toBe(404);
    mocks.clearPrFixClaimant.mockResolvedValue({ updated: false, reason: "contended", previousClaimant: null, previousSource: null });
    expect((await postRequest({ repo: "org/repo", pr: 42, action: "clear" })).status).toBe(503);
    mocks.transferPrFixClaimant.mockResolvedValue({ updated: false, reason: "contended", previousClaimant: null, previousSource: null });
    expect((await postRequest({ repo: "org/repo", pr: 42, action: "transfer", claimant: "smurf" })).status).toBe(503);
  });

  it("returns 500 when the stamp throws", async () => {
    mocks.setPrFixClaimant.mockRejectedValue(new Error("db connection lost"));

    const res = await postRequest({ repo: "org/repo", pr: 42, claimant: "alpha" });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to stamp pr-fix claimant");
  });
});
