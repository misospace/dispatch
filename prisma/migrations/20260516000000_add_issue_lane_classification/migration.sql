-- CreateTable
CREATE TABLE "IssueLane" (
    "id" TEXT NOT NULL DEFAULT '',
    "issueId" TEXT NOT NULL DEFAULT '',
    "lane" TEXT NOT NULL DEFAULT '',
    "confidence" TEXT NOT NULL DEFAULT '',
    "reason" TEXT,
    "model" TEXT,
    "judgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueLane_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IssueLane_issueId_idx" ON "IssueLane"("issueId");

-- CreateIndex
CREATE INDEX "IssueLane_lane_idx" ON "IssueLane"("lane");

-- AddForeignKey
ALTER TABLE "IssueLane" ADD CONSTRAINT "IssueLane_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add currentLane column to Issue for quick UI access
ALTER TABLE "Issue" ADD COLUMN "currentLane" TEXT DEFAULT 'normal';
