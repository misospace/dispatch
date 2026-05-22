-- Add durable agent work/checkpoint tracking and active issue leases.
-- These models were added for Dispatch v0.3.0 agent queue/active-work APIs.

CREATE TYPE "AgentWorkState" AS ENUM ('CLAIMED', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'RELEASED', 'STALE');

CREATE TYPE "AgentWorkCheckpoint" AS ENUM ('CLAIMED', 'REPO_PREPARED', 'BRANCH_CREATED', 'CHANGES_MADE', 'TESTS_RUNNING', 'PR_OPENED', 'DONE', 'BLOCKED');

CREATE TABLE "AgentWork" (
    "id" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "issueId" TEXT,
    "runId" TEXT,
    "state" "AgentWorkState" NOT NULL DEFAULT 'CLAIMED',
    "checkpoint" "AgentWorkCheckpoint" NOT NULL DEFAULT 'CLAIMED',
    "branch" TEXT,
    "prUrl" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary" TEXT,
    "blockerReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentWork_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentWorkHistory" (
    "id" TEXT NOT NULL,
    "workId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "state" "AgentWorkState",
    "checkpoint" "AgentWorkCheckpoint",
    "summary" TEXT,
    "blockerReason" TEXT,

    CONSTRAINT "AgentWorkHistory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Lease" (
    "id" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "checkpoint" TEXT NOT NULL,
    "branch" TEXT,
    "prUrl" TEXT,
    "expiredAt" TIMESTAMP(3) NOT NULL,
    "renewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lease_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentWork_agentName_idx" ON "AgentWork"("agentName");
CREATE INDEX "AgentWork_state_idx" ON "AgentWork"("state");
CREATE INDEX "AgentWork_issueId_idx" ON "AgentWork"("issueId");
CREATE INDEX "AgentWorkHistory_workId_idx" ON "AgentWorkHistory"("workId");
CREATE INDEX "AgentWorkHistory_at_idx" ON "AgentWorkHistory"("at");
CREATE UNIQUE INDEX "Lease_agentName_issueId_key" ON "Lease"("agentName", "issueId");
CREATE INDEX "Lease_expiredAt_idx" ON "Lease"("expiredAt");
CREATE INDEX "Lease_issueId_idx" ON "Lease"("issueId");

ALTER TABLE "AgentWork" ADD CONSTRAINT "AgentWork_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentWorkHistory" ADD CONSTRAINT "AgentWorkHistory_workId_fkey" FOREIGN KEY ("workId") REFERENCES "AgentWork"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Lease" ADD CONSTRAINT "Lease_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
