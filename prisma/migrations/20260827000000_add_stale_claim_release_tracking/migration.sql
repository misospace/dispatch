-- Keep stale AgentWork rows retryable until their GitHub claim is released.
ALTER TABLE "AgentWork"
  ADD COLUMN "staleClaimReleasePending" BOOLEAN NOT NULL DEFAULT false;
