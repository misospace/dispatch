import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Helpers to manage env var state between tests
// ---------------------------------------------------------------------------

function clearAll() {
  delete process.env.DISPATCH_URL;
  delete process.env.MISSION_CONTROL_URL;
  delete process.env.DISPATCH_AGENT_TOKEN;
  delete process.env.MISSION_CONTROL_AGENT_TOKEN;
  delete process.env.DATABASE_URL;
  delete process.env.DISPATCH_DATABASE_URL;
  delete process.env.MISSION_CONTROL_DATABASE_URL;
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

  it("falls back to MISSION_CONTROL_URL when DISPATCH_URL is not set", async () => {
    process.env.MISSION_CONTROL_URL = "http://legacy.example.com";
    const mod = await import("./dispatch-env");
    expect(mod.getDispatchUrl()).toBe("http://legacy.example.com");
  });

  it("prefers DISPATCH_URL over MISSION_CONTROL_URL when both are set", async () => {
    process.env.DISPATCH_URL = "http://dispatch.example.com";
    process.env.MISSION_CONTROL_URL = "http://legacy.example.com";
    const mod = await import("./dispatch-env");
    expect(mod.getDispatchUrl()).toBe("http://dispatch.example.com");
  });

  it("returns undefined when neither is set", async () => {
    const mod = await import("./dispatch-env");
    expect(mod.getDispatchUrl()).toBeUndefined();
  });

  it("warns when both are set and differ", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.DISPATCH_URL = "http://dispatch.example.com";
    process.env.MISSION_CONTROL_URL = "http://legacy.example.com";
    const mod = await import("./dispatch-env");
    mod.getDispatchUrl();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Both DISPATCH_URL and MISSION_CONTROL_URL"),
    );
    warnSpy.mockRestore();
  });

  it("warns when using legacy MISSION_CONTROL_URL", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.MISSION_CONTROL_URL = "http://legacy.example.com";
    const mod = await import("./dispatch-env");
    mod.getDispatchUrl();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("MISSION_CONTROL_URL is deprecated"),
    );
    warnSpy.mockRestore();
  });

  it("does not print URL values in warnings", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.DISPATCH_URL = "http://dispatch.example.com";
    process.env.MISSION_CONTROL_URL = "http://legacy-secret-url.example.com";
    const mod = await import("./dispatch-env");
    mod.getDispatchUrl();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
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

  it("falls back to MISSION_CONTROL_AGENT_TOKEN when DISPATCH_AGENT_TOKEN is not set", async () => {
    process.env.MISSION_CONTROL_AGENT_TOKEN = "legacy-token-456";
    const mod = await import("./dispatch-env");
    expect(mod.getDispatchAgentToken()).toBe("legacy-token-456");
  });

  it("prefers DISPATCH_AGENT_TOKEN over MISSION_CONTROL_AGENT_TOKEN when both are set", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "dispatch-token-123";
    process.env.MISSION_CONTROL_AGENT_TOKEN = "legacy-token-456";
    const mod = await import("./dispatch-env");
    expect(mod.getDispatchAgentToken()).toBe("dispatch-token-123");
  });

  it("returns undefined when neither is set", async () => {
    const mod = await import("./dispatch-env");
    expect(mod.getDispatchAgentToken()).toBeUndefined();
  });

  it("warns when both are set and differ", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.DISPATCH_AGENT_TOKEN = "dispatch-token-123";
    process.env.MISSION_CONTROL_AGENT_TOKEN = "legacy-token-456";
    const mod = await import("./dispatch-env");
    mod.getDispatchAgentToken();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Both DISPATCH_AGENT_TOKEN and MISSION_CONTROL_AGENT_TOKEN"),
    );
    warnSpy.mockRestore();
  });

  it("warns when using legacy MISSION_CONTROL_AGENT_TOKEN", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.MISSION_CONTROL_AGENT_TOKEN = "legacy-token-456";
    const mod = await import("./dispatch-env");
    mod.getDispatchAgentToken();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("MISSION_CONTROL_AGENT_TOKEN is deprecated"),
    );
    warnSpy.mockRestore();
  });

  it("never prints token values in warnings", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.DISPATCH_AGENT_TOKEN = "super-secret-dispatch-token";
    process.env.MISSION_CONTROL_AGENT_TOKEN = "super-secret-legacy-token";
    const mod = await import("./dispatch-env");
    mod.getDispatchAgentToken();
    const calls = warnSpy.mock.calls.flat();
    for (const call of calls) {
      if (typeof call === "string") {
        expect(call).not.toContain("super-secret-dispatch-token");
        expect(call).not.toContain("super-secret-legacy-token");
      }
    }
    warnSpy.mockRestore();
  });
});

