CREATE TABLE "IssueMutationGuard" (
    "issueId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "ownerToken" TEXT NOT NULL,
    "agentName" TEXT,
    "claimToken" TEXT,
    "executing" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IssueMutationGuard_pkey" PRIMARY KEY ("issueId"),
    CONSTRAINT "IssueMutationGuard_ownerToken_key" UNIQUE ("ownerToken"),
    CONSTRAINT "IssueMutationGuard_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "IssueMutationGuard_agentName_claimToken_idx" ON "IssueMutationGuard"("agentName", "claimToken");
