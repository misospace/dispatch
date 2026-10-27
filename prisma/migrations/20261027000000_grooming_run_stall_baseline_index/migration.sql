-- #1437: index the groomer-stall baseline query (#1420).
-- observability collector reads newest successful applied grooming run
-- on every /api/metrics scrape and /api/observability fetch:
-- status + dryRun + stage equality, completedAt `not null`, sort
-- completedAt DESC. without covering index lookup degraded to scan of
-- growing grooming history. composite index keeps it single ordered seek.
CREATE INDEX "GroomingRun_status_dryRun_stage_completedAt_idx" ON "GroomingRun"("status", "dryRun", "stage", "completedAt" DESC);
