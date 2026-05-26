-- Add Issue grooming fields (nullable, no destructive changes)
ALTER TABLE "Issue"
  ADD COLUMN IF NOT EXISTS "groomedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "groomedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "groomingSummary" TEXT,
  ADD COLUMN IF NOT EXISTS "notReadyReason" TEXT,
  ADD COLUMN IF NOT EXISTS "blockedReason" TEXT,
  ADD COLUMN IF NOT EXISTS "needsInfoReason" TEXT,
  ADD COLUMN IF NOT EXISTS "nextGroomingAction" TEXT;
