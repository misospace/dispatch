import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addIssueComment,
  addIssueLabel,
  closeIssue,
  fetchIssue,
  fetchIssueComments,
  fetchIssues,
  fetchLinkedPrHealthInput,
  fetchPaginated,
  fetchPullRequestCheckFailures,
  fetchPullRequestHealthSignals,
  fetchRepositoryMetadata,
  removeIssueLabel,
  searchRepositoryCode,
  fetchRepositoryFileText,
  syncStatusLabels,
  updateIssueLabels,
  updateIssueTitleAndBody,
  validateGitHubToken,
  type GithubPR,
} from "./github";

process.env.GITHUB_TOKEN = "test-token-for-pagination-tests";

vi.mock("./github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github")>();
  return { ...actual };
});

function makeResponse(data: unknown, hasNext = false): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (hasNext) {
    headers.Link = '<https://api.github.com/resource?page=2>; rel="next"';
  }
  return {
    ok: true,
    json: () => Promise.resolve(data),
    headers: new Headers(headers),
  } as Response;
}

describe("fetchPaginated", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("returns items from a single-page response", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse([{ id: 1 }, { id: 2 }]));

    const result = await fetchPaginated<{ id: number }>("https://example.com/api");

    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows Link headers across multiple pages", async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse([{ id: 1 }], true))
      .mockResolvedValueOnce(makeResponse([{ id: 2 }, { id: 3 }], true))
      .mockResolvedValueOnce(makeResponse([{ id: 4 }]));

    const result = await fetchPaginated<{ id: number }>("https://example.com/api");

    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("respects maxItems limit and stops fetching", async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse([{ id: 1 }, { id: 2 }, { id: 3 }], true))
      .mockResolvedValueOnce(makeResponse([{ id: 4 }, { id: 5 }]));

    const result = await fetchPaginated<{ id: number }>("https://example.com/api", 3);

    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    // Only 1 call because maxItems was reached on the first page
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("slices page data when near the maxItems boundary", async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse([{ id: 1 }, { id: 2 }], true))
      .mockResolvedValueOnce(makeResponse([{ id: 3 }, { id: 4 }, { id: 5 }]));

    const result = await fetchPaginated<{ id: number }>("https://example.com/api", 4);

    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    // 2 calls: first page has 2 items, second page would have 3 but only 2 are needed
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on non-OK response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: () => Promise.resolve("rate limited"),
    } as Response);

    await expect(fetchPaginated<{ id: number }>("https://example.com/api"))
      .rejects.toThrow("GitHub API error: 403");
  });

  it("returns empty array when no items returned", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse([]));

    const result = await fetchPaginated<{ id: number }>("https://example.com/api");

    expect(result).toEqual([]);
  });

  it("extracts items from wrapped GitHub responses", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ total_count: 2, workflow_runs: [{ id: 1 }, { id: 2 }] }));

    const result = await fetchPaginated<{ id: number }>(
      "https://example.com/api",
      Infinity,
      (data) => (data as { workflow_runs?: { id: number }[] }).workflow_runs ?? [],
    );

    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("throws a useful error when an unwrapped response is not an array", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ message: "not an array" }));

    await expect(fetchPaginated<{ id: number }>("https://example.com/api"))
      .rejects.toThrow("expected array response");
  });

  it("handles maxItems of 0", async () => {
    const result = await fetchPaginated<{ id: number }>("https://example.com/api", 0);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchRepositoryMetadata", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("returns repo metadata on success", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ full_name: "org/repo", default_branch: "main", description: "A repo" }),
    } as Response);

    const result = await fetchRepositoryMetadata("org/repo");

    expect(result).toEqual({
      fullName: "org/repo",
      defaultBranch: "main",
      description: "A repo",
    });
  });

  it("handles null description", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ full_name: "org/repo", default_branch: "develop", description: null }),
    } as Response);

    const result = await fetchRepositoryMetadata("org/repo");

    expect(result.description).toBeNull();
    expect(result.defaultBranch).toBe("develop");
  });

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not Found"),
    } as Response);

    await expect(fetchRepositoryMetadata("org/repo")).rejects.toThrow("Failed to fetch repo metadata");
  });
});

