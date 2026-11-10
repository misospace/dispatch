// Barrel re-exports for the split pr-fix-queue modules (issue #1592).
// Public surface is identical to the pre-split single-file module.

export type { PrFixQueueClient } from "./pr-fix-queue/client";
export { MAX_EVIDENCE_LENGTH, nonEmpty, resolvePrFixOutcome, normalizeQueueRepo, DEFAULT_PR_FIX_HANDOUT_TIMEOUT_MS, DEFAULT_PR_FIX_MAX_RECLAIMS, prFixHandoutTimeoutMs, maxPrFixReclaims, DEFAULT_PR_FIX_ACK_LIVENESS_MS, prFixAckLivenessMs } from "./pr-fix-queue/shared";
export { REBASE_LANE_ADVISORY_LOCK_KEY, parseRebaseAgentPool, isRebaseLaneAgent, withRebaseLaneAdmission, withHandoutLaneExclusivityFence } from "./pr-fix-queue/lane-admission";
export { prFixOwnershipMode, evaluatePrFixHandoutOwnership, backfillPrFixClaimant, setPrFixClaimant } from "./pr-fix-queue/handout-ownership";
export type { PrFixOwnershipMode, PrFixOwnershipRow } from "./pr-fix-queue/handout-ownership";
export { parseEnqueuePrFixInput, parseMarkPrFixInput, parseAckPrFixHandoutInput, parseRequeuePrFixInput } from "./pr-fix-queue/inputs";
export type { EnqueuePrFixInput, CreateLinkedPrFixInput, MarkPrFixInput, RequeuePrFixInput, AckPrFixHandoutInput, AckPrFixHandoutResult } from "./pr-fix-queue/inputs";
export { getExplicitEscalationLane, linkedIssueEscalationClassified, enforcePrFixHandoutLaneExclusivity } from "./pr-fix-queue/escalation-lane";
export type { LinkedIssueEscalationClassification } from "./pr-fix-queue/escalation-lane";
export { buildPrFixBlockedContext } from "./pr-fix-queue/evidence";
export type { EvidenceObservation } from "./pr-fix-queue/evidence";
export { maxPrFixStagnation, attemptHeadAdvanced, externalWaitCooldownMs, reconcileExternalWaitTriggers } from "./pr-fix-queue/external-wait";
export { ackPrFixHandout, reclaimStalePrFixHandouts } from "./pr-fix-queue/claim-handout";
export type { ReclaimStalePrFixHandoutsOptions, ReclaimStalePrFixHandoutsReport } from "./pr-fix-queue/claim-handout";
export { enqueuePrFixItem, recordPrFixEvidenceBaseline, createLinkedPrFixItem } from "./pr-fix-queue/enqueue";
export { listQueuedPrFixItems, hasInFlightRebaseHandout, assertPrHeadMovedForFix } from "./pr-fix-queue/queue-read";
export { markPrFixItem } from "./pr-fix-queue/settlement";
export type { MarkPrFixResult } from "./pr-fix-queue/settlement";
export { reconcileStalePrFixItems, isPrFixRepoArchived, reconcileArchivedRepoPrFixItems } from "./pr-fix-queue/reconcile";
export { freshAttemptGeneration, agentHandoutToken, parseAgentHandoutToken, newHandoutToken, handoutReceipt, parseHandoutReceipt, findHandoutReceipt, agentAlreadyHanded, releaseAgentHandout, toAgentQueuePrFixItem } from "./pr-fix-queue/handout";
export { requeuePrFixItem } from "./pr-fix-queue/requeue";
export { resolvePrFixFromAgentReport } from "./pr-fix-queue/report-resolution";
export type { AgentReportOutcome, PrFixReportAttempt, ResolvePrFixFromAgentReportInput, ResolvePrFixFromAgentReportResult } from "./pr-fix-queue/report-resolution";
