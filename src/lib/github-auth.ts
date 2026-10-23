// Internal shared helper, do not re-export from barrel
import { createPrivateKey } from "node:crypto";

const GITHUB_API = "https://api.github.com";

interface CachedToken {
  token: string;
  expiresAt: number;
}

let installationTokenCache: CachedToken | null = null;
let useGitHubApp = false;
let appNotConfigured = false;
let appInitFailed = false;
let inFlightTokenFetch: Promise<void> | null = null;

function base64urlEncodeArrayBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return Buffer.from(binary, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlEncode(data: string): string {
  return Buffer.from(data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Normalize a PEM private key (PKCS1 "BEGIN RSA PRIVATE KEY" or PKCS8
 * "BEGIN PRIVATE KEY") to PKCS8 DER, which is the only format
 * crypto.subtle.importKey accepts. GitHub App keys are generated as PKCS1,
 * so importing the raw PEM as pkcs8 fails without this step.
 * Never include key material or raw parser output in error messages.
 */
function privateKeyPemToPkcs8Buffer(pem: string): ArrayBuffer {
  let key;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw new Error("GitHub App private key is not a valid PKCS1 or PKCS8 PEM private key");
  }
  const der = key.export({ type: "pkcs8", format: "der" });
  const copy = Buffer.alloc(der.length);
  copy.set(der);
  return copy.buffer as ArrayBuffer;
}

async function generateAppJwt(privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64urlEncode(JSON.stringify({
    iat: now,
    exp: now + 600,
    iss: process.env.GITHUB_APP_ID,
  }));
  const signingInput = `${header}.${payload}`;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyPemToPkcs8Buffer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const signature = base64urlEncodeArrayBuffer(signatureBuffer);

  return `${signingInput}.${signature}`;
}

async function getInstallationTokenWithExpiry(): Promise<CachedToken> {
  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  let privateKey = process.env.GITHUB_APP_PRIVATE_KEY || "";

  if (!appId || !installationId || !privateKey) {
    throw new Error("GitHub App authentication is misconfigured — missing required env vars");
  }

  privateKey = privateKey.replace(/\\n/g, "\n");

  const jwt = await generateAppJwt(privateKey);

  const response = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      // #1347: this raw call bypasses `fetchWithRetry`, so it carries the
      // same bounded-timeout premise directly.
      signal: AbortSignal.timeout(githubFetchTimeoutMs()),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get GitHub App installation token: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { token: string; expires_at: string };

  const githubExpiresAt = Math.floor(Date.parse(data.expires_at) / 1000);
  const safeTtl = Math.min(3300, githubExpiresAt - Math.floor(Date.now() / 1000) - 60);

  return { token: data.token, expiresAt: Date.now() / 1000 + safeTtl };
}

function fetchAndCacheInstallationToken(): Promise<void> {
  if (!inFlightTokenFetch) {
    inFlightTokenFetch = getInstallationTokenWithExpiry()
      .then((cached) => {
        installationTokenCache = cached;
        useGitHubApp = true;
      })
      .finally(() => {
        inFlightTokenFetch = null;
      });
  }
  return inFlightTokenFetch;
}

async function ensureInit(): Promise<void> {
  if (useGitHubApp || appNotConfigured) return;

  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || !installationId || !privateKey) {
    appNotConfigured = true;
    return;
  }

  try {
    await fetchAndCacheInstallationToken();
    appInitFailed = false;
  } catch {
    // Keep retrying on later calls, but remember the failure so getGitHubToken
    // can report a useful error instead of a misleading missing-GITHUB_TOKEN
    // when no PAT fallback exists. Error details are intentionally not
    // retained — they may contain response bodies.
    appInitFailed = true;
  }
}

async function refreshIfNeeded(): Promise<void> {
  if (!useGitHubApp || !installationTokenCache) return;

  if (installationTokenCache.expiresAt <= Date.now() / 1000 + 60) {
    await fetchAndCacheInstallationToken();
  }
}

export async function getGitHubToken(): Promise<string> {
  await ensureInit();
  await refreshIfNeeded();

  if (useGitHubApp && installationTokenCache) {
    return installationTokenCache.token;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    if (appInitFailed) {
      throw new Error(
        "GitHub App authentication is configured but failed to obtain an installation token. " +
          "Verify GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and GITHUB_APP_PRIVATE_KEY " +
          "(PKCS1 and PKCS8 PEM keys are both supported). GITHUB_TOKEN is not set, so there is no fallback."
      );
    }
    throw new Error("GITHUB_TOKEN environment variable is not set");
  }
  return token;
}

// Internal shared helper, do not re-export from barrel
export async function getHeadersAsync(): Promise<HeadersInit> {
  const token = await getGitHubToken();
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Statuses that indicate a transient GitHub failure worth retrying:
 * rate limiting (429) and server-side errors (5xx).
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * #1347 (#1254 fallout): a HARD per-attempt bound on every GitHub REST
 * request, so no code path can wait on a stalled socket forever. Two safety
 * bounds assume remote calls terminate: the guard-override age fence
 * (`GUARD_OVERRIDE_MIN_AGE_MS` treats a silent executing guard as proof of a
 * crashed holder) and the live-label re-checks inside the reconciler's
 * §8.7 anchor windows. Both premises are only real while every fetch is
 * bounded — this constant, applied in `fetchWithRetry` (every helper funnels
 * through it) and the App installation-token POST, is what makes them so.
 */
const DEFAULT_GITHUB_FETCH_TIMEOUT_MS = 30_000;
const GITHUB_FETCH_TIMEOUT_FLOOR_MS = 1_000;

/** #1347: configurable via `DISPATCH_GITHUB_TIMEOUT_MS` (floored at 1s). */
export function githubFetchTimeoutMs(): number {
  const raw = Number(process.env.DISPATCH_GITHUB_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_GITHUB_FETCH_TIMEOUT_MS;
  return Math.max(raw, GITHUB_FETCH_TIMEOUT_FLOOR_MS);
}

/**
 * #1347: cap on a single backoff sleep. Honoring a far-future
 * `x-ratelimit-reset`/`Retry-After` verbatim would make a holder's total wait
 * (attempts × timeout + sleeps) unbounded again — exactly the stall the age
 * fence must treat as dead. A rate-limited call therefore fails fast after
 * bounded bounded waits (worst case 3 attempts: 3 × timeout + 2 × this cap)
 * and its caller retries on the NEXT pass/request, which is the retry
 * boundary the fenced protocols already model.
 */
export const GITHUB_RETRY_MAX_DELAY_MS = 30_000;

/**
 * #1254: the default attempt count of `fetchWithRetry` (total attempts,
 * including the first). MUTATING calls get the same count: a write retries
 * on 429/5xx like a read; only a TIMEOUT is not retried for a write (its
 * outcome is ambiguous). The fenced region's transaction budget is derived
 * from this number (`githubCallBudgetMs`), so the two must not drift.
 */
export const GITHUB_FETCH_MAX_ATTEMPTS = 3;

/**
 * #1254: the worst-case duration of ONE mutating forge call — the bound the
 * fenced region's transaction budget is derived from.
 *
 * A mutating call is `fetchWithRetry` with the default attempt count, and
 * every attempt carries the #1347 per-attempt timeout, with the retry sleeps
 * capped at `GITHUB_RETRY_MAX_DELAY_MS`. The bound therefore is:
 *
 *   attempts × per-attempt timeout + (attempts − 1) × capped backoff
 *
 * plus one per-attempt timeout for a COLD App installation-token fetch (the
 * token POST bypasses `fetchWithRetry` but carries the same timeout bound).
 * The token is cached, so this last term is paid at most once per region.
 *
 * At the default configuration (30s timeout, 30s backoff cap, 3 attempts)
 * that is 3 × 30s + 2 × 30s + 30s = 180s.
 */
export function githubCallBudgetMs(): number {
  const attempts = GITHUB_FETCH_MAX_ATTEMPTS;
  const attemptChainMs =
    attempts * githubFetchTimeoutMs() + (attempts - 1) * GITHUB_RETRY_MAX_DELAY_MS;
  return attemptChainMs + githubFetchTimeoutMs();
}

export interface FetchWithRetryOptions {
  /** Total attempts including the first (default 3). */
  maxAttempts?: number;
  /** Injectable sleep for tests (default: real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Retry a request that hit the #1347 timeout bound. Default: GET/HEAD
   * only. Set true for requests the caller KNOWS are read-idempotent even
   * though they ride POST (e.g. the GraphQL search) — never for mutating
   * writes, whose timeout outcome is ambiguous.
   */
  retryOnTimeout?: boolean;
}

/**
 * Backoff delay for the given attempt (1-indexed): 1s, 2s, 4s, ...
 * On 429 the GitHub `Retry-After` header (seconds or HTTP date) and the
 * `x-ratelimit-reset` header (unix epoch seconds) are honored when they
 * ask for a longer wait than the exponential base.
 */
function retryDelayMs(response: Response, attempt: number): number {
  const base = 1000 * 2 ** (attempt - 1);
  const headers = response.headers;
  if (!headers) return base;

  const retryAfter = headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(base, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(base, date - Date.now());
  }

  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(base, reset * 1000 - Date.now() + 100);
  }

  return base;
}

/**
 * Compose the per-attempt request signal: the caller's cancellation (if
 * any) AND the hard timeout, never one instead of the other (#1347 — the
 * bound must hold for every request, including ones with a caller signal).
 * `AbortSignal.any` propagates the FIRST abort, so the rejection reason
 * still distinguishes `TimeoutError` (our bound) from the caller's abort
 * reason, keeping the retry decision below honest.
 */
function attemptSignal(callerSignal: AbortSignal | null | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(githubFetchTimeoutMs());
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

/**
 * fetch() with retry-with-backoff for transient GitHub failures.
 *
 * Retries 429 and 5xx responses up to `maxAttempts` times with exponential
 * backoff, honoring `Retry-After` / `x-ratelimit-reset` on 429 (capped at
 * `GITHUB_RETRY_MAX_DELAY_MS` per sleep, #1347). Non-retryable responses
 * (e.g. 404) are returned immediately so callers keep their existing error
 * handling. Every attempt carries a fresh timeout bound (#1347): a stalled
 * request rejects instead of hanging the caller. The bound stays armed
 * through BODY consumption too — a slow large response (e.g. a CI job log)
 * aborts mid-read at the caller, which is the point: the wait is bounded
 * even when the server is slow. A timeout is retried only for idempotent
 * reads (GET/HEAD, or POSTs the caller declares read-idempotent via
 * `retryOnTimeout`) — a timed-out write may already have applied
 * server-side, so it re-throws fail-closed and the caller's own fenced
 * protocol decides the retry. A caller-supplied `init.signal` is combined
 * with the bound (cancellation stays the caller's; the bound still holds).
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? GITHUB_FETCH_MAX_ATTEMPTS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const method = (init.method ?? "GET").toUpperCase();
  const timeoutIsRetryable =
    options.retryOnTimeout ?? (method === "GET" || method === "HEAD");

  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      // Fresh signal per attempt: one signal shared across attempts would
      // expire during the backoff sleeps between them.
      response = await fetch(url, {
        ...init,
        signal: attemptSignal(init.signal),
      });
    } catch (error) {
      // A composed signal aborts with `TimeoutError` only when OUR bound
      // fired; any other reason is the caller's cancellation — never retried.
      // (The `!init.signal?.aborted` guard keeps even a caller abort reason
      // *named* TimeoutError from being mistaken for our bound.)
      const timedOut =
        error instanceof Error && error.name === "TimeoutError" && !init.signal?.aborted;
      if (timedOut && timeoutIsRetryable && attempt < maxAttempts) {
        await sleep(Math.min(GITHUB_RETRY_MAX_DELAY_MS, 1000 * 2 ** (attempt - 1)));
        continue;
      }
      throw error;
    }
    if (response.ok || !RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts) {
      return response;
    }
    await sleep(Math.min(GITHUB_RETRY_MAX_DELAY_MS, retryDelayMs(response, attempt)));
  }
}

export function __resetGitHubAppState(): void {
  installationTokenCache = null;
  useGitHubApp = false;
  appNotConfigured = false;
  appInitFailed = false;
  inFlightTokenFetch = null;
}

function getNextLink(response: Response): string | null {
  const link = response.headers.get("Link");
  if (!link) return null;
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  return match?.[1] ?? null;
}

export async function fetchPaginated<T>(
  url: string,
  maxItems = Infinity,
  extractPageItems?: (data: unknown) => T[],
): Promise<T[]> {
  const all: T[] = [];
  let currentUrl: string | null = url;

  while (currentUrl && all.length < maxItems) {
    const response = await fetchWithRetry(currentUrl, { headers: await getHeadersAsync() });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API error: ${response.status} ${text}`);
    }

    const data = await response.json();
    const page = extractPageItems ? extractPageItems(data) : data;
    if (!Array.isArray(page)) {
      throw new Error(`GitHub API error: expected array response from ${currentUrl}`);
    }
    const remaining = maxItems - all.length;
    all.push(...page.slice(0, remaining));

    if (all.length >= maxItems) break;

    currentUrl = getNextLink(response);
  }

  return all;
}

export async function validateGitHubToken(): Promise<boolean> {
  try {
    const response = await fetchWithRetry(`${GITHUB_API}/user`, {
      headers: await getHeadersAsync(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export { GITHUB_API };
