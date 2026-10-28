-- Verify the #1459 rotation migration against a copy of the production schema.
--
-- Run after the migration has been (re)deployed onto a database that already
-- carried the production schema and production-shaped rows. It proves:
--   1. the additive column exists and is a nullable timestamp,
--   2. the rotation index exists, is valid, carries the scan's full ORDER BY
--      columns and the same NULLS FIRST placement the scan's ORDER BY uses,
--   3. the pre-existing rows survived the migration with their values intact,
--   4. the new column is NULL for every pre-existing row (audit-only stamp:
--      the migration back-fills nothing).
DO $$
DECLARE
  seeded integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'Issue'
      AND column_name = 'blockedReconciliationAt'
      AND is_nullable = 'YES'
      AND data_type = 'timestamp without time zone'
  ) THEN
    RAISE EXCEPTION 'Issue.blockedReconciliationAt is missing or is not a nullable timestamp';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
    WHERE ns.nspname = 'public'
      AND tbl.relname = 'Issue'
      AND idx.relname = 'Issue_blocked_reconciliation_rotation_idx'
      AND i.indisvalid
      AND i.indnatts = 4
      AND (
        SELECT string_agg(att.attname, ',' ORDER BY key.ordinality)
        FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_attribute att
          ON att.attrelid = i.indrelid AND att.attnum = key.attnum
      ) = 'repositoryId,blockedReconciliationAt,groomedAt,number'
      -- Per-column sort options: bit 0 is DESC, bit 1 is NULLS FIRST. The
      -- scan orders the two nullable columns NULLS FIRST, so the index must
      -- declare the same placement (2) or Postgres sorts the eligible set per
      -- pass instead of delivering the order.
      AND (
        SELECT string_agg(opt::text, ',' ORDER BY key.ordinality)
        FROM unnest(i.indoption) WITH ORDINALITY AS key(opt, ordinality)
      ) = '0,2,2,0'
  ) THEN
    RAISE EXCEPTION 'Issue_blocked_reconciliation_rotation_idx is missing, invalid, or has the wrong columns or sort options';
  END IF;

  SELECT count(*) INTO seeded FROM "Issue" WHERE "repositoryId" = 'repo-production-copy';
  IF seeded <> 3 THEN
    RAISE EXCEPTION 'expected 3 production-shaped rows after the migration, found %', seeded;
  END IF;

  IF EXISTS (SELECT 1 FROM "Issue" WHERE "blockedReconciliationAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'pre-existing rows must keep a NULL blockedReconciliationAt';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "Issue"
    WHERE "id" = 'issue-anchored'
      AND "blockedReason" = 'waiting on #2'
      AND "groomedDependencyKeys" = ARRAY['it-migrations/production-copy#2']::TEXT[]
      AND "groomedOpenBlockerKeys" = ARRAY['it-migrations/production-copy#2']::TEXT[]
  ) THEN
    RAISE EXCEPTION 'the anchored row lost its recorded dependency evidence';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "Issue"
    WHERE "id" = 'issue-anchorless'
      AND "groomedDependencyKeys" = ARRAY[]::TEXT[]
      AND "groomedOpenBlockerKeys" = ARRAY[]::TEXT[]
      AND "groomedRunId" IS NULL
  ) THEN
    RAISE EXCEPTION 'the anchorless row lost its legacy shape';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "Issue"
    WHERE "id" = 'issue-worker'
      AND "labels" = ARRAY['status/blocked', 'status/in-progress']::TEXT[]
  ) THEN
    RAISE EXCEPTION 'the worker-owned row lost its labels';
  END IF;
END
$$;
