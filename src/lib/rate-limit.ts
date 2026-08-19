/**
 * Simple in-memory fixed-window rate limiter.
 *
 * Dispatch runs as a single-node internal ops tool, so a module-level Map
 * is sufficient — no Redis or external store. Each key gets a fixed window:
 * the first request opens the window, and once `limit` requests have been
 * counted the caller is rejected until the window expires.
 *
 * Route handlers should call `enforceRateLimit` at the top of their mutating
 * handlers, right after auth, keyed by the authenticated actor:
 *
 *   const limited = enforceRateLimit(`issues/move:${auth.actor}`, RATE_LIMIT);
 *   if (limited) return limited;
 *
 * Expired windows are pruned lazily on write (no timers), so the map stays
 * bounded even if callers use many distinct keys.
 */

import { NextResponse } from "next/server";
import { errorResponse } from "./api-errors";

export interface RateLimitOptions {
  /** Maximum number of requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets. 0 when the request is allowed. */
  retryAfterSeconds: number;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

const windows = new Map<string, WindowEntry>();

/** Sweep expired entries once the map grows past this size. */
const PRUNE_THRESHOLD = 1000;

/**
 * Count a request against `key` and report whether it is within the limit.
 * Opening a new window also lazily prunes expired entries for other keys.
 */
export function checkRateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const { limit, windowMs } = opts;
  const now = Date.now();

  const entry = windows.get(key);
  if (!entry || now >= entry.resetAt) {
    pruneExpired(now);
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (entry.count < limit) {
    entry.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
  };
}

/**
 * Check the limit for `key` and return a ready-to-send 429 response (with a
 * Retry-After header) when exceeded, or null when the request is allowed.
 */
export function enforceRateLimit(
  key: string,
  opts: RateLimitOptions,
): NextResponse<{ error: string }> | null {
  const result = checkRateLimit(key, opts);
  if (result.allowed) return null;

  const response = errorResponse("Rate limit exceeded", 429);
  response.headers.set("Retry-After", String(result.retryAfterSeconds));
  return response;
}

function pruneExpired(now: number): void {
  if (windows.size < PRUNE_THRESHOLD) return;
  for (const [key, entry] of windows) {
    if (now >= entry.resetAt) windows.delete(key);
  }
}

/**
 * Reset all limiter state. Intended for test isolation — call in beforeEach.
 */
export function resetRateLimits(): void {
  windows.clear();
}

/**
 * Reset a single key's window. Used by the auth middleware when a successful
 * credential check occurs, so that the caller gets a fresh bucket after they
 * prove they know the password. Returns true if a window was cleared.
 */
export function resetRateLimitKey(key: string): boolean {
  return windows.delete(key);
}
