/**
 * Courier contribution status READ client (#1538, parent #1349).
 *
 * The submission path (#1537) proves a request was admitted; it proves
 * nothing about execution or publication. This module reads the authenticated
 * lifecycle contract Courier ships since #836 (v0.1.26):
 * `GET /v1/contributions/<run>?namespace=<ns>` on the SAME configured
 * contribute-API endpoint, answered from Courier's own controller-recorded
 * state — never a forge call, never a parallel state machine.
 *
 * Credential boundary (#1538): the read is authenticated with a SECOND,
 * separately configured credential (`DISPATCH_COURIER_READ_TOKEN`, the
 * counterpart of Courier's `contributeAPI.readKeySecret`). The admission token
 * never authenticates reads and this token never admits, so tracking can be
 * handed read-only authority. When no read token is configured, tracking is
 * UNAVAILABLE and submission is untouched — a missing capability is named,
 * never guessed. The token is never logged, stored, or returned; every
 * diagnostic passes through `redactSecret` first, bound to the FULL configured
 * surface (`credentialSurface`, query included) so the scrubber covers even a
 * query credential configured for the POST surface, independently of what the
 * read happens to send. The read itself derives from a query-less `statusBase`.
 *
 * Endpoint boundary: the status URL is derived from the operator-configured
 * `DISPATCH_COURIER_ADMISSION_URL` (the same `/v1/contributions` surface) plus
 * the stored run identity. Nothing is browser-selected, and `redirect:
 * "error"` stops a redirect from carrying the read credential to another URL.
 *
 * Contract version: the `/v1` path prefix IS the version (Courier #819) — an
 * incompatible change ships as a new prefix, never a silent reshape. A 2xx
 * body that fails the strict shape check is therefore an INCOMPATIBLE
 * response: it is refused with a diagnostic, never guessed into state.
 *
 * Freshness: `observedAt` is always present and bounds the projection ("this
 * instant"). A `404` is deliberately ambiguous (missing, foreign, or reaped);
 * the state machine in `external-contribution-tracking.ts` maps it for a run
 * we previously admitted to an explicit expired observation, never completion.
 */
import { courierAdmissionTimeoutMs, errorName, errorMessage, redactSecret } from "./courier-admission";

/** Operator-configured status-read endpoint + read-only credential, or why tracking is off. */
export type CourierTrackingConfig =
  | {
      ok: true;
      /** The configured `/v1/contributions` surface, query/hash dropped; the run segment is appended per read. */
      statusBase: URL;
      /**
       * The FULL configured surface (query/hash as typed), scrub-only: it
       * anchors `scrubEndpoint` for every diagnostic so a query credential
       * configured for the POST surface is a scrub form even though the read
       * never sends it. Never used to build a request.
       */
      credentialSurface: URL;
      /** Server-side READ-ONLY credential; only ever enters an Authorization header. */
      token: string;
      timeoutMs: number;
    }
  | { ok: false; reason: string };

/**
 * Resolve the tracking configuration. It REUSES the admission endpoint (the
 * status route lives on the same contribute-API Service) but requires its own
 * read token. Missing endpoint or missing read token disables tracking
 * fail-closed with an operator-safe reason; submission is unaffected.
 */
export function getCourierTrackingConfig(): CourierTrackingConfig {
  const rawUrl = process.env.DISPATCH_COURIER_ADMISSION_URL?.trim();
  const token = process.env.DISPATCH_COURIER_READ_TOKEN?.trim();

  if (!rawUrl) {
    return {
      ok: false,
      reason:
        "Courier tracking is unavailable — no contribute-API endpoint is configured. Set DISPATCH_COURIER_ADMISSION_URL and DISPATCH_COURIER_READ_TOKEN (server-side, read-only) to enable lifecycle reads.",
    };
  }
  if (!token) {
    return {
      ok: false,
      reason:
        "Courier tracking is unavailable — the read-only credential is not configured. Set DISPATCH_COURIER_READ_TOKEN (the counterpart of Courier's contributeAPI.readKeySecret). Submission remains unaffected.",
    };
  }

  let statusBase: URL;
  try {
    statusBase = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      reason: "Courier tracking is unavailable — DISPATCH_COURIER_ADMISSION_URL is not a valid URL.",
    };
  }
  if (statusBase.protocol !== "https:" && statusBase.protocol !== "http:") {
    return {
      ok: false,
      reason: "Courier tracking is unavailable — DISPATCH_COURIER_ADMISSION_URL must be an http(s) URL.",
    };
  }
  if (!statusBase.hostname) {
    return {
      ok: false,
      reason: "Courier tracking is unavailable — DISPATCH_COURIER_ADMISSION_URL has no host.",
    };
  }
  // The status route is `<surface>/<run>`; drop any trailing slashes so the
  // run segment cannot produce `//run` (and never guess a different prefix —
  // the `/v1` prefix is the contract version).
  statusBase.pathname = statusBase.pathname.replace(/\/+$/, "");
  // Keep the full configured surface (query included) as the SCRUB anchor, then
  // drop the query/hash from the construction base: a read rebuilds the query
  // from the stored run identity and never sends the configured one, and the
  // scrub coverage never depends on that construction behavior.
  const credentialSurface = new URL(statusBase);
  statusBase.search = "";
  statusBase.hash = "";

  return { ok: true, statusBase, credentialSurface, token, timeoutMs: courierAdmissionTimeoutMs() };
}

