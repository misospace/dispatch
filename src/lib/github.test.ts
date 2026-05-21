import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPaginated } from "./github";

process.env.GITHUB_TOKEN = "test-token-for-pagination-tests";

vi.mock("./github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github")>();
  return { ...actual };
});

function makeResponse(data: unknown[], hasNext = false): Response {
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

  it("handles maxItems of 0", async () => {
    const result = await fetchPaginated<{ id: number }>("https://example.com/api", 0);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
