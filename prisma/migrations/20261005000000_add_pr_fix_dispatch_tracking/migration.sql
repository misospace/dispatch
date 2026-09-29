-- AlterTable: dispatch hand-out tracking for PR-fix queue items (#1119).
-- Evidence that arrives while an attempt is in flight is absorbed into that
-- attempt and never reaches the worker already running on it; when the
-- attempt settles the late evidence becomes "known evidence" (#25 anti-churn)
-- and is lost. dispatchedGeneration / dispatchedAt record the last next-task
-- hand-out; postDispatchEvidenceKeys records the evidence keys that arrived
-- AFTER that hand-out (each entry `<evidenceKey>@<head>`, where <head> is
-- the enqueue's observed headSha or "unknown") so settlement can revalidate
-- them and reopen a fresh attempt. No backfill: a row that was never
-- dispatched is simply empty.
ALTER TABLE "PrFixQueueItem" ADD COLUMN IF NOT EXISTS "dispatchedGeneration" INTEGER;
ALTER TABLE "PrFixQueueItem" ADD COLUMN IF NOT EXISTS "dispatchedAt" TIMESTAMP(3);
ALTER TABLE "PrFixQueueItem" ADD COLUMN IF NOT EXISTS "postDispatchEvidenceKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
-- Self-heal: an earlier in-place revision of this migration added a boolean
-- "postDispatchEvidence" column, and ADD COLUMN IF NOT EXISTS never drops it,
-- so dev databases that applied that revision would drift from the schema.
-- The column is unused; drop it idempotently.
ALTER TABLE "PrFixQueueItem" DROP COLUMN IF EXISTS "postDispatchEvidence";
