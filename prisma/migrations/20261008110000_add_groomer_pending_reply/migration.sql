CREATE TABLE "GroomerPendingReply" (
    "id" TEXT NOT NULL,
    "applicationKey" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "issueId" TEXT NOT NULL,
    "groomingRunId" TEXT,
    "commentBody" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "trustContext" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "postedUrl" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroomerPendingReply_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "GroomerPendingReply" ADD CONSTRAINT "GroomerPendingReply_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "GroomerPendingReply_applicationKey_key" ON "GroomerPendingReply"("applicationKey");
CREATE INDEX "GroomerPendingReply_issueId_idx" ON "GroomerPendingReply"("issueId");
CREATE INDEX "GroomerPendingReply_status_idx" ON "GroomerPendingReply"("status");
CREATE INDEX "GroomerPendingReply_repoFullName_issueNumber_idx" ON "GroomerPendingReply"("repoFullName", "issueNumber");
