/**
 * Shared response projection for external contribution requests (#1537,
 * extended by #1538). One projection for every surface — POST submission,
 * the stored-evidence reads, and refresh — so no route can drift toward
 * leaking more (or less) than the others. No credential ever exists here.
 */
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
