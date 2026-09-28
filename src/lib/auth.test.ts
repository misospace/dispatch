import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  getAuthMode,
  getBasicAuthCredentials,
  parseAuthorizationHeader,
  isAuthorizedBearerToken,
  isAuthorizedBasicAuth,
  authenticateRequest,
  authorizeRequest,
  requiredTierForRoute,
  authErrorResponse,
  resetAuthCaches,
  validateOidcConfig,
  authorizeGroomerRequest,
} from "./auth";
import { resetRateLimits } from "./rate-limit";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    auth: vi.fn(),
    auditCreate: vi.fn(),
  },
}));

vi.mock("@/lib/auth-next", () => ({
  auth: mocks.auth,
}));

// The tier-denial audit row is written through a lazy prisma import; mock it
// so the denial path is testable without a database.
vi.mock("./prisma", () => ({
  prisma: {
    auditLog: {
      create: mocks.auditCreate,
    },
  },
}));

function clearAll() {
  delete process.env.DISPATCH_AUTH_MODE;
  delete process.env.DISPATCH_AUTH_USERNAME;
  delete process.env.DISPATCH_AUTH_PASSWORD;
  delete process.env.DISPATCH_AGENT_TOKEN;
  delete process.env.DISPATCH_MAINTAINER_TOKEN;
  delete process.env.DISPATCH_WORKER_TOKEN;
  delete process.env.DISPATCH_GROOMER_TOKEN;
}

describe("getAuthMode", () => {
  beforeEach(() => { clearAll(); resetAuthCaches(); });
  afterEach(() => { clearAll(); });

  it('returns "basic" when DISPATCH_AUTH_MODE=basic', () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    expect(getAuthMode()).toBe("basic");
  });

  it('returns "disabled" when DISPATCH_AUTH_MODE=disabled', () => {
    process.env.DISPATCH_AUTH_MODE = "disabled";
    expect(getAuthMode()).toBe("disabled");
  });

  it('returns "oidc" when DISPATCH_AUTH_MODE=oidc', () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    expect(getAuthMode()).toBe("oidc");
  });

  it("returns undefined when DISPATCH_AUTH_MODE is not set", () => {
    expect(getAuthMode()).toBeUndefined();
  });

  it("ignores invalid values and returns undefined", () => {
    process.env.DISPATCH_AUTH_MODE = "oauth";
    expect(getAuthMode()).toBeUndefined();
  });

  it("caches the result", () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    const first = getAuthMode();
    process.env.DISPATCH_AUTH_MODE = "disabled";
    // Still returns cached value
    expect(getAuthMode()).toBe(first);
  });
});

describe("validateOidcConfig", () => {
  beforeEach(() => {
    clearAll();
    delete process.env.DISPATCH_OIDC_ISSUER;
    delete process.env.DISPATCH_OIDC_CLIENT_ID;
    delete process.env.DISPATCH_OIDC_CLIENT_SECRET;
  });
  afterEach(() => {
    clearAll();
    delete process.env.DISPATCH_OIDC_ISSUER;
    delete process.env.DISPATCH_OIDC_CLIENT_ID;
    delete process.env.DISPATCH_OIDC_CLIENT_SECRET;
  });

  it("does not throw when all three OIDC env vars are present", () => {
    process.env.DISPATCH_OIDC_ISSUER = "https://auth.example.com";
    process.env.DISPATCH_OIDC_CLIENT_ID = "client-id";
    process.env.DISPATCH_OIDC_CLIENT_SECRET = "client-secret";
    expect(() => validateOidcConfig()).not.toThrow();
  });

  it("throws listing the missing keys when all three are absent", () => {
    expect(() => validateOidcConfig()).toThrow(
      "OIDC authentication is misconfigured — missing required env vars: DISPATCH_OIDC_ISSUER, DISPATCH_OIDC_CLIENT_ID, DISPATCH_OIDC_CLIENT_SECRET",
    );
  });

  it("throws listing only the missing keys when some are present", () => {
    process.env.DISPATCH_OIDC_ISSUER = "https://auth.example.com";
    process.env.DISPATCH_OIDC_CLIENT_ID = "client-id";
    expect(() => validateOidcConfig()).toThrow(
      "OIDC authentication is misconfigured — missing required env vars: DISPATCH_OIDC_CLIENT_SECRET",
    );
  });

  it("treats whitespace-only values as missing", () => {
    process.env.DISPATCH_OIDC_ISSUER = "https://auth.example.com";
    process.env.DISPATCH_OIDC_CLIENT_ID = "   ";
    process.env.DISPATCH_OIDC_CLIENT_SECRET = "client-secret";
    expect(() => validateOidcConfig()).toThrow(
      "OIDC authentication is misconfigured — missing required env vars: DISPATCH_OIDC_CLIENT_ID",
    );
  });
});

