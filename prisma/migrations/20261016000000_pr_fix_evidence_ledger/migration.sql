-- AlterTable
ALTER TABLE "PrFixQueueItem" ADD COLUMN     "evidenceSequence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "attemptEvidenceWatermark" INTEGER;

-- CreateTable
CREATE TABLE "PrFixEvidence" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "contentSignature" TEXT,
    "observedAt" TIMESTAMP(3),
    "headSha" TEXT,
    "source" TEXT,
    "actionable" BOOLEAN NOT NULL DEFAULT true,
    "sequence" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PrFixEvidence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PrFixEvidence_itemId_identity_key" UNIQUE ("itemId", "identity"),
    CONSTRAINT "PrFixEvidence_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PrFixQueueItem"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PrFixEvidence_itemId_sequence_idx" ON "PrFixEvidence"("itemId", "sequence");
CREATE INDEX "PrFixEvidence_itemId_contentSignature_idx" ON "PrFixEvidence"("itemId", "contentSignature");
