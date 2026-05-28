/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.GITHUB_TOKEN = "test-token-for-github-app-tests";

vi.mock("./github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github")>();
  return { ...actual };
});

describe("GitHub App authentication", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
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

    vi.resetModules();
    const { getGitHubToken } = await import("./github");
    await expect(getGitHubToken()).rejects.toThrow("GITHUB_TOKEN environment variable is not set");
  });

  it("falls back to PAT when GitHub App token fetch fails", async () => {
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "789012";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\ntestkey\n-----END RSA PRIVATE KEY-----";

    fetchMock.mockRejectedValueOnce(new Error("network error"));

    vi.resetModules();
    const { getGitHubToken } = await import("./github");
    const token = await getGitHubToken();
    expect(token).toBe("pat-token");
  });

  it("does not log secrets or tokens on failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "789012";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nsecretkey\n-----END RSA PRIVATE KEY-----";

    fetchMock.mockRejectedValueOnce(new Error("auth failed"));

    vi.resetModules();
    const { getGitHubToken } = await import("./github");
    await getGitHubToken();

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
