-- #1562: a worker's repeated blocked settlements on issue work (`blocked` /
-- `waiting-external` implement reports carrying the same missing-prerequisite
-- descriptor) park the issue out of the agent queue after a bounded
-- threshold, so the same verification loop cannot run forever. The row is the
-- accumulating counter AND the park: it goes live at
-- `consecutiveCount >= DISPATCH_BLOCKED_EXTERNAL_PARK_THRESHOLD` while
-- `contentFingerprint` (sha256 over canonical { title, body } at record time)
-- still matches — labels/state are deliberately excluded, so status churn
-- never ends a park and a content edit always does. One row per issue
-- (`issueId` unique): a settlement carrying a different descriptor resets the
-- count in place.
--
-- Additive only: new table, no existing column drop or type change.
-- CreateTable
CREATE TABLE "BlockedExternalPark" (
"id" TEXT NOT NULL,
"issueId" TEXT NOT NULL,
"agentName" TEXT NOT NULL,
"outcome" TEXT NOT NULL,
"descriptor" TEXT NOT NULL,
"consecutiveCount" INTEGER NOT NULL DEFAULT 1,
"summary" TEXT,
"contentFingerprint" TEXT NOT NULL,
"lastSettledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"updatedAt" TIMESTAMP(3) NOT NULL,
CONSTRAINT "BlockedExternalPark_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "BlockedExternalPark_issueId_key" ON "BlockedExternalPark"("issueId");
-- CreateIndex
CREATE INDEX "BlockedExternalPark_lastSettledAt_idx" ON "BlockedExternalPark"("lastSettledAt");
-- AddForeignKey
ALTER TABLE "BlockedExternalPark" ADD CONSTRAINT "BlockedExternalPark_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
