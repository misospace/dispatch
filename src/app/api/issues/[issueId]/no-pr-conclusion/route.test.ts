import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMockWithSafeEqual, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMockWithSafeEqual(mockToken, { "test-worker-token": "worker" }));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUnique: vi.fn(),
    noPrConclusionFindUnique: vi.fn().mockResolvedValue(null),
    noPrConclusionDelete: vi.fn().mockResolvedValue({}),
    lifecycleCreate: vi.fn().mockResolvedValue({ id: "evt-1" }),
    lifecycleUpsert: vi.fn().mockResolvedValue({ id: "evt-1" }),
    auditCreate: vi.fn().mockResolvedValue({ id: "log-1" }),
    auth: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findUnique: mocks.findUnique },
    noPrConclusion: {
      findUnique: mocks.noPrConclusionFindUnique,
      delete: mocks.noPrConclusionDelete,
    },
    issueLifecycleEvent: {
      create: mocks.lifecycleCreate,
      upsert: mocks.lifecycleUpsert,
    },
    auditLog: { create: mocks.auditCreate },
  },
}));

vi.mock("@/lib/auth-next", () => ({ auth: mocks.auth }));

import { DELETE, GET } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";
import { computeConclusionContentFingerprint } from "@/lib/no-pr-conclusion";

const ISSUE = {
  id: "issue-1",
  number: 42,
  title: "Fix login",
  body: "Login fails.",
  state: "open",
  labels: ["status/ready"],
  repository: { fullName: "org/repo" },
};

const URL_ = "http://localhost/api/issues/issue-1/no-pr-conclusion";
const ctx = { params: Promise.resolve({ issueId: "issue-1" }) };
const BASIC = `Basic ${Buffer.from("jory:op-pass").toString("base64")}`;

/** A park row whose fingerprint matches the cached issue content (LIVE). */
function livePark(over: Record<string, unknown> = {}) {
  return {
    id: "park-1",
    issueId: "issue-1",
    agentName: "alpha",
    outcome: "no_changes_needed",
    summary: "already fixed on main",
    evidence: "https://github.com/org/repo/commit/abc",
    contentFingerprint: computeConclusionContentFingerprint({ title: ISSUE.title, body: ISSUE.body }),
    createdAt: new Date("2026-10-31T00:00:00.000Z"),
    ...over,
  };
}

/** Operator (basic auth) request; the default for the DELETE tests. */
function operatorRequest(method: string) {
  return new Request(URL_, { method, headers: { Authorization: BASIC } });
}

/** Agent bearer request (held by every worker — the caller DELETE must refuse). */
function agentBearerRequest(method: string) {
  return authedRequest(URL_, { method, headers: { "x-agent-name": "worker-1" } });
}

function useAuthMode(mode: "basic" | "oidc" | "disabled" | undefined) {
  if (mode) process.env.DISPATCH_AUTH_MODE = mode;
  else delete process.env.DISPATCH_AUTH_MODE;
  resetAuthCaches();
}

beforeEach(() => {
  process.env.DISPATCH_AUTH_USERNAME = "jory";
  process.env.DISPATCH_AUTH_PASSWORD = "op-pass";
  useAuthMode("basic");
  resetRateLimits();
  vi.clearAllMocks();
  // clearAllMocks keeps prior implementations alive, so pin the lookups back.
  mocks.findUnique.mockResolvedValue(ISSUE);
  mocks.noPrConclusionFindUnique.mockResolvedValue(null);
  mocks.noPrConclusionDelete.mockResolvedValue({});
  mocks.lifecycleCreate.mockResolvedValue({ id: "evt-1" });
  mocks.lifecycleUpsert.mockResolvedValue({ id: "evt-1" });
  mocks.auditCreate.mockResolvedValue({ id: "log-1" });
  mocks.auth.mockResolvedValue(null);
});

