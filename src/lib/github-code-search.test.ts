// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  fetchRepo,
  fetchRepositoryFileText,
  fetchRepositoryMetadata,
  listRepositoryDirectory,
  searchRepositoryCode,
} from "./github-code-search";

// GITHUB_TOKEN is read by getHeadersAsync (github-auth) on every request; the
// GitHub App env vars stay unset so the PAT path is exercised.
process.env.GITHUB_TOKEN = "test-token-for-code-search-tests";

/** Build a mock Response. `ok` is derived from `status`; `headers` supports the
 *  `Link: rel="next"` and `Retry-After` shapes that fetchWithRetry /
 *  fetchPaginated read. */
function mockResponse(
  data: unknown,
  {
    status = 200,
    headers = {},
  }: {
    status?: number;
    headers?: Record<string, string>;
  } = {},
): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(typeof data === "string" ? data : JSON.stringify(data)),
    headers: new Headers(headers),
  } as Response;
}

/** A 200 whose body is not parseable JSON (e.g. an HTML error page): the
 *  `json()` promise rejects, which is how a malformed body surfaces. */
function malformedJsonResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON at position 0")),
    text: () => Promise.resolve("<html><body>502 Bad Gateway</body></html>"),
    headers: new Headers({ "Content-Type": "text/html" }),
  } as Response;
}

/** The code-search items the client maps out of `data.items`. */
function searchItems(paths: string[]): { path: string; html_url: string }[] {
  return paths.map((path) => ({
    path,
    html_url: `https://github.com/org/repo/blob/main/${path}`,
  }));
}

describe("github-code-search: searchRepositoryCode (the groomer repo-exploration fetcher)", () => {
  let fetchSpy: Mock<typeof globalThis.fetch>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  // (a) Successful query, one page of results.
  it("returns the mapped results from a single page", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ total_count: 2, incomplete_results: false, items: searchItems(["src/a.ts", "src/b.ts"]) }),
    );

    const result = await searchRepositoryCode("org/repo", "prisma", 10);

    expect(result).toEqual([
      { path: "src/a.ts", url: "https://github.com/org/repo/blob/main/src/a.ts" },
      { path: "src/b.ts", url: "https://github.com/org/repo/blob/main/src/b.ts" },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The query is the user term plus the `repo:` scoping clause, URL-encoded.
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.searchParams.get("q")).toBe("prisma repo:org/repo");
  });

  it("returns an empty array when the search matches nothing", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ total_count: 0, incomplete_results: false, items: [] }));

    await expect(searchRepositoryCode("org/repo", "nothing-here", 10)).resolves.toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array when `items` is missing from the payload", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ total_count: 0, incomplete_results: false }));

    await expect(searchRepositoryCode("org/repo", "q", 5)).resolves.toEqual([]);
  });

  // (b) Multi-page aggregation until the final page (no `rel="next"` left).
  it("aggregates results across Link-header pages until the final page", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        mockResponse({ total_count: 5, incomplete_results: false, items: searchItems(["a.ts", "b.ts", "c.ts"]) }, {
          headers: { Link: '<https://api.github.com/search/code?page=2>; rel="next"' },
        }),
      )
      .mockResolvedValueOnce(
        mockResponse({ total_count: 5, incomplete_results: false, items: searchItems(["d.ts", "e.ts"]) }),
      );

    const result = await searchRepositoryCode("org/repo", "prisma", 100);

    expect(result.map((r) => r.path)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // The second request follows the Link header's next page.
    expect(String(fetchSpy.mock.calls[1]![0])).toContain("page=2");
  });

  it("stops paginating once the requested limit is reached", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        mockResponse({ total_count: 10, incomplete_results: true, items: searchItems(["a.ts", "b.ts"]) }, {
          headers: { Link: '<https://api.github.com/search/code?page=2>; rel="next"' },
        }),
      )
      .mockResolvedValueOnce(mockResponse({ total_count: 10, incomplete_results: true, items: searchItems(["c.ts"]) }));

    const result = await searchRepositoryCode("org/repo", "prisma", 2);

    expect(result.map((r) => r.path)).toEqual(["a.ts", "b.ts"]);
    // Limit hit on the first page -> the next page is never fetched.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // (c) HTTP 429 retried with backoff.
  it("retries a 429 rate-limit response with backoff and succeeds on the next attempt", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        mockResponse({ message: "API rate limit exceeded" }, { status: 429, headers: { "Retry-After": "1" } }),
      )
      .mockResolvedValueOnce(mockResponse({ total_count: 1, incomplete_results: false, items: searchItems(["ok.ts"]) }));

    const promise = searchRepositoryCode("org/repo", "prisma", 10);
    // Base backoff (1s) and Retry-After (1s) coincide -> advance the clock past it.
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toEqual([
      { path: "ok.ts", url: "https://github.com/org/repo/blob/main/ok.ts" },
    ]);
    // One 429 attempt + one successful retry.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // (d) HTTP 5xx retried with backoff.
  it("retries a transient 503 and succeeds on the second attempt", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ message: "server error" }, { status: 503 }))
      .mockResolvedValueOnce(mockResponse({ total_count: 1, incomplete_results: false, items: searchItems(["ok.ts"]) }));

    const promise = searchRepositoryCode("org/repo", "prisma", 10);
    // 503 has no Retry-After -> exponential base of 1s on the first retry.
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toEqual([
      { path: "ok.ts", url: "https://github.com/org/repo/blob/main/ok.ts" },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // (e) Non-2xx final response (non-retryable) surfaces a clear, prefixed error.
  it("surfaces a clear 'Code search failed' error for a non-retryable non-2xx final response", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ message: "Validation Failed: search term not supported" }, { status: 422 }),
    );

    // fetchPaginated prefixes non-ok responses with its own "GitHub API error:
    // <status>" line, and the code-search client re-wraps it with its own.
    await expect(searchRepositoryCode("org/repo", "prisma", 10)).rejects.toThrow(
      "Code search failed for org/repo: GitHub API error: 422",
    );
    // 422 is not retryable -> a single attempt, no backoff.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces a clear 'Code search failed' error when the body is not valid JSON", async () => {
    fetchSpy.mockResolvedValueOnce(malformedJsonResponse());

    await expect(searchRepositoryCode("org/repo", "prisma", 10)).rejects.toThrow(
      "Code search failed for org/repo",
    );
  });
});

