/**
 * @vitest-environment node
 */
import { createPublicKey, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetGitHubAppState } from "./github";

process.env.GITHUB_TOKEN = "test-token-for-github-app-tests";

vi.mock("./github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github")>();
  return { ...actual };
});

// Generate a reusable RSA key pair once (module load). GitHub issues App keys
// as PKCS1 ("BEGIN RSA PRIVATE KEY"); PKCS8 ("BEGIN PRIVATE KEY") must keep
// working too. Unlike the old fixture, these are labeled with their true type.
let testKeys:
  | { pkcs1: string; pkcs8: string; escapedPkcs1: string; escapedPkcs8: string; spkiPem: string }
  | undefined;
async function getTestKeys() {
  if (testKeys) return testKeys;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  testKeys = {
    pkcs1,
    pkcs8,
    escapedPkcs1: pkcs1.replace(/\n/g, "\\n"),
    escapedPkcs8: pkcs8.replace(/\n/g, "\\n"),
    spkiPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  return testKeys;
}

/** Assert a "Bearer <jwt>" header carries a valid RS256 signature. */
function expectValidJwt(authHeader: string, spkiPem: string) {
  expect(authHeader).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  const jwt = authHeader.slice("Bearer ".length);
  const [header, payload, signature] = jwt.split(".");
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toMatchObject({
    alg: "RS256",
    typ: "JWT",
  });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  expect(claims.iss).toBe(process.env.GITHUB_APP_ID);
  expect(claims.exp).toBeGreaterThan(claims.iat);
  const signed = cryptoVerify(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    createPublicKey(spkiPem),
    Buffer.from(signature, "base64url")
  );
  expect(signed).toBe(true);
}

function tokenResponse(token: string, ttlSeconds = 3600) {
  const now = Math.floor(Date.now() / 1000);
  return {
    ok: true,
    json: () =>
      Promise.resolve({ token, expires_at: new Date((now + ttlSeconds) * 1000).toISOString() }),
    headers: new Headers(),
  } as Response;
}

describe("GitHub App authentication", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Pre-generate key before resetting module state
    await getTestKeys();
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
    const { pkcs8 } = await getTestKeys();
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "789012";
    process.env.GITHUB_APP_PRIVATE_KEY = pkcs8;

    fetchMock.mockRejectedValueOnce(new Error("network error"));

    const { getGitHubToken } = await import("./github");
    const token = await getGitHubToken();
    expect(token).toBe("pat-token");
  });

  it("does not log secrets or tokens on failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { pkcs8 } = await getTestKeys();
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "789012";
    process.env.GITHUB_APP_PRIVATE_KEY = pkcs8;

    fetchMock.mockRejectedValueOnce(new Error("auth failed"));

    const { getGitHubToken } = await import("./github");
    await getGitHubToken();

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("returns installation token when GitHub App is configured and fetch succeeds", async () => {
    const { pkcs8, spkiPem } = await getTestKeys();
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "789012";
    process.env.GITHUB_APP_PRIVATE_KEY = pkcs8;

    fetchMock.mockResolvedValueOnce(tokenResponse("app-token-abc"));

    const { getGitHubToken } = await import("./github");
    const token = await getGitHubToken();
    expect(token).toBe("app-token-abc");

    // The App JWT must be awaited before being sent — a missing await would
    // produce "Bearer [object Promise]" and GitHub would reject with 401.
    const authHeader = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expectValidJwt(authHeader.Authorization, spkiPem);
  });

  it("mints a valid JWT from a PKCS1 (BEGIN RSA PRIVATE KEY) key", async () => {
    const { pkcs1, spkiPem } = await getTestKeys();
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "789012";
    process.env.GITHUB_APP_PRIVATE_KEY = pkcs1;

    fetchMock.mockResolvedValueOnce(tokenResponse("pkcs1-token"));

    const { getGitHubToken } = await import("./github");
    const token = await getGitHubToken();
    expect(token).toBe("pkcs1-token");

    const authHeader = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expectValidJwt(authHeader.Authorization, spkiPem);
  });

  it("supports escaped newlines in PKCS1 keys", async () => {
    const { escapedPkcs1, spkiPem } = await getTestKeys();
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "789012";
    process.env.GITHUB_APP_PRIVATE_KEY = escapedPkcs1;

    fetchMock.mockResolvedValueOnce(tokenResponse("escaped-pkcs1-token"));

    const { getGitHubToken } = await import("./github");
    const token = await getGitHubToken();
    expect(token).toBe("escaped-pkcs1-token");

    const authHeader = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expectValidJwt(authHeader.Authorization, spkiPem);
  });

  it("caches token and reuses on second call without refetching", async () => {
    const { pkcs8 } = await getTestKeys();
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "789012";
    process.env.GITHUB_APP_PRIVATE_KEY = pkcs8;

    fetchMock.mockResolvedValueOnce(tokenResponse("cached-token"));

    const { getGitHubToken } = await import("./github");
    const t1 = await getGitHubToken();
    const t2 = await getGitHubToken();
    expect(t1).toBe("cached-token");
    expect(t2).toBe("cached-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses expires_at from GitHub response for cache TTL", async () => {
    const { pkcs8 } = await getTestKeys();
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "789012";
    process.env.GITHUB_APP_PRIVATE_KEY = pkcs8;

    fetchMock.mockResolvedValueOnce(tokenResponse("short-lived", 600)); // 10 min

    const { getGitHubToken } = await import("./github");
    const token = await getGitHubToken();
    expect(token).toBe("short-lived");
  });

  it("supports escaped newline private key format", async () => {
    const { escapedPkcs8, spkiPem } = await getTestKeys();
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "789012";
    process.env.GITHUB_APP_PRIVATE_KEY = escapedPkcs8;

    fetchMock.mockResolvedValueOnce(tokenResponse("escaped-key-token"));

    const { getGitHubToken } = await import("./github");
    const token = await getGitHubToken();
    expect(token).toBe("escaped-key-token");

    const authHeader = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expectValidJwt(authHeader.Authorization, spkiPem);
  });

  it("reports App auth failure (not missing GITHUB_TOKEN) when init fails with no PAT", async () => {
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "789012";
    process.env.GITHUB_APP_PRIVATE_KEY = "definitely-not-a-private-key";
    delete process.env.GITHUB_TOKEN;
    __resetGitHubAppState?.();

    const { getGitHubToken } = await import("./github");
    await expect(getGitHubToken()).rejects.toThrow(/GitHub App authentication is configured but failed/);
    await expect(getGitHubToken()).rejects.not.toThrow("GITHUB_TOKEN environment variable is not set");
  });

  it("error on unparsable key never contains key material", async () => {
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "789012";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nbm90LWEta2V5\n-----END RSA PRIVATE KEY-----";
    delete process.env.GITHUB_TOKEN;
    __resetGitHubAppState?.();

    const { getGitHubToken } = await import("./github");
    const error = await getGitHubToken().catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("PRIVATE KEY");
    expect((error as Error).message).not.toContain("bm90LWEta2V5");
  });
});
