-- AlterTable: count dispatchable fix attempts on PR-fix queue items (#1103).
-- PR_FIX_MAX_ATTEMPTS used to bound distinct evidence keys, and every inline
-- review comment is its own key, so one review with more comments than the
-- cap blocked an item before any attempt ran. Existing rows start at 1.
ALTER TABLE "PrFixQueueItem" ADD COLUMN IF NOT EXISTS "fixAttempts" INTEGER NOT NULL DEFAULT 1;

-- Backfill: give QUEUED rows without a per-attempt head baseline the head last
-- observed for them (#1104). Without it the FIXED guard falls back to the
-- mutable headSha, which the next sync can overwrite with the worker's own
-- push, refusing a real fix.
UPDATE "PrFixQueueItem" SET "attemptHeadSha" = "headSha"
WHERE "status" = 'QUEUED' AND "attemptHeadSha" IS NULL AND "headSha" IS NOT NULL;
