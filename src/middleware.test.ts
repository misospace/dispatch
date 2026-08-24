import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";
import { resetAuthCaches } from "@/lib/auth";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getToken: vi.fn(),
  },
}));

vi.mock("next-auth/jwt", () => ({
  getToken: mocks.getToken,
}));

function clearAll() {
  delete process.env.DISPATCH_AUTH_MODE;
  delete process.env.DISPATCH_AUTH_USERNAME;
  delete process.env.DISPATCH_AUTH_PASSWORD;
  delete process.env.DISPATCH_AGENT_TOKEN;
  delete process.env.AUTH_URL;
  delete process.env.NEXTAUTH_URL;
  delete process.env.NEXTAUTH_SECRET;
}

function makeRequest(path: string, headers?: HeadersInit) {
  return new NextRequest(new Request(`http://localhost${path}`, { headers }));
}

describe("middleware auth protection", () => {
  beforeEach(() => {
    clearAll();
    resetAuthCaches();
    mocks.getToken.mockReset();
  });

  afterEach(() => {
    clearAll();
    resetAuthCaches();
  });

  it("rejects unauthenticated UI routes in basic mode", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";

    const res = await middleware(makeRequest("/board"));

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
  });

  it("accepts valid Basic Auth for UI routes in basic mode", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";

    const res = await middleware(makeRequest("/board", {
      Authorization: "Basic b3BlcmF0b3I6czNjcmV0",
    }));

    expect(res.status).toBe(200);
  });

  it("accepts valid Bearer auth for API routes in basic mode", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";

    const res = await middleware(makeRequest("/api/sync", {
      Authorization: "Bearer agent-token",
    }));

    expect(res.status).toBe(200);
  });
});

