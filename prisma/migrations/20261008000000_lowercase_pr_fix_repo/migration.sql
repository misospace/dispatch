-- Queue identity is case-insensitive (#1145).
--
-- GitHub treats `owner/repo` case-insensitively, but the `(repo, pr)` unique
-- key does not: a row written as "Org/Repo" and a lookup for "org/repo" were
-- different records. Two rows could therefore own the same PR — one of them
-- BLOCKED — and the second would shadow the human verdict. Writers and identity
-- lookups now fold the repo to lowercase (normalizeQueueRepo); this migration
-- brings existing rows onto the same footing, merging any that collide.

-- 1. Choose the surviving row per (lower(btrim(repo)), pr) group. A BLOCKED row
--    wins — a human verdict must not be dropped by the merge — otherwise the
--    most recently updated row, with the id as a stable tiebreak.
CREATE TEMP TABLE "_pr_fix_repo_merge" AS
SELECT
  "id" AS loser_id,
  first_value("id") OVER (
    PARTITION BY lower(btrim("repo")), "pr"
    ORDER BY (CASE WHEN "status" = 'BLOCKED' THEN 0 ELSE 1 END), "updatedAt" DESC, "id"
  ) AS winner_id
FROM "PrFixQueueItem";

-- 2. Repoint the losers' history at the surviving row before deleting them
--    (PrFixHistory.itemId cascades on delete, so the audit trail must move
--    first or it would be destroyed).
UPDATE "PrFixHistory" AS h
SET "itemId" = m.winner_id
FROM "_pr_fix_repo_merge" AS m
WHERE h."itemId" = m.loser_id AND m.loser_id <> m.winner_id;

-- 3. Drop the duplicate rows.
DELETE FROM "PrFixQueueItem" AS i
USING "_pr_fix_repo_merge" AS m
WHERE i."id" = m.loser_id AND m.loser_id <> m.winner_id;

DROP TABLE "_pr_fix_repo_merge";

-- 4. Fold the survivors. Safe now: at most one row remains per
--    (lower(btrim(repo)), pr), so the unique key cannot be violated.
UPDATE "PrFixQueueItem"
SET "repo" = lower(btrim("repo"))
WHERE "repo" <> lower(btrim("repo"));
