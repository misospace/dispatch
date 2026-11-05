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
   * 5xx, or a malformed 2xx body. Safe to retry later with the SAME key;
   * Courier's idempotency key dedupes a double admission.
   */
  | { outcome: "uncertain"; httpStatus?: number; diagnostic: string; timeout: boolean };

/** Upper bound for any stored/logged diagnostic (keeps ledger rows bounded). */
const MAX_DIAGNOSTIC_LENGTH = 500;

/**
 * Bound a diagnostic and strip any occurrence of `secret` from it. Applied to
 * every string this module (and the submission route) may store or log, so
 * the credential cannot leak into the ledger, the audit log, or a response.
 */
export function redactSecret(text: string, secret: string): string {
  let redacted = text;
  if (secret) redacted = redacted.split(secret).join("[redacted]");
  if (redacted.length > MAX_DIAGNOSTIC_LENGTH) {
    redacted = `${redacted.slice(0, MAX_DIAGNOSTIC_LENGTH)}…[truncated]`;
  }
  return redacted;
}

/** Pull a bounded, token-redacted error string out of a Courier error body. */
function diagnosticFromErrorBody(bodyText: string, status: number, token: string): string {
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
 * Submit one admission request to the configured endpoint. One network
 * attempt per call — retry policy (uncertain delivery, original key, bounded)
 * is the caller's state machine, not this module's.
 */
export async function submitAdmission(fields: AdmissionRequestFields, config: Extract<CourierAdmissionConfig, { ok: true }>): Promise<AdmissionResult> {
  const payload = buildAdmissionPayload(fields);
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
    if (error instanceof Error && error.name === "TimeoutError") {
      return {
        outcome: "uncertain",
        diagnostic: `courier admission timed out after ${config.timeoutMs}ms; delivery outcome unknown`,
        timeout: true,
      };
    }
    if (error instanceof Error && error.name === "AbortError") {
      return {
        outcome: "uncertain",
        diagnostic: `courier admission request aborted after ${config.timeoutMs}ms; delivery outcome unknown`,
        timeout: true,
      };
    }
    const detail = error instanceof Error ? error.message : "Unknown network error";
    return {
      outcome: "uncertain",
      diagnostic: `courier admission request failed: ${detail}`,
      timeout: false,
    };
  }

  const bodyText = await response.text();
  if (response.status === 200 || response.status === 201) {
    return parseAdmissionIdentity(response.status, bodyText);
  }
  const diagnostic = redactSecret(diagnosticFromErrorBody(bodyText, response.status, config.token), config.token);
  if (response.status >= 400 && response.status < 500) {
    return { outcome: "rejected", httpStatus: response.status, diagnostic };
  }
  return {
    outcome: "uncertain",
    httpStatus: response.status,
    diagnostic: redactSecret(
      `courier admission returned HTTP ${response.status}; delivery outcome unknown${bodyText.trim() ? `: ${bodyText.trim()}` : ""}`,
      config.token,
    ),
    timeout: false,
  };
}

/** A fresh contribution identity for a deliberate new submission. */
export function newIdempotencyKey(): string {
  return randomUUID();
}
