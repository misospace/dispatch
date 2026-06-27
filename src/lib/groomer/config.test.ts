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

  it("defaults model to gpt-4o-mini when not set", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    const config = getHostedGroomerConfig();
    expect(config.model).toBe("gpt-4o-mini");
  });

  it("reads timeoutMs from env", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    process.env.DISPATCH_GROOMER_TIMEOUT_MS = "30000";
    const config = getHostedGroomerConfig();
    expect(config.timeoutMs).toBe(30000);
  });

  it("defaults timeoutMs to 60000 when not set", () => {
    process.env.DISPATCH_HOSTED_GROOMER_ENABLED = "true";
    process.env.DISPATCH_LLM_BASE_URL = "https://llm.example.com";
    process.env.DISPATCH_LLM_API_KEY = "test-key";
    const config = getHostedGroomerConfig();
    expect(config.timeoutMs).toBe(60000);
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
});
