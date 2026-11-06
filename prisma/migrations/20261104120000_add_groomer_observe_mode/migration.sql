-- #1542: off/observe/auto rollout mode for the hosted groomer.
--
-- `mode` records the run's rollout mode: "observe" (full assessment ran,
-- zero external writes) or "auto" (writes allowed). Null on rows recorded
-- before the off/observe/auto contract; those stay readable through the
-- dryRun boolean.
-- `observeDisposition` records what an observe run would have done had it
-- been allowed to act: would_act | would_noop | would_refuse |
-- assessment_unavailable. Null on auto-mode and legacy rows.
--
-- Additive only: two nullable columns, no existing column drop or type
-- change, `prisma migrate deploy` safe on databases already
-- 20261104000000_add_pr_fix_stagnation_count.
ALTER TABLE "GroomingRun" ADD COLUMN "mode" TEXT;
ALTER TABLE "GroomingRun" ADD COLUMN "observeDisposition" TEXT;

-- Observe-mode receipt rollups: the summary seek filters mode + a recent
-- createdAt window to count would-dispositions.
CREATE INDEX "GroomingRun_mode_createdAt_idx" ON "GroomingRun"("mode", "createdAt");
