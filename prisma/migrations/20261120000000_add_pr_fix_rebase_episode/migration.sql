-- #1675: durable semantic-conflict episode accounting for the bounded
-- REBASE→fix transfer. When the mechanical rebase lane reports the structured
-- nonmechanical-conflict refusal and the exact rebase receipt/generation is
-- settled, the episode transfers one way onto an ordinary fix attempt. The
-- new columns record WHICH conflict episode was transferred:
--
-- "rebaseEpisodeId"            the stable episode identity, derived from
--                              authoritative Dispatch state (base repo + PR +
--                              head ref + head sha), never from poll
--                              timestamps or worker free text.
-- "rebaseEpisodeTransferred"   the one-way flag the enqueue-side gate reads so
--                              a repeat observation of the same conflict
--                              (resync, restart, re-read) never bounces the
--                              row back onto the mechanical REBASE lane.
-- "rebaseEpisodeTransferredAt" audit stamp of when the transfer committed.
-- "rebaseEpisodeGeneration"    the settled rebase attempt generation the
--                              transfer was authorized by (audit).
--
-- Additive only: new nullable/defaulted columns, no existing column drop or
-- type change, so `prisma migrate deploy` is safe against a database already
-- at 20261116000000_add_pr_fix_presence_probe_stamp.
ALTER TABLE "PrFixQueueItem" ADD COLUMN "rebaseEpisodeId" TEXT;
ALTER TABLE "PrFixQueueItem" ADD COLUMN "rebaseEpisodeTransferred" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PrFixQueueItem" ADD COLUMN "rebaseEpisodeTransferredAt" TIMESTAMP(3);
ALTER TABLE "PrFixQueueItem" ADD COLUMN "rebaseEpisodeGeneration" INTEGER;
