-- AlterTable: Dispatch-owned work generation for PR-fix queue items (#1044).
-- 1 on creation; bumped when a non-QUEUED item becomes dispatchable again as a
-- fresh attempt (requeue, new evidence reopening a resolved item, #940 recovery,
-- refused-FIXED rollback). Workers consume (id, generation) as opaque work
-- identity via next-task's followup-pr.prFixItem.
-- Existing rows safely default to 1 — the generation every new item starts at.
ALTER TABLE "PrFixQueueItem" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 1;
