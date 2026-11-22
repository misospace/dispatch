/**
 * Shared response projection for external contribution requests (#1537,
 * extended by #1538), plus the sanitized configuration view the operator UI
 * renders (#1539). One projection for every surface — POST submission, the
 * stored-evidence reads, and refresh — so no route can drift toward leaking
 * more (or less) than the others. No credential ever exists here.
 */
import { getCourierAdmissionConfig } from "./courier-admission";
import { getCourierTrackingConfig } from "./courier-tracking";
import { parseDelimitedList } from "./config-parsers";
import { projectTracking } from "./external-contribution-tracking";
import { MAX_DELIVERY_ATTEMPTS, type ExternalContributionRow } from "./external-contribution";

export function projectExternalContribution(row: ExternalContributionRow, now: Date = new Date()) {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    status: row.deliveryStatus,
    // The identity Courier returned (null until accepted). Identity is not
    // proof of successful execution or publication.
    run: row.courierRun,
    namespace: row.courierNamespace ?? row.namespace,
    workItemId: row.courierWorkItemId,
    resumed: row.resumed,
    baseRepo: row.baseRepo,
    baseRef: row.baseRef,
    workRepo: row.workRepo,
    // The recorded request itself (#1539): the operator UI shows the goal and
    // lane it submitted without inventing a second projection. Bounded by the
    // same shape limits the submission validator enforces (goal ≤ 10k chars,
    // lane ≤ 64) and maintainer-tier only, like every other surface.
    lane: row.lane,
    goal: row.goal,
    upstreamIssue: row.upstreamIssue,
    attempts: row.attemptCount,
    lastError: row.lastError,
    // The #1538 lifecycle view: last trustworthy Courier observation, its
    // freshness, and the derived state (admitted | executing | published |
    // completed | failed | unavailable | expired). Read from the ledger only.
    tracking: projectTracking(row, now),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The exact JSON shape every external-contribution route answers with. */
export type ExternalContributionView = ReturnType<typeof projectExternalContribution>;
/** The lifecycle half of the shared projection (#1538). */
export type TrackingView = ExternalContributionView["tracking"];

/**
 * The JSON form of a projection after serialization through an HTTP response
 * (every `Date` becomes an ISO string). Clients type their fetch bodies with
 * this instead of hand-mirroring the projection, so a server-side shape change
 * cannot silently diverge from what the browser assumes.
 */
export type WireValue<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? WireValue<U>[]
    : T extends object
      ? { [K in keyof T]: WireValue<T[K]> }
      : T;
/** Exactly what the external-contribution routes answer with, over JSON. */
export type ExternalContributionWire = WireValue<ExternalContributionView>;

/**
 * What the operator UI may show about the Courier surface (#1539): endpoint
 * PRESENCE and approved namespaces, credential PRESENCE (never values), and —
 * when submission or tracking is disabled — the same named capability gap the
 * API answers with. Derived from the fail-closed config resolvers, so the UI
 * can never show a destination the server would refuse to use, and a secret
 * has no path into this object.
 *
 * The endpoint URL itself is deliberately NOT part of this view: it is a
 * credential-bearing transport URL (an operator may configure it with userinfo
 * or token-like query parameters), and #1539 forbids placing arbitrary
 * admission endpoints in browser state. Presence is all the UI needs.
 */
export interface CourierSurfaceView {
  /** True when `DISPATCH_COURIER_ADMISSION_URL` is set (presence only, not validity — `admissionReason` names any config gap); the URL itself never ships. */
  endpointConfigured: boolean;
  /** Operator-approved namespaces (empty until explicitly configured). */
  namespaces: string[];
  /** Presence only — the token itself is never readable from this process's config view. */
  admissionTokenConfigured: boolean;
  readTokenConfigured: boolean;
  /** Non-null exactly when submission is disabled; names the missing piece. */
  admissionReason: string | null;
  trackingAvailable: boolean;
  /** Non-null exactly when tracking is disabled; names the missing piece. */
  trackingReason: string | null;
  /** The server's bound on delivery attempts per request identity (shared single source). */
  maxDeliveryAttempts: number;
}

export function projectCourierSurface(): CourierSurfaceView {
  const admission = getCourierAdmissionConfig();
  const tracking = getCourierTrackingConfig();
  return {
    // Presence only — the configured URL never enters the browser tree, so a
    // userinfo/query-bearing endpoint cannot cross the credential boundary.
    endpointConfigured: Boolean(process.env.DISPATCH_COURIER_ADMISSION_URL?.trim()),
    namespaces: parseDelimitedList(process.env.DISPATCH_COURIER_ADMISSION_NAMESPACES),
    admissionTokenConfigured: Boolean(process.env.DISPATCH_COURIER_ADMISSION_TOKEN?.trim()),
    readTokenConfigured: Boolean(process.env.DISPATCH_COURIER_READ_TOKEN?.trim()),
    admissionReason: admission.ok ? null : admission.reason,
    trackingAvailable: tracking.ok,
    trackingReason: tracking.ok ? null : tracking.reason,
    maxDeliveryAttempts: MAX_DELIVERY_ATTEMPTS,
  };
}