describe("getAcceptedAgentTokens", () => {
  beforeEach(() => {
    clearAll();
    vi.resetModules();
  });
  afterEach(() => { clearAll(); });

  it("returns only DISPATCH_AGENT_TOKEN when only it is set", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "dispatch-token";
    const mod = await import("./dispatch-env");
    expect(mod.getAcceptedAgentTokens()).toEqual(["dispatch-token"]);
  });

  it("returns only MISSION_CONTROL_AGENT_TOKEN when only it is set", async () => {
    process.env.MISSION_CONTROL_AGENT_TOKEN = "legacy-token";
    const mod = await import("./dispatch-env");
    expect(mod.getAcceptedAgentTokens()).toEqual(["legacy-token"]);
  });

  it("returns both tokens when both are set", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "dispatch-token";
    process.env.MISSION_CONTROL_AGENT_TOKEN = "legacy-token";
    const mod = await import("./dispatch-env");
    expect(mod.getAcceptedAgentTokens()).toContain("dispatch-token");
    expect(mod.getAcceptedAgentTokens()).toContain("legacy-token");
  });

  it("returns empty array when neither is set", async () => {
    const mod = await import("./dispatch-env");
    expect(mod.getAcceptedAgentTokens()).toEqual([]);
  });
});

describe("isAuthorizedAgentToken", () => {
  beforeEach(() => {
    clearAll();
    vi.resetModules();
  });
  afterEach(() => { clearAll(); });

  it("returns true for DISPATCH_AGENT_TOKEN", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "valid-token";
    const mod = await import("./dispatch-env");
    expect(mod.isAuthorizedAgentToken("valid-token")).toBe(true);
  });

  it("returns true for MISSION_CONTROL_AGENT_TOKEN (legacy)", async () => {
    process.env.MISSION_CONTROL_AGENT_TOKEN = "legacy-valid-token";
    const mod = await import("./dispatch-env");
    expect(mod.isAuthorizedAgentToken("legacy-valid-token")).toBe(true);
  });

  it("returns true when both tokens are set and matches either", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "dispatch-token";
    process.env.MISSION_CONTROL_AGENT_TOKEN = "legacy-token";
    const mod = await import("./dispatch-env");
    expect(mod.isAuthorizedAgentToken("dispatch-token")).toBe(true);
    expect(mod.isAuthorizedAgentToken("legacy-token")).toBe(true);
  });

  it("returns false for wrong token", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "valid-token";
    const mod = await import("./dispatch-env");
    expect(mod.isAuthorizedAgentToken("wrong-token")).toBe(false);
  });

  it("returns false for null token", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "valid-token";
    const mod = await import("./dispatch-env");
    expect(mod.isAuthorizedAgentToken(null)).toBe(false);
  });

  it("returns false for empty string token", async () => {
    process.env.DISPATCH_AGENT_TOKEN = "valid-token";
    const mod = await import("./dispatch-env");
    expect(mod.isAuthorizedAgentToken("")).toBe(false);
  });

  it("returns false when no tokens are configured", async () => {
    const mod = await import("./dispatch-env");
    expect(mod.isAuthorizedAgentToken("any-token")).toBe(false);
  });
});

describe("getDatabaseUrl", () => {
  beforeEach(() => {
    clearAll();
    vi.resetModules();
  });
  afterEach(() => { clearAll(); });

  it("returns DATABASE_URL when set (canonical)", async () => {
    process.env.DATABASE_URL = "postgresql://canonical:5432/db";
    const mod = await import("./dispatch-env");
    expect(mod.getDatabaseUrl()).toBe("postgresql://canonical:5432/db");
  });

  it("falls back to DISPATCH_DATABASE_URL when DATABASE_URL is not set", async () => {
    process.env.DISPATCH_DATABASE_URL = "postgresql://dispatch-db:5432/db";
    const mod = await import("./dispatch-env");
    expect(mod.getDatabaseUrl()).toBe("postgresql://dispatch-db:5432/db");
  });

  it("falls back to MISSION_CONTROL_DATABASE_URL when only legacy is set", async () => {
    process.env.MISSION_CONTROL_DATABASE_URL = "postgresql://legacy-db:5432/db";
    const mod = await import("./dispatch-env");
    expect(mod.getDatabaseUrl()).toBe("postgresql://legacy-db:5432/db");
  });

  it("prefers DATABASE_URL over DISPATCH_DATABASE_URL", async () => {
    process.env.DATABASE_URL = "postgresql://canonical:5432/db";
    process.env.DISPATCH_DATABASE_URL = "postgresql://dispatch-db:5432/db";
    const mod = await import("./dispatch-env");
    expect(mod.getDatabaseUrl()).toBe("postgresql://canonical:5432/db");
  });

  it("prefers DATABASE_URL over MISSION_CONTROL_DATABASE_URL", async () => {
    process.env.DATABASE_URL = "postgresql://canonical:5432/db";
    process.env.MISSION_CONTROL_DATABASE_URL = "postgresql://legacy-db:5432/db";
    const mod = await import("./dispatch-env");
    expect(mod.getDatabaseUrl()).toBe("postgresql://canonical:5432/db");
  });

  it("prefers DISPATCH_DATABASE_URL over MISSION_CONTROL_DATABASE_URL", async () => {
    process.env.DISPATCH_DATABASE_URL = "postgresql://dispatch-db:5432/db";
    process.env.MISSION_CONTROL_DATABASE_URL = "postgresql://legacy-db:5432/db";
    const mod = await import("./dispatch-env");
    expect(mod.getDatabaseUrl()).toBe("postgresql://dispatch-db:5432/db");
  });

  it("returns undefined when none are set", async () => {
    const mod = await import("./dispatch-env");
    expect(mod.getDatabaseUrl()).toBeUndefined();
  });

  it("warns when DATABASE_URL and legacy both exist", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.DATABASE_URL = "postgresql://canonical:5432/db";
    process.env.MISSION_CONTROL_DATABASE_URL = "postgresql://legacy-db:5432/db";
    const mod = await import("./dispatch-env");
    mod.getDatabaseUrl();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("DATABASE_URL is set"),
    );
    warnSpy.mockRestore();
  });
});

