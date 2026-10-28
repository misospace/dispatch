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
