-- The original index migration sorts before the migrations that create Issue and
-- currentLane. Finish the index creation after the complete schema exists.
CREATE INDEX IF NOT EXISTS "Issue_currentLane_idx" ON "Issue"("currentLane");
CREATE INDEX IF NOT EXISTS "Issue_currentLane_state_idx" ON "Issue"("currentLane", "state");
