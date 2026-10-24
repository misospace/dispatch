-- #1183: durable run→fix-round association.
-- Stamped by tasks/report only after the report's (id, generation) attempt
-- token was verified against the queue item. Additive: existing rows stay
-- NULL (unassociated evidence, never a timestamp guess).
ALTER TABLE "AgentRun" ADD COLUMN "prFixQueueItemId" TEXT;
ALTER TABLE "AgentRun" ADD COLUMN "prFixGeneration" INTEGER;

-- #1183: the attempt-chain read fetches runs by their fix-round association.
CREATE INDEX "AgentRun_prFixQueueItemId_idx" ON "AgentRun"("prFixQueueItemId");

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_prFixQueueItemId_fkey" FOREIGN KEY ("prFixQueueItemId") REFERENCES "PrFixQueueItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
