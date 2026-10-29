-- #1480: durable release-delta snapshot per tracked repo.
-- Latest stable GitHub release → current default-branch head, computed
-- during Automation sync. releaseState vocabulary:
-- identical | ahead | diverged | unknown | no-baseline.
-- releaseAheadBy is only an unreleased count when releaseState is
-- identical/ahead; diverged/unknown/no-baseline must never be read as one.
ALTER TABLE "AutomationRepo" ADD COLUMN "releaseState" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "AutomationRepo" ADD COLUMN "releaseBaselineTag" TEXT;
ALTER TABLE "AutomationRepo" ADD COLUMN "releaseBaselineSha" TEXT;
ALTER TABLE "AutomationRepo" ADD COLUMN "releaseBaselinePublishedAt" TIMESTAMP(3);
ALTER TABLE "AutomationRepo" ADD COLUMN "releaseHeadSha" TEXT;
ALTER TABLE "AutomationRepo" ADD COLUMN "releaseAheadBy" INTEGER;
ALTER TABLE "AutomationRepo" ADD COLUMN "releaseError" TEXT;
ALTER TABLE "AutomationRepo" ADD COLUMN "releaseDeltaSyncedAt" TIMESTAMP(3);
