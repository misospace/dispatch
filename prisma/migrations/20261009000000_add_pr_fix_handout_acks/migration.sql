-- AlterTable: hand-out acknowledgements and bounded reclamations for PR-fix
-- queue items (#1211). next-task stamps `dispatchedGeneration`/`dispatchedAt`
-- on the first hand-out of a generation and records the agent in
-- `agentHandouts`, but a worker that dies before durably creating its run
-- leaves no trace: the hand-out is stamped, never acknowledged, and the item
-- is never re-offered — stranded.
--
-- `handoutAcks` records `<agentName>@<generation>` when a worker durably
-- materialized its attempt. The reclaimer refuses to reclaim a generation any
-- agent acknowledged; entries for older generations are inert and every fresh
-- attempt clears the list.
--
-- `handoutReclaims` counts bounded automatic reclamations of stale
-- unacknowledged hand-outs. Past PR_FIX_MAX_RECLAIMS the item goes to BLOCKED
-- in the NEEDS_HUMAN lane instead of being reclaimed again. No backfill: a row
-- that was never acknowledged simply starts empty, and an already-handled row
-- starts at zero.
ALTER TABLE "PrFixQueueItem" ADD COLUMN IF NOT EXISTS "handoutAcks" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "PrFixQueueItem" ADD COLUMN IF NOT EXISTS "handoutReclaims" INTEGER NOT NULL DEFAULT 0;
