// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetGitHubAppState } from "./github-auth";
import { fetchPullRequestHeadRepo } from "./github-prs";

// Token-mode bearer auth so the real getHeadersAsync()/fetchWithRetry() run;
// only the underlying global fetch is stubbed (github-prs-review-threads
// pattern). #1638: this reader is the fork-eligibility proof for the enqueue
// gate and the reconcile drain, so its null-vs-value mapping is pinned here.
process.env.GITHUB_TOKEN = "test-token-for-head-repo-tests";

const fetchMock = vi.fn();

function jsonResponse(status: number, value: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  } as unknown as Response;
}

describe("fetchPullRequestHeadRepo (#1638)", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  beforeEach(() => {
    __resetGitHubAppState();
    process.env.GITHUB_TOKEN = "test-token-for-head-repo-tests";
    fetchMock.mockReset();
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("returns head.repo.full_name on a well-formed PR detail", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { head: { repo: { full_name: "Contributor/Repo" } } }));

    await expect(fetchPullRequestHeadRepo("org/repo", 7)).resolves.toBe("Contributor/Repo");
  });

  it("returns null (unverifiable) on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { message: "Not Found" }));

    await expect(fetchPullRequestHeadRepo("org/repo", 7)).resolves.toBeNull();
  });

  it("returns null when the shape omits head.repo.full_name", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { head: { repo: null } }));

    await expect(fetchPullRequestHeadRepo("org/repo", 7)).resolves.toBeNull();
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await expect(fetchPullRequestHeadRepo("org/repo", 7)).resolves.toBeNull();
  });

  it("returns null when the fetch itself fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    await expect(fetchPullRequestHeadRepo("org/repo", 7)).resolves.toBeNull();
  });
});
