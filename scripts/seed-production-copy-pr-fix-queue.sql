-- Production-shaped rows for the #1569 claimant migration exercise.
--
-- The exercise applies 20261106000000_add_pr_fix_claimant_ownership to a
-- database that already carries the production schema AND production-shaped
-- data, so the migration is exercised against real PrFixQueueItem rows
-- instead of an empty database. Every seeded row predates the #1569
-- contract: it has no recorded claimant, because the column did not exist
-- yet. The rows cover the shapes a pre-#1569 production instance holds:
--   - a legacy queued row in the NORMAL lane, carrying only a PR author
--     (the author is the TRANSPORT identity, never the claimant),
--   - a legacy queued row in the ESCALATED lane on a later generation (a
--     re-enqueued row),
--   - a legacy row that already went through a hand-out, so it carries the
--     per-generation receiving consumer, the durable hand-out receipt, and
--     the acknowledgement timestamp (a receiving consumer is never the
--     original claimant either).
--
-- The shapes follow what `src/lib/pr-fix-queue.ts` actually writes: a
-- hand-out stamps `dispatchedGeneration`/`dispatchedAt` alongside the
-- `agentHandouts` entry, a receipt exists exactly while its `agentHandouts`
-- entry exists, `handoutAckTimes` is index-parallel to `handoutAcks`, the
-- receipt token matches the `hnd_` + hex shape `parseHandoutReceipt`
-- accepts, and the ack timestamp is the ISO-8601 form `nowIso()` writes.
--
-- Every timestamp is expressed in UTC (`now() at time zone 'UTC'`) and
-- truncated to milliseconds, so the seeded instants do not depend on the
-- server's session time zone and match the ISO-8601 strings the
-- application writes.
--
-- The migration adds two NULLABLE columns and runs no backfill UPDATE, so
-- every seeded row must come out of the migration with a NULL claimant and
-- a NULL claimantSource — ownership is never guessed at deploy time, and a
-- legacy row stays unresolved until an explicit recovery resolves it.
--
-- Re-runnable: the seeded rows are replaced, so the seed can be repeated on
-- the same database. (The exercise as a whole is not re-runnable on one
-- database: the CI job creates a fresh copy per run.)
DELETE FROM "PrFixHistory" WHERE "itemId" IN (
  'prfix-legacy-queued',
  'prfix-legacy-escalated',
  'prfix-legacy-handed-out'
);

DELETE FROM "PrFixQueueItem" WHERE "repo" = 'it-migrations/production-copy';

INSERT INTO "PrFixQueueItem" (
  "id", "repo", "pr", "issue", "branch", "lane", "type", "reason", "feedback",
  "status", "generation", "fixAttempts", "queuedAt", "updatedAt", "url", "title", "headSha",
  "author", "agentHandouts", "handoutAcks", "handoutAckTimes", "handoutReceipts",
  "dispatchedGeneration", "dispatchedAt"
) VALUES
  -- Legacy queued row, NORMAL lane: only a PR author, no claimant.
  (
    'prfix-legacy-queued', 'it-migrations/production-copy', 11, 101, 'feature/legacy-queued',
    'NORMAL', 'OTHER', 'PR review: CHANGES_REQUESTED', ARRAY['PR review: CHANGES_REQUESTED']::TEXT[],
    'QUEUED', 1, 1,
    date_trunc('milliseconds', (now() at time zone 'UTC') - interval '72 hours'),
    date_trunc('milliseconds', (now() at time zone 'UTC') - interval '72 hours'),
    'https://github.com/it-migrations/production-copy/pull/11',
    'Legacy queued PR-fix row',
    '1111111111111111111111111111111111111111',
    'legacy-pr-author-n', ARRAY[]::TEXT[], ARRAY[]::TEXT[], ARRAY[]::TEXT[], ARRAY[]::TEXT[],
    NULL, NULL
  ),
  -- Legacy queued row, ESCALATED lane, later generation (a re-enqueue).
  (
    'prfix-legacy-escalated', 'it-migrations/production-copy', 12, 102, 'feature/legacy-escalated',
    'ESCALATED', 'REVIEW_FEEDBACK', 'PR review: CHANGES_REQUESTED', ARRAY['PR review: CHANGES_REQUESTED']::TEXT[],
    'QUEUED', 3, 3,
    date_trunc('milliseconds', (now() at time zone 'UTC') - interval '48 hours'),
    date_trunc('milliseconds', (now() at time zone 'UTC') - interval '48 hours'),
    'https://github.com/it-migrations/production-copy/pull/12',
    'Legacy escalated PR-fix row',
    '2222222222222222222222222222222222222222',
    'legacy-pr-author-e', ARRAY[]::TEXT[], ARRAY[]::TEXT[], ARRAY[]::TEXT[], ARRAY[]::TEXT[],
    NULL, NULL
  ),
  -- Legacy row that already went through a hand-out: it carries a
  -- per-generation receiving consumer, the matching durable receipt, and
  -- the acknowledgement timestamp. None of them is the claimant.
  --
  -- The acknowledgement timestamp is derived from the SAME instant the row
  -- stores in `dispatchedAt`, in the column's own `timestamp without time
  -- zone` type, so the two are exactly one hour apart and the verification
  -- can assert that relation exactly.
  (
    'prfix-legacy-handed-out', 'it-migrations/production-copy', 13, 103, 'feature/legacy-handed-out',
    'NORMAL', 'MERGE_CONFLICT', 'Merge state change: dirty', ARRAY['Merge conflict']::TEXT[],
    'QUEUED', 2, 2,
    date_trunc('milliseconds', (now() at time zone 'UTC') - interval '24 hours'),
    date_trunc('milliseconds', (now() at time zone 'UTC') - interval '24 hours'),
    'https://github.com/it-migrations/production-copy/pull/13',
    'Legacy handed-out PR-fix row',
    '3333333333333333333333333333333333333333',
    'legacy-pr-author-h',
    ARRAY['legacy-worker@2']::TEXT[],
    ARRAY['legacy-worker@2']::TEXT[],
    ARRAY[to_char(
      date_trunc('milliseconds', (now() at time zone 'UTC') - interval '24 hours') + interval '1 hour',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )]::TEXT[],
    ARRAY['hnd_deadbeefdeadbeefdeadbeef@legacy-worker@2']::TEXT[],
    2, date_trunc('milliseconds', (now() at time zone 'UTC') - interval '24 hours')
  );