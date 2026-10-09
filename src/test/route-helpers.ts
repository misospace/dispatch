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
 * The test token resolves to the "maintainer" tier so existing suites keep
 * exercising the full-rights path. Pass `tierMap` to accept extra tokens at
 * a specific tier (e.g. a worker token for tier-gate tests), and `bindings`
 * (token -> agentName) to model bound worker credentials for identity-scope
 * tests.
 */
export function makeDispatchEnvMock(
  token: string = TEST_AGENT_TOKEN,
  tierMap: Record<string, "worker" | "maintainer"> = {},
  bindings: Record<string, string> = {},
) {
  const accepted = [token, ...Object.keys(tierMap), ...Object.keys(bindings)];
  return {
    isAuthorizedAgentToken: vi.fn((t: string | null | undefined) => (t !== null && t !== undefined ? accepted.includes(t) : false)),
    isAuthorizedBearerToken: vi.fn((t: string | null | undefined) => (t !== null && t !== undefined ? accepted.includes(t) : false)),
    getAcceptedAgentTokens: vi.fn(() => accepted),
    getBearerTokenTier: vi.fn((t: string | null | undefined) => {
      if (t === null || t === undefined) return null;
      if (t === token) return tierMap[token] ?? "maintainer";
      if (t in bindings) return "worker";
      return tierMap[t] ?? null;
    }),
    getBearerTokenIdentity: vi.fn((t: string | null | undefined) => {
      if (t === null || t === undefined) return null;
      if (t === token) {
        return (tierMap[token] ?? "maintainer") === "worker"
          ? { tier: "worker" }
          : { tier: "maintainer" };
      }
      if (t in bindings) return { tier: "worker", agentName: bindings[t] };
      const tier = tierMap[t];
      return tier ? { tier } : null;
    }),
    getBoundAgentName: vi.fn((t: string | null | undefined) =>
      t !== null && t !== undefined && t in bindings ? bindings[t] : undefined,
    ),
    resetCaches: vi.fn(),
  };
}

/**
 * Same as {@link makeDispatchEnvMock}, plus a `safeEqual` stub for routes
 * that use constant-time comparisons directly (e.g. webhook signature checks).
 */
export function makeDispatchEnvMockWithSafeEqual(
  token: string = TEST_AGENT_TOKEN,
  tierMap: Record<string, "worker" | "maintainer"> = {},
  bindings: Record<string, string> = {},
) {
  return {
    ...makeDispatchEnvMock(token, tierMap, bindings),
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
