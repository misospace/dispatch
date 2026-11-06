-- #1569: PR-fix ORIGINAL CLAIMANT ownership evidence.
-- `claimant` records who originally owned the work the PR-fix row covers;
-- `claimantSource` records WHY that value is what it is ("lease",
-- "agent-label", "owner-label", "pr-author", "operator", or the failure
-- states "missing" / "ambiguous"). A per-generation hand-out recipient never
-- becomes the claimant, and a lane re-classification never transfers it; a
-- recorded claimant is only ever written again by operator recovery.
-- NULL claimant means unresolved, which the issuance ownership gate refuses
-- to auto-hand-out (see docs/pr-fix-ownership-contract.md).
--
-- Additive only: two nullable columns, no drop, no type change, no backfill
-- UPDATE here — legacy rows resolve lazily at first contact (re-ingestion,
-- operator requeue, or POST /api/pr-fix-queue/claimant) so the SQL migration
-- stays reversible and no ownership is guessed at deploy time.
-- AlterTable
ALTER TABLE "PrFixQueueItem" ADD COLUMN IF NOT EXISTS "claimant" TEXT;
ALTER TABLE "PrFixQueueItem" ADD COLUMN IF NOT EXISTS "claimantSource" TEXT;
