-- CreateIssueSyncRun
CREATE TABLE "IssueSyncRun" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reposFetched" INTEGER NOT NULL DEFAULT 0,
    "syncedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "notes" TEXT,
    "syncType" TEXT NOT NULL DEFAULT 'scheduled',
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(6),
    CONSTRAINT "IssueSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex on IssueSyncRun.startedAt
CREATE INDEX "IssueSyncRun_startedAt_idx" ON "IssueSyncRun"("startedAt");

-- CreateIndex on IssueSyncRun.status
CREATE INDEX "IssueSyncRun_status_idx" ON "IssueSyncRun"("status");

-- CreateSyncLock
CREATE TABLE "sync_lock" (
    "id" TEXT NOT NULL,
    "syncRunId" TEXT,
    "acquiredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sync_lock_pkey" PRIMARY KEY ("id")
);