describe("searchRepositoryCode", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("returns search results with path and url", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        items: [
          { path: "src/a.ts", html_url: "https://github.com/org/repo/blob/main/src/a.ts" },
          { path: "src/b.ts", html_url: "https://github.com/org/repo/blob/main/src/b.ts" },
        ],
      }),
    } as Response);

    const result = await searchRepositoryCode("org/repo", "test", 10);

    expect(result).toEqual([
      { path: "src/a.ts", url: "https://github.com/org/repo/blob/main/src/a.ts" },
      { path: "src/b.ts", url: "https://github.com/org/repo/blob/main/src/b.ts" },
    ]);
  });

  it("encodes the full search query string correctly", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ items: [] }),
    } as Response);

    await searchRepositoryCode("org/repo", "fix auth", 10);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    const url = new URL(calledUrl);
    expect(url.searchParams.get("q")).toBe("fix auth repo:org/repo");
  });

  it("respects the limit parameter", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        items: [
          { path: "a.ts", html_url: "1" },
          { path: "b.ts", html_url: "2" },
          { path: "c.ts", html_url: "3" },
        ],
      }),
    } as Response);

    const result = await searchRepositoryCode("org/repo", "test", 2);

    expect(result.length).toBe(2);
  });

  it("returns empty array when no items", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ items: [] }),
    } as Response);

    const result = await searchRepositoryCode("org/repo", "test", 10);

    expect(result).toEqual([]);
  });

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: () => Promise.resolve("Validation failed"),
    } as Response);

    await expect(searchRepositoryCode("org/repo", "test", 10)).rejects.toThrow("Code search failed");
  });
});

describe("fetchRepositoryFileText", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("returns decoded file content", async () => {
    const content = "const x = 1;";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ content: Buffer.from(content).toString("base64"), type: "file" }),
    } as Response);

    const result = await fetchRepositoryFileText("org/repo", "src/index.ts");

    expect(result).toBe(content);
  });

  it("encodes each path segment separately", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ content: Buffer.from("ok").toString("base64"), type: "file" }),
    } as Response);

    await fetchRepositoryFileText("org/repo", "src/my file.ts");

    const calledUrl = (fetchMock.mock.calls[0][0] as string);
    expect(calledUrl).toContain("my%20file.ts");
  });

  it("includes ref query param when provided", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ content: Buffer.from("ok").toString("base64"), type: "file" }),
    } as Response);

    await fetchRepositoryFileText("org/repo", "src/index.ts", "feature-branch");

    const calledUrl = (fetchMock.mock.calls[0][0] as string);
    expect(calledUrl).toContain("?ref=feature-branch");
  });

  it("returns empty string for directory response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ type: "dir" }),
    } as Response);

    const result = await fetchRepositoryFileText("org/repo", "src");

    expect(result).toBe("");
  });

  it("returns empty string when content is missing", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ type: "file", content: null }),
    } as Response);

    const result = await fetchRepositoryFileText("org/repo", "src/index.ts");

    expect(result).toBe("");
  });

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not Found"),
    } as Response);

    await expect(fetchRepositoryFileText("org/repo", "missing.ts")).rejects.toThrow("Failed to fetch file missing.ts");
  });
});

describe("addIssueComment", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("returns the comment url from the response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ html_url: "https://github.com/org/repo/issues/1#issuecomment-999" }),
    } as Response);

    const result = await addIssueComment("org/repo", 1, "test comment");

    expect(result).toEqual({ url: "https://github.com/org/repo/issues/1#issuecomment-999" });
  });

  it("returns null url when html_url is missing", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    } as Response);

    const result = await addIssueComment("org/repo", 1, "test comment");

    expect(result).toEqual({ url: null });
  });

  it("returns null url when json parse fails", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.reject(new Error("parse error")),
    } as Response);

    const result = await addIssueComment("org/repo", 1, "test comment");

    expect(result).toEqual({ url: null });
  });

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: () => Promise.resolve("rate limited"),
    } as Response);

    await expect(addIssueComment("org/repo", 1, "test")).rejects.toThrow("GitHub API error adding comment");
  });
});

