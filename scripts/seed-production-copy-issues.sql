-- Production-shaped rows for the migration exercise (#1459).
--
-- The exercise applies the rotation migration to a database that already
-- carries the production schema AND production-shaped data, so the migration
-- is exercised against real rows instead of an empty database. The rows cover
-- the shapes the blocked-reconciliation scan reads:
--   - an anchored parked block (a typed dependency anchor makes it the
--     freshness pass's territory),
--   - an anchorless legacy park (the reconciliation pass's territory),
--   - a worker-owned row (skipped in memory by the scan).
INSERT INTO "Repository" ("id", "name", "owner", "fullName", "enabled", "createdAt", "updatedAt")
VALUES (
  'repo-production-copy',
  'production-copy',
  'it-migrations',
  'it-migrations/production-copy',
  true,
  now(),
  now()
);

INSERT INTO "Issue" (
  "id", "number", "repositoryId", "title", "body", "state", "url", "labels", "assignees",
  "createdAt", "updatedAt", "blockedReason", "nextGroomingAction", "groomedAt",
  "groomedRunId", "groomedIssueFingerprint", "groomedDependencyKeys", "groomedOpenBlockerKeys"
) VALUES
  (
    'issue-anchored', 1, 'repo-production-copy', 'Anchored parked block',
    'Depends on #2.', 'open', 'https://github.com/it-migrations/production-copy/issues/1',
    ARRAY['status/blocked'], ARRAY[]::TEXT[],
    now(), now(), 'waiting on #2', 'mark_blocked', now() - interval '48 hours',
    'run-anchored', 'fingerprint-anchored',
    ARRAY['it-migrations/production-copy#2'], ARRAY['it-migrations/production-copy#2']
  ),
  (
    'issue-anchorless', 2, 'repo-production-copy', 'Anchorless legacy park',
    'Depends on #3.', 'open', 'https://github.com/it-migrations/production-copy/issues/2',
    ARRAY['status/blocked'], ARRAY[]::TEXT[],
    now(), now(), 'waiting on #3', 'mark_blocked', now() - interval '48 hours',
    NULL, NULL,
    ARRAY[]::TEXT[], ARRAY[]::TEXT[]
  ),
  (
    'issue-worker', 3, 'repo-production-copy', 'Worker-owned row',
    'Depends on #4.', 'open', 'https://github.com/it-migrations/production-copy/issues/3',
    ARRAY['status/blocked', 'status/in-progress'], ARRAY[]::TEXT[],
    now(), now(), 'waiting on #4', 'mark_blocked', now() - interval '48 hours',
    NULL, NULL,
    ARRAY[]::TEXT[], ARRAY[]::TEXT[]
  );
