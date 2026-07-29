-- Add index on Issue.currentLane for lane-filtered queries
CREATE INDEX CONCURRENTLY "Issue_currentLane_idx" ON "Issue"("currentLane");

-- Add composite index on (currentLane, state) for common lane+open filter pattern
CREATE INDEX CONCURRENTLY "Issue_currentLane_state_idx" ON "Issue"("currentLane", "state");