describe("basic-auth rate limiting", () => {
  beforeEach(() => {
    clearAll();
    resetAuthCaches();
    mocks.getToken.mockReset();
  });

  afterEach(() => {
    clearAll();
    resetAuthCaches();
  });

  it("returns 429 after five failed Basic-auth attempts from the same IP", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";

    const badCreds = "Basic " + Buffer.from("admin:wrong").toString("base64");

    for (let i = 0; i < 5; i++) {
      const res = await middleware(makeRequest("/board", {
        "x-forwarded-for": "10.0.0.5",
        Authorization: badCreds,
      }));
      expect(res.status).toBe(401);
    }

    const locked = await middleware(makeRequest("/board", {
      "x-forwarded-for": "10.0.0.5",
      Authorization: badCreds,
    }));

    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBeTruthy();
  });

  it("attaches security headers to the 429 lockout response", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";

    const badCreds = "Basic " + Buffer.from("admin:wrong").toString("base64");

    for (let i = 0; i < 5; i++) {
      await middleware(makeRequest("/board", {
        "x-forwarded-for": "10.0.0.6",
        Authorization: badCreds,
      }));
    }

    const locked = await middleware(makeRequest("/board", {
      "x-forwarded-for": "10.0.0.6",
      Authorization: badCreds,
    }));

    expect(locked.status).toBe(429);
    expect(locked.headers.get("x-content-type-options")).toBe("nosniff");
    expect(locked.headers.get("x-frame-options")).toBe("DENY");
    expect(locked.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(locked.headers.get("strict-transport-security")).toContain("max-age=31536000");
  });

  it("does not count unauthenticated hits toward the rate limit", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";

    // The browser's first unauthenticated request to /board returns 401 with
    // no Authorization header — this should not consume a failure slot.
    for (let i = 0; i < 10; i++) {
      const res = await middleware(makeRequest("/board", {
        "x-forwarded-for": "10.0.0.7",
      }));
      expect(res.status).toBe(401);
    }

    // A valid Basic auth should still succeed because no failures were counted.
    const ok = await middleware(makeRequest("/board", {
      "x-forwarded-for": "10.0.0.7",
      Authorization: "Basic " + Buffer.from("operator:s3cret").toString("base64"),
    }));
    expect(ok.status).toBe(200);
  });

  it("rotating the leftmost X-Forwarded-For hop cannot bypass the lockout", async () => {
    // Envoy Gateway appends the observed peer address to the right of the
    // X-Forwarded-For chain rather than replacing it. The attacker controls
    // the leftmost entry but cannot influence the rightmost, so taking the
    // last hop means rotating the first hop does not grant a fresh bucket.
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";

    const badCreds = "Basic " + Buffer.from("admin:wrong").toString("base64");

    for (let i = 0; i < 5; i++) {
      const res = await middleware(makeRequest("/board", {
        // Varying attacker-controlled first hop; fixed gateway-appended last hop.
        "x-forwarded-for": `attacker-forged-${i}, 10.0.0.8`,
        Authorization: badCreds,
      }));
      expect(res.status).toBe(401);
    }

    // A sixth attempt with a fresh forged first hop is still locked out,
    // because the last hop (the gateway-appended peer address) is unchanged.
    const locked = await middleware(makeRequest("/board", {
      "x-forwarded-for": "attacker-forged-fresh, 10.0.0.8",
      Authorization: badCreds,
    }));
    expect(locked.status).toBe(429);
  });

  it("buckets failed attempts by the last X-Forwarded-For hop", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";

    const badCreds = "Basic " + Buffer.from("admin:wrong").toString("base64");

    // Exhaust the bucket for last-hop 10.0.0.9.
    for (let i = 0; i < 5; i++) {
      await middleware(makeRequest("/board", {
        "x-forwarded-for": "9.9.9.9, 10.0.0.9",
        Authorization: badCreds,
      }));
    }

    // A request from a different last hop should NOT be locked out.
    const fromDifferentLastHop = await middleware(makeRequest("/board", {
      "x-forwarded-for": "9.9.9.9, 10.0.0.10",
      Authorization: badCreds,
    }));
    expect(fromDifferentLastHop.status).toBe(401);
  });

  it("successful Basic auth resets the counter for that IP", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";

    const badCreds = "Basic " + Buffer.from("admin:wrong").toString("base64");
    const goodCreds = "Basic " + Buffer.from("operator:s3cret").toString("base64");

    // Burn four failures, then succeed — the counter must reset so that a
    // full second window of five failures is permitted afterward.
    for (let i = 0; i < 4; i++) {
      const res = await middleware(makeRequest("/board", {
        "x-forwarded-for": "10.0.0.11",
        Authorization: badCreds,
      }));
      expect(res.status).toBe(401);
    }

    const ok = await middleware(makeRequest("/board", {
      "x-forwarded-for": "10.0.0.11",
      Authorization: goodCreds,
    }));
    expect(ok.status).toBe(200);

    // Five further failures should now be permitted (counter was reset).
    for (let i = 0; i < 5; i++) {
      const res = await middleware(makeRequest("/board", {
        "x-forwarded-for": "10.0.0.11",
        Authorization: badCreds,
      }));
      expect(res.status).toBe(401);
    }

    const locked = await middleware(makeRequest("/board", {
      "x-forwarded-for": "10.0.0.11",
      Authorization: badCreds,
    }));
    expect(locked.status).toBe(429);
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";

    const badCreds = "Basic " + Buffer.from("admin:wrong").toString("base64");

    // No XFF — only X-Real-IP. Five attempts should still lock the IP.
    for (let i = 0; i < 5; i++) {
      await middleware(makeRequest("/board", {
        "x-real-ip": "192.168.1.20",
        Authorization: badCreds,
      }));
    }

    const locked = await middleware(makeRequest("/board", {
      "x-real-ip": "192.168.1.20",
      Authorization: badCreds,
    }));
    expect(locked.status).toBe(429);
  });

  it("counts Basic-auth failures on API routes the same as UI routes", async () => {
    // Moving Basic first in the auth check is what makes the counter reset on
    // any route when the user proves they know the password. Both UI and API
    // paths must therefore share the same per-IP lockout window.
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";

    const badCreds = "Basic " + Buffer.from("admin:wrong").toString("base64");

    for (let i = 0; i < 3; i++) {
      const uiRes = await middleware(makeRequest("/board", {
        "x-forwarded-for": "10.0.0.12",
        Authorization: badCreds,
      }));
      expect(uiRes.status).toBe(401);
    }
    for (let i = 0; i < 2; i++) {
      const apiRes = await middleware(makeRequest("/api/sync", {
        "x-forwarded-for": "10.0.0.12",
        Authorization: badCreds,
      }));
      expect(apiRes.status).toBe(401);
    }

    const locked = await middleware(makeRequest("/board", {
      "x-forwarded-for": "10.0.0.12",
      Authorization: badCreds,
    }));
    expect(locked.status).toBe(429);
  });
});

