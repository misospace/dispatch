-- #1543: the lifetime PR_FIX_MAX_ATTEMPTS stop is retired in favor of a
-- consecutive-stagnation guard. `stagnationCount` counts attempts that ended
-- without authoritative progress (the observed PR head never advanced past
-- the attempt baseline); it resets on a proven progress event and on an
-- operator requeue, and PR_FIX_MAX_STAGNATION bounds it.
ALTER TABLE "PrFixQueueItem" ADD COLUMN IF NOT EXISTS "stagnationCount" INTEGER NOT NULL DEFAULT 0;
