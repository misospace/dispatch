-- CreateEnum
CREATE TYPE "PrFixType" AS ENUM ('MERGE_CONFLICT', 'CI_FAILURE', 'REVIEW_FEEDBACK', 'OTHER');

-- AlterTable: Add type column to PrFixQueueItem
ALTER TABLE "PrFixQueueItem" ADD COLUMN "type" "PrFixType" NOT NULL DEFAULT 'OTHER';

-- CreateIndex: Priority ordering for queue consumption
CREATE INDEX "PrFixQueueItem_type_idx" ON "PrFixQueueItem"("type");
CREATE INDEX "PrFixQueueItem_status_type_idx" ON "PrFixQueueItem"("status", "type");