describe("oidc mode (DISPATCH_AUTH_MODE=oidc)", () => {
  beforeEach(() => {
    clearAll();
    resetAuthCaches();
    mocks.getToken.mockReset();
  });

  afterEach(() => {
    clearAll();
    resetAuthCaches();
  });

  it("redirects unauthenticated UI routes in oidc mode", async () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    process.env.NEXTAUTH_SECRET = "secret";
    mocks.getToken.mockResolvedValue(null);

    const res = await middleware(makeRequest("/board?repo=org%2Frepo"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/login?callbackUrl=%2Fboard%3Frepo%3Dorg%252Frepo");
  });

  it("accepts authenticated UI routes in oidc mode", async () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    process.env.NEXTAUTH_SECRET = "secret";
    mocks.getToken.mockResolvedValue({ sub: "user-1" });

    const res = await middleware(makeRequest("/board"));

    expect(res.status).toBe(200);
  });

  it("reads the secure Auth.js session cookie for HTTPS OIDC deployments", async () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    process.env.NEXTAUTH_SECRET = "secret";
    process.env.NEXTAUTH_URL = "https://dispatch.example.com";
    mocks.getToken.mockResolvedValue({ sub: "user-1" });

    const res = await middleware(makeRequest("/board"));

    expect(res.status).toBe(200);
    expect(mocks.getToken).toHaveBeenCalledWith(expect.objectContaining({
      secret: "secret",
      secureCookie: true,
    }));
  });

  it("reads the unprefixed Auth.js session cookie for HTTP OIDC deployments", async () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    process.env.NEXTAUTH_SECRET = "secret";
    process.env.NEXTAUTH_URL = "http://localhost:3000";
    mocks.getToken.mockResolvedValue({ sub: "user-1" });

    const res = await middleware(makeRequest("/board"));

    expect(res.status).toBe(200);
    expect(mocks.getToken).toHaveBeenCalledWith(expect.objectContaining({
      secret: "secret",
      secureCookie: false,
    }));
  });

  it("passes API routes through in oidc mode for route-level auth", async () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";

    const res = await middleware(makeRequest("/api/sync"));

    expect(res.status).toBe(200);
    expect(mocks.getToken).not.toHaveBeenCalled();
  });
});

