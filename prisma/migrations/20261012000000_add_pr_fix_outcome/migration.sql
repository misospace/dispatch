-- The new columns are TEXT/JSONB, not the "PrFixStatus"/enum type, so the
-- ALTER TYPE ... ADD VALUE below is never referenced by a column cast inside
-- this migration transaction. Postgres forbids using a newly added enum value
-- in the same transaction that added it; keeping these columns as plain
-- TEXT/JSONB avoids that constraint entirely.
ALTER TYPE "PrFixStatus" ADD VALUE IF NOT EXISTS 'PARKED';
ALTER TABLE "PrFixQueueItem" ADD COLUMN IF NOT EXISTS "outcome" TEXT;
ALTER TABLE "PrFixQueueItem" ADD COLUMN IF NOT EXISTS "decisionDetail" JSONB;
ALTER TABLE "PrFixHistory" ADD COLUMN IF NOT EXISTS "outcome" TEXT;