// Shorthand for a JSON-body OK response (fetchPaginated is not involved).
function ok(data: unknown): Response {
  return { ok: true, json: () => Promise.resolve(data) } as Response;
}

function httpError(status: number, text = "boom"): Response {
  return { ok: false, status, text: () => Promise.resolve(text) } as Response;
}

describe("fetchIssues", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("filters out pull requests (GitHub returns PRs on the issues endpoint)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse([
        { number: 1, title: "a real issue" },
        { number: 2, title: "a PR", pull_request: { url: "https://api.github.com/pulls/2" } },
        { number: 3, title: "another issue" },
      ]),
    );

    const result = await fetchIssues("org/repo");

    expect(result.map((i) => i.number)).toEqual([1, 3]);
  });

  it("requests state=open by default and state=all when includeClosed", async () => {
    fetchMock.mockResolvedValue(makeResponse([]));

    await fetchIssues("org/repo");
    expect(fetchMock.mock.calls[0][0]).toContain("state=open");

    await fetchIssues("org/repo", { includeClosed: true });
    expect(fetchMock.mock.calls[1][0]).toContain("state=all");
  });
});

describe("fetchIssue", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("returns the issue on success", async () => {
    fetchMock.mockResolvedValueOnce(ok({ number: 42, title: "hello" }));

    const result = await fetchIssue("org/repo", 42);

    expect(result).toMatchObject({ number: 42, title: "hello" });
  });

  it("throws when the number is a pull request", async () => {
    fetchMock.mockResolvedValueOnce(ok({ number: 42, pull_request: { url: "x" } }));

    await expect(fetchIssue("org/repo", 42)).rejects.toThrow("#42 is a pull request, not an issue");
  });

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(httpError(404, "Not Found"));

    await expect(fetchIssue("org/repo", 42)).rejects.toThrow("GitHub API error for org/repo#42: 404");
  });
});

describe("fetchIssueComments", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("clamps per_page into [1, 100]", async () => {
    fetchMock.mockResolvedValue(ok([]));

    await fetchIssueComments("org/repo", 1, 500);
    expect(fetchMock.mock.calls[0][0]).toContain("per_page=100");
  });

  it("slices the response down to maxComments", async () => {
    const comments = Array.from({ length: 10 }, (_, i) => ({ body: `c${i}` }));
    fetchMock.mockResolvedValueOnce(ok(comments));

    const result = await fetchIssueComments("org/repo", 1, 3);

    expect(result).toHaveLength(3);
  });

  it("throws when the payload is not an array", async () => {
    fetchMock.mockResolvedValueOnce(ok({ message: "nope" }));

    await expect(fetchIssueComments("org/repo", 1)).rejects.toThrow("expected comments array");
  });

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(httpError(500));

    await expect(fetchIssueComments("org/repo", 1)).rejects.toThrow("comments: 500");
  });
});

describe("issue mutations", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("updateIssueLabels PUTs the full label set", async () => {
    fetchMock.mockResolvedValueOnce(ok({}));

    await updateIssueLabels("org/repo", 5, ["status/done", "type/bug"]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/repos/org/repo/issues/5/labels");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ labels: ["status/done", "type/bug"] });
  });

  it("addIssueLabel POSTs a single-label array", async () => {
    fetchMock.mockResolvedValueOnce(ok({}));

    await addIssueLabel("org/repo", 5, "status/done");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ labels: ["status/done"] });
  });

  it("updateIssueTitleAndBody PATCHes only the provided fields", async () => {
    fetchMock.mockResolvedValueOnce(ok({}));

    await updateIssueTitleAndBody("org/repo", 5, { title: "new title" });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ title: "new title" });
  });

  it("closeIssue PATCHes state=closed", async () => {
    fetchMock.mockResolvedValueOnce(ok({}));

    await closeIssue("org/repo", 5);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ state: "closed" });
  });

  it("removeIssueLabel DELETEs the url-encoded label", async () => {
    fetchMock.mockResolvedValueOnce(ok({}));

    await removeIssueLabel("org/repo", 5, "status/in progress");

    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect(url).toContain("/labels/status%2Fin%20progress");
  });

  it("removeIssueLabel tolerates a 404 (label already absent)", async () => {
    fetchMock.mockResolvedValueOnce(httpError(404, "Label does not exist"));

    await expect(removeIssueLabel("org/repo", 5, "gone")).resolves.toBeUndefined();
  });

  it("removeIssueLabel still throws on non-404 errors", async () => {
    fetchMock.mockResolvedValueOnce(httpError(500));

    await expect(removeIssueLabel("org/repo", 5, "x")).rejects.toThrow("GitHub API error: 500");
  });
});

