-- Apply-time validation and idempotent application of grooming plans (#1063).
-- Additive: new nullable/defaulted GroomingRun columns and a new table, so
-- existing runs read as recorded before validation existed.
ALTER TABLE "GroomingRun"
  ADD COLUMN IF NOT EXISTS "applicationKey" TEXT,
  ADD COLUMN IF NOT EXISTS "applyOutcome" TEXT,
  ADD COLUMN IF NOT EXISTS "preconditions" JSONB,
  ADD COLUMN IF NOT EXISTS "preconditionFailures" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX IF NOT EXISTS "GroomingRun_applicationKey_idx" ON "GroomingRun"("applicationKey");

-- CreateTable: one row per logical plan application. The unique
-- applicationKey is the claim; a retry with the same key replays the recorded
-- steps. groomingRunId is the run that first claimed it; SetNull keeps the
-- claim recognizable if that run's history row is deleted.
CREATE TABLE "GroomingApplication" (
    "id" TEXT NOT NULL,
    "applicationKey" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "groomingRunId" TEXT,
    "repoFullName" TEXT NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroomingApplication_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "GroomingApplication" ADD CONSTRAINT "GroomingApplication_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroomingApplication" ADD CONSTRAINT "GroomingApplication_groomingRunId_fkey" FOREIGN KEY ("groomingRunId") REFERENCES "GroomingRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "GroomingApplication_applicationKey_key" ON "GroomingApplication"("applicationKey");
CREATE INDEX "GroomingApplication_issueId_idx" ON "GroomingApplication"("issueId");
CREATE INDEX "GroomingApplication_groomingRunId_idx" ON "GroomingApplication"("groomingRunId");
