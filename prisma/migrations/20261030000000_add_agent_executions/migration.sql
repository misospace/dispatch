-- #1495: source-neutral agent execution observation surface. External
-- sources (e.g. Courier harnesses) report active executions (issue work and
-- PR-fix work) that the Agents page displays alongside legacy AgentWork
-- sessions. Observation only: this table never synthesizes AgentWork rows,
-- leases, or ownership state.
--
-- Additive only: new table, no existing column drop or type change,
-- `prisma migrate deploy` safe on databases already at
-- 20261028120000_issue_release_signal. The optional issueId FK follows the
-- optional-relation convention (ON DELETE SET NULL) used by AgentRun.
-- CreateTable
CREATE TABLE "AgentExecution" (
    "id" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "workType" TEXT NOT NULL,
    "workRefUrl" TEXT,
    "issueId" TEXT,
    "executionState" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "lastObservedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "summary" TEXT,
    "revision" INTEGER NOT NULL,
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

-- AddForeignKey
ALTER TABLE "AgentExecution" ADD CONSTRAINT "AgentExecution_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
