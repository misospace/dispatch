-- #1430: identity of the bound worker that started the current external wait.
-- Written atomically with the single WAITING_EXTERNAL status write; the
-- idempotent same-generation replay is bound to it. NULL for waits started by
-- unscoped (maintainer/operator/internal) callers and for non-waiting rows.
ALTER TABLE "PrFixQueueItem" ADD COLUMN IF NOT EXISTS "externalWaitBy" TEXT;
