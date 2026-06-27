import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addIssueComment,
  fetchPaginated,
  fetchRepositoryMetadata,
  searchRepositoryCode,
  fetchRepositoryFileText,
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
