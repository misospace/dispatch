-- Preserve empty code-search queries so freshness checks can verify whether
-- repo-wide negative evidence still holds after a default-branch commit.
ALTER TABLE "Issue"
  ADD COLUMN IF NOT EXISTS "groomedSearchCodeQueries" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN "Issue"."groomedSearchCodeQueries" IS 'Successful empty search_code queries backing global grooming evidence';
