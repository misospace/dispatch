/**
 * Shared test setup for API route tests.
 *
 * These helpers are designed to be safe to reference from inside hoisted
 * `vi.mock()` factories: `vi.mock()` calls are hoisted above regular
 * `import` statements by vitest, but factory *bodies* are only invoked
 * lazily (when the mocked module is first imported), by which point this
 * module's exports are already initialized. See usage below.
 *
 * @example
 * ```ts
 * import { vi } from "vitest";
 * import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";
 *
 * process.env.DISPATCH_AGENT_TOKEN = mockToken;
 *
 * vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());
 *
 * const res = await GET(authedRequest("http://localhost/api/things"));
 * ```
 */
import { vi } from "vitest";

/** The default bearer token used by route tests that stub agent-token auth. */
export const TEST_AGENT_TOKEN = "test-agent-token";

/**
 * Builds the mock module shape for `@/lib/dispatch-env`, matching the
 * common pattern of comparing an incoming token against a fixed test token.
 */
export function makeDispatchEnvMock(token: string = TEST_AGENT_TOKEN) {
  return {
    isAuthorizedAgentToken: vi.fn((t: string | null | undefined) => t === token),
    isAuthorizedBearerToken: vi.fn((t: string | null | undefined) => t === token),
    getAcceptedAgentTokens: vi.fn(() => [token]),
    resetCaches: vi.fn(),
  };
}

/**
 * Same as {@link makeDispatchEnvMock}, plus a `safeEqual` stub for routes
 * that use constant-time comparisons directly (e.g. webhook signature checks).
 */
export function makeDispatchEnvMockWithSafeEqual(token: string = TEST_AGENT_TOKEN) {
  return {
    ...makeDispatchEnvMock(token),
    safeEqual: vi.fn((a: string, b: string) => a === b),
  };
}

export interface AuthedRequestOptions {
  /** HTTP method. Defaults to "GET" (or "POST" implicitly when a body is given, per the Request default). */
  method?: string;
  /** Bearer token to send. Defaults to {@link TEST_AGENT_TOKEN}. */
  token?: string;
  /** Whether to attach the Authorization header at all. Defaults to true. */
  includeAuth?: boolean;
  /** JSON-serializable body. When provided, Content-Type: application/json is set automatically. */
  body?: unknown;
  /** Additional/overriding headers. */
  headers?: Record<string, string>;
}

/**
 * Builds a `Request` for exercising a route handler, with an optional
 * `Authorization: Bearer <token>` header and an optional JSON body.
 */
export function authedRequest(url: string, options: AuthedRequestOptions = {}): Request {
  const { method, token = TEST_AGENT_TOKEN, includeAuth = true, body, headers } = options;
  // Build defaults first, then let explicit `headers` win — this lets callers
  // override/replace the Authorization header (e.g. to simulate a bad token)
  // by passing `headers: { Authorization: "Bearer wrong-token" }`.
  const finalHeaders: Record<string, string> = {};
  if (body !== undefined) finalHeaders["Content-Type"] = "application/json";
  if (includeAuth) finalHeaders.Authorization = `Bearer ${token}`;
  Object.assign(finalHeaders, headers);
  return new Request(url, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
