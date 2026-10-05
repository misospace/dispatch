-- One row per child brief the hosted groomer intends for a decomposed parent
-- (#1066). The unique childKey (parent issue + normalized child brief) is
-- the claim: creation is idempotent, so a retry after partial failure reuses
-- children whose rows already carry their URLs and creates only the missing
-- ones.
CREATE TABLE "GroomingChildClaim" (
    "id" TEXT NOT NULL,
    "childKey" TEXT NOT NULL,
    "parentIssueId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "parentNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "childNumber" INTEGER,
    "childUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroomingChildClaim_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "GroomingChildClaim" ADD CONSTRAINT "GroomingChildClaim_parentIssueId_fkey" FOREIGN KEY ("parentIssueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "GroomingChildClaim_childKey_key" ON "GroomingChildClaim"("childKey");
CREATE INDEX "GroomingChildClaim_parentIssueId_idx" ON "GroomingChildClaim"("parentIssueId");
