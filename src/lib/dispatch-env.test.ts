import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Helpers to manage env var state between tests
// ---------------------------------------------------------------------------

function clearAll() {
  delete process.env.DISPATCH_URL;
  delete process.env.DISPATCH_AGENT_TOKEN;
  delete process.env.DATABASE_URL;
  delete process.env.DISPATCH_DATABASE_URL;
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

  it("does not accept MISSION_CONTROL_AGENT_TOKEN as authorized", async () => {
    process.env.MISSION_CONTROL_AGENT_TOKEN = "legacy-token";
    const mod = await import("./dispatch-env");
    expect(mod.isAuthorizedAgentToken("legacy-token")).toBe(false);
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

  it("prefers DATABASE_URL over DISPATCH_DATABASE_URL", async () => {
    process.env.DATABASE_URL = "postgresql://canonical:5432/db";
    process.env.DISPATCH_DATABASE_URL = "postgresql://dispatch-db:5432/db";
    const mod = await import("./dispatch-env");
    expect(mod.getDatabaseUrl()).toBe("postgresql://canonical:5432/db");
  });

  it("returns undefined when neither is set", async () => {
    const mod = await import("./dispatch-env");
    expect(mod.getDatabaseUrl()).toBeUndefined();
  });

  it("does not fall back to MISSION_CONTROL_DATABASE_URL", async () => {
    process.env.MISSION_CONTROL_DATABASE_URL = "postgresql://legacy-db:5432/db";
    const mod = await import("./dispatch-env");
    expect(mod.getDatabaseUrl()).toBeUndefined();
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

  it("does not export MISSION_CONTROL_DATABASE_URL as DATABASE_URL", async () => {
    process.env.MISSION_CONTROL_DATABASE_URL = "postgresql://legacy-db:5432/db";
    const mod = await import("./dispatch-env");
    mod.ensureDatabaseUrl();
    expect(process.env.DATABASE_URL).toBeUndefined();
  });

  it("does not override existing preferred vars with legacy ones", async () => {
    process.env.DATABASE_URL = "postgresql://canonical:5432/db";
    process.env.DISPATCH_AGENT_TOKEN = "dispatch-token";
    const mod = await import("./dispatch-env");
    mod.ensureDatabaseUrl();
    expect(process.env.DATABASE_URL).toBe("postgresql://canonical:5432/db");
    expect(process.env.DISPATCH_AGENT_TOKEN).toBe("dispatch-token");
  });

  it("is idempotent — safe to call multiple times", async () => {
    process.env.DISPATCH_DATABASE_URL = "postgresql://dispatch-db:5432/db";
    const mod = await import("./dispatch-env");
    mod.ensureDatabaseUrl();
    const firstDb = process.env.DATABASE_URL;
    mod.ensureDatabaseUrl();
    expect(process.env.DATABASE_URL).toBe(firstDb);
  });

  it("does not map MISSION_CONTROL_AGENT_TOKEN to DISPATCH_AGENT_TOKEN", async () => {
    process.env.MISSION_CONTROL_AGENT_TOKEN = "legacy-token";
    const mod = await import("./dispatch-env");
    mod.ensureDatabaseUrl();
    expect(process.env.DISPATCH_AGENT_TOKEN).toBeUndefined();
  });

  it("does not map MISSION_CONTROL_URL to DISPATCH_URL", async () => {
    process.env.MISSION_CONTROL_URL = "http://legacy.example.com";
    const mod = await import("./dispatch-env");
    mod.ensureDatabaseUrl();
    expect(process.env.DISPATCH_URL).toBeUndefined();
  });
});
