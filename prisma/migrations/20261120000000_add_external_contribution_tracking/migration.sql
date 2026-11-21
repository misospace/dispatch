-- #1538 (parent #1349): Courier lifecycle tracking for external contribution
-- requests. These columns hold ONLY observations from the authenticated,
-- read-only Courier status API (`GET /v1/contributions/<run>`, Courier #836),
-- recorded after the response's identity echo is verified against the stored
-- admission. `trackingState` is the derived lifecycle state
-- (admitted | executing | published | completed | failed | unavailable |
-- expired); a PR is recorded only from Courier's own publication evidence.
-- No credential is ever stored here; `trackingError` holds bounded,
-- token-redacted diagnostics only.
--
-- Additive only: nullable columns, no existing column drop or type change.
ALTER TABLE "ExternalContributionRequest" ADD COLUMN "trackingState" TEXT;
ALTER TABLE "ExternalContributionRequest" ADD COLUMN "courierPhase" TEXT;
ALTER TABLE "ExternalContributionRequest" ADD COLUMN "courierCiParked" BOOLEAN;
ALTER TABLE "ExternalContributionRequest" ADD COLUMN "courierCauseCategory" TEXT;
ALTER TABLE "ExternalContributionRequest" ADD COLUMN "courierCauseOutcome" TEXT;
ALTER TABLE "ExternalContributionRequest" ADD COLUMN "courierPrUrl" TEXT;
ALTER TABLE "ExternalContributionRequest" ADD COLUMN "courierPrBranch" TEXT;
ALTER TABLE "ExternalContributionRequest" ADD COLUMN "courierPrHeadRepo" TEXT;
ALTER TABLE "ExternalContributionRequest" ADD COLUMN "courierPrHeadSha" TEXT;
ALTER TABLE "ExternalContributionRequest" ADD COLUMN "courierObservedAt" TIMESTAMP(3);
ALTER TABLE "ExternalContributionRequest" ADD COLUMN "courierPhaseEnteredAt" TIMESTAMP(3);
ALTER TABLE "ExternalContributionRequest" ADD COLUMN "courierFinishedAt" TIMESTAMP(3);
ALTER TABLE "ExternalContributionRequest" ADD COLUMN "trackingCheckedAt" TIMESTAMP(3);
ALTER TABLE "ExternalContributionRequest" ADD COLUMN "trackingError" TEXT;
