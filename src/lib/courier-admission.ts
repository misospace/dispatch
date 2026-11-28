/**
 * Courier HTTP admission client (#1537, parent #1349; wire contract Courier
 * #708, shipped 0.1.16 — at v0.1.18 `internal/source/adhoc/server.go` accepts
 * `POST /v1/contributions` only).
 *
 * This module owns ONLY the network hop and its configuration. It never
 * decides contribution policy (Courier does), never touches tracked upstream
 * issues, never writes Kubernetes state, and never persists anything — the
 * Dispatch-owned request ledger lives in `external-contribution.ts`.
 *
 * Credential boundary: the operator-configured admission token
 * (`DISPATCH_COURIER_ADMISSION_TOKEN`) is read server-side, attached to the
 * single configured endpoint, and never logged, stored, or returned. Every
 * diagnostic that could echo server or body text goes through
 * `redactSecret` before it can reach a log line, the ledger, or a response.
 * The endpoint URL is itself credential-bearing (an operator may configure
 * userinfo or a token-like query), so `redactSecret` also scrubs the endpoint's
 * origin/userinfo/query via `scrubEndpoint`: some runtimes echo the full request
 * URL in a fetch error string, and the bearer token is only one secret in it.
 *
 * Endpoint boundary: the endpoint is operator configuration only. Fetch runs
 * with `redirect: "error"`, so a misconfigured or compromised endpoint cannot
 * bounce a credential-bearing request to an arbitrary URL. Nothing else in
 * Dispatch may aim these credentials at a URL.
 *
 * Privileged choices are not request-controlled: `fresh`/`debug` are Courier
 * operator choices and are deliberately absent from the payload this module
 * builds — a browser or caller cannot smuggle them in, because the body is
 * constructed field-by-field from the validated request.
 *
 * Missing or malformed configuration disables submission (see
 * `getCourierAdmissionConfig`) without affecting any other Dispatch queue.
 */
import { randomUUID } from "node:crypto";
import { parseDelimitedList } from "./config";

/** The operator-configured admission endpoint + credential, or why it is off. */
export type CourierAdmissionConfig =
  | {
      ok: true;
      /** The exact endpoint Dispatch POSTs to. Never derived from request data. */
      endpoint: URL;
      /** Server-side credential; never leaves this module except into the Authorization header. */
      token: string;
      /** Operator-approved namespaces. A request outside the list is a validation failure. */
      namespaces: string[];
      timeoutMs: number;
    }
  | { ok: false; reason: string };

const DEFAULT_ADMISSION_TIMEOUT_MS = 30_000;
const ADMISSION_TIMEOUT_FLOOR_MS = 1_000;

/** `DISPATCH_COURIER_ADMISSION_TIMEOUT_MS`, floored at 1s (mirrors githubFetchTimeoutMs). */
export function courierAdmissionTimeoutMs(): number {
  const raw = Number(process.env.DISPATCH_COURIER_ADMISSION_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ADMISSION_TIMEOUT_MS;
  return Math.max(raw, ADMISSION_TIMEOUT_FLOOR_MS);
}

/**
 * Resolve the operator-configured admission configuration. Any missing or
 * invalid piece disables submission FAIL-CLOSED: the approved-namespace list
 * must be configured explicitly (an empty list approves nothing), mirroring
 * the `DISPATCH_REBASE_AGENTS` posture. The returned reason is safe to show
 * an operator and never contains the token.
 */
export function getCourierAdmissionConfig(): CourierAdmissionConfig {
  const rawUrl = process.env.DISPATCH_COURIER_ADMISSION_URL?.trim();
  const token = process.env.DISPATCH_COURIER_ADMISSION_TOKEN?.trim();
  const namespaces = parseDelimitedList(process.env.DISPATCH_COURIER_ADMISSION_NAMESPACES);

  if (!rawUrl || !token) {
    return {
      ok: false,
      reason:
        "Courier admission is not configured — submission is disabled. Set DISPATCH_COURIER_ADMISSION_URL and DISPATCH_COURIER_ADMISSION_TOKEN (server-side) to enable it.",
    };
  }
  if (namespaces.length === 0) {
    return {
      ok: false,
      reason:
        "Courier admission has no approved namespaces — submission is disabled. Set DISPATCH_COURIER_ADMISSION_NAMESPACES to the namespaces submission may target.",
    };
  }

  let endpoint: URL;
  try {
    endpoint = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      reason: "Courier admission is disabled — DISPATCH_COURIER_ADMISSION_URL is not a valid URL.",
    };
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    return {
      ok: false,
      reason: "Courier admission is disabled — DISPATCH_COURIER_ADMISSION_URL must be an http(s) URL.",
    };
  }
  if (!endpoint.hostname) {
    return {
      ok: false,
      reason: "Courier admission is disabled — DISPATCH_COURIER_ADMISSION_URL has no host.",
    };
  }

  return { ok: true, endpoint, token, namespaces, timeoutMs: courierAdmissionTimeoutMs() };
}

