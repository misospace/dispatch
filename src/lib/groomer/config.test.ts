import { describe, expect, it, beforeEach } from "vitest";
import { getHostedGroomerConfig } from "./config";

describe("groomer config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    delete process.env.DISPATCH_HOSTED_GROOMER_ENABLED;
    delete process.env.DISPATCH_LLM_BASE_URL;
    delete process.env.DISPATCH_LLM_API_KEY;
    delete process.env.DISPATCH_GROOMER_MODEL;
    delete process.env.DISPATCH_GROOMER_TIMEOUT_MS;
    delete process.env.DISPATCH_GROOMER_MAX_CONTEXT_BYTES;
    delete process.env.DISPATCH_GROOMER_DRY_RUN;
    delete process.env.DISPATCH_GROOMER_REPO_CONTEXT_ENABLED;
    delete process.env.DISPATCH_GROOMER_MAX_CONTEXT_FILES;
    delete process.env.DISPATCH_GROOMER_MAX_SEARCHES;
    delete process.env.DISPATCH_GROOMER_MAX_FILE_BYTES;
    delete process.env.DISPATCH_GROOMER_COMMENT_COOLDOWN_HOURS;
    delete process.env.DISPATCH_GROOMER_TOKEN;
  });

  it("is disabled by default", () => {
    const config = getHostedGroomerConfig();
    expect(config.enabled).toBe(false);
  });

  it("is dry-run by default when enabled", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    const config = getHostedGroomerConfig();
    expect(config.enabled).toBe(true);
    expect(config.dryRun).toBe(true);
  });

  it("enables when DISPATCH_HOSTED_GROOMER_ENABLED is true", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    const config = getHostedGroomerConfig();
    expect(config.enabled).toBe(true);
  });

  it("stays disabled when enabled is 0", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "0";
    const config = getHostedGroomerConfig();
    expect(config.enabled).toBe(false);
  });

  it("stays disabled when enabled is false", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "false";
    const config = getHostedGroomerConfig();
    expect(config.enabled).toBe(false);
  });

  it("stays disabled when enabled is empty string", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "";
    const config = getHostedGroomerConfig();
    expect(config.enabled).toBe(false);
  });

  it("reads dryRun=false when explicitly set", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    process.env.DISPATCH_GROOMER_DRY_RUN = "false";
    const config = getHostedGroomerConfig();
    expect(config.dryRun).toBe(false);
  });

  it("reads dryRun=true when explicitly set", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    process.env.DISPATCH_GROOMER_DRY_RUN = "true";
    const config = getHostedGroomerConfig();
    expect(config.dryRun).toBe(true);
  });

  it("reads llmBaseUrl from env", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://custom.llm/api";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    const config = getHostedGroomerConfig();
    expect(config.llmBaseUrl).toBe("https://custom.llm/api");
  });

  it("reads apiKey from env", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "sk-custom-key-123";
    const config = getHostedGroomerConfig();
    expect(config.apiKey).toBe("sk-custom-key-123");
  });

  it("reads model from env", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    process.env.DISPATCH_GROOMER_MODEL = "gpt-4o-mini";
    const config = getHostedGroomerConfig();
    expect(config.model).toBe("gpt-4o-mini");
  });

  it("throws when enabled but missing model", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    expect(() => getHostedGroomerConfig()).toThrow(/model/i);
  });

  it("reads timeoutMs from env", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    process.env.DISPATCH_GROOMER_TIMEOUT_MS = "30000";
    const config = getHostedGroomerConfig();
    expect(config.timeoutMs).toBe(30000);
  });

  it("env override DISPATCH_GROOMER_TIMEOUT_MS wins over scaled default", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    process.env.DISPATCH_GROOMER_MAX_CONTEXT_BYTES = "16384";
    // Without override, 16KB would yield 140000. Override to 45000 should win.
    process.env.DISPATCH_GROOMER_TIMEOUT_MS = "45000";
    const config = getHostedGroomerConfig();
    expect(config.timeoutMs).toBe(45000);
  });

  it("scales default timeoutMs with maxContextBytes (8192 → 100000)", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    // default maxContextBytes = 8192 → ceil(8)*5000 + 60000 = 100000
    const config = getHostedGroomerConfig();
    expect(config.timeoutMs).toBe(100_000);
  });

  it("scales default timeoutMs with maxContextBytes (2048 → floor 60000)", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    process.env.DISPATCH_GROOMER_MAX_CONTEXT_BYTES = "2048";
    // ceil(2048/1024)*5000 + 60000 = 70000, above floor so no clamp needed
    const config = getHostedGroomerConfig();
    expect(config.timeoutMs).toBe(70_000);
  });

  it("scales default timeoutMs with maxContextBytes (16384 → 140000)", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    process.env.DISPATCH_GROOMER_MAX_CONTEXT_BYTES = "16384";
    // ceil(16)*5000 + 60000 = 140000
    const config = getHostedGroomerConfig();
    expect(config.timeoutMs).toBe(140_000);
  });

  it("clamps default timeoutMs to 300000 ceiling at large maxContextBytes", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    process.env.DISPATCH_GROOMER_MAX_CONTEXT_BYTES = "65536";
    // ceil(64)*5000 + 60000 = 380000 → clamped to 300000
    const config = getHostedGroomerConfig();
    expect(config.timeoutMs).toBe(300_000);
  });

  it("reads maxContextBytes from env", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    process.env.DISPATCH_GROOMER_MAX_CONTEXT_BYTES = "4096";
    const config = getHostedGroomerConfig();
    expect(config.maxContextBytes).toBe(4096);
  });

  it("defaults maxContextBytes to 8192 when not set", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    const config = getHostedGroomerConfig();
    expect(config.maxContextBytes).toBe(8192);
  });

  it("throws when enabled but missing baseUrl", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    expect(() => getHostedGroomerConfig()).toThrow(/base.?url/i);
  });

  it("throws when enabled but missing apiKey", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    expect(() => getHostedGroomerConfig()).toThrow(/api.?key/i);
  });

  it("is disabled when baseUrl or apiKey is missing (no throw)", () => {
    const config = getHostedGroomerConfig();
    expect(config.enabled).toBe(false);
  });

  it("defaults repository context and cooldown settings safely", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    const config = getHostedGroomerConfig();
    expect(config.repoContextEnabled).toBe(false);
    expect(config.maxContextFiles).toBe(5);
    expect(config.maxSearches).toBe(3);
    expect(config.maxFileBytes).toBe(4096);
    expect(config.commentCooldownHours).toBe(24);
    expect(config.groomerToken).toBeNull();
  });

  it("reads repository context and scheduler token settings", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    process.env.DISPATCH_GROOMER_REPO_CONTEXT_ENABLED = "true";
    process.env.DISPATCH_GROOMER_MAX_CONTEXT_FILES = "2";
    process.env.DISPATCH_GROOMER_MAX_SEARCHES = "1";
    process.env.DISPATCH_GROOMER_MAX_FILE_BYTES = "1024";
    process.env.DISPATCH_GROOMER_COMMENT_COOLDOWN_HOURS = "6";
    process.env.DISPATCH_GROOMER_TOKEN = "scheduled-token";
    const config = getHostedGroomerConfig();
    expect(config.repoContextEnabled).toBe(true);
    expect(config.maxContextFiles).toBe(2);
    expect(config.maxSearches).toBe(1);
    expect(config.maxFileBytes).toBe(1024);
    expect(config.commentCooldownHours).toBe(6);
    expect(config.groomerToken).toBe("scheduled-token");
  });
});