describe("github-code-search: repository metadata and contents fetchers", () => {
  let fetchSpy: Mock<typeof globalThis.fetch>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  it("fetchRepositoryMetadata maps the raw repo JSON into the normalized shape", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ full_name: "org/repo", default_branch: "main", description: "A repo" }),
    );

    await expect(fetchRepositoryMetadata("org/repo")).resolves.toEqual({
      fullName: "org/repo",
      defaultBranch: "main",
      description: "A repo",
    });
  });

  it("fetchRepositoryMetadata falls back to defaults when fields are missing", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ full_name: "org/repo" }));

    await expect(fetchRepositoryMetadata("org/repo")).resolves.toEqual({
      fullName: "org/repo",
      defaultBranch: "main",
      description: null,
    });
  });

  it("fetchRepo returns the raw repo object and throws on 404", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ full_name: "org/repo", name: "repo", owner: { login: "org" } }))
      .mockResolvedValueOnce(mockResponse({ message: "Not Found" }, { status: 404 }));

    const repo = await fetchRepo("org/repo");
    expect(repo.full_name).toBe("org/repo");

    await expect(fetchRepo("org/missing")).rejects.toThrow("Failed to fetch repo org/missing: 404");
  });

  it("fetchRepositoryFileText decodes base64 content and returns '' for a directory", async () => {
    const content = "const x = 1;\n";
    fetchSpy
      .mockResolvedValueOnce(
        mockResponse({ type: "file", content: Buffer.from(content).toString("base64"), path: "org/repo/src/index.ts" }),
      )
      .mockResolvedValueOnce(mockResponse({ type: "dir", path: "org/repo/src" }));

    await expect(fetchRepositoryFileText("org/repo", "src/index.ts")).resolves.toBe(content);
    await expect(fetchRepositoryFileText("org/repo", "src")).resolves.toBe("");
  });

  it("fetchRepositoryFileText throws on 404", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ message: "Not Found" }, { status: 404 }));

    await expect(fetchRepositoryFileText("org/repo", "missing.ts")).rejects.toThrow(
      "Failed to fetch file missing.ts in org/repo: 404",
    );
  });

  it("listRepositoryDirectory maps directory entries and returns [] for a file path", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        mockResponse([
          { path: "org/repo/src/a.ts", name: "a.ts", type: "file", size: 12 },
          { path: "org/repo/src/sub", name: "sub", type: "dir", size: null },
        ]),
      )
      .mockResolvedValueOnce(mockResponse({ type: "file", path: "org/repo/src/a.ts", size: 12 }));

    const dir = await listRepositoryDirectory("org/repo", "src");
    expect(dir).toEqual([
      { path: "org/repo/src/a.ts", name: "a.ts", type: "file", size: 12 },
      { path: "org/repo/src/sub", name: "sub", type: "dir", size: null },
    ]);
    // A file path is not a directory -> empty result, not an exception.
    await expect(listRepositoryDirectory("org/repo", "src/a.ts")).resolves.toEqual([]);
  });

  it("listRepositoryDirectory throws with a summarized body on 404", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ message: "Not Found" }, { status: 404 }));

    await expect(listRepositoryDirectory("org/repo", "nope")).rejects.toThrow(
      "Failed to list directory nope in org/repo: 404",
    );
  });
});
