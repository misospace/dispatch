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
-- Bound the content signature in the schema, not only at the write boundary.
-- `recordEvidenceTransition` normalizes every signature through
-- `normalizeEvidenceContentSignature` (`^[0-9a-f]{32}$`), but
-- "contentSignature" is an indexed TEXT column (PrFixEvidence_itemId_contentSignature_idx)
-- and settlement compares it for equality, so a direct SQL writer could park
-- unbounded text there — bloating the index and making the anti-repetition
-- comparison meaningless. The table is new in this unreleased migration, so the
-- constraint is additive (#1276 review).
ALTER TABLE "PrFixEvidence" ADD CONSTRAINT "PrFixEvidence_contentSignature_check" CHECK ("contentSignature" IS NULL OR "contentSignature" ~ '^[0-9a-f]{32}$');
