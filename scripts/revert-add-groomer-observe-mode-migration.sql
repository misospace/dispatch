-- Reconstruct the PRE-migration production schema on the copy (#1542).
--
-- The observe-mode migration is additive: two nullable columns and one
-- index, touching nothing else. Dropping exactly those three objects and
-- removing the migration record therefore reproduces the database state a
-- production instance would be in right before `prisma migrate deploy` runs
-- it — same schema, same rows — so the next deploy applies the migration
-- against a production-shaped database instead of an empty one.
DROP INDEX IF EXISTS "GroomingRun_mode_createdAt_idx";

ALTER TABLE "GroomingRun" DROP COLUMN IF EXISTS "mode";

ALTER TABLE "GroomingRun" DROP COLUMN IF EXISTS "observeDisposition";

DELETE FROM "_prisma_migrations" WHERE migration_name = '20261104120000_add_groomer_observe_mode';

-- The rewind must actually rewind: without these assertions the exercise
-- would silently degrade into "deploy against an empty database" if the
-- drops stopped matching the migration, and the verification that follows
-- would still pass.
DO $$
DECLARE
  seeded integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'GroomingRun' AND column_name IN ('mode', 'observeDisposition')
  ) THEN
    RAISE EXCEPTION 'the rewind left GroomingRun.mode/observeDisposition in place';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class idx
    JOIN pg_namespace ns ON ns.oid = idx.relnamespace
    WHERE ns.nspname = 'public' AND idx.relname = 'GroomingRun_mode_createdAt_idx'
  ) THEN
    RAISE EXCEPTION 'the rewind left the observe-mode index in place';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261104120000_add_groomer_observe_mode'
  ) THEN
    RAISE EXCEPTION 'the rewind left the migration record in place';
  END IF;

  SELECT count(*) INTO seeded FROM "GroomingRun" WHERE "repoFullName" = 'it-migrations/production-copy';
  IF seeded <> 3 THEN
    RAISE EXCEPTION 'the rewind lost the production-shaped rows (found %)', seeded;
  END IF;
END
$$;
