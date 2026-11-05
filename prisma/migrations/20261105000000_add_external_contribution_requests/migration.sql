-- #1537 (parent #1349): Dispatch-owned external contribution requests for
-- Courier's HTTP admission API (Courier #708, POST /v1/contributions). The
-- row is persisted before the first network call so the same idempotency key
-- and canonical request fields survive timeouts, restarts, and lost success
-- responses. `idempotencyKey` is unique: one key is one contribution
-- identity. Dispatch-side ledger only — the named upstream issue is never
-- mutated from here and Courier credentials are never stored.
--
-- Additive only: new table, no existing column drop or type change.
-- CreateTable
CREATE TABLE "ExternalContributionRequest" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "lane" TEXT NOT NULL,
    "baseRepo" TEXT NOT NULL,
    "baseRef" TEXT NOT NULL,
    "workRepo" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "upstreamIssue" TEXT,
    "payloadDigest" TEXT NOT NULL,
    "deliveryStatus" TEXT NOT NULL DEFAULT 'pending',
    "courierRun" TEXT,
    "courierNamespace" TEXT,
    "courierWorkItemId" TEXT,
    "resumed" BOOLEAN,
    "courierHttpStatus" INTEGER,
    "lastError" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalContributionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalContributionRequest_idempotencyKey_key" ON "ExternalContributionRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ExternalContributionRequest_createdAt_idx" ON "ExternalContributionRequest"("createdAt");
