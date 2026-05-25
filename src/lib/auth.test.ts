import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  getAuthMode,
  getBasicAuthCredentials,
  parseAuthorizationHeader,
  isAuthorizedBearerToken,
  isAuthorizedBasicAuth,
  isAuthorized,
  authenticateRequest,
  resetAuthCaches,
} from "./auth";

function clearAll() {
  delete process.env.DISPATCH_AUTH_MODE;
  delete process.env.DISPATCH_AUTH_USERNAME;
  delete process.env.DISPATCH_AUTH_PASSWORD;
  delete process.env.DISPATCH_AGENT_TOKEN;
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

describe("isAuthorized (unified entry point)", () => {
  beforeEach(() => { clearAll(); resetAuthCaches(); });
  afterEach(() => { clearAll(); });

  it('returns true when DISPATCH_AUTH_MODE=disabled', () => {
    process.env.DISPATCH_AUTH_MODE = "disabled";
    const request = new Request("http://localhost/api/test");
    expect(isAuthorized(request)).toBe(true);
  });

  it('returns false for unauthenticated request in basic mode', () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    const request = new Request("http://localhost/api/test");
    expect(isAuthorized(request)).toBe(false);
  });

  it('returns true for valid Basic Auth in basic mode', () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    // base64("operator:s3cret") = "b3BlcmF0b3I6czNjcmV0"
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Basic b3BlcmF0b3I6czNjcmV0" },
    });
    expect(isAuthorized(request)).toBe(true);
  });

  it('returns false for wrong Basic Auth credentials in basic mode', () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "operator";
    process.env.DISPATCH_AUTH_PASSWORD = "s3cret";
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Basic d3Jvbmc6d3Jvbmc=" }, // wrong:wrong
    });
    expect(isAuthorized(request)).toBe(false);
  });

  it("accepts Bearer token in legacy mode (no DISPATCH_AUTH_MODE)", () => {
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer agent-token" },
    });
    expect(isAuthorized(request)).toBe(true);
  });

  it("rejects wrong Bearer token in legacy mode", () => {
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(isAuthorized(request)).toBe(false);
  });

  it("rejects Basic Auth in legacy mode (only Bearer accepted)", () => {
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";
    process.env.DISPATCH_AUTH_MODE = undefined as unknown as string; // ensure not set
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Basic b3BlcmF0b3I6czNjcmV0" },
    });
    expect(isAuthorized(request)).toBe(false);
  });

  it("accepts Bearer token when DISPATCH_AUTH_MODE=disabled", () => {
    process.env.DISPATCH_AUTH_MODE = "disabled";
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer any-token" },
    });
    expect(isAuthorized(request)).toBe(true);
  });

  it("accepts unauthenticated request when DISPATCH_AUTH_MODE=disabled", () => {
    process.env.DISPATCH_AUTH_MODE = "disabled";
    const request = new Request("http://localhost/api/test");
    expect(isAuthorized(request)).toBe(true);
  });
});

describe("authenticateRequest (typed entry point)", () => {
  beforeEach(() => { clearAll(); resetAuthCaches(); });
  afterEach(() => { clearAll(); });

  it('returns { authorized: true, type: "bearer" } in disabled mode', () => {
    process.env.DISPATCH_AUTH_MODE = "disabled";
    const request = new Request("http://localhost/api/test");
    expect(authenticateRequest(request)).toEqual({ authorized: true, type: "bearer" });
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
    expect(authenticateRequest(request)).toEqual({ authorized: true, type: "bearer" });
  });

  it("returns { authorized: false } for invalid Bearer in legacy mode", () => {
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(authenticateRequest(request)).toEqual({ authorized: false });
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
