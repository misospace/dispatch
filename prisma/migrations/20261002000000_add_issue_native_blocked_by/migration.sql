-- Native GitHub blocked_by dependencies for dependency gating (#1086).
-- Additive and backfill-free: existing issues get an empty array until the
-- next sync ingests their native blocked_by links.
ALTER TABLE "Issue"
  ADD COLUMN IF NOT EXISTS "nativeBlockedBy" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