describe("getBasicAuthCredentials", () => {
  beforeEach(() => { clearAll(); resetAuthCaches(); });
  afterEach(() => { clearAll(); });

  it("returns username and password when both are set", () => {
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    expect(getBasicAuthCredentials()).toEqual({ username: "operator", password: "s3cret" });
  });

  it("returns null when username is not set", () => {
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    expect(getBasicAuthCredentials()).toBeNull();
  });

  it("returns null when password is not set", () => {
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    expect(getBasicAuthCredentials()).toBeNull();
  });

  it("returns null when neither is set", () => {
    expect(getBasicAuthCredentials()).toBeNull();
  });
});

describe("parseAuthorizationHeader", () => {
  it("parses Bearer token", () => {
    const result = parseAuthorizationHeader("Bearer my-token-123");
    expect(result).toEqual({ type: "bearer", token: "my-token-123" });
  });

  it("parses Basic auth credentials", () => {
    // base64("operator:s3cret") = "b3BlcmF0b3I6czNjcmV0"
    const result = parseAuthorizationHeader("Basic b3BlcmF0b3I6czNjcmV0");
    expect(result).toEqual({ type: "basic", username: "operator", password: "s3cret" });
  });

  it("handles case-insensitive Bearer scheme", () => {
    const result = parseAuthorizationHeader("bearer my-token");
    expect(result).toEqual({ type: "bearer", token: "my-token" });
  });

  it("handles case-insensitive Basic scheme", () => {
    const result = parseAuthorizationHeader("basic b3BlcmF0b3I6czNjcmV0");
    expect(result).toEqual({ type: "basic", username: "operator", password: "s3cret" });
  });

  it("returns null for empty string", () => {
    expect(parseAuthorizationHeader("")).toBeNull();
  });

  it("returns null for null", () => {
    expect(parseAuthorizationHeader(null)).toBeNull();
  });

  it("returns null for unrecognized scheme", () => {
    expect(parseAuthorizationHeader("Token my-token")).toBeNull();
  });

  it("handles Bearer token with extra whitespace", () => {
    const result = parseAuthorizationHeader("Bearer   my-token  ");
    expect(result).toEqual({ type: "bearer", token: "my-token" });
  });

  it("returns null for Basic auth without colon separator", () => {
    // base64("noColonHere") = "bm9Db2xvbkhlcmU="
    const result = parseAuthorizationHeader("Basic bm9Db2xvbkhlcmU=");
    expect(result).toBeNull();
  });
});

describe("isAuthorizedBearerToken", () => {
  beforeEach(() => { clearAll(); resetAuthCaches(); });
  afterEach(() => { clearAll(); });

  it("returns true for DISPATCH_AGENT_TOKEN", () => {
    process.env.DISPATCH_AGENT_TOKEN = "valid-token";
    expect(isAuthorizedBearerToken("valid-token")).toBe(true);
  });

  it("returns false for wrong token", () => {
    process.env.DISPATCH_AGENT_TOKEN = "valid-token";
    expect(isAuthorizedBearerToken("wrong-token")).toBe(false);
  });

  it("returns false when no tokens configured", () => {
    expect(isAuthorizedBearerToken("any-token")).toBe(false);
  });

  it("uses timing-safe comparison (no early return on mismatch)", () => {
    process.env.DISPATCH_AGENT_TOKEN = "a";
    // Should not throw or behave differently for short inputs
    expect(isAuthorizedBearerToken("b")).toBe(false);
  });
});

