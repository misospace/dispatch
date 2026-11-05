-- Production-shaped rows for the #1542 observe-mode migration exercise.
--
-- The exercise applies 20261104120000_add_groomer_observe_mode to a database
-- that already carries the production schema AND production-shaped data, so
-- the migration is exercised against real GroomingRun rows instead of an
-- empty database. The rows cover the legacy shapes a pre-#1542 production
-- instance holds — every row predates the mode/observeDisposition columns,
-- so `mode` must stay NULL and readability must come from `dryRun`:
--   - a legacy dry-run receipt (the pre-#1542 observe equivalent),
--   - a legacy auto (write) row with its applied mutations,
--   - a legacy failed row.
--
-- Re-runnable: the seeded rows are replaced, so the exercise can be repeated
-- on the same database.
DELETE FROM "GroomingRun" WHERE "repoFullName" = 'it-migrations/production-copy';

DELETE FROM "AutomationRepo" WHERE "id" = 'repo-production-copy-groomer';

DELETE FROM "Issue" WHERE "repositoryId" = 'repo-production-copy-groomer';

DELETE FROM "Repository" WHERE "id" = 'repo-production-copy-groomer';

INSERT INTO "Repository" ("id", "name", "owner", "fullName", "enabled", "createdAt", "updatedAt")
VALUES (
  'repo-production-copy-groomer',
  'production-copy',
  'it-migrations',
  'it-migrations/production-copy',
  true,
  now(),
  now()
);

INSERT INTO "Issue" (
  "id", "number", "repositoryId", "title", "body", "state", "url", "labels", "assignees",
  "createdAt", "updatedAt"
) VALUES (
  'issue-groomer-copy', 7, 'repo-production-copy-groomer', 'Stale grooming target',
  'Legacy issue the pre-#1542 groomer ran against.', 'open',
  'https://github.com/it-migrations/production-copy/issues/7',
  ARRAY['priority/p2'], ARRAY[]::TEXT[],
  now(), now()
);

INSERT INTO "AutomationRepo" ("id", "fullName", "name", "owner", "createdAt", "updatedAt")
VALUES (
  'repo-production-copy-groomer',
  'it-migrations/production-copy',
  'production-copy',
  'it-migrations',
  now(),
  now()
);

INSERT INTO "GroomingRun" (
  "id", "issueId", "repoId", "repoFullName", "issueNumber", "issueUrl",
  "status", "dryRun", "stage", "candidateSource", "staleReasons",
  "model", "provider", "promptVersion",
  "labelsBefore", "labelsAfter", "labelsToAdd", "labelsToRemove",
  "laneBefore", "laneAfter", "commentUrl", "errorMessage", "retryable",
  "startedAt", "completedAt", "createdAt", "updatedAt"
) VALUES
  -- Legacy dry-run receipt: the pre-#1542 observe equivalent.
  (
    'run-legacy-dry', 'issue-groomer-copy', 'repo-production-copy-groomer',
    'it-migrations/production-copy', 7,
    'https://github.com/it-migrations/production-copy/issues/7',
    'dry_run_completed', true, 'planned', 'selector', ARRAY[]::TEXT[],
    'test-model', 'github', 'hosted-groomer-v1',
    ARRAY['priority/p2'], ARRAY['priority/p2'], ARRAY[]::TEXT[], ARRAY[]::TEXT[],
    NULL, 'local', NULL, NULL, false,
    now() - interval '72 hours', now() - interval '72 hours',
    now() - interval '72 hours', now() - interval '72 hours'
  ),
  -- Legacy auto (write) row with its applied mutations.
  (
    'run-legacy-auto', 'issue-groomer-copy', 'repo-production-copy-groomer',
    'it-migrations/production-copy', 7,
    'https://github.com/it-migrations/production-copy/issues/7',
    'completed', false, 'applied', 'stale', ARRAY['stale_labels']::TEXT[],
    'test-model', 'github', 'hosted-groomer-v1',
    ARRAY['priority/p2'], ARRAY['status/ready'], ARRAY['status/ready']::TEXT[], ARRAY[]::TEXT[],
    'local', 'ready', 'https://github.com/it-migrations/production-copy/issues/7#issuecomment-legacy',
    NULL, false,
    now() - interval '48 hours', now() - interval '48 hours',
    now() - interval '48 hours', now() - interval '48 hours'
  ),
  -- Legacy failed row.
  (
    'run-legacy-failed', 'issue-groomer-copy', 'repo-production-copy-groomer',
    'it-migrations/production-copy', 7,
    'https://github.com/it-migrations/production-copy/issues/7',
    'failed', false, 'model', 'selector', ARRAY[]::TEXT[],
    'test-model', 'github', 'hosted-groomer-v1',
    ARRAY['priority/p2'], ARRAY['priority/p2'], ARRAY[]::TEXT[], ARRAY[]::TEXT[],
    NULL, NULL, NULL,
    'LLM timeout', true,
    now() - interval '24 hours', now() - interval '24 hours',
    now() - interval '24 hours', now() - interval '24 hours'
  );
