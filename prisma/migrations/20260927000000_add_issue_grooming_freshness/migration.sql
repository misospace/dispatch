-- Grooming freshness (#1064). Additive and backfill-free: every column is
-- nullable or defaulted, so existing rows read as "freshness unknown"
-- (groomedIssueFingerprint IS NULL) until their next applied groom records a
-- baseline.
ALTER TABLE "Issue"
  ADD COLUMN IF NOT EXISTS "groomedRunId" TEXT,
  ADD COLUMN IF NOT EXISTS "groomedHeadSha" TEXT,
  ADD COLUMN IF NOT EXISTS "groomedDefaultBranch" TEXT,
  ADD COLUMN IF NOT EXISTS "groomedIssueFingerprint" TEXT,
  ADD COLUMN IF NOT EXISTS "groomedCommentCount" INTEGER,
  ADD COLUMN IF NOT EXISTS "groomedEvidenceDigest" TEXT,
  ADD COLUMN IF NOT EXISTS "groomedEvidenceCapturedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "groomedEvidenceScope" TEXT,
  ADD COLUMN IF NOT EXISTS "groomedEvidencePaths" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "groomedDependencyKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "groomedOpenBlockerKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "groomedRelatedWork" JSONB,
  ADD COLUMN IF NOT EXISTS "groomingVerifiedSha" TEXT,
  ADD COLUMN IF NOT EXISTS "groomingStaleAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "groomingStaleReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "groomingStaleDetail" TEXT;

CREATE INDEX IF NOT EXISTS "Issue_groomingStaleAt_idx" ON "Issue"("groomingStaleAt");

-- The stale reasons that made a run's candidate eligible (empty for ordinary
-- selection), so a re-groom's history row says why it happened.
ALTER TABLE "GroomingRun"
  ADD COLUMN IF NOT EXISTS "staleReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
