import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "./github-auth";

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
});
