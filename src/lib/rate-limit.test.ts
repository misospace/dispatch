import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { checkRateLimit, enforceRateLimit, resetRateLimits } from "./rate-limit";

const OPTS = { limit: 3, windowMs: 60_000 };

describe("checkRateLimit", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests under the limit", () => {
    for (let i = 0; i < OPTS.limit; i++) {
      expect(checkRateLimit("actor-1", OPTS)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
  });

  it("blocks requests over the limit and reports retry-after", () => {
    for (let i = 0; i < OPTS.limit; i++) {
      checkRateLimit("actor-1", OPTS);
    }

    const result = checkRateLimit("actor-1", OPTS);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(60);
  });

  it("counts down retry-after as the window ages", () => {
    for (let i = 0; i <= OPTS.limit; i++) {
      checkRateLimit("actor-1", OPTS);
    }

    vi.advanceTimersByTime(45_000);
    const result = checkRateLimit("actor-1", OPTS);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(15);
  });

  it("allows again after the window expires", () => {
    for (let i = 0; i <= OPTS.limit; i++) {
      checkRateLimit("actor-1", OPTS);
    }
    expect(checkRateLimit("actor-1", OPTS).allowed).toBe(false);

    vi.advanceTimersByTime(OPTS.windowMs);

    expect(checkRateLimit("actor-1", OPTS)).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("isolates counts per key", () => {
    for (let i = 0; i < OPTS.limit; i++) {
      checkRateLimit("actor-1", OPTS);
    }
    expect(checkRateLimit("actor-1", OPTS).allowed).toBe(false);

    expect(checkRateLimit("actor-2", OPTS).allowed).toBe(true);
  });

  it("resetRateLimits clears all state", () => {
    for (let i = 0; i <= OPTS.limit; i++) {
      checkRateLimit("actor-1", OPTS);
    }
    expect(checkRateLimit("actor-1", OPTS).allowed).toBe(false);

    resetRateLimits();

    expect(checkRateLimit("actor-1", OPTS).allowed).toBe(true);
  });

  it("reports at least 1 second of retry-after near the window edge", () => {
    for (let i = 0; i < OPTS.limit; i++) {
      checkRateLimit("actor-1", OPTS);
    }

    vi.advanceTimersByTime(OPTS.windowMs - 1);
    const result = checkRateLimit("actor-1", OPTS);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(1);
  });
});

describe("enforceRateLimit", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("returns null while under the limit", () => {
    for (let i = 0; i < OPTS.limit; i++) {
      expect(enforceRateLimit("actor-1", OPTS)).toBeNull();
    }
  });

  it("returns a 429 response with Retry-After once the limit is exceeded", async () => {
    for (let i = 0; i < OPTS.limit; i++) {
      enforceRateLimit("actor-1", OPTS);
    }

    const response = enforceRateLimit("actor-1", OPTS);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(429);
    expect(Number(response!.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = await response!.json();
    expect(body.error).toBe("Rate limit exceeded");
  });
});
