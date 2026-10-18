-- #1253 recovery columns on PR-fix items: stale-disposition flag,
-- evidence-driven disposition anchor (max of disposedAt/recoveryAppliedAt),
-- the disposition evidence fingerprint, the cooldown anchor for
-- operational-hold reactivation, and the fair-eligibility rotation stamp
-- for the bounded external-wait trigger reconciliation pass. Additive only:
-- no column drop or type change, so `prisma migrate deploy` is safe against a
-- database already at 20261016000000_pr_fix_evidence_ledger.
ALTER TABLE "PrFixQueueItem" ADD COLUMN "staleDisposition" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "disposedAt" TIMESTAMP(3),
ADD COLUMN "disposedEvidence" TEXT,
ADD COLUMN "recoveryAppliedAt" TIMESTAMP(3),
ADD COLUMN "triggerEvaluatedAt" TIMESTAMP(3);

-- Serves the fairness read of `reconcileExternalWaitTriggers`
-- (WHERE status = 'WAITING_EXTERNAL' AND "externalWait" IS NOT NULL
--  ORDER BY "triggerEvaluatedAt" ASC NULLS FIRST, "id" ASC LIMIT 500).
-- A btree only delivers that order when the index declares the same NULL
-- placement and the same trailing tiebreak. CREATE INDEX is additive and
-- takes no lock that blocks writes on the existing ones in this file.
CREATE INDEX "PrFixQueueItem_status_triggerEvaluatedAt_id_idx" ON "PrFixQueueItem"("status", "triggerEvaluatedAt" ASC NULLS FIRST, "id" ASC);
