-- CreateTable
CREATE TABLE "GroomingRun" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "agentRunId" TEXT,
    "repoFullName" TEXT NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "issueUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL,
    "candidateSource" TEXT NOT NULL DEFAULT 'selector',
    "stage" TEXT NOT NULL DEFAULT 'selected',
    "model" TEXT,
    "provider" TEXT,
    "promptVersion" TEXT NOT NULL DEFAULT 'hosted-groomer-v1',
    "timeoutMs" INTEGER,
    "maxContextBytes" INTEGER,
    "contextSummary" JSONB,
    "contextWarnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rawOutput" JSONB,
    "validatedOutput" JSONB,
    "validationErrors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "labelsBefore" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "labelsAfter" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "labelsToAdd" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "labelsToRemove" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "laneBefore" TEXT,
    "laneAfter" TEXT,
    "mutationPlan" JSONB,
    "appliedMutations" JSONB,
    "commentBodyPreview" TEXT,
    "commentUrl" TEXT,
    "errorMessage" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroomingRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GroomingRun_repoFullName_idx" ON "GroomingRun"("repoFullName");
CREATE INDEX "GroomingRun_issueId_idx" ON "GroomingRun"("issueId");
CREATE INDEX "GroomingRun_repoId_idx" ON "GroomingRun"("repoId");
CREATE INDEX "GroomingRun_agentRunId_idx" ON "GroomingRun"("agentRunId");
CREATE INDEX "GroomingRun_status_idx" ON "GroomingRun"("status");
CREATE INDEX "GroomingRun_dryRun_idx" ON "GroomingRun"("dryRun");
CREATE INDEX "GroomingRun_createdAt_idx" ON "GroomingRun"("createdAt");
CREATE INDEX "GroomingRun_issueId_createdAt_idx" ON "GroomingRun"("issueId", "createdAt");
CREATE INDEX "GroomingRun_repoId_status_createdAt_idx" ON "GroomingRun"("repoId", "status", "createdAt");
CREATE INDEX "GroomingRun_issueId_status_idx" ON "GroomingRun"("issueId", "status");

-- AddForeignKey
ALTER TABLE "GroomingRun" ADD CONSTRAINT "GroomingRun_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroomingRun" ADD CONSTRAINT "GroomingRun_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "AutomationRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroomingRun" ADD CONSTRAINT "GroomingRun_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