describe("GET /api/issues/[issueId]/no-pr-conclusion — read-only diagnostics", () => {
  it("reports a live park with its provenance, liveness, and mode", async () => {
    mocks.noPrConclusionFindUnique.mockResolvedValue(livePark());

    // Maintainer tier may read — the agent/maintainer token is enough.
    const res = await GET(agentBearerRequest("GET"), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      park: {
        agentName: "alpha",
        outcome: "no_changes_needed",
        summary: "already fixed on main",
        evidence: "https://github.com/org/repo/commit/abc",
        parkedAt: "2026-10-31T00:00:00.000Z",
      },
      live: true,
      mode: "enforce",
    });
    // Read-only: nothing is deleted or recorded.
    expect(mocks.noPrConclusionDelete).not.toHaveBeenCalled();
    expect(mocks.lifecycleCreate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("reports a stored park whose content fingerprint moved as not live", async () => {
    // The issue body was edited after the conclusion: the fingerprint no
    // longer matches, so the park is stored but ended.
    const stale = livePark({ contentFingerprint: computeConclusionContentFingerprint({ title: ISSUE.title, body: "edited body" }) });
    mocks.noPrConclusionFindUnique.mockResolvedValue(stale);

    const res = await GET(authedRequest(URL_, { method: "GET" }), ctx);

    expect(res.status).toBe(200);
    expect((await res.json()).live).toBe(false);
  });

  it("reports no park when the issue carries none", async () => {
    const res = await GET(authedRequest(URL_, { method: "GET" }), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ park: null, live: false, mode: "enforce" });
  });

  it("returns 404 when the issue is not in the local cache", async () => {
    mocks.findUnique.mockResolvedValue(null);

    const res = await GET(authedRequest(URL_, { method: "GET" }), ctx);

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Issue not found in local cache");
  });

  it("returns 401 when no authorization is provided", async () => {
    const res = await GET(new Request(URL_, { method: "GET" }), ctx);
    expect(res.status).toBe(401);
  });

  it("refuses a worker-tier token with 403 (maintainer-tier route by construction)", async () => {
    // #1510 review (Minor): this GET is absent from WORKER_ALLOWLIST, so the
    // route tier gate refuses worker-tier credentials — bound or legacy
    // unbound. The refusal is intentional (the park provenance of any issue is
    // operator-scoped), not a gap in the allowlist.
    const res = await GET(
      authedRequest(URL_, { method: "GET", token: "test-worker-token" }),
      ctx,
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/maintainer/i);
    // The park is never read on the denied path. The tier gate does write its
    // own `auth_tier_denied` audit row — that is the auth module's row, not
    // this route's.
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.noPrConclusionFindUnique).not.toHaveBeenCalled();
    expect(mocks.noPrConclusionDelete).not.toHaveBeenCalled();
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "auth_tier_denied", success: false }),
      }),
    );
  });
});

describe("DELETE /api/issues/[issueId]/no-pr-conclusion — operator clear", () => {
  it.each([undefined, "basic", "oidc"] as const)(
    "rejects an agent bearer token with 403 (auth mode %s)",
    async (mode) => {
      useAuthMode(mode);
      mocks.noPrConclusionFindUnique.mockResolvedValue(livePark());

      const res = await DELETE(agentBearerRequest("DELETE"), ctx);

      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/require\w* operator auth.*agent bearer tokens cannot/);
      expect(mocks.noPrConclusionDelete).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    },
  );

  it("clears the park with basic auth, recording lifecycle evidence and the audit row", async () => {
    mocks.noPrConclusionFindUnique.mockResolvedValue(livePark());

    const res = await DELETE(operatorRequest("DELETE"), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, cleared: true });

    expect(mocks.noPrConclusionDelete).toHaveBeenCalledWith({ where: { issueId: "issue-1" } });
    expect(mocks.lifecycleCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        issueId: "issue-1",
        repoFullName: "org/repo",
        issueNumber: 42,
        kind: "conclusion_cleared",
        source: "api:no-pr-conclusion",
        actor: "jory",
        agentName: null,
        fromStatus: null,
        toStatus: null,
        metadata: {
          parkedBy: "alpha",
          parkedOutcome: "no_changes_needed",
          reason: "operator clear",
        },
      }),
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actor: "jory",
        action: "no_pr_conclusion_cleared",
        repoFullName: "org/repo",
        issueNumber: 42,
        issueId: "issue-1",
        success: true,
        notes: JSON.stringify({
          cleared: true,
          parkedBy: "alpha",
          parkedOutcome: "no_changes_needed",
          authType: "basic",
        }),
      }),
    });
  });

  it("accepts an OIDC session and stamps its email as the actor", async () => {
    useAuthMode("oidc");
    mocks.auth.mockResolvedValue({ user: { email: "jory@example.com" } });
    mocks.noPrConclusionFindUnique.mockResolvedValue(livePark());

    const res = await DELETE(
      new Request(URL_, { method: "DELETE", headers: { "Content-Type": "application/json" } }),
      ctx,
    );

    expect(res.status).toBe(200);
    const notes = JSON.parse(mocks.auditCreate.mock.calls[0][0].data.notes);
    expect(notes.authType).toBe("oidc");
    expect(mocks.auditCreate.mock.calls[0][0].data.actor).toBe("jory@example.com");
  });

  it("is an idempotent no-op when the issue carries no park row", async () => {
    const res = await DELETE(operatorRequest("DELETE"), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, cleared: false });
    expect(mocks.noPrConclusionDelete).not.toHaveBeenCalled();
    expect(mocks.lifecycleCreate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "no_pr_conclusion_cleared",
        success: true,
        notes: JSON.stringify({ cleared: false, parkedBy: null, parkedOutcome: null, authType: "basic" }),
      }),
    });
  });

  it("returns 404 when the issue is not in the local cache", async () => {
    mocks.findUnique.mockResolvedValue(null);

    const res = await DELETE(operatorRequest("DELETE"), ctx);

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Issue not found in local cache");
    expect(mocks.noPrConclusionDelete).not.toHaveBeenCalled();
  });

  it("returns 401 when no authorization is provided", async () => {
    const res = await DELETE(new Request(URL_, { method: "DELETE" }), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 429 with Retry-After after exceeding the rate limit", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await DELETE(operatorRequest("DELETE"), ctx);
      expect(res.status).toBe(200);
    }

    const res = await DELETE(operatorRequest("DELETE"), ctx);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});
