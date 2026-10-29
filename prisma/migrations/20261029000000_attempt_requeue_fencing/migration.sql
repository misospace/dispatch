-- #1491: fenced attempt-requeue routes pinned by Courier.
-- Durable issuance ledger (proves a receipt was ever issued after the live
-- hand-out / claim released it) + the PR-fix replay settlement + shared
-- IssueHandoffSettlement columns the issue-requeue writer needs.

-- Issuance history: minted receipts (PR-fix hand-out tokens, issue claim
-- tokens) recorded at issuance. Proof of a past issuance, never dispatch
-- state. Token is globally unique (the mint is collision-impossible).
CREATE TABLE "AttemptIssuance" (
    "id" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "generation" INTEGER,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttemptIssuance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AttemptIssuance_token_key" ON "AttemptIssuance"("token");
CREATE INDEX "AttemptIssuance_surface_attemptId_agentName_idx" ON "AttemptIssuance"("surface", "attemptId", "agentName");

-- Fenced PR-fix attempt-requeue replay ledger (#1262 pattern, queue surface).
CREATE TABLE "PrFixRequeueSettlement" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "pr" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL,
    "agentName" TEXT NOT NULL,
    "fenceToken" TEXT NOT NULL,
    "settlementKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "requeuedGeneration" INTEGER NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrFixRequeueSettlement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PrFixRequeueSettlement_agentName_itemId_settlementKey_key" ON "PrFixRequeueSettlement"("agentName", "itemId", "settlementKey");
CREATE INDEX "PrFixRequeueSettlement_itemId_idx" ON "PrFixRequeueSettlement"("itemId");
CREATE INDEX "PrFixRequeueSettlement_expiresAt_idx" ON "PrFixRequeueSettlement"("expiresAt");

-- Shared replay ledger: the issue-requeue writer settles no capacity, and
-- carries the operation tag / payload fingerprint / replayed attempt identity.
ALTER TABLE "IssueHandoffSettlement" ALTER COLUMN "capacity" DROP NOT NULL;
ALTER TABLE "IssueHandoffSettlement" ADD COLUMN "operation" TEXT;
ALTER TABLE "IssueHandoffSettlement" ADD COLUMN "payloadHash" TEXT;
ALTER TABLE "IssueHandoffSettlement" ADD COLUMN "attemptId" TEXT;

-- PrFixQueueItem back-relation FK for the settlement rows.
ALTER TABLE "PrFixRequeueSettlement" ADD CONSTRAINT "PrFixRequeueSettlement_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PrFixQueueItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
