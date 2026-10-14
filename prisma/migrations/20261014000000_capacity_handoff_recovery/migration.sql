-- Fenced capacity-exhaustion handoff (#1256)

-- Claim/attempt fencing token on the issue lease.
ALTER TABLE "Lease" ADD COLUMN "claimToken" TEXT;

CREATE UNIQUE INDEX "Lease_claimToken_key" ON "Lease"("claimToken");

-- Capacity-scoped bounded cooldowns for explicit capacity exhaustion.
CREATE TABLE "CapacityHandoff" (
    "id" TEXT NOT NULL,
    "capacity" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "issueNumber" INTEGER,
    "prNumber" INTEGER,
    "agentName" TEXT NOT NULL,
    "issueId" TEXT,
    "generation" INTEGER,
    "cooldownUntil" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CapacityHandoff_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CapacityHandoff_capacity_cooldownUntil_idx" ON "CapacityHandoff"("capacity", "cooldownUntil");
CREATE INDEX "CapacityHandoff_kind_repoFullName_issueNumber_cooldownUntil_idx" ON "CapacityHandoff"("kind", "repoFullName", "issueNumber", "cooldownUntil");
CREATE INDEX "CapacityHandoff_kind_repoFullName_prNumber_cooldownUntil_idx" ON "CapacityHandoff"("kind", "repoFullName", "prNumber", "cooldownUntil");
CREATE INDEX "CapacityHandoff_cooldownUntil_idx" ON "CapacityHandoff"("cooldownUntil");

-- Per-hand-out receipts for exact source-attempt fencing (#1256 review).
ALTER TABLE "PrFixQueueItem" ADD COLUMN "handoutReceipts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
