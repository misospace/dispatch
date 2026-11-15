// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetGitHubAppState } from "./github-auth";
import { fetchPullRequestReviews } from "./github-prs";

// Bearer auth for getHeadersAsync(): token-mode (no GitHub App), so ensureInit()
// is a no-op and the only thing the test has to provide is GITHUB_TOKEN.
process.env.GITHUB_TOKEN = "test-token-for-review-tests";

// We exercise the real getHeadersAsync()/fetchWithRetry() from github-auth and
// only stub the global fetch() they call underneath (same pattern as
// github-prs-review-threads.test.ts).
const fetchMock = vi.fn();

interface MinimalResponseInit {
  status: number;
  value: unknown;
  link?: string | null;
}

function jsonResponse({ status, value, link }: MinimalResponseInit) {
  const headers = new Map<string, string>();
  if (link) headers.set("link", link);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    json: async () => value,
  } as unknown as Response;
}

function review(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user: { login: `reviewer-${id}` },
    state: "CHANGES_REQUESTED",
    submitted_at: new Date(Date.UTC(2026, 0, 1) + id * 1000).toISOString(),
    commit_id: "a".repeat(40),
    body: `feedback ${id}`,
    ...overrides,
  };
}

describe("fetchPullRequestReviews", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  beforeEach(() => {
    __resetGitHubAppState();
    process.env.GITHUB_TOKEN = "test-token-for-review-tests";
    fetchMock.mockReset();
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("projects each review's fields", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ status: 200, value: [review(1, { state: "APPROVED", user: { login: "a" } })] }),
    );

    const reviews = await fetchPullRequestReviews("org/repo", 42);

    expect(reviews).toEqual([
      {
        id: 1,
        user: "a",
        state: "APPROVED",
        submittedAt: review(1).submitted_at,
        commitId: "a".repeat(40),
        body: "feedback 1",
      },
    ]);
  });

  it("paginates past the first page so the NEWEST reviews are not truncated (regression: the 100-record cap dropped the latest reviews, oldest-first ordering)", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => review(i + 1));
    const latest = review(101, {
      submitted_at: new Date(Date.UTC(2026, 0, 2)).toISOString(),
      body: "the blocking review on the current head",
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("page=1")) {
        return jsonResponse({
          status: 200,
          value: firstPage,
          link: `<${url.replace("page=1", "page=2")}>; rel="next"`,
        });
      }
      return jsonResponse({ status: 200, value: [latest], link: null });
    });

    const reviews = await fetchPullRequestReviews("org/repo", 42);

    // All 101 reviews are present — the first page is not the whole story and
    // the final (newest) review is not dropped.
    expect(reviews).toHaveLength(101);
    expect(reviews![0]!.id).toBe(1);
    expect(reviews![100]!.id).toBe(101);
    expect(reviews![100]!.body).toBe("the blocking review on the current head");
    // Two requests: the first page and the page its Link header pointed at.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null on a non-2xx response", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ status: 500, value: null }));

    const reviews = await fetchPullRequestReviews("org/repo", 42);

    expect(reviews).toBeNull();
  });

  it("returns null when fetch rejects (network failure)", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("network is down");
    });

    const reviews = await fetchPullRequestReviews("org/repo", 42);

    expect(reviews).toBeNull();
  });
});