/** The canonical AdmissionRequest fields the wire contract names (Courier #708). */
export interface AdmissionRequestFields {
  namespace: string;
  lane: string;
  baseRepo: string;
  baseRef: string;
  workRepo: string;
  goal: string;
  upstreamIssue: string | null;
  idempotencyKey: string;
}

/**
 * Build the exact POST body. Fixed key order (so the payload is canonical and
 * comparable) and field-by-field construction (so no caller-supplied key —
 * in particular `fresh`/`debug`, which are privileged operator choices in
 * Courier, not browser-controlled defaults — can enter the payload).
 */
export function buildAdmissionPayload(fields: AdmissionRequestFields): string {
  const body: Record<string, string> = {
    namespace: fields.namespace,
    lane: fields.lane,
    baseRepo: fields.baseRepo,
    baseRef: fields.baseRef,
    workRepo: fields.workRepo,
    goal: fields.goal,
  };
  if (fields.upstreamIssue) body.upstreamIssue = fields.upstreamIssue;
  body.idempotencyKey = fields.idempotencyKey;
  return JSON.stringify(body);
}

/** The admission identity Courier returns on 201 (creation) / 200 (resume). */
export interface AdmissionIdentity {
  run: string;
  namespace: string;
  workItemId: string;
  resumed: boolean;
}

export type AdmissionResult =
  | ({ outcome: "created" } & AdmissionIdentity)
  | ({ outcome: "resumed" } & AdmissionIdentity)
  /** Explicit Courier refusal (4xx). Terminal — the policy call is Courier's. */
  | { outcome: "rejected"; httpStatus: number; diagnostic: string }
  /**
   * Delivery outcome unknown: timeout, network failure, refused redirect,
   * 5xx, a malformed 2xx body, or a response-body read failure (#1627 —
   * headers arrived, so the request may have reached Courier). Safe to
   * retry later with the SAME key; Courier's idempotency key dedupes a
   * double admission.
   */
  | { outcome: "uncertain"; httpStatus?: number; diagnostic: string; timeout: boolean };

/** Upper bound for any stored/logged diagnostic (keeps ledger rows bounded). */
const MAX_DIAGNOSTIC_LENGTH = 500;

/** Marker left where a credential-bearing endpoint component was removed. */
const SCRUBBED_ENDPOINT = "[scrubbed-endpoint]";

/** Decode a WHATWG URL component (already a valid percent-encoding); never throws. */
function tryDecodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Remove the configured endpoint's credential-bearing components from a
 * diagnostic: its origin, userinfo, and query. The URL is operator configuration
 * and may carry `user:pass@` or `?token=***`; a runtime fetch error can echo the
 * whole request URL, and `redactSecret`'s exact-token strip alone cannot cover
 * the other secrets inside that URL.
 *
 * Every candidate form carries structural context (a scheme, `@host`, or `?`),
 * so scrubbing removes the URL without mangling unrelated diagnostic text — a
 * bare host is never scrubbed, since it is not a secret and a DNS/connect error
 * that names only the host carries no credential. Forms are removed longest-first
 * so a whole-URL echo is gone before its parts. Both the normalized (`URL.href`)
 * and the operator-typed (decoded userinfo) spellings are covered, since a
 * runtime may echo the raw configuration string. The query is scrubbed whole
 * AND pair-by-pair, because a derived-URL echo can carry a configured pair
 * behind another parameter (`?namespace=…&token=…`), where only the delimiter-
 * prefixed pair form matches. Idempotent: every form holds a `:`, `@`, `?`, or
 * `&`, and the `[scrubbed-endpoint]` placeholder holds none.
 */
