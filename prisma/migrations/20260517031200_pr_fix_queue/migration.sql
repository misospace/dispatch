-- CreateEnum
CREATE TYPE "PrFixLane" AS ENUM ('NORMAL', 'ESCALATED', 'NEEDS_HUMAN');

-- CreateEnum
CREATE TYPE "PrFixStatus" AS ENUM ('QUEUED', 'FIXED', 'BLOCKED', 'STALE', 'IGNORED');

-- CreateTable
CREATE TABLE "PrFixQueueItem" (
    "id" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "pr" INTEGER NOT NULL,
    "issue" INTEGER,
    "branch" TEXT,
    "lane" "PrFixLane" NOT NULL DEFAULT 'NORMAL',
    "reason" TEXT NOT NULL,
    "feedback" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidenceKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "PrFixStatus" NOT NULL DEFAULT 'QUEUED',
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "url" TEXT,
    "title" TEXT,
    "headSha" TEXT,
    "author" TEXT,

    CONSTRAINT "PrFixQueueItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrFixHistory" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "status" TEXT,
    "reason" TEXT,
    "note" TEXT,
    "evidenceKey" TEXT,

    CONSTRAINT "PrFixHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrFixQueueItem_repo_pr_key" ON "PrFixQueueItem"("repo", "pr");

-- CreateIndex
CREATE INDEX "PrFixQueueItem_status_idx" ON "PrFixQueueItem"("status");

-- CreateIndex
CREATE INDEX "PrFixQueueItem_lane_idx" ON "PrFixQueueItem"("lane");

-- CreateIndex
CREATE INDEX "PrFixQueueItem_status_lane_idx" ON "PrFixQueueItem"("status", "lane");

-- CreateIndex
CREATE INDEX "PrFixHistory_itemId_idx" ON "PrFixHistory"("itemId");

-- CreateIndex
CREATE INDEX "PrFixHistory_at_idx" ON "PrFixHistory"("at");

-- AddForeignKey
ALTER TABLE "PrFixHistory" ADD CONSTRAINT "PrFixHistory_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PrFixQueueItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
