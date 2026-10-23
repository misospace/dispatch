-- #1327: stamp the PR-fix lane each attempt was handed out as. The row's
-- `type` is mutable (every re-enqueue overwrites it, mid-attempt included),
-- so the rebase lane's one-attempt settlement and its concurrency-1 gate key
-- on the dispatched lane, not the current type. Plain TEXT (not the PrFixType
-- enum) so a future lane can never strand a stamped row on a value the enum
-- lacks; the app normalizes on read.
ALTER TABLE "PrFixQueueItem" ADD COLUMN IF NOT EXISTS "attemptType" TEXT;
