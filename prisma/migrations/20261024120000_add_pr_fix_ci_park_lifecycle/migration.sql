-- CI park-and-resume deferral (misospace/courier#495): the five nullable
-- lifecycle columns on the queue item. Null ciParkState = no lifecycle ever
-- recorded; passive on non-QUEUED dispositions (its requeue bumps generation
-- and clears the columns in the same write, which is the deferral's leash).
-- Additive: existing rows stay NULL.
ALTER TABLE "PrFixQueueItem" ADD COLUMN "ciParkState" TEXT;
ALTER TABLE "PrFixQueueItem" ADD COLUMN "ciParkHead" TEXT;
ALTER TABLE "PrFixQueueItem" ADD COLUMN "ciParkKey" TEXT;
ALTER TABLE "PrFixQueueItem" ADD COLUMN "ciParkFence" TEXT;
ALTER TABLE "PrFixQueueItem" ADD COLUMN "ciParkAt" TIMESTAMP(3);
-- CreateTable
CREATE TABLE "PrFixCIParkLedger" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "fence" TEXT,
    "result" TEXT,
    "head" TEXT,
    "agent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrFixCIParkLedger_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "PrFixCIParkLedger_itemId_kind_key_key" ON "PrFixCIParkLedger"("itemId", "kind", "key");
-- AddForeignKey
ALTER TABLE "PrFixCIParkLedger" ADD CONSTRAINT "PrFixCIParkLedger_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PrFixQueueItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
