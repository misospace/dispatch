DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
    WHERE ns.nspname = 'public'
      AND tbl.relname = 'Issue'
      AND idx.relname = 'Issue_currentLane_idx'
      AND i.indisvalid
      AND i.indnatts = 1
      AND (
        SELECT string_agg(att.attname, ',' ORDER BY key.ordinality)
        FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_attribute att
          ON att.attrelid = i.indrelid AND att.attnum = key.attnum
      ) = 'currentLane'
  ) THEN
    RAISE EXCEPTION 'Issue_currentLane_idx is missing or has the wrong columns';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
    WHERE ns.nspname = 'public'
      AND tbl.relname = 'Issue'
      AND idx.relname = 'Issue_currentLane_state_idx'
      AND i.indisvalid
      AND i.indnatts = 2
      AND (
        SELECT string_agg(att.attname, ',' ORDER BY key.ordinality)
        FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_attribute att
          ON att.attrelid = i.indrelid AND att.attnum = key.attnum
      ) = 'currentLane,state'
  ) THEN
    RAISE EXCEPTION 'Issue_currentLane_state_idx is missing or has the wrong columns';
  END IF;
END
$$;
