-- CreateTable
CREATE TABLE "IssueHandoffSettlement" (
    "id" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "claimToken" TEXT NOT NULL,
    "settlementKey" TEXT NOT NULL,
    "capacity" TEXT NOT NULL,
    "labels" TEXT[] NOT NULL,
    "status" TEXT,
    "statusNote" TEXT,
    "cooldownUntil" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueHandoffSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IssueHandoffSettlement_agentName_issueId_settlementKey_key" ON "IssueHandoffSettlement"("agentName", "issueId", "settlementKey");

-- CreateIndex
CREATE INDEX "IssueHandoffSettlement_expiresAt_idx" ON "IssueHandoffSettlement"("expiresAt");

-- AddForeignKey
ALTER TABLE "IssueHandoffSettlement" ADD CONSTRAINT "IssueHandoffSettlement_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
