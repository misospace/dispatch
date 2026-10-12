-- AlterTable: `already_done` report close resolution (dispatch#1143).
--
-- `tasks/report` now accepts an `already_done` outcome that closes the reported
-- issue when the hosted groomer's close policy is satisfied against a
-- server-built, revision-pinned evidence catalog. The resolution (action,
-- policy reasons, pinned head SHA and evidence digest) is persisted here so an
-- idempotent retry with the same (agentName, idempotencyKey) replays the close
-- outcome instead of re-running the GitHub close. Nullable: existing rows and
-- non-already_done reports carry no close resolution.
ALTER TABLE "AgentReportDedupe" ADD COLUMN IF NOT EXISTS "closeResolution" JSONB;