export function scrubEndpoint(text: string, endpoint: URL): string {
  if (!text) return text;
  // Only a configured http(s) surface can carry a credential here; the config
  // resolvers already enforce this, and `.origin` is opaque (`"null"`) otherwise.
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") return text;
  const hasUserinfo = Boolean(endpoint.username || endpoint.password);
  const authority = hasUserinfo
    ? `${endpoint.username}${endpoint.password ? `:${endpoint.password}` : ""}@${endpoint.host}`
    : endpoint.host;
  const forms: string[] = [];
  const add = (form: string) => {
    if (form && !forms.includes(form)) forms.push(form);
  };
  add(endpoint.href);
  add(`${endpoint.protocol}//${authority}`);
  if (hasUserinfo) {
    add(`${authority}${endpoint.pathname}${endpoint.search}`);
    add(`//${authority}`);
    add(authority);
    // Raw echo: the userinfo the operator typed, before the URL parser
    // percent-encoded it (e.g. `p%40ss` vs `p@ss`).
    const rawAuthority = `${tryDecodeComponent(endpoint.username)}${
      endpoint.password ? `:${tryDecodeComponent(endpoint.password)}` : ""
    }@${endpoint.host}`;
    add(`${rawAuthority}${endpoint.pathname}${endpoint.search}`);
    add(`${endpoint.protocol}//${rawAuthority}`);
    add(rawAuthority);
    add(`//${rawAuthority}`);
  }
  add(endpoint.origin);
  // Query forms keep a `?`/`&` anchor: a scheme-less/`?`-less token would be a
  // bare substring with no structural bound. A valueless pair is not scrubbed
  // as a pair — a bare flag is too short to anchor without mangling unrelated
  // text — and stays covered only by the contiguous whole-query form.
  if (endpoint.search) {
    add(endpoint.search);
    for (const pair of endpoint.search.slice(1).split("&")) {
      const separator = pair.indexOf("=");
      if (separator < 1 || separator === pair.length - 1) continue;
      add(`?${pair}`);
      add(`&${pair}`);
      const decodedPair = tryDecodeComponent(pair);
      if (decodedPair !== pair) {
        add(`?${decodedPair}`);
        add(`&${decodedPair}`);
      }
    }
  }
  let scrubbed = text;
  for (const form of forms.sort((a, b) => b.length - a.length)) {
    scrubbed = scrubbed.split(form).join(SCRUBBED_ENDPOINT);
  }
  return scrubbed;
}

/**
 * Bound a diagnostic, strip any occurrence of `secret`, and scrub the
 * configured endpoint's origin/userinfo/query. Applied to every string this
 * module (and the submission/tracking routes) may store or log, so neither the
 * credential nor the credential-bearing URL can leak into the ledger, the audit
 * log, or a response. `endpoint` is REQUIRED: every credential-path diagnostic
 * is bound to its surface, so a future call site cannot silently omit the URL
 * scrub. Scrub runs before the length bound so a truncated tail can never split
 * a URL fragment past a removed component.
 */
export function redactSecret(text: string, secret: string, endpoint: URL): string {
  let redacted = scrubEndpoint(text, endpoint);
  if (secret) redacted = redacted.split(secret).join("[redacted]");
  if (redacted.length > MAX_DIAGNOSTIC_LENGTH) {
    redacted = `${redacted.slice(0, MAX_DIAGNOSTIC_LENGTH)}…[truncated]`;
  }
  return redacted;
}

/** Compose an error-body diagnostic; the caller scrubs it before it is retained. */
function diagnosticFromErrorBody(bodyText: string, status: number): string {
  const base = `courier admission rejected with HTTP ${status}`;
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return `${base}: ${parsed.error.trim()}`;
    }
  } catch {
    // Not JSON — fall through to the bounded raw slice below.
  }
  const trimmed = bodyText.trim();
  if (!trimmed) return base;
  return `${base}: ${trimmed}`;
}

