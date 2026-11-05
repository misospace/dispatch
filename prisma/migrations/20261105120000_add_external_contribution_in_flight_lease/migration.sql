-- #1556 review: durable in-flight claim/lease on ExternalContributionRequest.
-- At most one Courier admission request per contribution identity may be
-- active at a time: the atomic claim flips the row to deliveryStatus
-- 'in_flight' under a bounded lease (`inFlightUntil` = attempt start +
-- configured admission timeout + margin). A live lease is never stolen;
-- a stale lease recovers a crashed attempt with the SAME idempotency key,
-- consuming the next bounded attempt. `attemptToken` is a random per-attempt
-- ownership token so a delayed response from a recovered attempt can never
-- overwrite a newer attempt's settlement.
--
-- Additive only: two new nullable columns, no existing column drop or change.
-- Existing rows are pending/accepted/rejected/uncertain and need no backfill:
-- a NULL inFlightUntil is never a live lease, and a NULL attemptToken simply
-- owns nothing.
ALTER TABLE "ExternalContributionRequest" ADD COLUMN "inFlightUntil" TIMESTAMP(3);
ALTER TABLE "ExternalContributionRequest" ADD COLUMN "attemptToken" TEXT;
