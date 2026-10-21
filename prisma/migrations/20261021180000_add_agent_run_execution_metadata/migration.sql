-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN "executionMetadata" JSONB;

-- #1183: the attempt-chain read resolves an issue's run evidence by issueId.
CREATE INDEX "AgentRun_issueId_idx" ON "AgentRun"("issueId");

-- #1183: the attempt-chain read fetches the queue items for one work item's
-- exact (repo, issue) coordinates.
CREATE INDEX "PrFixQueueItem_repo_issue_idx" ON "PrFixQueueItem"("repo", "issue");
