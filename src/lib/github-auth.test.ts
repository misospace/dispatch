import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, githubFetchTimeoutMs } from "./github-auth";

function jsonResponse(status: number, headers: Record<string, string> = {}, body = "{}"): Response {
  return new Response(body, { status, headers });
}

describe("fetchWithRetry", () => {
  let originalFetch: typeof globalThis.fetch;
  const sleeps: number[] = [];
  const fakeSleep = vi.fn(async (ms: number) => {
    sleeps.push(ms);
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    sleeps.length = 0;
    fakeSleep.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("returns the response immediately on success without sleeping", async () => {
    const ok = jsonResponse(200);
    vi.stubGlobal("fetch", vi.fn(async () => ok));

    const res = await fetchWithRetry("https://api.github.com/x", {}, { sleep: fakeSleep });

    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(fakeSleep).not.toHaveBeenCalled();
  });

  it("retries a transient 429 and succeeds on the next attempt", async () => {
    const calls = vi.fn(async () => {
      if (calls.mock.calls.length === 1) return jsonResponse(429);
      return jsonResponse(200);
    });
    vi.stubGlobal("fetch", calls);

    const res = await fetchWithRetry("https://api.github.com/x", {}, { sleep: fakeSleep });

    expect(res.status).toBe(200);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(fakeSleep).toHaveBeenCalledTimes(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000); // exponential base for attempt 1
  });

  it("retries a transient 503 and succeeds", async () => {
    const calls = vi.fn(async () => {
      if (calls.mock.calls.length === 1) return jsonResponse(503);
      return jsonResponse(200);
    });
    vi.stubGlobal("fetch", calls);

    const res = await fetchWithRetry("https://api.github.com/x", {}, { sleep: fakeSleep });

    expect(res.status).toBe(200);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("honors the Retry-After header (seconds) on 429", async () => {
    const calls = vi.fn(async () => {
      if (calls.mock.calls.length === 1) return jsonResponse(429, { "Retry-After": "7" });
      return jsonResponse(200);
    });
    vi.stubGlobal("fetch", calls);

    await fetchWithRetry("https://api.github.com/x", {}, { sleep: fakeSleep });

    expect(sleeps[0]).toBe(7000);
  });

  it("honors the x-ratelimit-reset header on 429 when it asks for a longer wait", async () => {
    const reset = Math.floor(Date.now() / 1000) + 30;
    const calls = vi.fn(async () => {
      if (calls.mock.calls.length === 1) return jsonResponse(429, { "x-ratelimit-reset": String(reset) });
      return jsonResponse(200);
    });
    vi.stubGlobal("fetch", calls);

    await fetchWithRetry("https://api.github.com/x", {}, { sleep: fakeSleep });

    expect(sleeps[0]).toBeGreaterThanOrEqual(29000);
    expect(sleeps[0]).toBeLessThanOrEqual(31000);
  });

  it("uses exponential backoff when no rate-limit headers are present", async () => {
    const calls = vi.fn(async () => {
      if (calls.mock.calls.length < 3) return jsonResponse(502);
      return jsonResponse(200);
    });
    vi.stubGlobal("fetch", calls);

    const res = await fetchWithRetry("https://api.github.com/x", {}, { sleep: fakeSleep });

    expect(res.status).toBe(200);
    expect(calls).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("returns the last 429 response after exhausting retries", async () => {
    const calls = vi.fn(async () => jsonResponse(429));
    vi.stubGlobal("fetch", calls);

    const res = await fetchWithRetry("https://api.github.com/x", {}, { sleep: fakeSleep });

    expect(res.status).toBe(429);
    expect(calls).toHaveBeenCalledTimes(3); // default maxAttempts
    expect(fakeSleep).toHaveBeenCalledTimes(2);
  });

  it("returns the last 5xx response after exhausting retries", async () => {
    const calls = vi.fn(async () => jsonResponse(503));
    vi.stubGlobal("fetch", calls);

    const res = await fetchWithRetry("https://api.github.com/x", {}, { sleep: fakeSleep, maxAttempts: 4 });

    expect(res.status).toBe(503);
    expect(calls).toHaveBeenCalledTimes(4);
  });

  it("does not retry non-retryable statuses such as 404", async () => {
    const calls = vi.fn(async () => jsonResponse(404));
    vi.stubGlobal("fetch", calls);

    const res = await fetchWithRetry("https://api.github.com/x", {}, { sleep: fakeSleep });

    expect(res.status).toBe(404);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(fakeSleep).not.toHaveBeenCalled();
  });

  it("does not retry 401 auth failures", async () => {
    const calls = vi.fn(async () => jsonResponse(401));
    vi.stubGlobal("fetch", calls);

    const res = await fetchWithRetry("https://api.github.com/x", {}, { sleep: fakeSleep });

    expect(res.status).toBe(401);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("caps a single backoff sleep (#1347: no unbounded rate-limit wait inside a guard window)", async () => {
    const calls = vi.fn(async () => {
      if (calls.mock.calls.length === 1) return jsonResponse(429, { "Retry-After": "3600" });
      return jsonResponse(200);
    });
    vi.stubGlobal("fetch", calls);

    await fetchWithRetry("https://api.github.com/x", {}, { sleep: fakeSleep });

    // The header asks for an hour; the holder must wait at most the cap.
    expect(sleeps[0]).toBe(30000);
  });
});

describe("fetchWithRetry bounded timeout (#1347)", () => {
  let originalFetch: typeof globalThis.fetch;
  const sleeps: number[] = [];
  const fakeSleep = vi.fn(async (ms: number) => {
    sleeps.push(ms);
  });
  const timeoutError = () => Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    sleeps.length = 0;
    fakeSleep.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    delete process.env.DISPATCH_GITHUB_TIMEOUT_MS;
  });

  it("every attempt gets a fresh AbortSignal; the caller's own signal is kept verbatim", async () => {
    const calls = vi.fn(async () => {
      if (calls.mock.calls.length === 1) return jsonResponse(503);
      return jsonResponse(200);
    });
    vi.stubGlobal("fetch", calls);

    await fetchWithRetry("https://api.github.com/x", {}, { sleep: fakeSleep });

    const first = (calls.mock.calls[0][1] as RequestInit).signal;
    const second = (calls.mock.calls[1][1] as RequestInit).signal;
    expect(first).toBeInstanceOf(AbortSignal);
    expect(second).toBeInstanceOf(AbortSignal);
    expect(second).not.toBe(first);

    const callerSignal = new AbortController().signal;
    await fetchWithRetry("https://api.github.com/x", { signal: callerSignal }, { sleep: fakeSleep });
    expect((calls.mock.calls[2][1] as RequestInit).signal).toBe(callerSignal);
  });

  it("a stalled GET is retried and a late success still resolves", async () => {
    const calls = vi.fn(async () => {
      if (calls.mock.calls.length === 1) throw timeoutError();
      return jsonResponse(200);
    });
    vi.stubGlobal("fetch", calls);

    const res = await fetchWithRetry("https://api.github.com/x", {}, { sleep: fakeSleep });

    expect(res.status).toBe(200);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("a permanently stalled GET rejects with the timeout after bounded attempts", async () => {
    const calls = vi.fn(async () => {
      throw timeoutError();
    });
    vi.stubGlobal("fetch", calls);

    await expect(
      fetchWithRetry("https://api.github.com/x", {}, { sleep: fakeSleep }),
    ).rejects.toThrow(/timed out/);
    expect(calls).toHaveBeenCalledTimes(3); // default maxAttempts, then fail closed
    expect(sleeps).toEqual([1000, 2000]); // bounded backoff between attempts
  });

  it("a stalled WRITE is never retried (it may have applied server-side)", async () => {
    const calls = vi.fn(async () => {
      throw timeoutError();
    });
    vi.stubGlobal("fetch", calls);

    await expect(
      fetchWithRetry("https://api.github.com/x", { method: "PATCH", body: "{}" }, { sleep: fakeSleep }),
    ).rejects.toThrow(/timed out/);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(fakeSleep).not.toHaveBeenCalled();
  });

  it("a caller-signal abort is surfaced once and never treated as our timeout", async () => {
    const calls = vi.fn(async () => {
      throw Object.assign(new Error("aborted by caller"), { name: "AbortError" });
    });
    vi.stubGlobal("fetch", calls);
    const controller = new AbortController();

    await expect(
      fetchWithRetry("https://api.github.com/x", { signal: controller.signal }, { sleep: fakeSleep }),
    ).rejects.toThrow(/aborted by caller/);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("DISPATCH_GITHUB_TIMEOUT_MS configures the bound (floored, invalid-safe)", async () => {
    process.env.DISPATCH_GITHUB_TIMEOUT_MS = "5000";
    expect(githubFetchTimeoutMs()).toBe(5000);
    process.env.DISPATCH_GITHUB_TIMEOUT_MS = "10";
    expect(githubFetchTimeoutMs()).toBe(1000); // floor: a sub-second bound would break large reads
    process.env.DISPATCH_GITHUB_TIMEOUT_MS = "nonsense";
    expect(githubFetchTimeoutMs()).toBe(30000); // default
    delete process.env.DISPATCH_GITHUB_TIMEOUT_MS;
    expect(githubFetchTimeoutMs()).toBe(30000);
  });
});
