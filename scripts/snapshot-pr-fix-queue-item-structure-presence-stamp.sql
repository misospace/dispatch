-- Snapshot structure PrFixQueueItem on the rewound copy (#1641).
--
-- companion verification
-- (scripts/verify-pr-fix-queue-item-structure-presence-stamp.sql) needs
-- prove the stamp migration changed NOTHING on PrFixQueueItem beyond
-- adding its column and its index. verification only recorded a "before"
-- picture, and the before picture must be the table's OWN pre-migration
-- state — not a hand-maintained column list that drifts out of date, and
-- not a comparison against other tables in the repository that carry
-- known schema/datamodel drift.
--
-- script records the picture: column (name, type, nullability, default,
-- and type parameters `data_type` alone is too coarse to carry — varchar
-- length, timestamp precision), index definition, and constraint
-- definition. It runs on the rewound copy, BEFORE the migration is
-- re-applied, so the recorded state is exactly what a production instance
-- holds right before `prisma migrate deploy` runs the migration.
--
-- The snapshot lives in the exercise database and is read by the
-- verification script; nothing passes CI steps but the database.
DROP TABLE IF EXISTS "_prfix_stamp_structure_columns";
CREATE TABLE "_prfix_stamp_structure_columns" (
"columnName" TEXT PRIMARY KEY,
"dataType" TEXT NOT NULL,
"isNullable" TEXT NOT NULL,
"columnDefault" TEXT,
"characterMaxLength" INTEGER,
"numericPrecision" INTEGER,
"numericScale" INTEGER,
"dateTimePrecision" INTEGER
);
INSERT INTO "_prfix_stamp_structure_columns" (
"columnName", "dataType", "isNullable", "columnDefault",
"characterMaxLength", "numericPrecision", "numericScale", "dateTimePrecision"
)
SELECT
c.column_name,
c.data_type,
c.is_nullable,
c.column_default,
c.character_maximum_length,
c.numeric_precision,
c.numeric_scale,
c.datetime_precision
FROM information_schema.columns c
WHERE c.table_schema = 'public'
AND c.table_name = 'PrFixQueueItem';
DROP TABLE IF EXISTS "_prfix_stamp_structure_indexes";
CREATE TABLE "_prfix_stamp_structure_indexes" (
"indexName" TEXT PRIMARY KEY,
-- full definition, not just name: an index rebuilt over different
-- columns under the same name changes the name alone would hide.
"indexDefinition" TEXT NOT NULL
);
INSERT INTO "_prfix_stamp_structure_indexes" ("indexName", "indexDefinition")
SELECT i.indexname, i.indexdef
FROM pg_indexes i
WHERE i.schemaname = 'public'
AND i.tablename = 'PrFixQueueItem';
DROP TABLE IF EXISTS "_prfix_stamp_structure_constraints";
CREATE TABLE "_prfix_stamp_structure_constraints" (
"constraintName" TEXT PRIMARY KEY,
-- full definition, not just name.
"constraintDefinition" TEXT NOT NULL
);
INSERT INTO "_prfix_stamp_structure_constraints" ("constraintName", "constraintDefinition")
SELECT k.conname, pg_get_constraintdef(k.oid)
FROM pg_constraint k
WHERE k.conrelid = 'public."PrFixQueueItem"'::regclass
AND k.contype IN ('u', 'p', 'c', 'f');
-- The snapshot must be non-empty, and must NOT carry the column the
-- migration adds: the script runs on the rewound copy, so its absence
-- proves the rewind really rewound. An empty snapshot, or one that
-- already carries the column, would make the verification that follows
-- vacuous.
DO $$
DECLARE
recorded integer;
leaked text;
BEGIN
SELECT count(*) INTO recorded FROM "_prfix_stamp_structure_columns";
IF recorded < 10 THEN
RAISE EXCEPTION 'the structure snapshot recorded only % columns, expected full pre-migration table', recorded;
END IF;
SELECT string_agg("columnName", ', ') INTO leaked
FROM "_prfix_stamp_structure_columns"
WHERE "columnName" = 'prPresenceCheckedAt';
IF leaked IS NOT NULL THEN
RAISE EXCEPTION 'the structure snapshot already carries the stamp column (%), so rewind did not rewind', leaked;
END IF;
END
$$;
