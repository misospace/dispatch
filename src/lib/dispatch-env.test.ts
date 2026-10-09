import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Helpers to manage env var state between tests
// ---------------------------------------------------------------------------

function clearAll() {
  delete process.env.DISPATCH_URL;
  delete process.env.DISPATCH_AGENT_TOKEN;
  delete process.env.DISPATCH_MAINTAINER_TOKEN;
  delete process.env.DISPATCH_WORKER_TOKEN;
  delete process.env.DISPATCH_WORKER_TOKENS;
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

  it("trims env values at table construction: a padded worker env duplicates the agent env and warns", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.DISPATCH_AGENT_TOKEN = "shared";
      process.env.DISPATCH_WORKER_TOKEN = " shared ";
      const mod = await import("./dispatch-env");
      expect(mod.getBearerTokenTier("shared")).toBe("worker");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain("DISPATCH_AGENT_TOKEN");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("treats a whitespace-only env value as unset", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "agent-token";
    process.env.DISPATCH_WORKER_TOKEN = "   ";
    const mod = await import("./dispatch-env");
    expect(mod.getAcceptedTokenTiers()).toEqual([{ token: "agent-token", tier: "maintainer" }]);
    expect(mod.getBearerTokenTier("   ")).toBeNull();
  });

  it("trims the presented token before comparing it to table entries", async () => {
    process.env.DISPATCH_WORKER_TOKEN = "worker-token";
    const mod = await import("./dispatch-env");
    expect(mod.getBearerTokenTier(" worker-token ")).toBe("worker");
  });

  it('resolves a value shared between DISPATCH_AGENT_TOKEN and DISPATCH_WORKER_TOKEN to "worker"', async () => {
    process.env.DISPATCH_AGENT_TOKEN = "shared-value";
    process.env.DISPATCH_WORKER_TOKEN = "shared-value";
    const mod = await import("./dispatch-env");
    expect(mod.getBearerTokenTier("shared-value")).toBe("worker");
  });

  it('resolves a value shared between DISPATCH_MAINTAINER_TOKEN and DISPATCH_WORKER_TOKEN to "worker"', async () => {
    process.env.DISPATCH_MAINTAINER_TOKEN = "shared-value";
    process.env.DISPATCH_WORKER_TOKEN = "shared-value";
    const mod = await import("./dispatch-env");
    expect(mod.getBearerTokenTier("shared-value")).toBe("worker");
  });

  it('keeps "maintainer" for a value shared only between the two maintainer aliases', async () => {
    process.env.DISPATCH_AGENT_TOKEN = "shared-value";
    process.env.DISPATCH_MAINTAINER_TOKEN = "shared-value";
    const mod = await import("./dispatch-env");
    expect(mod.getBearerTokenTier("shared-value")).toBe("maintainer");
  });

  it("warns once (without token values) when the worker token duplicates a maintainer token", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.DISPATCH_AGENT_TOKEN = "shared-value";
      process.env.DISPATCH_WORKER_TOKEN = "shared-value";
      const mod = await import("./dispatch-env");
      mod.getAcceptedTokenTiers();
      mod.getAcceptedTokenTiers();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).not.toContain("shared-value");
      // The warning names the colliding env var, not just "a maintainer token".
      expect(String(warnSpy.mock.calls[0][0])).toContain("DISPATCH_AGENT_TOKEN");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns once (without token values) when the worker token duplicates DISPATCH_MAINTAINER_TOKEN", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.DISPATCH_MAINTAINER_TOKEN = "shared-value";
      process.env.DISPATCH_WORKER_TOKEN = "shared-value";
      const mod = await import("./dispatch-env");
      mod.getAcceptedTokenTiers();
      mod.getAcceptedTokenTiers();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).not.toContain("shared-value");
      expect(String(warnSpy.mock.calls[0][0])).toContain("DISPATCH_MAINTAINER_TOKEN");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn when the two maintainer aliases share a value", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.DISPATCH_AGENT_TOKEN = "shared-value";
      process.env.DISPATCH_MAINTAINER_TOKEN = "shared-value";
      const mod = await import("./dispatch-env");
      mod.getAcceptedTokenTiers();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
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

