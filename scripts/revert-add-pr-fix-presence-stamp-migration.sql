-- Reconstruct the PRE-migration production schema on the copy (#1641).
--
-- The stamp migration is additive: it adds one nullable column and one
-- index, and touches nothing else. This script reproduces the database
-- state a production instance would be in right before `prisma migrate
-- deploy` runs the migration — same schema, same rows — so the migration
-- is then applied against a production-shaped database instead of an
-- empty one.
--
-- How the copy reaches that state: the CI job marks the migration as
-- applied (`prisma migrate resolve --applied`, which writes the migration
-- record without executing the SQL), deploys everything else, and seeds
-- production-shaped rows. The table therefore never carried the
-- prPresenceCheckedAt column, so there is nothing to drop here — the ONLY
-- thing standing between this copy and a real run of the migration is the
-- migration record. This script removes it, and the next deploy runs the
-- migration for real: its first execution, against the seeded rows.
--
-- That ordering matters for what the exercise can detect. If the migration
-- had already run once, a migration that damages the table would have done
-- its damage before the "before" picture was taken, and the comparison
-- would compare a damaged table against itself.
--
-- The rewind is closed over the migration's object set: the guard below
-- runs BEFORE the destructive statement, and it fails if the copy already
-- carries the stamp column — so a migration that grew a second column the
-- rewind does not know about turns the gate red here instead of letting
-- the following deploy no-op over it.
DO $$
DECLARE
  seeded integer;
BEGIN
  -- The column must be ABSENT here: this script runs on the copy BEFORE
  -- the migration ever ran, so its presence would mean the migration was
  -- already applied and the exercise would not test it.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'PrFixQueueItem'
      AND column_name = 'prPresenceCheckedAt'
  ) THEN
    RAISE EXCEPTION 'the copy already carries the prPresenceCheckedAt column, so the migration has already run and this exercise would not test it';
  END IF;

  -- The migration record must be present and marked applied: the CI job
  -- marked it so the deploy that seeded this copy skipped it.
  IF NOT EXISTS (
    SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261116000000_add_pr_fix_presence_probe_stamp'
  ) THEN
    RAISE EXCEPTION 'the migration record is missing, so the copy was not prepared for this exercise';
  END IF;

  -- The production-shaped rows must be present BEFORE the record is
  -- removed: this is the guard that keeps the destructive statement below
  -- away from a database this exercise did not set up.
  SELECT count(*) INTO seeded FROM "PrFixQueueItem" WHERE "repo" = 'it-migrations/production-copy';
  IF seeded <> 3 THEN
    RAISE EXCEPTION 'the rewind found % production-shaped rows, expected 3', seeded;
  END IF;
END
$$;

-- Remove the migration record so the next deploy runs the migration for
-- real. The column is absent already (the migration never ran), so
-- nothing is dropped here.
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261116000000_add_pr_fix_presence_probe_stamp';

-- The rewind must actually rewind: without these assertions the exercise
-- would silently degrade into "deploy against an empty database" if the
-- record removal stopped matching the migration, and the verification that
-- follows would still pass.
DO $$
DECLARE
  seeded integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261116000000_add_pr_fix_presence_probe_stamp'
  ) THEN
    RAISE EXCEPTION 'the rewind left the migration record in place';
  END IF;

  -- No leftover stamp column may exist: the rewind is closed over the
  -- migration's object set, so a column the migration adds that the
  -- rewind does not know about turns the gate red here instead of
  -- letting the following deploy no-op over it.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'PrFixQueueItem'
      AND column_name = 'prPresenceCheckedAt'
  ) THEN
    RAISE EXCEPTION 'the copy already carries the prPresenceCheckedAt column, so the rewind no longer matches the migration object set';
  END IF;

  SELECT count(*) INTO seeded FROM "PrFixQueueItem" WHERE "repo" = 'it-migrations/production-copy';
  IF seeded <> 3 THEN
    RAISE EXCEPTION 'the rewind lost the production-shaped rows (found %)', seeded;
  END IF;
END
$$;
