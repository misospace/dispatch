/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetGitHubAppState } from "./github";

process.env.GITHUB_TOKEN = "test-token-for-github-app-tests";

vi.mock("./github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github")>();
  return { ...actual };
});

// Generate a reusable RSA key pair for tests (done once at module load)
let testKeyPair: { pem: string; escapedPem: string } | undefined;
async function getTestKeyPair() {
  if (testKeyPair) return testKeyPair;
  const { privateKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  const base64 = Buffer.from(pkcs8).toString("base64");
  const pemLines = [
    "-----BEGIN RSA PRIVATE KEY-----",
    ...base64.match(/.{1,64}/g)!,
    "-----END RSA PRIVATE KEY-----",
  ];
  testKeyPair = {
    pem: pemLines.join("\n"),
    escapedPem: pemLines.join("\\n"),
  };
  return testKeyPair;
}

describe("GitHub App authentication", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Pre-generate key before resetting module state
    await getTestKeyPair();
    // Reset github module internal state (no need for full module reset)
    __resetGitHubAppState?.();
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_INSTALLATION_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    process.env.GITHUB_TOKEN = "pat-token";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("falls back to PAT when GitHub App env vars are absent", async () => {
    const { getGitHubToken } = await import("./github");
    const token = await getGitHubToken();
    expect(token).toBe("pat-token");
  });

  it("throws when GITHUB_TOKEN is missing and GitHub App is not configured", async () => {
    delete process.env.GITHUB_TOKEN;
    __resetGitHubAppState?.();

    const { getGitHubToken } = await import("./github");
    await expect(getGitHubToken()).rejects.toThrow("GITHUB_TOKEN environment variable is not set");
  });

  it("falls back to PAT when GitHub App token fetch fails", async () => {
    const { pem } = await getTestKeyPair();
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "789012";
    process.env.GITHUB_APP_PRIVATE_KEY = pem;

    fetchMock.mockRejectedValueOnce(new Error("network error"));

    const { getGitHubToken } = await import("./github");
    const token = await getGitHubToken();
    expect(token).toBe("pat-token");
  });

  it("does not log secrets or tokens on failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { pem } = await getTestKeyPair();
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "789012";
    process.env.GITHUB_APP_PRIVATE_KEY = pem;

    fetchMock.mockRejectedValueOnce(new Error("auth failed"));

    const { getGitHubToken } = await import("./github");
    await getGitHubToken();

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("returns installation token when GitHub App is configured and fetch succeeds", async () => {
    const { pem } = await getTestKeyPair();
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "789012";
    process.env.GITHUB_APP_PRIVATE_KEY = pem;

    const now = Math.floor(Date.now() / 1000);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ token: "app-token-abc", expires_at: new Date((now + 3600) * 1000).toISOString() }),
      headers: new Headers(),
    } as Response);

    const { getGitHubToken } = await import("./github");
    const token = await getGitHubToken();
    expect(token).toBe("app-token-abc");

    // The App JWT must be awaited before being sent — a missing await would
    // produce "Bearer [object Promise]" and GitHub would reject with 401.
    const authHeader = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(authHeader.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("caches token and reuses on second call without refetching", async () => {
    const { pem } = await getTestKeyPair();
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "789012";
    process.env.GITHUB_APP_PRIVATE_KEY = pem;

    const now = Math.floor(Date.now() / 1000);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ token: "cached-token", expires_at: new Date((now + 3600) * 1000).toISOString() }),
      headers: new Headers(),
    } as Response);

    const { getGitHubToken } = await import("./github");
    const t1 = await getGitHubToken();
    const t2 = await getGitHubToken();
    expect(t1).toBe("cached-token");
    expect(t2).toBe("cached-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses expires_at from GitHub response for cache TTL", async () => {
    const { pem } = await getTestKeyPair();
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "789012";
    process.env.GITHUB_APP_PRIVATE_KEY = pem;

    const now = Math.floor(Date.now() / 1000);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ token: "short-lived", expires_at: new Date((now + 600) * 1000).toISOString() }), // 10 min
      headers: new Headers(),
    } as Response);

    const { getGitHubToken } = await import("./github");
    const token = await getGitHubToken();
    expect(token).toBe("short-lived");
  });

  it("supports escaped newline private key format", async () => {
    const { escapedPem } = await getTestKeyPair();
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "789012";
    process.env.GITHUB_APP_PRIVATE_KEY = escapedPem;

    const now = Math.floor(Date.now() / 1000);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ token: "escaped-key-token", expires_at: new Date((now + 3600) * 1000).toISOString() }),
      headers: new Headers(),
    } as Response);

    const { getGitHubToken } = await import("./github");
    const token = await getGitHubToken();
    expect(token).toBe("escaped-key-token");
  });
});