describe("ensureDatabaseUrl", () => {
  beforeEach(() => {
    clearAll();
    vi.resetModules();
  });
  afterEach(() => { clearAll(); });

  it("does nothing when DATABASE_URL is already set", async () => {
    process.env.DATABASE_URL = "postgresql://already-set:5432/db";
    const mod = await import("./dispatch-env");
    mod.ensureDatabaseUrl();
    expect(process.env.DATABASE_URL).toBe("postgresql://already-set:5432/db");
  });

  it("exports DISPATCH_DATABASE_URL as DATABASE_URL", async () => {
    process.env.DISPATCH_DATABASE_URL = "postgresql://dispatch-db:5432/db";
    const mod = await import("./dispatch-env");
    mod.ensureDatabaseUrl();
    expect(process.env.DATABASE_URL).toBe("postgresql://dispatch-db:5432/db");
  });

  it("exports MISSION_CONTROL_DATABASE_URL as DATABASE_URL with deprecation warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.MISSION_CONTROL_DATABASE_URL = "postgresql://legacy-db:5432/db";
    const mod = await import("./dispatch-env");
    mod.ensureDatabaseUrl();
    expect(process.env.DATABASE_URL).toBe("postgresql://legacy-db:5432/db");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("MISSION_CONTROL_DATABASE_URL is deprecated"),
    );
    warnSpy.mockRestore();
  });

  it("exports MISSION_CONTROL_AGENT_TOKEN as DISPATCH_AGENT_TOKEN", async () => {
    process.env.MISSION_CONTROL_AGENT_TOKEN = "legacy-token";
    const mod = await import("./dispatch-env");
    mod.ensureDatabaseUrl();
    expect(process.env.DISPATCH_AGENT_TOKEN).toBe("legacy-token");
  });

  it("exports MISSION_CONTROL_URL as DISPATCH_URL", async () => {
    process.env.MISSION_CONTROL_URL = "http://legacy.example.com";
    const mod = await import("./dispatch-env");
    mod.ensureDatabaseUrl();
    expect(process.env.DISPATCH_URL).toBe("http://legacy.example.com");
  });

  it("does not override existing preferred vars with legacy ones", async () => {
    process.env.DATABASE_URL = "postgresql://canonical:5432/db";
    process.env.DISPATCH_AGENT_TOKEN = "dispatch-token";
    process.env.MISSION_CONTROL_DATABASE_URL = "postgresql://legacy-db:5432/db";
    process.env.MISSION_CONTROL_AGENT_TOKEN = "legacy-token";
    const mod = await import("./dispatch-env");
    mod.ensureDatabaseUrl();
    expect(process.env.DATABASE_URL).toBe("postgresql://canonical:5432/db");
    expect(process.env.DISPATCH_AGENT_TOKEN).toBe("dispatch-token");
  });

  it("is idempotent — safe to call multiple times", async () => {
    process.env.MISSION_CONTROL_DATABASE_URL = "postgresql://legacy-db:5432/db";
    const mod = await import("./dispatch-env");
    mod.ensureDatabaseUrl();
    const firstDb = process.env.DATABASE_URL;
    mod.ensureDatabaseUrl();
    expect(process.env.DATABASE_URL).toBe(firstDb);
  });

  it("never prints secret values", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.MISSION_CONTROL_AGENT_TOKEN = "super-secret-legacy-agent-token";
    process.env.MISSION_CONTROL_DATABASE_URL = "postgresql://user:supersecret@host:5432/db";
    const mod = await import("./dispatch-env");
    mod.ensureDatabaseUrl();
    const calls = warnSpy.mock.calls.flat();
    for (const call of calls) {
      if (typeof call === "string") {
        expect(call).not.toContain("super-secret-legacy-agent-token");
        expect(call).not.toContain("supersecret");
      }
    }
    warnSpy.mockRestore();
  });
});
