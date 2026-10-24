-- #1363: bound the growth of the reconciler's per-pass audit annotations.
-- The annotation dedupe reads the latest annotation per (actor, action, issue)
-- before every per-pass candidate annotation; this composite index keeps that
-- lookup a single ordered seek instead of a scan of the issue's full audit
-- history as the log grows.
CREATE INDEX "AuditLog_actor_action_issueId_createdAt_idx" ON "AuditLog"("actor", "action", "issueId", "createdAt" DESC);
