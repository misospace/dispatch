-- The durable lifecycle event stream for a work item (#1202): claim, release,
-- status, completion and merge evidence, one row per transition, owned by the
-- Issue it describes. Additive and backfill-free — nothing here changes an
-- existing column, so existing issues simply have no history yet and no reader
-- may infer a first claim from that absence.
--
-- occurredAt is when the transition happened and observedAt is when Dispatch
-- saw it, so a late or out-of-order observation stays visibly late instead of
-- being backdated. dedupeKey carries a source-provided identity (GitHub
-- delivery id, merged-PR identity, a sync's issue updated_at) and is unique so
-- redelivery upserts instead of duplicating; Dispatch-authored writes leave it
-- NULL and are guarded by the transition check instead. See
-- docs/issue-lifecycle-events.md.

-- CreateTable
CREATE TABLE "IssueLifecycleEvent" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "agentName" TEXT,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "sourceEventId" TEXT,
    "dedupeKey" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueLifecycleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IssueLifecycleEvent_dedupeKey_key" ON "IssueLifecycleEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "IssueLifecycleEvent_issueId_occurredAt_idx" ON "IssueLifecycleEvent"("issueId", "occurredAt");

-- CreateIndex
CREATE INDEX "IssueLifecycleEvent_issueId_kind_idx" ON "IssueLifecycleEvent"("issueId", "kind");

-- CreateIndex
CREATE INDEX "IssueLifecycleEvent_issueId_kind_occurredAt_idx" ON "IssueLifecycleEvent"("issueId", "kind", "occurredAt");

-- CreateIndex
CREATE INDEX "IssueLifecycleEvent_repoFullName_issueNumber_idx" ON "IssueLifecycleEvent"("repoFullName", "issueNumber");

-- CreateIndex
CREATE INDEX "IssueLifecycleEvent_kind_idx" ON "IssueLifecycleEvent"("kind");

-- AddForeignKey
ALTER TABLE "IssueLifecycleEvent" ADD CONSTRAINT "IssueLifecycleEvent_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;