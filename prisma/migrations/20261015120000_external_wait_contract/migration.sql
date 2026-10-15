-- #1250: structured external-wait contract on PrFixQueueItem.
-- Null on a WAITING_EXTERNAL row means a legacy free-text wait
-- (pre-#1250) — surfaced for operator action, never auto-downgraded.
ALTER TABLE "PrFixQueueItem" ADD COLUMN "externalWait" JSONB;