describe("syncStatusLabels", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("removes then adds, in that order", async () => {
    fetchMock.mockResolvedValue(ok({}));

    await syncStatusLabels("org/repo", 5, ["status/done"], ["status/backlog", "status/in-progress"]);

    const methods = fetchMock.mock.calls.map((c) => c[1].method);
    // Two DELETEs (removes) precede the single POST (add).
    expect(methods).toEqual(["DELETE", "DELETE", "POST"]);
  });

  it("is a no-op when both lists are empty", async () => {
    await syncStatusLabels("org/repo", 5, [], []);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("validateGitHubToken", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("returns true when /user responds ok", async () => {
    fetchMock.mockResolvedValueOnce(ok({ login: "me" }));
    expect(await validateGitHubToken()).toBe(true);
  });

  it("returns false when /user is not ok", async () => {
    fetchMock.mockResolvedValueOnce(httpError(401, "Bad credentials"));
    expect(await validateGitHubToken()).toBe(false);
  });

  it("returns false when the request throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect(await validateGitHubToken()).toBe(false);
  });
});

describe("fetchPullRequestHealthSignals", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  // Call order: [0] PR detail GET, [1] reviews (via fetchPaginated).
  function mockDetailThenReviews(detail: Response, reviews: unknown[]) {
    fetchMock.mockResolvedValueOnce(detail).mockResolvedValueOnce(makeResponse(reviews));
  }

  it("returns merge state and the derived review decision", async () => {
    mockDetailThenReviews(ok({ mergeable_state: "clean" }), [
      { user: { login: "alice" }, state: "APPROVED", submitted_at: "2026-01-01T00:00:00Z" },
    ]);

    expect(await fetchPullRequestHealthSignals("org/repo", 7)).toEqual({
      reviewDecision: "APPROVED",
      mergeStateStatus: "clean",
    });
  });

  it("lets an outstanding CHANGES_REQUESTED win over another reviewer's APPROVED", async () => {
    mockDetailThenReviews(ok({ mergeable_state: "blocked" }), [
      { user: { login: "alice" }, state: "APPROVED", submitted_at: "2026-01-01T00:00:00Z" },
      { user: { login: "bob" }, state: "CHANGES_REQUESTED", submitted_at: "2026-01-02T00:00:00Z" },
    ]);

    expect((await fetchPullRequestHealthSignals("org/repo", 7)).reviewDecision).toBe("CHANGES_REQUESTED");
  });

  it("uses only each reviewer's latest review", async () => {
    mockDetailThenReviews(ok({ mergeable_state: "clean" }), [
      { user: { login: "alice" }, state: "CHANGES_REQUESTED", submitted_at: "2026-01-01T00:00:00Z" },
      { user: { login: "alice" }, state: "APPROVED", submitted_at: "2026-01-02T00:00:00Z" },
    ]);

    expect((await fetchPullRequestHealthSignals("org/repo", 7)).reviewDecision).toBe("APPROVED");
  });

  it("ignores COMMENTED reviews (no approval signal)", async () => {
    mockDetailThenReviews(ok({ mergeable_state: "clean" }), [
      { user: { login: "alice" }, state: "COMMENTED", submitted_at: "2026-01-01T00:00:00Z" },
    ]);

    expect((await fetchPullRequestHealthSignals("org/repo", 7)).reviewDecision).toBeNull();
  });

  it("degrades to null merge state when the detail GET is not ok", async () => {
    mockDetailThenReviews(httpError(500), [
      { user: { login: "alice" }, state: "APPROVED", submitted_at: "2026-01-01T00:00:00Z" },
    ]);

    expect(await fetchPullRequestHealthSignals("org/repo", 7)).toEqual({
      reviewDecision: "APPROVED",
      mergeStateStatus: null,
    });
  });
});

