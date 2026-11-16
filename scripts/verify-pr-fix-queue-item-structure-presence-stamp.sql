-- Verify the #1641 stamp migration changed NOTHING on PrFixQueueItem
-- beyond adding its column and its index.
--
-- companion verification
-- (scripts/verify-add-pr-fix-presence-stamp-migration.sql) inspects the
-- column and index the migration adds and the rows it must not touch. It
-- cannot see the migration damaged anything ELSE on the table: the new
-- column and index would still be there, and the rows would still look
-- right, while the table itself is broken — a dropped column, a retyped
-- column, changed nullability, a changed varchar length or timestamp
-- precision, a dropped index, a dropped constraint.
--
-- This script closes that gap by comparing the live table against the
-- structure snapshot taken on the rewound copy BEFORE the migration was
-- re-applied (scripts/snapshot-pr-fix-queue-item-structure-presence-stamp.sql).
-- The expected shape is therefore the table's OWN pre-migration state:
-- never a hand-maintained column list that drifts out of date, and never
-- a comparison against other tables in the repository that carry known
-- schema/datamodel drift.
--
-- Run after the migration (re)deployed onto the production-shaped copy.
--
-- Note: set comparisons use NOT EXISTS rather EXCEPT. `prisma db
-- execute --file` cannot parse a set operation inside a PL/pgSQL block
-- (it fails P1014), so the file must avoid EXCEPT, INTERSECT, and UNION.
DO $$
DECLARE
drifted text;
BEGIN
-- every column the migration does not own must still exist, with the
-- same type, nullability, default, and type parameters it had before the
-- migration ran.
SELECT string_agg(
format('%s (now %s%s, nullable=%s, default=%s; %s%s, nullable=%s, default=%s)',
c.column_name,
c.data_type,
coalesce(
case when c.character_maximum_length is not null
then format('(%s)', c.character_maximum_length) else '' end, ''),
c.is_nullable, coalesce(c.column_default, '-'),
coalesce(s."dataType", 'ABSENT'),
coalesce(
case when s."characterMaxLength" is not null
then format('(%s)', s."characterMaxLength") else '' end, ''),
coalesce(s."isNullable", 'ABSENT'),
coalesce(s."columnDefault", '-')),
'; ')
INTO drifted
FROM information_schema.columns c
LEFT JOIN "_prfix_stamp_structure_columns" s
ON s."columnName" = c.column_name
WHERE c.table_schema = 'public'
AND c.table_name = 'PrFixQueueItem'
AND c.column_name <> 'prPresenceCheckedAt'
AND (s."columnName" IS NULL
OR s."dataType" <> c.data_type
OR s."isNullable" <> c.is_nullable
OR coalesce(s."columnDefault", '') <> coalesce(c.column_default, '')
OR coalesce(s."characterMaxLength", -1) <> coalesce(c.character_maximum_length, -1)
OR coalesce(s."numericPrecision", -1) <> coalesce(c.numeric_precision, -1)
OR coalesce(s."numericScale", -1) <> coalesce(c.numeric_scale, -1)
OR coalesce(s."dateTimePrecision", -1) <> coalesce(c.datetime_precision, -1));
IF drifted IS NOT NULL THEN
RAISE EXCEPTION 'the migration changed columns it does not own: %', drifted;
END IF;
-- a column the snapshot recorded but the table no longer has was dropped
-- by the migration.
SELECT string_agg(s."columnName", ', ') INTO drifted
FROM "_prfix_stamp_structure_columns" s
WHERE NOT EXISTS (
SELECT 1 FROM information_schema.columns c
WHERE c.table_schema = 'public'
AND c.table_name = 'PrFixQueueItem'
AND c.column_name = s."columnName"
);
IF drifted IS NOT NULL THEN
RAISE EXCEPTION 'the migration dropped columns it not own: %', drifted;
END IF;
-- the index set must be unchanged, apart from the rotation index the
-- migration owns: an index the migration dropped, or one rebuilt over
-- different columns, changes the table it does not own.
SELECT string_agg(i.indexname, ', ') INTO drifted
FROM pg_indexes i
WHERE i.schemaname = 'public'
AND i.tablename = 'PrFixQueueItem'
AND i.indexname <> 'PrFixQueueItem_status_prPresenceCheckedAt_id_idx'
AND NOT EXISTS (
SELECT 1 FROM "_prfix_stamp_structure_indexes" s
WHERE s."indexName" = i.indexname
AND s."indexDefinition" = i.indexdef
);
IF drifted IS NOT NULL THEN
RAISE EXCEPTION 'the migration changed indexes it does not own: %', drifted;
END IF;
SELECT string_agg(s."indexName", ', ') INTO drifted
FROM "_prfix_stamp_structure_indexes" s
WHERE NOT EXISTS (
SELECT 1 FROM pg_indexes i
WHERE i.schemaname = 'public'
AND i.tablename = 'PrFixQueueItem'
AND i.indexname = s."indexName"
AND i.indexdef = s."indexDefinition"
);
IF drifted IS NOT NULL THEN
RAISE EXCEPTION 'the migration dropped indexes it does not own: %', drifted;
END IF;
-- the constraint set must be unchanged, for the same reason.
SELECT string_agg(k.conname, ', ') INTO drifted
FROM pg_constraint k
WHERE k.conrelid = 'public."PrFixQueueItem"'::regclass
AND k.contype IN ('u', 'p', 'c', 'f')
AND NOT EXISTS (
SELECT 1 FROM "_prfix_stamp_structure_constraints" s
WHERE s."constraintName" = k.conname
AND s."constraintDefinition" = pg_get_constraintdef(k.oid)
);
IF drifted IS NOT NULL THEN
RAISE EXCEPTION 'the migration changed constraints it does not own: %', drifted;
END IF;
SELECT string_agg(s."constraintName", ', ') INTO drifted
FROM "_prfix_stamp_structure_constraints" s
WHERE NOT EXISTS (
SELECT 1 FROM pg_constraint k
WHERE k.conrelid = 'public."PrFixQueueItem"'::regclass
AND k.contype IN ('u', 'p', 'c', 'f')
AND k.conname = s."constraintName"
AND pg_get_constraintdef(k.oid) = s."constraintDefinition"
);
IF drifted IS NOT NULL THEN
RAISE EXCEPTION 'the migration dropped constraints it does not own: %', drifted;
END IF;
END
$$;