describe("isAuthorizedBasicAuth", () => {
  beforeEach(() => { clearAll(); resetAuthCaches(); });
  afterEach(() => { clearAll(); });

  it("returns true for correct credentials", () => {
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    expect(isAuthorizedBasicAuth("operator", "s3cret")).toBe(true);
  });

  it("returns false for wrong username", () => {
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    expect(isAuthorizedBasicAuth("wrong", "s3cret")).toBe(false);
  });

  it("returns false for wrong password", () => {
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    expect(isAuthorizedBasicAuth("operator", "wrong")).toBe(false);
  });

  it("returns false when no credentials configured", () => {
    expect(isAuthorizedBasicAuth("any", "any")).toBe(false);
  });

  it("returns false when username or password is empty", () => {
    process.env.DISPATCH_AUTH_USERNAME = "";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    expect(isAuthorizedBasicAuth("", "s3cret")).toBe(false);
  });

  it("returns false when neither is set", () => {
    expect(isAuthorizedBasicAuth("any", "any")).toBe(false);
  });
});

describe("authenticateRequest (typed entry point)", () => {
  beforeEach(() => { clearAll(); resetAuthCaches(); mocks.auth.mockReset(); });
  afterEach(() => { clearAll(); });

  it('returns { authorized: true, type: "bearer" } in disabled mode', () => {
    process.env.DISPATCH_AUTH_MODE = "disabled";
    const request = new Request("http://localhost/api/test");
    expect(authenticateRequest(request)).toEqual({ authorized: true, type: "bearer", tier: "maintainer" });
  });

  it('returns { authorized: true, type: "basic", username } for valid Basic Auth', () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Basic b3BlcmF0b3I6czNjcmV0" },
    });
    expect(authenticateRequest(request)).toEqual({ authorized: true, type: "basic", username: "operator" });
  });

  it('returns { authorized: true, type: "bearer" } for valid Bearer in basic mode', () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer agent-token" },
    });
    expect(authenticateRequest(request)).toEqual({ authorized: true, type: "bearer", tier: "maintainer" });
  });

  it("returns { authorized: false } for invalid Basic Auth", () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    const request = new Request("http://localhost/api/test");
    expect(authenticateRequest(request)).toEqual({ authorized: false });
  });

  it('returns { authorized: true, type: "bearer" } for valid Bearer in legacy mode', () => {
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer agent-token" },
    });
    expect(authenticateRequest(request)).toEqual({ authorized: true, type: "bearer", tier: "maintainer" });
  });

  it("returns { authorized: false } for invalid Bearer in legacy mode", () => {
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(authenticateRequest(request)).toEqual({ authorized: false });
  });

  it('returns { authorized: true, type: "bearer" } for valid Bearer in oidc mode', () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer agent-token" },
    });
    expect(authenticateRequest(request)).toEqual({ authorized: true, type: "bearer", tier: "maintainer" });
  });

  it("returns { authorized: false } for invalid Bearer in oidc mode", () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(authenticateRequest(request)).toEqual({ authorized: false });
  });

  it("returns { authorized: false } for unauthenticated request in oidc mode", () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    const request = new Request("http://localhost/api/test");
    expect(authenticateRequest(request)).toEqual({ authorized: false });
  });
});

describe("authorizeRequest (route helper)", () => {
  beforeEach(() => { clearAll(); resetAuthCaches(); mocks.auth.mockReset(); });
  afterEach(() => { clearAll(); });

  it("returns disabled authorization when auth mode is disabled", async () => {
    process.env.DISPATCH_AUTH_MODE = "disabled";
    const request = new Request("http://localhost/api/test");
    await expect(authorizeRequest(request)).resolves.toEqual({
      authorized: true,
      type: "disabled",
      actor: "operator",
      tier: "maintainer",
    });
  });

  it("authorizes Basic Auth and uses the username as actor", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Basic b3BlcmF0b3I6czNjcmV0" },
    });
    await expect(authorizeRequest(request)).resolves.toEqual({
      authorized: true,
      type: "basic",
      username: "operator",
      actor: "operator",
      tier: "maintainer",
    });
  });

  it("authorizes Bearer auth in basic mode and uses x-agent-name as actor", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer agent-token", "x-agent-name": "worker-1" },
    });
    await expect(authorizeRequest(request)).resolves.toEqual({
      authorized: true,
      type: "bearer",
      actor: "worker-1",
      tier: "maintainer",
    });
  });

  it("authorizes OIDC sessions and uses email as actor", async () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    mocks.auth.mockResolvedValue({ user: { email: "operator@example.com", name: "Operator" } });
    const request = new Request("http://localhost/api/test");
    await expect(authorizeRequest(request)).resolves.toEqual({
      authorized: true,
      type: "oidc",
      actor: "operator@example.com",
      tier: "maintainer",
    });
  });

  it("authorizes Bearer auth in oidc mode without calling NextAuth", async () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer agent-token" },
    });
    await expect(authorizeRequest(request)).resolves.toEqual({
      authorized: true,
      type: "bearer",
      actor: "agent",
      tier: "maintainer",
    });
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated OIDC requests with no session", async () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    mocks.auth.mockResolvedValue(null);
    const request = new Request("http://localhost/api/test");
    await expect(authorizeRequest(request)).resolves.toEqual({ authorized: false });
  });
});

