-- Explicit operator admission override for the worker queue (#1065).
-- Additive and backfill-free: every column is nullable, so existing issues
-- have no override.
ALTER TABLE "Issue"
  ADD COLUMN IF NOT EXISTS "admissionOverrideId" TEXT,
  ADD COLUMN IF NOT EXISTS "admissionOverrideBy" TEXT,
  ADD COLUMN IF NOT EXISTS "admissionOverrideAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "admissionOverrideReason" TEXT,
  ADD COLUMN IF NOT EXISTS "admissionOverrideHeadSha" TEXT;