describe("DISPATCH_WORKER_TOKENS binding (#1129)", () => {
  beforeEach(() => {
    clearAll();
    vi.resetModules();
  });
  afterEach(() => { clearAll(); });

  it("parses comma- and newline-separated agent:token entries, trimming each side", async () => {
    process.env.DISPATCH_WORKER_TOKENS = " alpha : tok-a ,\n bravo:tok-b \n\n";
    const mod = await import("./dispatch-env");
    expect(mod.getWorkerTokenBindings()).toEqual([
      { token: "tok-a", agentName: "alpha" },
      { token: "tok-b", agentName: "bravo" },
    ]);
  });

  it("splits on the first colon so tokens may contain colons", async () => {
    process.env.DISPATCH_WORKER_TOKENS = "alpha:aa:bb:cc";
    const mod = await import("./dispatch-env");
    expect(mod.getWorkerTokenBindings()).toEqual([{ token: "aa:bb:cc", agentName: "alpha" }]);
  });

  it("skips malformed entries without logging the value", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.DISPATCH_WORKER_TOKENS = "no-colon,alpha:, :tok,bravo:tok-b";
      const mod = await import("./dispatch-env");
      expect(mod.getWorkerTokenBindings()).toEqual([{ token: "tok-b", agentName: "bravo" }]);
      expect(warnSpy).toHaveBeenCalled();
      for (const call of warnSpy.mock.calls) {
        expect(String(call[0])).not.toContain("tok-b");
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("resolves a bound token to worker tier with its agent identity", async () => {
    process.env.DISPATCH_WORKER_TOKENS = "alpha:tok-a,bravo:tok-b";
    const mod = await import("./dispatch-env");
    expect(mod.getBearerTokenIdentity("tok-a")).toEqual({ tier: "worker", agentName: "alpha" });
    expect(mod.getBearerTokenIdentity("tok-b")).toEqual({ tier: "worker", agentName: "bravo" });
    expect(mod.getBoundAgentName("tok-a")).toBe("alpha");
    expect(mod.getBearerTokenTier("tok-a")).toBe("worker");
    expect(mod.isAuthorizedBearerToken("tok-a")).toBe(true);
  });

  it("allows multiple tokens per agent (rotation)", async () => {
    process.env.DISPATCH_WORKER_TOKENS = "alpha:old,alpha:new";
    const mod = await import("./dispatch-env");
    expect(mod.getBoundAgentName("old")).toBe("alpha");
    expect(mod.getBoundAgentName("new")).toBe("alpha");
  });

  it("fails closed on an ambiguous token bound to two agents", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.DISPATCH_WORKER_TOKENS = "alpha:dup,bravo:dup,charlie:ok";
      const mod = await import("./dispatch-env");
      expect(mod.getWorkerTokenBindings()).toEqual([{ token: "ok", agentName: "charlie" }]);
      expect(mod.getBearerTokenIdentity("dup")).toBeNull();
      expect(mod.getBoundAgentName("dup")).toBeUndefined();
      expect(mod.isAuthorizedBearerToken("dup")).toBe(false);
      // The non-ambiguous credential still works.
      expect(mod.getBoundAgentName("ok")).toBe("charlie");
      expect(warnSpy).toHaveBeenCalled();
      for (const call of warnSpy.mock.calls) {
        expect(String(call[0])).not.toContain("dup");
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("never binds an ambiguous token, even when it also matches the legacy worker token", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.DISPATCH_WORKER_TOKEN = "dup";
      process.env.DISPATCH_WORKER_TOKENS = "alpha:dup,bravo:dup";
      const mod = await import("./dispatch-env");
      // It is usable only as the unbound legacy token — never as a bound
      // identity and never as maintainer.
      expect(mod.getBearerTokenIdentity("dup")).toEqual({ tier: "worker", legacyUnbound: true });
      expect(mod.getBoundAgentName("dup")).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("resolves a bound token that duplicates a maintainer token to worker tier with binding intact", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.DISPATCH_AGENT_TOKEN = "shared";
      process.env.DISPATCH_WORKER_TOKENS = "alpha:shared";
      const mod = await import("./dispatch-env");
      // Building the tier table (as instrumentation does at boot) surfaces the
      // collision warning.
      mod.getAcceptedTokenTiers();
      expect(mod.getBearerTokenIdentity("shared")).toEqual({ tier: "worker", agentName: "alpha" });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain("DISPATCH_AGENT_TOKEN");
      expect(String(warnSpy.mock.calls[0][0])).not.toContain("shared");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("resolves the legacy unbound worker token with legacyUnbound true", async () => {
    process.env.DISPATCH_WORKER_TOKEN = "legacy";
    const mod = await import("./dispatch-env");
    expect(mod.getBearerTokenIdentity("legacy")).toEqual({ tier: "worker", legacyUnbound: true });
    expect(mod.getBoundAgentName("legacy")).toBeUndefined();
  });

  it("rotates bound credentials after resetCaches", async () => {
    process.env.DISPATCH_WORKER_TOKENS = "alpha:old";
    const mod = await import("./dispatch-env");
    expect(mod.getBoundAgentName("old")).toBe("alpha");

    mod.resetCaches();
    process.env.DISPATCH_WORKER_TOKENS = "alpha:new";
    expect(mod.getBoundAgentName("old")).toBeUndefined();
    expect(mod.isAuthorizedBearerToken("old")).toBe(false);
    expect(mod.getBoundAgentName("new")).toBe("alpha");
  });

  it("warnLegacyWorkerToken warns once and never logs the value", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.DISPATCH_WORKER_TOKEN = "legacy-secret";
      const mod = await import("./dispatch-env");
      mod.warnLegacyWorkerToken();
      mod.warnLegacyWorkerToken();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain("DISPATCH_WORKER_TOKENS");
      expect(String(warnSpy.mock.calls[0][0])).not.toContain("legacy-secret");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
