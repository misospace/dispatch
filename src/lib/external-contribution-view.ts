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
import type { ExternalContributionRow } from "./external-contribution";

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
 * What the operator UI may show about the Courier surface (#1539): the
 * configured endpoint and approved namespaces, credential PRESENCE (never
 * values), and — when submission or tracking is disabled — the same named
 * capability gap the API answers with. Derived from the fail-closed config
 * resolvers, so the UI can never show a destination the server would refuse
 * to use, and a secret has no path into this object.
 */
export interface CourierSurfaceView {
  /** The configured admission endpoint, or null while submission is unconfigured. */
  endpoint: string | null;
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
}

export function projectCourierSurface(): CourierSurfaceView {
  const admission = getCourierAdmissionConfig();
  const tracking = getCourierTrackingConfig();
  return {
    // The endpoint is only shown when the full admission config resolved;
    // a half-configured surface shows the named gap instead.
    endpoint: admission.ok ? admission.endpoint.toString() : null,
    namespaces: parseDelimitedList(process.env.DISPATCH_COURIER_ADMISSION_NAMESPACES),
    admissionTokenConfigured: Boolean(process.env.DISPATCH_COURIER_ADMISSION_TOKEN?.trim()),
    readTokenConfigured: Boolean(process.env.DISPATCH_COURIER_READ_TOKEN?.trim()),
    admissionReason: admission.ok ? null : admission.reason,
    trackingAvailable: tracking.ok,
    trackingReason: tracking.ok ? null : tracking.reason,
  };
}
