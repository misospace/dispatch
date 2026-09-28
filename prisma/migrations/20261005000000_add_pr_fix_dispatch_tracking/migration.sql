-- AlterTable: dispatch hand-out tracking for PR-fix queue items (#1119).
-- Evidence that arrives while an attempt is in flight is absorbed into that
-- attempt and never reaches the worker already running on it; when the
-- attempt settles the late evidence becomes "known evidence" (#25 anti-churn)
-- and is lost. dispatchedGeneration / dispatchedAt record the last next-task
-- hand-out; postDispatchEvidence flags new evidence arriving after that
-- hand-out so settlement reopens a fresh attempt. No backfill: a row that
-- was never dispatched is simply unflagged.
ALTER TABLE "PrFixQueueItem" ADD COLUMN IF NOT EXISTS "dispatchedGeneration" INTEGER;
ALTER TABLE "PrFixQueueItem" ADD COLUMN IF NOT EXISTS "dispatchedAt" TIMESTAMP(3);
ALTER TABLE "PrFixQueueItem" ADD COLUMN IF NOT EXISTS "postDispatchEvidence" BOOLEAN NOT NULL DEFAULT false;
