// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetGitHubAppState } from "./github-auth";
import { fetchPullRequestReviewThreadStates } from "./github-prs";

// Bearer auth for getHeadersAsync(): token-mode (no GitHub App), so ensureInit()
// is a no-op and the only thing the test has to provide is GITHUB_TOKEN.
process.env.GITHUB_TOKEN = "test-token-for-review-thread-tests";

// We exercise the real getHeadersAsync()/fetchWithRetry() from github-auth and
// only stub the global fetch() they call underneath (same pattern as github.test.ts).
const requests: Array<Record<string, unknown>> = [];
const fetchMock = vi.fn();

// A minimal Response: `ok`/`status` drive fetchWithRetry()'s retry decision,
// `json()` feeds the GraphQL payload the reader parses.
function jsonResponse(status: number, value: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  } as unknown as Response;
}

function reviewThreadsPayload(
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
  nodes: Array<Record<string, unknown>>,
) {
  return {
    data: {
      repository: {
        pullRequest: { reviewThreads: { pageInfo, nodes } },
      },
    },
  };
}

describe("fetchPullRequestReviewThreadStates", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  beforeEach(() => {
    __resetGitHubAppState();
    process.env.GITHUB_TOKEN = "test-token-for-review-thread-tests";
    requests.length = 0;
    fetchMock.mockReset();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.GITHUB_TOKEN;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("maps each inline comment's string databaseId to its thread's resolved/outdated state", async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      return jsonResponse(200,
        reviewThreadsPayload(
          { hasNextPage: false, endCursor: null },
          [
            { isResolved: true, isOutdated: false, comments: { nodes: [{ databaseId: 101 }, { databaseId: 102 }] } },
            { isResolved: false, isOutdated: true, comments: { nodes: [{ databaseId: 103 }] } },
          ],
        ),
      );
    });

    const map = await fetchPullRequestReviewThreadStates("org/repo", 42);

    expect(map).not.toBeNull();
    expect(map!.get("101")).toEqual({ resolved: true, outdated: false });
    expect(map!.get("102")).toEqual({ resolved: true, outdated: false });
    expect(map!.get("103")).toEqual({ resolved: false, outdated: true });
    expect(map!.size).toBe(3);
    expect(Array.from(map!.keys()).every((k) => /^\d+$/.test(k))).toBe(true); // string keys
  });

  it("follows pageInfo.endCursor across pages until the connection ends", async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      requests.push(body);
      const after = (body.variables as { after?: string | null }).after ?? null;
      if (after === null) {
        // First page: not finished, hand back a cursor.
        return jsonResponse(200,
          reviewThreadsPayload(
            { hasNextPage: true, endCursor: "c1" },
            [{ isResolved: true, isOutdated: false, comments: { nodes: [{ databaseId: 201 }] } }],
          ),
        );
      }
      // Second page: finished.
      return jsonResponse(200,
        reviewThreadsPayload(
          { hasNextPage: false, endCursor: null },
          [{ isResolved: false, isOutdated: true, comments: { nodes: [{ databaseId: 202 }] } }],
        ),
      );
    });

    const map = await fetchPullRequestReviewThreadStates("org/repo", 42);

    expect(map).not.toBeNull();
    expect(map!.get("201")).toEqual({ resolved: true, outdated: false });
    expect(map!.get("202")).toEqual({ resolved: false, outdated: true });
    // Both pages' comments are present.
    expect(map!.size).toBe(2);
    // Exactly two requests; the second carried the first page's endCursor.
    expect(requests).toHaveLength(2);
    expect((requests[0].variables as { after?: string | null }).after ?? null).toBeNull();
    expect((requests[1].variables as { after?: string | null }).after).toBe("c1");
  });

  it("returns null on a non-2xx response (fail closed)", async () => {
    fetchMock.mockImplementation(async () => {
      requests.push({});
      return jsonResponse(404, null);
    });

    const map = await fetchPullRequestReviewThreadStates("org/repo", 42);

    expect(map).toBeNull();
  });

  it("returns null when the GraphQL response carries an errors array", async () => {
    fetchMock.mockImplementation(async () => {
      requests.push({});
      return jsonResponse(200, {
        data: null,
        errors: [{ message: "Something went wrong while executing your query" }],
      });
    });

    const map = await fetchPullRequestReviewThreadStates("org/repo", 42);

    expect(map).toBeNull();
  });

  it("returns null when the JSON body is malformed", async () => {
    fetchMock.mockImplementation(async () => {
      requests.push({});
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Unexpected token in JSON");
        },
      } as unknown as Response;
    });

    const map = await fetchPullRequestReviewThreadStates("org/repo", 42);

    expect(map).toBeNull();
  });

  it("returns null when the response has no recognizable reviewThreads shape", async () => {
    fetchMock.mockImplementation(async () => {
      requests.push({});
      // pullRequest present but the connection field is missing.
      return jsonResponse(200, { data: { repository: { pullRequest: { } } } });
    });

    const map = await fetchPullRequestReviewThreadStates("org/repo", 42);

    expect(map).toBeNull();
  });

  it("returns null when fetch rejects (network failure)", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("network is down");
    });

    const map = await fetchPullRequestReviewThreadStates("org/repo", 42);

    expect(map).toBeNull();
  });

  it("fails closed when the connection is still paginating at the page bound", async () => {
    // A connection that never ends would otherwise return a PARTIAL map, whose
    // missing threads are indistinguishable from "thread state unknown" per
    // comment — the exact shape the null return exists to prevent.
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      requests.push(body);
      const after = (body.variables as { after?: string | null }).after ?? null;
      return jsonResponse(200,
        reviewThreadsPayload(
          { hasNextPage: true, endCursor: after === null ? "c1" : `c${Number(after.slice(1)) + 1}` },
          [{ isResolved: true, isOutdated: false, comments: { nodes: [{ databaseId: 9000 }] } }],
        ),
      );
    });

    const map = await fetchPullRequestReviewThreadStates("org/repo", 42);

    expect(map).toBeNull();
    // The bound is honored: 10 pages of 50 threads, then it gives up.
    expect(requests).toHaveLength(10);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("thread state as unknown"));
  });
});