/** Well-formed 2xx admission body (contract: run, namespace, workItemId, resumed). */
function parseAdmissionIdentity(status: number, bodyText: string): AdmissionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      outcome: "uncertain",
      httpStatus: status,
      diagnostic: `courier admission returned HTTP ${status} with a non-JSON body; delivery outcome unknown`,
      timeout: false,
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {
      outcome: "uncertain",
      httpStatus: status,
      diagnostic: `courier admission returned HTTP ${status} with a malformed body; delivery outcome unknown`,
      timeout: false,
    };
  }
  const body = parsed as Record<string, unknown>;
  const run = typeof body.run === "string" ? body.run : undefined;
  const namespace = typeof body.namespace === "string" ? body.namespace : undefined;
  const workItemId = typeof body.workItemId === "string" ? body.workItemId : undefined;
  const resumed = typeof body.resumed === "boolean" ? body.resumed : undefined;
  if (!run || !namespace || !workItemId || resumed === undefined) {
    return {
      outcome: "uncertain",
      httpStatus: status,
      diagnostic: `courier admission returned HTTP ${status} but the body is missing run/namespace/workItemId/resumed; delivery outcome unknown`,
      timeout: false,
    };
  }
  return { outcome: resumed ? "resumed" : "created", run, namespace, workItemId, resumed };
}

/**
 * Read `name` / `message` off a thrown value WITHOUT requiring `instanceof
 * Error`: fetch/abort failures arrive as `DOMException` (`TimeoutError`,
 * `AbortError`), which does not subclass `Error` in every runtime.
 */
export function errorName(error: unknown): string {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" ? name : "";
}

export function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message ? message : "Unknown network error";
}

/**
 * Submit one admission request to the configured endpoint. One network
 * attempt per call — retry policy (uncertain delivery, original key, bounded)
 * is the caller's state machine, not this module's.
 */
export async function submitAdmission(fields: AdmissionRequestFields, config: Extract<CourierAdmissionConfig, { ok: true }>): Promise<AdmissionResult> {
  const payload = buildAdmissionPayload(fields);
  // Bound every retained/returned diagnostic to this endpoint + token: strip
  // the bearer secret AND the credential-bearing request URL that a runtime may
  // echo in a fetch error string, before it can reach the ledger or a response.
  const scrub = (text: string) => redactSecret(text, config.token, config.endpoint);
  let response: Response;
  try {
    // `redirect: "error"` is the credential guard: a redirect would be a
    // different URL receiving the Authorization header. Fail as uncertain.
    response = await fetch(config.endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: payload,
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const name = errorName(error);
    if (name === "TimeoutError") {
      return {
        outcome: "uncertain",
        diagnostic: `courier admission timed out after ${config.timeoutMs}ms; delivery outcome unknown`,
        timeout: true,
      };
    }
    if (name === "AbortError") {
      return {
        outcome: "uncertain",
        diagnostic: `courier admission request aborted after ${config.timeoutMs}ms; delivery outcome unknown`,
        timeout: true,
      };
    }
    return {
      outcome: "uncertain",
      diagnostic: scrub(`courier admission request failed: ${errorMessage(error)}`),
      timeout: false,
    };
  }

  // Body consumption runs OUTSIDE the fetch guard (#1627): fetch resolves once
  // response headers arrive, so a timeout or connection reset while READING
  // the body throws here — and the request may already have reached Courier.
  // Settle it as uncertain delivery (same retry-with-SAME-key contract as a
  // failed fetch) instead of letting it escape to the caller's state machine.
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    const name = errorName(error);
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return {
      outcome: "uncertain",
      httpStatus: response.status,
      diagnostic: scrub(
        timedOut
          ? `courier admission response body read timed out after ${config.timeoutMs}ms; delivery outcome unknown`
          : `courier admission response body read failed: ${errorMessage(error)}; delivery outcome unknown`,
      ),
      timeout: timedOut,
    };
  }

  if (response.status === 200 || response.status === 201) {
    return parseAdmissionIdentity(response.status, bodyText);
  }
  const diagnostic = scrub(diagnosticFromErrorBody(bodyText, response.status));
  if (response.status >= 400 && response.status < 500) {
    return { outcome: "rejected", httpStatus: response.status, diagnostic };
  }
  return {
    outcome: "uncertain",
    httpStatus: response.status,
    diagnostic: scrub(
      `courier admission returned HTTP ${response.status}; delivery outcome unknown${bodyText.trim() ? `: ${bodyText.trim()}` : ""}`,
    ),
    timeout: false,
  };
}

/** A fresh contribution identity for a deliberate new submission. */
export function newIdempotencyKey(): string {
  return randomUUID();
}
