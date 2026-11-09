-- Verify the #1569 claimant migration against a copy of the production
-- schema.
--
-- Run after the migration has been (re)deployed onto a database that already
-- carried the production schema and production-shaped PrFixQueueItem rows. It
-- proves:
--   1. both additive columns exist and are nullable TEXT,
--   2. the pre-existing legacy rows survived the migration with their values
--      intact,
--   3. the migration back-fills nothing — every pre-existing row keeps a NULL
--      claimant and a NULL claimantSource, so no ownership is guessed at
--      deploy time and a legacy row stays unresolved until recovery resolves
--      it,
--   4. the PR author, the per-generation hand-out recipient, the durable
--      hand-out receipt, and the acknowledgement timestamp were NOT promoted
--      into the claimant column (a fresh hand-out recipient is never the
--      original claimant, and the PR author is a separate identity),
--   5. the migration record is present after the deploy.
--
-- This script only looks at the two columns the migration adds and the rows
-- it must not touch. A migration that damaged an UNRELATED column of the
-- same table would pass every assertion here, so the CI job also runs
-- scripts/verify-pr-fix-queue-item-structure.sql, which compares the live
-- table against the structure snapshot taken before the migration ran
-- (scripts/snapshot-pr-fix-queue-item-structure.sql).
DO $$
DECLARE
  seeded integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'PrFixQueueItem'
      AND column_name = 'claimant'
      AND is_nullable = 'YES'
      AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'PrFixQueueItem.claimant is missing or is not a nullable text column';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'PrFixQueueItem'
      AND column_name = 'claimantSource'
      AND is_nullable = 'YES'
      AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'PrFixQueueItem.claimantSource is missing or is not a nullable text column';
  END IF;

  SELECT count(*) INTO seeded FROM "PrFixQueueItem" WHERE "repo" = 'it-migrations/production-copy';
  IF seeded <> 3 THEN
    RAISE EXCEPTION 'expected 3 production-shaped rows after the migration, found %', seeded;
  END IF;

  -- The migration back-fills nothing: no pre-existing row gained a claimant
  -- or a provenance. Ownership stays unresolved until recovery resolves it.
  IF EXISTS (
    SELECT 1 FROM "PrFixQueueItem"
    WHERE "repo" = 'it-migrations/production-copy'
      AND ("claimant" IS NOT NULL OR "claimantSource" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'the migration back-filled a claimant onto a pre-existing row';
  END IF;

  -- Legacy queued row survived with its values intact.
  IF NOT EXISTS (
    SELECT 1
    FROM "PrFixQueueItem"
    WHERE "id" = 'prfix-legacy-queued'
      AND "repo" = 'it-migrations/production-copy'
      AND "pr" = 11
      AND "issue" = 101
      AND "lane" = 'NORMAL'
      AND "type" = 'OTHER'
      AND "status" = 'QUEUED'
      AND "generation" = 1
      AND "fixAttempts" = 1
      AND "author" = 'legacy-pr-author-n'
      AND "agentHandouts" = ARRAY[]::TEXT[]
      AND "dispatchedGeneration" IS NULL
      AND "claimant" IS NULL
      AND "claimantSource" IS NULL
  ) THEN
    RAISE EXCEPTION 'the legacy queued row lost its shape';
  END IF;

  -- Legacy escalated row survived with its re-enqueued generation intact.
  IF NOT EXISTS (
    SELECT 1
    FROM "PrFixQueueItem"
    WHERE "id" = 'prfix-legacy-escalated'
      AND "pr" = 12
      AND "issue" = 102
      AND "lane" = 'ESCALATED'
      AND "type" = 'REVIEW_FEEDBACK'
      AND "generation" = 3
      AND "fixAttempts" = 3
      AND "author" = 'legacy-pr-author-e'
      AND "agentHandouts" = ARRAY[]::TEXT[]
      AND "claimant" IS NULL
      AND "claimantSource" IS NULL
  ) THEN
    RAISE EXCEPTION 'the legacy escalated row lost its shape';
  END IF;

  -- Legacy handed-out row survived with its whole hand-out shape intact, and
  -- its per-generation receiving consumer was NOT promoted into the claimant
  -- column.
  IF NOT EXISTS (
    SELECT 1
    FROM "PrFixQueueItem"
    WHERE "id" = 'prfix-legacy-handed-out'
      AND "pr" = 13
      AND "issue" = 103
      AND "generation" = 2
      AND "fixAttempts" = 2
      AND "agentHandouts" = ARRAY['legacy-worker@2']::TEXT[]
      AND "handoutAcks" = ARRAY['legacy-worker@2']::TEXT[]
      AND array_length("handoutAckTimes", 1) = 1
      AND "handoutAckTimes" = ARRAY[to_char("dispatchedAt" + interval '1 hour', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')]::TEXT[]
      AND "handoutReceipts" = ARRAY['hnd_deadbeefdeadbeefdeadbeef@legacy-worker@2']::TEXT[]
      AND "dispatchedGeneration" = 2
      AND "dispatchedAt" IS NOT NULL
      AND "claimant" IS NULL
      AND "claimantSource" IS NULL
  ) THEN
    RAISE EXCEPTION 'the legacy handed-out row lost its shape';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261106000000_add_pr_fix_claimant_ownership'
  ) THEN
    RAISE EXCEPTION 'the migration record is missing after the deploy';
  END IF;
END
$$;
