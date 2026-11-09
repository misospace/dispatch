-- Snapshot the structure of PrFixQueueItem on the rewound copy (#1569).
--
-- The companion verification
-- (scripts/verify-pr-fix-queue-item-structure.sql) needs to prove that the
-- claimant migration changed NOTHING on PrFixQueueItem beyond adding its
-- two columns. The verification can only do that against a recorded
-- "before" picture, and the before picture must be the table's OWN
-- pre-migration state — not a hand-maintained column list that drifts out
-- of date, and not a comparison against other tables in this repository
-- that carry known schema/datamodel drift.
--
-- This script records that picture: every column (name, type, nullability,
-- default, and the type parameters `data_type` alone is too coarse to
-- carry — a varchar length, a timestamp precision), every index
-- definition, and every constraint definition. It runs on the rewound copy,
-- BEFORE the migration is re-applied, so the recorded state is exactly what
-- a production instance holds right before `prisma migrate deploy` runs the
-- migration.
--
-- The snapshot lives in this exercise database and is read by the
-- verification script; nothing passes between CI steps but the database.
DROP TABLE IF EXISTS "_prfix_claimant_structure_columns";

CREATE TABLE "_prfix_claimant_structure_columns" (
  "columnName" TEXT PRIMARY KEY,
  "dataType" TEXT NOT NULL,
  "isNullable" TEXT NOT NULL,
  "columnDefault" TEXT,
  "characterMaxLength" INTEGER,
  "numericPrecision" INTEGER,
  "numericScale" INTEGER,
  "dateTimePrecision" INTEGER
);

INSERT INTO "_prfix_claimant_structure_columns" (
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

DROP TABLE IF EXISTS "_prfix_claimant_structure_indexes";

CREATE TABLE "_prfix_claimant_structure_indexes" (
  "indexName" TEXT PRIMARY KEY,
  -- The full definition, not just the name: an index rebuilt over different
  -- columns under the same name is a change the name alone would hide.
  "indexDefinition" TEXT NOT NULL
);

INSERT INTO "_prfix_claimant_structure_indexes" ("indexName", "indexDefinition")
SELECT i.indexname, i.indexdef
FROM pg_indexes i
WHERE i.schemaname = 'public'
  AND i.tablename = 'PrFixQueueItem';

DROP TABLE IF EXISTS "_prfix_claimant_structure_constraints";

CREATE TABLE "_prfix_claimant_structure_constraints" (
  "constraintName" TEXT PRIMARY KEY,
  -- The full definition, not just the name.
  "constraintDefinition" TEXT NOT NULL
);

INSERT INTO "_prfix_claimant_structure_constraints" ("constraintName", "constraintDefinition")
SELECT k.conname, pg_get_constraintdef(k.oid)
FROM pg_constraint k
WHERE k.conrelid = 'public."PrFixQueueItem"'::regclass
  AND k.contype IN ('u', 'p', 'c', 'f');

-- The snapshot must be non-empty, and must NOT carry the two columns the
-- migration adds: this script runs on the rewound copy, so their absence
-- proves the rewind really rewound. A snapshot that is empty or that
-- already contains them would make the verification that follows vacuous.
DO $$
DECLARE
  recorded integer;
  leaked text;
BEGIN
  SELECT count(*) INTO recorded FROM "_prfix_claimant_structure_columns";
  IF recorded < 10 THEN
    RAISE EXCEPTION 'the structure snapshot recorded only % columns, expected the full pre-migration table', recorded;
  END IF;

  SELECT string_agg("columnName", ', ') INTO leaked
  FROM "_prfix_claimant_structure_columns"
  WHERE "columnName" IN ('claimant', 'claimantSource');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'the structure snapshot already carries the claimant columns (%), so the rewind did not rewind', leaked;
  END IF;
END
$$;
