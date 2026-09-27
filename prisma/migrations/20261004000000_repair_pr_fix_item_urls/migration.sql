-- Repair PR-fix item URLs that the pre-#1098 ingestion overwrote with a CI job
-- URL (#1118). The item URL is identity and is now write-once, so these rows
-- would otherwise keep the job URL. repo + pr already identify the PR.
UPDATE "PrFixQueueItem"
SET "url" = 'https://api.github.com/repos/' || "repo" || '/pulls/' || "pr"
WHERE "url" ~ '^https://github\.com/[^/]+/[^/]+/actions/runs/';
