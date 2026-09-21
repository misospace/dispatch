-- CreateTable: durable idempotency claims for tasks/report (#1044).
-- A worker that crashes between Dispatch committing a report and recording the
-- result locally retries the same report with the same idempotencyKey. The
-- unique (agentName, idempotencyKey) constraint makes the claim atomic — the
-- loser of a concurrent race hits P2002 and replays the stored result instead
-- of creating a second AgentRun or re-running PR-fix resolution. payloadHash
-- detects key reuse with a different report payload (rejected as 409).
CREATE TABLE "AgentReportDedupe" (
    "id" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "agentRunId" TEXT,
    "prFixResolution" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentReportDedupe_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentReportDedupe_agentName_idempotencyKey_key" ON "AgentReportDedupe"("agentName", "idempotencyKey");
CREATE INDEX "AgentReportDedupe_agentName_idx" ON "AgentReportDedupe"("agentName");
