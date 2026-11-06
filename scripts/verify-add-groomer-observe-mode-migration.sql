-- Verify the #1542 observe-mode migration against a copy of the production
-- schema.
--
-- Run after the migration has been (re)deployed onto a database that already
-- carried the production schema and production-shaped GroomingRun rows. It
-- proves:
--   1. both additive columns exist and are nullable TEXT,
--   2. the receipt rollup index exists and is valid over (mode, createdAt),
--   3. the pre-existing legacy rows survived the migration with their values
--      intact,
--   4. `mode` is NULL for every pre-existing row (the migration back-fills
--      nothing; legacy rows stay readable through the dryRun boolean).
DO $$
DECLARE
  seeded integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'GroomingRun'
      AND column_name = 'mode'
      AND is_nullable = 'YES'
      AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'GroomingRun.mode is missing or is not a nullable text column';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'GroomingRun'
      AND column_name = 'observeDisposition'
      AND is_nullable = 'YES'
      AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'GroomingRun.observeDisposition is missing or is not a nullable text column';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
    WHERE ns.nspname = 'public'
      AND tbl.relname = 'GroomingRun'
      AND idx.relname = 'GroomingRun_mode_createdAt_idx'
      AND i.indisvalid
      AND i.indnatts = 2
      AND (
        SELECT string_agg(att.attname, ',' ORDER BY key.ordinality)
        FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_attribute att
          ON att.attrelid = i.indrelid AND att.attnum = key.attnum
      ) = 'mode,createdAt'
  ) THEN
    RAISE EXCEPTION 'GroomingRun_mode_createdAt_idx is missing, invalid, or has the wrong columns';
  END IF;

  SELECT count(*) INTO seeded FROM "GroomingRun" WHERE "repoFullName" = 'it-migrations/production-copy';
  IF seeded <> 3 THEN
    RAISE EXCEPTION 'expected 3 production-shaped rows after the migration, found %', seeded;
  END IF;

  IF EXISTS (SELECT 1 FROM "GroomingRun" WHERE "mode" IS NOT NULL) THEN
    RAISE EXCEPTION 'pre-existing rows must keep a NULL mode (the migration back-fills nothing)';
  END IF;

  -- Legacy dry-run receipt survived with its values intact: still readable
  -- through dryRun, the pre-#1542 observe equivalent.
  IF NOT EXISTS (
    SELECT 1
    FROM "GroomingRun"
    WHERE "id" = 'run-legacy-dry'
      AND "dryRun" = true
      AND "status" = 'dry_run_completed'
      AND "stage" = 'planned'
      AND "model" = 'test-model'
      AND "observeDisposition" IS NULL
  ) THEN
    RAISE EXCEPTION 'the legacy dry-run row lost its receipt shape';
  END IF;

  -- Legacy auto row survived with its applied mutations intact.
  IF NOT EXISTS (
    SELECT 1
    FROM "GroomingRun"
    WHERE "id" = 'run-legacy-auto'
      AND "dryRun" = false
      AND "status" = 'completed'
      AND "labelsAfter" = ARRAY['status/ready']::TEXT[]
      AND "laneAfter" = 'ready'
      AND "commentUrl" = 'https://github.com/it-migrations/production-copy/issues/7#issuecomment-legacy'
      AND "staleReasons" = ARRAY['stale_labels']::TEXT[]
  ) THEN
    RAISE EXCEPTION 'the legacy auto row lost its applied-mutation shape';
  END IF;

  -- Legacy failed row survived with its failure record intact.
  IF NOT EXISTS (
    SELECT 1
    FROM "GroomingRun"
    WHERE "id" = 'run-legacy-failed'
      AND "status" = 'failed'
      AND "stage" = 'model'
      AND "retryable" = true
      AND "errorMessage" = 'LLM timeout'
  ) THEN
    RAISE EXCEPTION 'the legacy failed row lost its failure record';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261104120000_add_groomer_observe_mode'
  ) THEN
    RAISE EXCEPTION 'the migration record is missing after the deploy';
  END IF;
END
$$;
