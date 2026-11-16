-- Verify the #1641 deleted-PR rotation-stamp migration against copy
-- production schema.
--
-- Run after the migration has been (re)deployed onto a database that
-- already carried the production schema and production-shaped
-- PrFixQueueItem rows. It proves:
-- 1. the additive column exists, is nullable, is a timestamp(3), and
--    carries no default (a default would stamp every existing row at
--    deploy time),
-- 2. the rotation index exists, is valid, and carries the NULLS FIRST
--    placement the rotation order needs — PostgreSQL ranks NULL last by
--    default, and the reap reads the rows it considered least recently
--    first,
-- 3. the pre-existing production-shaped rows survived the migration with
--    their values intact,
-- 4. the migration back-fills nothing — every pre-existing row keeps a
--    NULL stamp, because the stamp records "the reap considered this
--    row", and a back-filled value would claim the row was considered
--    before the deploy,
-- 5. the migration record is present after the deploy.
--
-- The script only looks at the column and index the migration adds and
-- the rows it must not touch. The companion verification
-- (scripts/verify-pr-fix-queue-item-structure-presence-stamp.sql)
-- compares the whole table against the structure snapshot taken before
-- the migration ran, so a migration that damaged another column, index
-- or constraint still fails the exercise.
DO $$
DECLARE
seeded integer;
BEGIN
IF NOT EXISTS (
SELECT 1
FROM information_schema.columns
WHERE table_schema = 'public'
AND table_name = 'PrFixQueueItem'
AND column_name = 'prPresenceCheckedAt'
AND is_nullable = 'YES'
AND data_type = 'timestamp without time zone'
AND datetime_precision = 3
AND column_default IS NULL
) THEN
RAISE EXCEPTION 'PrFixQueueItem.prPresenceCheckedAt is missing, not nullable, not a timestamp(3), or carries a default';
END IF;
IF NOT EXISTS (
SELECT 1
FROM pg_index i
JOIN pg_class idx ON idx.oid = i.indexrelid
JOIN pg_class tbl ON tbl.oid = i.indrelid
JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
WHERE ns.nspname = 'public'
AND tbl.relname = 'PrFixQueueItem'
AND idx.relname = 'PrFixQueueItem_status_prPresenceCheckedAt_id_idx'
AND i.indisvalid
AND i.indnatts = 3
AND (
SELECT string_agg(att.attname, ',' ORDER BY key.ordinality)
FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
JOIN pg_attribute att
ON att.attrelid = i.indrelid AND att.attnum = key.attnum
) = 'status,prPresenceCheckedAt,id'
-- indoption carries one flag per index column: 0 = ASC NULLS LAST,
-- 2 = ASC NULLS FIRST. The stamp column must sort its NULLs first, or
-- the rotation never advances.
AND i.indoption::text = '0 2 0'
) THEN
RAISE EXCEPTION 'the rotation index is missing, invalid, or does not carry the NULLS FIRST placement';
END IF;
SELECT count(*) INTO seeded FROM "PrFixQueueItem" WHERE "repo" = 'it-migrations/production-copy';
IF seeded <> 3 THEN
RAISE EXCEPTION 'expected 3 production-shaped rows after migration, found %', seeded;
END IF;
-- the migration back-fills nothing: no pre-existing row gained a
-- stamp. The stamp is a rotation marker, not a proof, so a back-filled
-- value would silently move every row out of the due set.
IF EXISTS (
SELECT 1 FROM "PrFixQueueItem"
WHERE "repo" = 'it-migrations/production-copy'
AND "prPresenceCheckedAt" IS NOT NULL
) THEN
RAISE EXCEPTION 'the migration back-filled the rotation stamp onto pre-existing rows';
END IF;
-- the legacy queued row survived values intact.
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
AND "prPresenceCheckedAt" IS NULL
) THEN
RAISE EXCEPTION 'the legacy queued row lost its shape';
END IF;
-- the legacy escalated row survived its re-enqueued generation intact.
IF NOT EXISTS (
SELECT 1
FROM "PrFixQueueItem"
WHERE "id" = 'prfix-legacy-escalated'
AND "repo" = 'it-migrations/production-copy'
AND "pr" = 12
AND "issue" = 102
AND "lane" = 'ESCALATED'
AND "type" = 'REVIEW_FEEDBACK'
AND "generation" = 3
AND "fixAttempts" = 3
AND "author" = 'legacy-pr-author-e'
AND "agentHandouts" = ARRAY[]::TEXT[]
AND "prPresenceCheckedAt" IS NULL
) THEN
RAISE EXCEPTION 'the legacy escalated row lost its shape';
END IF;
-- the legacy handed-out row survived its whole hand-out shape intact.
IF NOT EXISTS (
SELECT 1
FROM "PrFixQueueItem"
WHERE "id" = 'prfix-legacy-handed-out'
AND "repo" = 'it-migrations/production-copy'
AND "pr" = 13
AND "issue" = 103
AND "generation" = 2
AND "fixAttempts" = 2
AND "agentHandouts" = ARRAY['legacy-worker@2']::TEXT[]
AND "handoutAcks" = ARRAY['legacy-worker@2']::TEXT[]
AND array_length("handoutAckTimes", 1) = 1
AND "handoutReceipts" = ARRAY['hnd_deadbeefdeadbeefdeadbeef@legacy-worker@2']::TEXT[]
AND "dispatchedGeneration" = 2
AND "dispatchedAt" IS NOT NULL
AND "prPresenceCheckedAt" IS NULL
) THEN
RAISE EXCEPTION 'the legacy handed-out row lost shape';
END IF;
IF NOT EXISTS (
SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261116000000_add_pr_fix_presence_probe_stamp'
) THEN
RAISE EXCEPTION 'the migration record missing after deploy';
END IF;
END
$$;