describe("fetchPullRequestCheckFailures", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("returns only completed runs with a failure-type conclusion", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        check_runs: [
          { name: "lint", conclusion: "failure" },
          { name: "unit", conclusion: "success" },
          { name: "build", conclusion: "timed_out" },
          { name: "pending", conclusion: null },
        ],
      }),
    );

    const result = await fetchPullRequestCheckFailures("org/repo", "main");

    expect(result).toEqual([
      { name: "lint", conclusion: "failure" },
      { name: "build", conclusion: "timed_out" },
    ]);
  });

  it("url-encodes the ref", async () => {
    fetchMock.mockResolvedValueOnce(ok({ check_runs: [] }));

    await fetchPullRequestCheckFailures("org/repo", "feature/x");

    expect(fetchMock.mock.calls[0][0]).toContain("/commits/feature%2Fx/check-runs");
  });

  it("returns [] on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(httpError(403));
    expect(await fetchPullRequestCheckFailures("org/repo", "main")).toEqual([]);
  });

  it("returns [] when the request throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect(await fetchPullRequestCheckFailures("org/repo", "main")).toEqual([]);
  });
});

describe("fetchLinkedPrHealthInput", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  // fetchLinkedPrHealthInput fans out signals + check failures via Promise.all,
  // so the fetch order is not deterministic — route by URL instead of sequence.
  function routeByUrl(opts: { mergeableState?: string; reviews?: unknown[]; checkRuns?: unknown[] }) {
    const { mergeableState = "clean", reviews = [], checkRuns = [] } = opts;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/reviews")) return Promise.resolve(makeResponse(reviews));
      if (url.includes("/check-runs")) return Promise.resolve(ok({ check_runs: checkRuns }));
      return Promise.resolve(ok({ mergeable_state: mergeableState }));
    });
  }

  function pr(overrides: Partial<GithubPR>): GithubPR {
    return {
      number: 7,
      url: "https://github.com/org/repo/pull/7",
      title: "t",
      state: "open",
      user: { login: "alice" },
      head: { ref: "feature" },
      base: { ref: "main" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      merged_at: null,
      draft: false,
      ...overrides,
    };
  }

  it("maps merged_at to state 'merged'", async () => {
    routeByUrl({});
    const result = await fetchLinkedPrHealthInput("org/repo", pr({ state: "closed", merged_at: "2026-01-02T00:00:00Z" }));
    expect(result.state).toBe("merged");
  });

  it("maps closed-and-unmerged to state 'closed'", async () => {
    routeByUrl({});
    const result = await fetchLinkedPrHealthInput("org/repo", pr({ state: "closed", merged_at: null }));
    expect(result.state).toBe("closed");
  });

  it("maps an open PR to state 'open'", async () => {
    routeByUrl({});
    const result = await fetchLinkedPrHealthInput("org/repo", pr({ state: "open" }));
    expect(result.state).toBe("open");
  });

  it("assembles review decision, merge state, and check failures", async () => {
    routeByUrl({
      mergeableState: "dirty",
      reviews: [{ user: { login: "bob" }, state: "CHANGES_REQUESTED", submitted_at: "2026-01-02T00:00:00Z" }],
      checkRuns: [{ name: "lint", conclusion: "failure" }],
    });

    const result = await fetchLinkedPrHealthInput("org/repo", pr({}));

    expect(result).toMatchObject({
      number: 7,
      state: "open",
      draft: false,
      mergeStateStatus: "dirty",
      reviewDecision: "CHANGES_REQUESTED",
      checkFailures: [{ name: "lint", conclusion: "failure" }],
    });
  });
});
