import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Helpers to manage env var state between tests
// ---------------------------------------------------------------------------

function clearAll() {
  delete process.env.DISPATCH_URL;
  delete process.env.DISPATCH_AGENT_TOKEN;
}

describe("getDispatchUrl", () => {
  beforeEach(() => {
    clearAll();
    vi.resetModules();
  });
  afterEach(() => { clearAll(); });

  it("returns DISPATCH_URL when set", async () => {
    process.env.DISPATCH_URL = "http://dispatch.example.com";
    const mod = await import("./dispatch-env");
    expect(mod.getDispatchUrl()).toBe("http://dispatch.example.com");
  });

  it("strips trailing slashes from DISPATCH_URL", async () => {
    process.env.DISPATCH_URL = "http://dispatch.example.com/";
    const mod = await import("./dispatch-env");
    expect(mod.getDispatchUrl()).toBe("http://dispatch.example.com");
  });

  it("returns undefined when DISPATCH_URL is not set", async () => {
    const mod = await import("./dispatch-env");
    expect(mod.getDispatchUrl()).toBeUndefined();
  });
});

describe("getDispatchAgentToken", () => {
  beforeEach(() => {
    clearAll();
    vi.resetModules();
  });
  afterEach(() => { clearAll(); });

  it("returns DISPATCH_AGENT_TOKEN when set", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "dispatch-token-123";
    const mod = await import("./dispatch-env");
    expect(mod.getDispatchAgentToken()).toBe("dispatch-token-123");
  });

  it("returns undefined when DISPATCH_AGENT_TOKEN is not set", async () => {
    const mod = await import("./dispatch-env");
    expect(mod.getDispatchAgentToken()).toBeUndefined();
  });
});

describe("getAcceptedAgentTokens", () => {
  beforeEach(() => {
    clearAll();
    vi.resetModules();
  });
  afterEach(() => { clearAll(); });

  it("returns DISPATCH_AGENT_TOKEN when set", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "dispatch-token";
    const mod = await import("./dispatch-env");
    expect(mod.getAcceptedAgentTokens()).toEqual(["dispatch-token"]);
  });

  it("returns empty array when not set", async () => {
    const mod = await import("./dispatch-env");
    expect(mod.getAcceptedAgentTokens()).toEqual([]);
  });
});

describe("isAuthorizedBearerToken", () => {
  beforeEach(() => {
    clearAll();
    vi.resetModules();
  });
  afterEach(() => { clearAll(); });

  it("returns true for DISPATCH_AGENT_TOKEN", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "valid-token";
    const mod = await import("./dispatch-env");
    expect(mod.isAuthorizedBearerToken("valid-token")).toBe(true);
  });

  it("returns false for wrong token", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "valid-token";
    const mod = await import("./dispatch-env");
    expect(mod.isAuthorizedBearerToken("wrong-token")).toBe(false);
  });

  it("returns false for null token", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "valid-token";
    const mod = await import("./dispatch-env");
    expect(mod.isAuthorizedBearerToken(null)).toBe(false);
  });

  it("returns false for empty string token", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "valid-token";
    const mod = await import("./dispatch-env");
    expect(mod.isAuthorizedBearerToken("")).toBe(false);
  });

  it("returns false when no tokens are configured", async () => {
    const mod = await import("./dispatch-env");
    expect(mod.isAuthorizedBearerToken("any-token")).toBe(false);
  });

  it("does not accept MISSION_CONTROL_AGENT_TOKEN as authorized", async () => {
    process.env.MISSION_CONTROL_AGENT_TOKEN = "legacy-token";
    const mod = await import("./dispatch-env");
    expect(mod.isAuthorizedBearerToken("legacy-token")).toBe(false);
  });
});
