-- #1254: ownership reconciliation — the two-sided release boundary
-- (docs/ownership-reconciliation.md §8.7).
-- OwnershipReleaseIntent: the reconciler-side pending release intent committed
-- under the per-issue IssueMutationGuard anchor in Phase A; its presence holds
-- the claim path (409) until the Phase C settle clears it.
-- OwnershipReconcileCandidate: persisted confirmation-ladder state (§8.2) —
-- stale observations for the multi-pass proof, per-claim reclaim counter and
-- cooldown.
CREATE TABLE "OwnershipReleaseIntent" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "agentLabel" TEXT NOT NULL,
    "attemptToken" TEXT,
    "phase" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "parkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnershipReleaseIntent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OwnershipReconcileCandidate" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "staleCount" INTEGER NOT NULL DEFAULT 0,
    "firstStaleAt" TIMESTAMP(3),
    "lastObservedAt" TIMESTAMP(3),
    "reclaimCount" INTEGER NOT NULL DEFAULT 0,
    "lastReclaimAt" TIMESTAMP(3),
    "lastReasons" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnershipReconcileCandidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OwnershipReleaseIntent_issueId_agentLabel_key" ON "OwnershipReleaseIntent"("issueId", "agentLabel");
CREATE INDEX "OwnershipReleaseIntent_createdAt_idx" ON "OwnershipReleaseIntent"("createdAt");

CREATE UNIQUE INDEX "OwnershipReconcileCandidate_issueId_key" ON "OwnershipReconcileCandidate"("issueId");

ALTER TABLE "OwnershipReleaseIntent" ADD CONSTRAINT "OwnershipReleaseIntent_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OwnershipReconcileCandidate" ADD CONSTRAINT "OwnershipReconcileCandidate_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
