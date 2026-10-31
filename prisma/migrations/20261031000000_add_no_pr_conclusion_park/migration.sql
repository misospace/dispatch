-- #1506: a terminal no-PR conclusion on an implement task parks the issue out
-- of the agent queue so the reconciler's restore-to-ready cannot re-offer
-- concluded work forever. Dispatch-side queue policy only: no GitHub label or
-- close is written. `contentFingerprint` is sha256 over canonical
-- { title, body } at park time — labels/state are deliberately excluded, so
-- status churn never ends a park and a content edit always does. One live
-- park per issue (`issueId` unique): a later conclusion replaces it.
--
-- Additive only: new table, no existing column drop or type change.
-- CreateTable
CREATE TABLE "NoPrConclusion" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "summary" TEXT,
    "evidence" TEXT,
    "contentFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoPrConclusion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NoPrConclusion_issueId_key" ON "NoPrConclusion"("issueId");

-- CreateIndex
CREATE INDEX "NoPrConclusion_createdAt_idx" ON "NoPrConclusion"("createdAt");

-- AddForeignKey
ALTER TABLE "NoPrConclusion" ADD CONSTRAINT "NoPrConclusion_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