describe("security headers", () => {
  beforeEach(() => {
    clearAll();
    resetAuthCaches();
    mocks.getToken.mockReset();
  });

  afterEach(() => {
    clearAll();
    resetAuthCaches();
  });

  it("injects security headers on disabled mode responses", async () => {
    process.env.DISPATCH_AUTH_MODE = "disabled";

    const res = await middleware(makeRequest("/board"));

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("injects security headers on basic auth success responses", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";

    const res = await middleware(makeRequest("/board", {
      Authorization: "Basic b3BlcmF0b3I6czNjcmV0",
    }));

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("injects security headers on basic auth 401 responses", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";

    const res = await middleware(makeRequest("/board"));

    expect(res.status).toBe(401);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("injects security headers on oidc authenticated responses", async () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    process.env.NEXTAUTH_SECRET = "secret";
    mocks.getToken.mockResolvedValue({ sub: "user-1" });

    const res = await middleware(makeRequest("/board"));

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("injects security headers on oidc redirect responses", async () => {
    process.env.DISPATCH_AUTH_MODE = "oidc";
    process.env.NEXTAUTH_SECRET = "secret";
    mocks.getToken.mockResolvedValue(null);

    const res = await middleware(makeRequest("/board"));

    expect(res.status).toBe(307);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("injects security headers on legacy mode responses", async () => {
    // No DISPATCH_AUTH_MODE set — legacy mode
    const res = await middleware(makeRequest("/board"));

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("applies security headers to /login without enforcing auth (basic mode)", async () => {
    // /login is publicly reachable in every auth mode; it must not 401,
    // but it must still carry the full header set (previously it was
    // excluded from the matcher and shipped with no security headers).
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";

    const res = await middleware(makeRequest("/login"));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self' 'nonce-");
  });

  it("does not redirect /login back to itself in oidc mode", async () => {
    // The oidc flow redirects unauthenticated UI requests to /login; /login
    // itself must be exempt from that redirect or the browser loops.
    process.env.DISPATCH_AUTH_MODE = "oidc";
    process.env.NEXTAUTH_SECRET = "secret";
    mocks.getToken.mockResolvedValue(null);

    const res = await middleware(makeRequest("/login"));

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self' 'nonce-");
  });

  it("does not allow inline scripts in the CSP except via a per-request nonce", async () => {
    process.env.DISPATCH_AUTH_MODE = "disabled";

    const res = await middleware(makeRequest("/board"));

    const csp = res.headers.get("content-security-policy") ?? "";
    const scriptSrc = csp.match(/script-src[^;]*/)?.[0] ?? "";
    // 'self' plus exactly one base64 nonce — and never 'unsafe-inline'
    // (the policy that let #841 ship with dark mode silently broken).
    expect(scriptSrc).toMatch(/^script-src 'self' 'nonce-[A-Za-z0-9+/]{16,}={0,2}'$/);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("passes the same nonce to the framework via the request CSP header", async () => {
    // The App Router's own inline scripts (the RSC flight payload) are only
    // unblocked if the framework stamps its nonce on them. Next reads that
    // nonce from the *incoming request's* content-security-policy header
    // (parseRequestHeaders / getScriptNonceFromHeader in next's app-render),
    // so the middleware forwards its generated nonce there. The two must
    // agree: a divergent request nonce means every flight script is blocked
    // and hydration fails on every page.
    process.env.DISPATCH_AUTH_MODE = "disabled";

    const req = makeRequest("/board");
    const res = await middleware(req);

    const responseCsp = res.headers.get("content-security-policy") ?? "";
    const responseNonce = responseCsp.match(/'nonce-([^']+)'/)?.[1];
    expect(responseNonce).toBeTruthy();
    expect(req.headers.get("content-security-policy")).toBe(
      `script-src 'nonce-${responseNonce}'`,
    );
  });

  it("issues a unique nonce per response, even for the same request twice", async () => {
    // The nonce must be unguessable and unique per response (CSP spec): the
    // value is readable by the client (the policy header plus the nonce= attribute
    // on every script tag in the DOM), so a nonce that is a stable function
    // of the request could be harvested from one page load and replayed on
    // injected content — script-src 'self' 'nonce-…' would become
    // 'unsafe-inline' for anyone who has loaded the page once. Two responses
    // for the identical request must therefore differ.
    process.env.DISPATCH_AUTH_MODE = "disabled";

    const first = await middleware(makeRequest("/board"));
    const second = await middleware(makeRequest("/board"));

    const nonce = (res: Awaited<ReturnType<typeof middleware>>) =>
      (res.headers.get("content-security-policy") ?? "").match(/'nonce-([^']+)'/)?.[1];

    expect(nonce(first)).toBeTruthy();
    expect(nonce(first)).not.toBe(nonce(second));
  });

  it("does not emit a CSP header in development mode (dev's multi-pass proxy would intersect divergent nonces)", async () => {
    // In `next dev`, Next 16 invokes the proxy several times per document
    // request and each pass accumulates its own CSP header onto the response;
    // the browser intersects them and the framework's nonce-stamped scripts
    // are blocked — a broken policy, and it cannot be fixed from inside the
    // proxy (see applySecurityHeaders in middleware.ts). Dev therefore skips
    // the CSP entirely; the deployment target (`next start`) enforces it.
    // The static security headers still apply.
    vi.stubEnv("NODE_ENV", "development");
    try {
      process.env.DISPATCH_AUTH_MODE = "disabled";

      const res = await middleware(makeRequest("/board"));

      expect(res.headers.get("content-security-policy")).toBeNull();
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("derives different nonces for different requests", async () => {
    process.env.DISPATCH_AUTH_MODE = "disabled";

    const board = await middleware(makeRequest("/board"));
    const grooming = await middleware(makeRequest("/grooming"));

    const nonce = (res: Awaited<ReturnType<typeof middleware>>) =>
      (res.headers.get("content-security-policy") ?? "").match(/'nonce-([^']+)'/)?.[1];

    expect(nonce(board)).toBeTruthy();
    expect(nonce(grooming)).toBeTruthy();
    expect(nonce(board)).not.toBe(nonce(grooming));
  });
});
