import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Helpers to manage env var state between tests
// ---------------------------------------------------------------------------

function clearAll() {
  delete process.env.DISPATCH_URL;
  delete process.env.DISPATCH_AGENT_TOKEN;
  delete process.env.DISPATCH_MAINTAINER_TOKEN;
  delete process.env.DISPATCH_WORKER_TOKEN;
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

  it("returns true for a worker-tier token", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "maintainer-token";
    process.env.DISPATCH_WORKER_TOKEN = "worker-token";
    const mod = await import("./dispatch-env");
    expect(mod.isAuthorizedBearerToken("worker-token")).toBe(true);
  });
});

describe("getBearerTokenTier", () => {
  beforeEach(() => {
    clearAll();
    vi.resetModules();
  });
  afterEach(() => { clearAll(); });

  it('resolves DISPATCH_WORKER_TOKEN to "worker"', async () => {
    process.env.DISPATCH_WORKER_TOKEN = "worker-token";
    const mod = await import("./dispatch-env");
    expect(mod.getBearerTokenTier("worker-token")).toBe("worker");
  });

  it('resolves DISPATCH_AGENT_TOKEN to "maintainer"', async () => {
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";
    const mod = await import("./dispatch-env");
    expect(mod.getBearerTokenTier("agent-token")).toBe("maintainer");
  });

  it('resolves DISPATCH_MAINTAINER_TOKEN to "maintainer"', async () => {
    process.env.DISPATCH_MAINTAINER_TOKEN = "maintainer-alias";
    const mod = await import("./dispatch-env");
    expect(mod.getBearerTokenTier("maintainer-alias")).toBe("maintainer");
  });

  it("returns null for an unknown token", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";
    process.env.DISPATCH_WORKER_TOKEN = "worker-token";
    const mod = await import("./dispatch-env");
    expect(mod.getBearerTokenTier("unknown-token")).toBeNull();
  });

  it("returns null for null/undefined/empty tokens", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";
    const mod = await import("./dispatch-env");
    expect(mod.getBearerTokenTier(null)).toBeNull();
    expect(mod.getBearerTokenTier(undefined)).toBeNull();
    expect(mod.getBearerTokenTier("")).toBeNull();
  });

  it("returns null when no tokens are configured", async () => {
    const mod = await import("./dispatch-env");
    expect(mod.getBearerTokenTier("any-token")).toBeNull();
  });

  it("maintainer wins when the same value is configured for multiple tiers", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "shared-value";
    process.env.DISPATCH_WORKER_TOKEN = "shared-value";
    const mod = await import("./dispatch-env");
    expect(mod.getBearerTokenTier("shared-value")).toBe("maintainer");
  });
});

describe("getAcceptedTokenTiers", () => {
  beforeEach(() => {
    clearAll();
    vi.resetModules();
  });
  afterEach(() => { clearAll(); });

  it("returns the token→tier table for all configured tokens", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";
    process.env.DISPATCH_MAINTAINER_TOKEN = "maintainer-alias";
    process.env.DISPATCH_WORKER_TOKEN = "worker-token";
    const mod = await import("./dispatch-env");
    expect(mod.getAcceptedTokenTiers()).toEqual([
      { token: "agent-token", tier: "maintainer" },
      { token: "maintainer-alias", tier: "maintainer" },
      { token: "worker-token", tier: "worker" },
    ]);
  });

  it("returns an empty array when nothing is configured", async () => {
    const mod = await import("./dispatch-env");
    expect(mod.getAcceptedTokenTiers()).toEqual([]);
  });
});

describe("getAcceptedAgentTokens (tier-derived)", () => {
  beforeEach(() => {
    clearAll();
    vi.resetModules();
  });
  afterEach(() => { clearAll(); });

  it("includes every configured token (all tiers)", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";
    process.env.DISPATCH_MAINTAINER_TOKEN = "maintainer-alias";
    process.env.DISPATCH_WORKER_TOKEN = "worker-token";
    const mod = await import("./dispatch-env");
    expect(mod.getAcceptedAgentTokens()).toEqual([
      "agent-token",
      "maintainer-alias",
      "worker-token",
    ]);
  });

  it("de-duplicates a value configured in multiple tiers", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "shared-value";
    process.env.DISPATCH_WORKER_TOKEN = "shared-value";
    const mod = await import("./dispatch-env");
    expect(mod.getAcceptedAgentTokens()).toEqual(["shared-value"]);
  });
});

describe("token tier cache reset", () => {
  beforeEach(() => {
    clearAll();
    vi.resetModules();
  });
  afterEach(() => { clearAll(); });

  it("picks up new env values after resetCaches", async () => {
    process.env.DISPATCH_WORKER_TOKEN = "worker-1";
    const mod = await import("./dispatch-env");
    expect(mod.getBearerTokenTier("worker-1")).toBe("worker");

    mod.resetCaches();
    process.env.DISPATCH_WORKER_TOKEN = "worker-2";
    delete process.env.DISPATCH_AGENT_TOKEN;
    expect(mod.getBearerTokenTier("worker-1")).toBeNull();
    expect(mod.getBearerTokenTier("worker-2")).toBe("worker");
    expect(mod.getAcceptedTokenTiers()).toEqual([{ token: "worker-2", tier: "worker" }]);
  });
});