describe("resetAuthCaches", () => {
  beforeEach(() => { clearAll(); resetAuthCaches(); });
  afterEach(() => { clearAll(); });

  it("resets auth mode cache", () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    expect(getAuthMode()).toBe("basic");
    resetAuthCaches();
    delete process.env.DISPATCH_AUTH_MODE;
    expect(getAuthMode()).toBeUndefined();
  });

  it("resets accepted tokens cache", () => {
    process.env.DISPATCH_AGENT_TOKEN = "token1";
    expect(isAuthorizedBearerToken("token1")).toBe(true);
    resetAuthCaches();
    process.env.DISPATCH_AGENT_TOKEN = "token2";
    expect(isAuthorizedBearerToken("token1")).toBe(false);
    expect(isAuthorizedBearerToken("token2")).toBe(true);
  });
});

describe("bearer token tiers (#1111)", () => {
  const WORKER_TOKEN = "worker-tier-token";

  beforeEach(() => {
    clearAll();
    resetAuthCaches();
    resetRateLimits();
    mocks.auth.mockReset();
    mocks.auditCreate.mockReset();
    process.env.DISPATCH_WORKER_TOKEN = WORKER_TOKEN;
  });
  afterEach(() => {
    clearAll();
  });

  function workerRequest(pathname: string, method = "GET"): Request {
    return new Request(`http://localhost${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${WORKER_TOKEN}` },
    });
  }

  const workerAllowlistedRoutes: Array<[string, string]> = [
    ["GET", "/api/agents/saffron/next-task"],
    ["POST", "/api/agents/saffron/tasks/report"],
    ["POST", "/api/agents/saffron/heartbeat"],
    ["GET", "/api/agents/saffron/active-work"],
    ["GET", "/api/agents/saffron/queue"],
    ["GET", "/api/agents/saffron/work-summary"],
    ["GET", "/api/agent-work"],
    ["POST", "/api/agent-work/start"],
    ["POST", "/api/agent-work/checkpoint"],
    ["POST", "/api/agent-work/finish"],
    ["POST", "/api/issues/claim"],
    ["POST", "/api/issues/unclaim"],
    ["GET", "/api/issues/state"],
    ["POST", "/api/issues/status"],
    ["GET", "/api/issues"],
    ["GET", "/api/pr-fix-queue/queued"],
    ["GET", "/api/pr-fix-queue/history"],
    ["POST", "/api/pr-fix-queue/mark"],
  ];

  for (const [method, pathname] of workerAllowlistedRoutes) {
    it(`accepts a worker token on ${method} ${pathname}`, async () => {
      await expect(authorizeRequest(workerRequest(pathname, method))).resolves.toMatchObject({
        authorized: true,
        type: "bearer",
        tier: "worker",
      });
    });
  }

  const maintainerOnlyRoutes: Array<[string, string]> = [
    ["POST", "/api/agent-work"],
    ["POST", "/api/agent-work/sweep"],
    ["POST", "/api/pr-fix-queue/requeue"],
    ["POST", "/api/sync"],
    ["POST", "/api/issues/move"],
    ["POST", "/api/issues/groom"],
    ["POST", "/api/groomer/run"],
    ["DELETE", "/api/automation/repos/foo/bar"],
    ["POST", "/api/issues/unassign"],
  ];

  for (const [method, pathname] of maintainerOnlyRoutes) {
    it(`forbids a worker token on ${method} ${pathname}`, async () => {
      await expect(authorizeRequest(workerRequest(pathname, method))).resolves.toEqual({
        authorized: false,
        forbidden: true,
        requiredTier: "maintainer",
      });
    });
  }

  it("records an auth_tier_denied audit row on a tier denial", async () => {
    await authorizeRequest(workerRequest("/api/sync", "POST"));
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    const call = mocks.auditCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data.action).toBe("auth_tier_denied");
    expect(call.data.success).toBe(false);
  });

  it("writes no audit row when the worker token is accepted", async () => {
    await authorizeRequest(workerRequest("/api/issues/claim", "POST"));
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("throttles denial audit rows to one per actor/method/path per window", async () => {
    await authorizeRequest(workerRequest("/api/sync", "POST"));
    await authorizeRequest(workerRequest("/api/sync", "POST"));
    await authorizeRequest(workerRequest("/api/sync", "POST"));
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);

    // A different path is a different throttle key — still denied, still audited.
    await authorizeRequest(workerRequest("/api/issues/move", "POST"));
    expect(mocks.auditCreate).toHaveBeenCalledTimes(2);
  });

  it("authorizeGroomerRequest preserves the worker-tier forbidden result", async () => {
    // No dedicated groomer token configured.
    await expect(authorizeGroomerRequest(workerRequest("/api/groomer/run", "POST"))).resolves.toEqual({
      authorized: false,
      forbidden: true,
      requiredTier: "maintainer",
    });

    // Groomer token configured but the caller presents the worker token.
    process.env.DISPATCH_GROOMER_TOKEN = "groomer-token";
    await expect(authorizeGroomerRequest(workerRequest("/api/groomer/run", "POST"))).resolves.toEqual({
      authorized: false,
      forbidden: true,
      requiredTier: "maintainer",
    });

    // The dedicated groomer token still authorizes at maintainer tier.
    const groomerRequest = new Request("http://localhost/api/groomer/run", {
      method: "POST",
      headers: { Authorization: "Bearer groomer-token" },
    });
    await expect(authorizeGroomerRequest(groomerRequest)).resolves.toMatchObject({
      authorized: true,
      type: "bearer",
      tier: "maintainer",
    });
  });

  it("authErrorResponse maps a tier denial to 403 naming the maintainer tier", async () => {
    const res = authErrorResponse({ authorized: false, forbidden: true, requiredTier: "maintainer" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("maintainer");
  });

  it("authErrorResponse maps a plain unauthorized result to 401", async () => {
    const res = authErrorResponse({ authorized: false });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("defaults unknown routes to maintainer for worker tokens", async () => {
    await expect(authorizeRequest(workerRequest("/api/something/new", "PATCH"))).resolves.toEqual({
      authorized: false,
      forbidden: true,
      requiredTier: "maintainer",
    });
  });

  it("does not match lookalike paths or wrong methods in the worker allowlist", () => {
    expect(requiredTierForRoute("/api/agent-work-evil", "POST")).toBe("maintainer");
    expect(requiredTierForRoute("/api/agent-work/sweep", "POST")).toBe("maintainer");
    expect(requiredTierForRoute("/api/issues/claim", "GET")).toBe("maintainer");
    expect(requiredTierForRoute("/api/agents/saffron/next-task", "GET")).toBe("worker");
    expect(requiredTierForRoute("/api/issues/state", "GET")).toBe("worker");
  });

  it("keeps DISPATCH_AGENT_TOKEN at maintainer rights", async () => {
    delete process.env.DISPATCH_WORKER_TOKEN;
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";
    const request = new Request("http://localhost/api/pr-fix-queue/requeue", {
      method: "POST",
      headers: { Authorization: "Bearer agent-token" },
    });
    await expect(authorizeRequest(request)).resolves.toMatchObject({
      authorized: true,
      type: "bearer",
      tier: "maintainer",
    });
  });

  it("resolves non-bearer modes to maintainer even with only a worker token configured", async () => {
    process.env.DISPATCH_AUTH_MODE = "disabled";
    const request = new Request("http://localhost/api/sync", { method: "POST" });
    await expect(authorizeRequest(request)).resolves.toMatchObject({
      authorized: true,
      tier: "maintainer",
    });
  });
});
