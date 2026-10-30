-- #1495: source-neutral agent execution observation surface. External
-- sources (e.g. Courier harnesses) report active executions (issue work and
-- PR-fix work) that the Agents page displays alongside legacy AgentWork
-- sessions, via the Courier (#637) wire contract
-- POST /api/agent-work/observations. Observation only: this table never
-- synthesizes AgentWork rows, leases, or ownership state.
--
-- `executionId` is the durable run UID (a recreated run is a NEW uid);
-- keyed by (agentName, executionId). `workItemId` is the source's opaque
-- work id — deliberately NOT an Issue foreign key. `idempotencyKey` only
-- dedupes byte-identical deliveries; it is never the storage identity.
-- `workRefUrl` carries the wire pullRequestUrl.
--
-- Additive only: new table, no existing column drop or type change,
-- `prisma migrate deploy` safe on databases already at
-- 20261028120000_issue_release_signal.
-- CreateTable
CREATE TABLE "AgentExecution" (
    "id" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "workType" TEXT,
    "workRefUrl" TEXT,
    "workItemId" TEXT,
    "workIdentity" TEXT,
    "mode" TEXT,
    "runNamespace" TEXT,
    "runName" TEXT,
    "pullRequestNumber" INTEGER,
    "executionState" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "lastObservedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "summary" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentExecution_agentName_executionId_key" ON "AgentExecution"("agentName", "executionId");

-- CreateIndex
CREATE INDEX "AgentExecution_executionState_lastObservedAt_idx" ON "AgentExecution"("executionState", "lastObservedAt");

-- CreateIndex
CREATE INDEX "AgentExecution_agentName_lastObservedAt_idx" ON "AgentExecution"("agentName", "lastObservedAt");
