-- Reconstruct the PRE-migration production schema on the copy (#1459).
--
-- The rotation migration is additive: it adds one nullable column and one
-- index, and touches nothing else. Dropping exactly those two objects and
-- removing the migration record therefore reproduces the database state a
-- production instance would be in right before `prisma migrate deploy` runs
-- it — same schema, same rows — so the next deploy applies the migration
-- against a production-shaped database instead of an empty one.
DROP INDEX IF EXISTS "Issue_blocked_reconciliation_rotation_idx";

ALTER TABLE "Issue" DROP COLUMN IF EXISTS "blockedReconciliationAt";

DELETE FROM "_prisma_migrations" WHERE migration_name = '20261028000000_blocked_reconciliation_rotation';

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
    WHERE table_name = 'Issue' AND column_name = 'blockedReconciliationAt'
  ) THEN
    RAISE EXCEPTION 'the rewind left Issue.blockedReconciliationAt in place';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class idx
    JOIN pg_namespace ns ON ns.oid = idx.relnamespace
    WHERE ns.nspname = 'public' AND idx.relname = 'Issue_blocked_reconciliation_rotation_idx'
  ) THEN
    RAISE EXCEPTION 'the rewind left the rotation index in place';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261028000000_blocked_reconciliation_rotation'
  ) THEN
    RAISE EXCEPTION 'the rewind left the migration record in place';
  END IF;

  SELECT count(*) INTO seeded FROM "Issue" WHERE "repositoryId" = 'repo-production-copy';
  IF seeded <> 3 THEN
    RAISE EXCEPTION 'the rewind lost the production-shaped rows (found %)', seeded;
  END IF;
END
$$;
