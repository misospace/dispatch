// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "./github-auth";
import { syncStatusLabels } from "./github-issues";

process.env.GITHUB_TOKEN = "test-token-for-retry-tests";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    headers: new Headers(headers),
  } as Response;
}

describe("fetchWithRetry (shared GitHub fetch retry wrapper)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries a 429 with Retry-After and succeeds on the second try", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { message: "rate limited" }, { "Retry-After": "1" }))
      .mockResolvedValueOnce(jsonResponse(200, { number: 7 }));

    const promise = fetchWithRetry("https://api.github.com/repos/o/r/issues/7", { headers: { Authorization: "Bearer test-token" } });
    await vi.advanceTimersByTimeAsync(2000);
    const response = await promise;

    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ number: 7 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 503 and succeeds on the second try", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, { message: "server error" }))
      .mockResolvedValueOnce(jsonResponse(200, { number: 8 }));

    const promise = fetchWithRetry("https://api.github.com/repos/o/r/issues/8", { headers: { Authorization: "Bearer test-token" } });
    await vi.advanceTimersByTimeAsync(5000);
    const response = await promise;

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 404 and throws immediately", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { message: "Not Found" }));

    const promise = fetchWithRetry("https://api.github.com/repos/o/r/issues/999", { headers: { Authorization: "Bearer test-token" } });
    await vi.advanceTimersByTimeAsync(60_000);

    const response = await promise;
    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("syncStatusLabels with a transient 429 mid-loop", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const labels = ["status/queued", "status/in-progress", "status/blocked", "status/review", "status/done"];

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("still attempts all 5 labels when one call hits a transient 429", async () => {
    // Every call succeeds except the 3rd, which 429s once then succeeds on retry.
    fetchMock.mockImplementation(async (url: string) => {
      const callIndex = fetchMock.mock.calls.length; // 1-based
      if (callIndex === 3) {
        return jsonResponse(429, { message: "rate limited" }, { "Retry-After": "1" });
      }
      return jsonResponse(200, {});
    });

    const promise = syncStatusLabels("o/r", 42, labels, []);
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    // 5 label calls + 1 retry of the 429'd call.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const calledPaths = fetchMock.mock.calls.map((call) => String(call[0]));
    for (const path of calledPaths) {
      expect(path).toContain("/repos/o/r/issues/42/labels");
    }
    // Each of the 5 labels was sent in a request body.
    const sentLabels = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1].body)).labels[0]);
    for (const label of labels) {
      expect(sentLabels).toContain(label);
    }
  });
});
