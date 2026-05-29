-- Add linked PR health fields to Issue (nullable / defaulted, no destructive changes)
ALTER TABLE "Issue"
  ADD COLUMN IF NOT EXISTS "linkedPrNumber" INTEGER,
  ADD COLUMN IF NOT EXISTS "linkedPrUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "linkedPrNeedsFollowup" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "linkedPrFollowupReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "linkedPrReviewDecision" TEXT,
  ADD COLUMN IF NOT EXISTS "linkedPrMergeState" TEXT,
  ADD COLUMN IF NOT EXISTS "linkedPrHealthCheckedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Issue_linkedPrNeedsFollowup_idx" ON "Issue"("linkedPrNeedsFollowup");
