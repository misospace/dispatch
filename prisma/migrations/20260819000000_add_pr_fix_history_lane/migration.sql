-- AlterTable: Track which lane each pr-fix history row was recorded under.
-- Nullable so historical rows can be counted as unknown/current lane.
ALTER TABLE "PrFixHistory" ADD COLUMN "lane" TEXT;