/**
 * A run name Courier can address: non-empty, printable, and inside the 253
 * byte cap the status route enforces before cluster contact. The ledger value
 * came from Courier itself, so this is defense-in-depth before it re-enters a
 * URL path — `encodeURIComponent` bounds the rest.
 */
export function isAddressableRunName(run: string): boolean {
  // A dot-only name would collapse path segments on the surface URL.
  if (!run || /^\.+$/.test(run)) return false;
  if (Buffer.byteLength(run, "utf8") > 253) return false;
  return !/[\u0000-\u0020\u007f/\\]/.test(run);
}

/** Build `<surface>/<run>?namespace=<ns>`. Never derived from request data. */
export function contributionStatusUrl(config: Extract<CourierTrackingConfig, { ok: true }>, run: string, namespace: string): URL {
  const url = new URL(config.statusBase.toString());
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeURIComponent(run)}`;
  url.search = "";
  url.hash = "";
  if (namespace) url.searchParams.set("namespace", namespace);
  return url;
}

/** The bounded publication identity Courier recorded (created-or-updated; Courier never merges). */
export interface CourierPublication {
  branch: string | null;
  headRepo: string | null;
  headSha: string | null;
  pr: string | null;
}

/** The bounded terminal cause classification (category + declared outcome; never free prose). */
export interface CourierCause {
  category: string | null;
  outcome: string | null;
}

/** The verified 2xx projection (`ContributionStatus`, Courier status.go). */
export interface CourierContributionStatus {
  run: string;
  namespace: string;
  lane: string;
  baseRepo: string;
  workRepo: string;
  /** CRD phase verbatim; `unknown` only before the controller first stamps. */
  phase: string;
  ciParked: boolean;
  publication: CourierPublication | null;
  cause: CourierCause | null;
  phaseEnteredAt: Date | null;
  finishedAt: Date | null;
  /** Courier's own read-instant freshness bound; always present. */
  observedAt: Date;
}

export type TrackingReadResult =
  | { outcome: "ok"; status: CourierContributionStatus }
  /** Shared miss: missing, foreign-source, or reaped run — never confirms which. */
  | { outcome: "notFound"; diagnostic: string }
  /** Explicit refusal other than 404 (401/403/405/4xx): the read credential or surface is wrong. */
  | { outcome: "refused"; httpStatus: number; diagnostic: string }
  /** 5xx (incl. 503 + Retry-After), timeout, network failure, or an INCOMPATIBLE 2xx shape. */
  | {
      outcome: "unavailable";
      httpStatus?: number;
      diagnostic: string;
      timeout: boolean;
      retryAfterMs?: number;
    };

/** Cap any stored/logged string (diagnostics AND projected fields) at a ledger-safe bound. */
const MAX_FIELD_LENGTH = 1024;

function bound(text: string): string {
  return text.length > MAX_FIELD_LENGTH ? `${text.slice(0, MAX_FIELD_LENGTH)}…` : text;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? bound(trimmed) : null;
}

function parseDateOrNull(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Strict allowlist parse of the 2xx body. Required scalars missing or
 * mistyped = an incompatible contract shape, refused wholesale (never a
 * partial guess). Unknown EXTRA fields are ignored (the allowlist is the
 * frontend's protection, per Courier #819).
 */
export function parseContributionStatus(bodyText: string, httpStatus: number, token: string, endpoint: URL): TrackingReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return incompatibleShape(httpStatus, token, "body was not JSON", endpoint);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return incompatibleShape(httpStatus, token, "body was not a JSON object", endpoint);
  }
  const body = parsed as Record<string, unknown>;

  const run = optionalString(body.run);
  const namespace = optionalString(body.namespace);
  const lane = optionalString(body.lane);
  const baseRepo = optionalString(body.baseRepo);
  const workRepo = optionalString(body.workRepo);
  const phase = optionalString(body.phase);
  const observedAt = parseDateOrNull(body.observedAt);
  if (!run || !namespace || !lane || !baseRepo || !workRepo || !phase || !observedAt) {
    return incompatibleShape(httpStatus, token, "body is missing one of run/namespace/lane/baseRepo/workRepo/phase/observedAt", endpoint);
  }
  if (typeof body.ciParked !== "boolean") {
    return incompatibleShape(httpStatus, token, "body ciParked is not a boolean", endpoint);
  }

  let publication: CourierPublication | null = null;
  if (body.publication !== undefined && body.publication !== null) {
    if (typeof body.publication !== "object" || Array.isArray(body.publication)) {
      return incompatibleShape(httpStatus, token, "body publication is not an object", endpoint);
    }
    const p = body.publication as Record<string, unknown>;
    publication = {
      branch: optionalString(p.branch),
      headRepo: optionalString(p.headRepo),
      headSha: optionalString(p.headSha),
      pr: optionalString(p.pr),
    };
  }

  let cause: CourierCause | null = null;
  if (body.cause !== undefined && body.cause !== null) {
    if (typeof body.cause !== "object" || Array.isArray(body.cause)) {
      return incompatibleShape(httpStatus, token, "body cause is not an object", endpoint);
    }
    const c = body.cause as Record<string, unknown>;
    cause = { category: optionalString(c.category), outcome: optionalString(c.outcome) };
  }

  return {
    outcome: "ok",
    status: {
      run,
      namespace,
      lane,
      baseRepo,
      workRepo,
      phase,
      ciParked: body.ciParked,
      publication,
      cause,
      phaseEnteredAt: parseDateOrNull(body.phaseEnteredAt),
      finishedAt: parseDateOrNull(body.finishedAt),
      observedAt,
    },
  };
}

function incompatibleShape(httpStatus: number, token: string, detail: string, endpoint: URL): TrackingReadResult {
  return {
    outcome: "unavailable",
    httpStatus,
    diagnostic: redactSecret(
      `courier status returned HTTP ${httpStatus} in an unrecognized shape (${detail}); the /v1 contract refuses silent reshapes, so the response is refused rather than guessed`,
      token,
      endpoint,
    ),
    timeout: false,
  };
}

/** Parse a `Retry-After` header (integer seconds); Courier sends `1` on saturation. */
function parseRetryAfterMs(response: Response): number | undefined {
  const raw = response.headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

function diagnosticFromErrorBody(bodyText: string, status: number): string {
  const base = `courier status read answered HTTP ${status}`;
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return `${base}: ${parsed.error.trim()}`;
    }
  } catch {
    // Not JSON — the bounded base alone.
  }
  return base;
}

/**
 * One bounded status read for one stored run identity. No retry policy here —
 * the caller owns refresh pacing; this performs a single attempt so the
 * duplicate-prevention fence (the atomic cooldown claim) is what paces Courier.
 */
export async function fetchContributionStatus(
  run: string,
  namespace: string,
  config: Extract<CourierTrackingConfig, { ok: true }>,
): Promise<TrackingReadResult> {
  // Bound every retained/returned diagnostic to this read credential + the FULL
  // configured surface: strip the READ token AND every credential-bearing form
  // (userinfo, origin, configured query pairs) that a runtime may echo.
  const scrub = (text: string) => redactSecret(text, config.token, config.credentialSurface);
  if (!isAddressableRunName(run)) {
    return {
      outcome: "refused",
      httpStatus: 400,
      diagnostic: scrub("stored courier run name is not an addressable run identifier; the status read was not sent"),
    };
  }
  const url = contributionStatusUrl(config, run, namespace);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const name = errorName(error);
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        outcome: "unavailable",
        diagnostic: scrub(`courier status read timed out after ${config.timeoutMs}ms`),
        timeout: true,
      };
    }
    return {
      outcome: "unavailable",
      diagnostic: scrub(`courier status read failed: ${errorMessage(error)}`),
      timeout: false,
    };
  }

  // Body consumption runs OUTSIDE the fetch guard (#1627 lesson): headers
  // arriving is not a readable answer. A failed body read on a GET settles as
  // unavailable — nothing was mutated, a later refresh simply tries again.
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    const name = errorName(error);
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return {
      outcome: "unavailable",
      httpStatus: response.status,
      diagnostic: scrub(
        timedOut
          ? `courier status response body read timed out after ${config.timeoutMs}ms`
          : `courier status response body read failed: ${errorMessage(error)}`,
      ),
      timeout: timedOut,
    };
  }

  if (response.status === 404) {
    // Shared miss by design: missing, foreign-source, or reaped. The caller
    // maps it for a previously-admitted run to an explicit expired state.
    return {
      outcome: "notFound",
      diagnostic: scrub(`${diagnosticFromErrorBody(bodyText, 404)} — the run was never admitted here, was reaped after retention, or is not a contribution run`),
    };
  }
  if (response.status === 200) {
    return parseContributionStatus(bodyText, response.status, config.token, config.credentialSurface);
  }
  if (response.status >= 400 && response.status < 500) {
    return {
      outcome: "refused",
      httpStatus: response.status,
      diagnostic: scrub(diagnosticFromErrorBody(bodyText, response.status)),
    };
  }
  const retryAfterMs = parseRetryAfterMs(response);
  return {
    outcome: "unavailable",
    httpStatus: response.status,
    diagnostic: scrub(`${diagnosticFromErrorBody(bodyText, response.status)}${retryAfterMs !== undefined ? ` (retry after ${retryAfterMs}ms)` : ""}`),
    timeout: false,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}
