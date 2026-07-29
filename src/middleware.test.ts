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

  it("CSP allows inline scripts and styles for Next.js compatibility", async () => {
    process.env.DISPATCH_AUTH_MODE = "disabled";

    const res = await middleware(makeRequest("/board"));

    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("'unsafe-inline'");
  });
});
