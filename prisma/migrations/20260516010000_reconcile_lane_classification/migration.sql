-- ============================================================
-- Reconcile lane classification with escalated-lane queue/outcome
-- ============================================================
-- This migration reconciles the lane classification system (#91)
-- with the escalated-lane outcome tracking (#87).
--
-- Changes:
-- 1. Drop old enum-based lane fields from Issue (lane, laneConfidence, laneReason, laneModel, laneJudgedAt)
-- 2. Recreate IssueLane table with correct defaults (cuid() for id, proper NOT NULL constraints)
-- 3. Add #87 decomposed tracking fields to Issue
-- 4. Create EscalatedOutcome enum type
-- 5. Add outcome column to AgentRun

-- Step 1: Drop old enum-based lane columns from Issue
ALTER TABLE "Issue" DROP COLUMN IF EXISTS "lane";
ALTER TABLE "Issue" DROP COLUMN IF EXISTS "laneConfidence";
ALTER TABLE "Issue" DROP COLUMN IF EXISTS "laneReason";
ALTER TABLE "Issue" DROP COLUMN IF EXISTS "laneModel";
ALTER TABLE "Issue" DROP COLUMN IF EXISTS "laneJudgedAt";

-- Step 2: Recreate IssueLane table with correct defaults
DROP TABLE IF EXISTS "IssueLane";

CREATE TABLE "IssueLane" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "issueId" TEXT NOT NULL,
    "lane" TEXT NOT NULL DEFAULT 'normal',
    "confidence" TEXT NOT NULL DEFAULT 'medium',
    "reason" TEXT,
    "model" TEXT,
    "judgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueLane_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IssueLane_issueId_idx" ON "IssueLane"("issueId");
CREATE INDEX "IssueLane_lane_idx" ON "IssueLane"("lane");

ALTER TABLE "IssueLane" ADD CONSTRAINT "IssueLane_issueId_fkey"
  FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ensure currentLane exists (for fresh installs where old migration may not have run)
ALTER TABLE "Issue" ADD COLUMN IF NOT EXISTS "currentLane" TEXT DEFAULT 'normal';

-- Step 3: Add #87 decomposed tracking fields to Issue
ALTER TABLE "Issue" ADD COLUMN IF NOT EXISTS "decomposed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Issue" ADD COLUMN IF NOT EXISTS "decomposedAt" TIMESTAMP(3);
ALTER TABLE "Issue" ADD COLUMN IF NOT EXISTS "decomposedBy" TEXT;
ALTER TABLE "Issue" ADD COLUMN IF NOT EXISTS "decomposedNote" TEXT;
ALTER TABLE "Issue" ADD COLUMN IF NOT EXISTS "followUpUrls" TEXT[] DEFAULT '{}';

-- Step 4: Create EscalatedOutcome enum type
DO $$ BEGIN
  CREATE TYPE "EscalatedOutcome" AS ENUM (
    'PR_OPENED',
    'PR_UPDATED',
    'FOLLOW_UP_CREATED',
    'DESIGN_COMMENT_POSTED',
    'DECOMPOSED_SKIPPED',
    'STUCK'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Step 5: Add outcome column to AgentRun
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "outcome" "EscalatedOutcome";
