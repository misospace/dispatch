-- #1251: optional worker ownership capability on Lease.
-- Durable registration, fenced renewal, external-wait marker, and terminal
-- disposition reuse the existing Lease row (design
-- docs/ownership-reconciliation.md §6.1 — no parallel lease table).
-- Every column is nullable: clients that never adopt the capability leave
-- them unset and stay conservatively unverified.
ALTER TABLE "Lease" ADD COLUMN "runRef" TEXT;
ALTER TABLE "Lease" ADD COLUMN "registeredAt" TIMESTAMP(3);
ALTER TABLE "Lease" ADD COLUMN "registrationOccurredAt" TIMESTAMP(3);
ALTER TABLE "Lease" ADD COLUMN "renewCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Lease" ADD COLUMN "lastRenewalObservedAt" TIMESTAMP(3);
ALTER TABLE "Lease" ADD COLUMN "lastRenewalOccurredAt" TIMESTAMP(3);
ALTER TABLE "Lease" ADD COLUMN "retryAfter" TIMESTAMP(3);
ALTER TABLE "Lease" ADD COLUMN "waitReason" TEXT;
ALTER TABLE "Lease" ADD COLUMN "disposition" TEXT;
ALTER TABLE "Lease" ADD COLUMN "dispositionNote" TEXT;
ALTER TABLE "Lease" ADD COLUMN "successorRef" TEXT;
ALTER TABLE "Lease" ADD COLUMN "dispositionOccurredAt" TIMESTAMP(3);
ALTER TABLE "Lease" ADD COLUMN "dispositionObservedAt" TIMESTAMP(3);
