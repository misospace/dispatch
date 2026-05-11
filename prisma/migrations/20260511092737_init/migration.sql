-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Issue" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "state" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "labels" TEXT[],
    "assignees" TEXT[],
    "commentsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "runType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "summary" TEXT,
    "errorMessage" TEXT,
    "touchedIssueUrls" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issueId" TEXT,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "issueNumber" INTEGER,
    "issueId" TEXT,
    "beforeLabels" TEXT[],
    "afterLabels" TEXT[],
    "success" BOOLEAN NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRepo" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "latestCommitSha" TEXT,
    "openPRCount" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRepo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubWorkflow" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "workflowId" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),

    CONSTRAINT "GithubWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubWorkflowRun" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "runId" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "conclusion" TEXT,
    "branch" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "runStartedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "durationSecs" INTEGER,
    "pullRequestUrl" TEXT,

    CONSTRAINT "GithubWorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubWorkflowJob" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "jobId" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "conclusion" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "GithubWorkflowJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubRelease" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "releaseId" BIGINT NOT NULL,
    "tagName" TEXT NOT NULL,
    "name" TEXT,
    "draft" BOOLEAN NOT NULL,
    "prerelease" BOOLEAN NOT NULL,
    "targetCommit" TEXT,
    "url" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GithubRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubPackage" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "packageType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "visibility" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "latestTag" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubPullRequest" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "mergedAt" TIMESTAMP(3),
    "isDraft" BOOLEAN NOT NULL,

    CONSTRAINT "GithubPullRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubCommit" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "authorDate" TIMESTAMP(3) NOT NULL,
    "url" TEXT NOT NULL,

    CONSTRAINT "GithubCommit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationEvent" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "actor" TEXT,
    "url" TEXT,
    "sha" TEXT,
    "branch" TEXT,
    "status" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationSyncRun" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reposFetched" INTEGER NOT NULL DEFAULT 0,
    "workflowsFetched" INTEGER NOT NULL DEFAULT 0,
    "runsFetched" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AutomationSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Repository_fullName_key" ON "Repository"("fullName");

-- CreateIndex
CREATE INDEX "Issue_state_idx" ON "Issue"("state");

-- CreateIndex
CREATE INDEX "Issue_labels_idx" ON "Issue"("labels");

-- CreateIndex
CREATE UNIQUE INDEX "Issue_repositoryId_number_key" ON "Issue"("repositoryId", "number");

-- CreateIndex
CREATE INDEX "AuditLog_repoFullName_idx" ON "AuditLog"("repoFullName");

-- CreateIndex
CREATE INDEX "AuditLog_issueId_idx" ON "AuditLog"("issueId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRepo_fullName_key" ON "AutomationRepo"("fullName");

-- CreateIndex
CREATE INDEX "AutomationRepo_owner_idx" ON "AutomationRepo"("owner");

-- CreateIndex
CREATE UNIQUE INDEX "GithubWorkflow_workflowId_key" ON "GithubWorkflow"("workflowId");

-- CreateIndex
CREATE INDEX "GithubWorkflow_repoId_idx" ON "GithubWorkflow"("repoId");

-- CreateIndex
CREATE INDEX "GithubWorkflow_state_idx" ON "GithubWorkflow"("state");

-- CreateIndex
CREATE UNIQUE INDEX "GithubWorkflowRun_runId_key" ON "GithubWorkflowRun"("runId");

-- CreateIndex
CREATE INDEX "GithubWorkflowRun_workflowId_idx" ON "GithubWorkflowRun"("workflowId");

-- CreateIndex
CREATE INDEX "GithubWorkflowRun_status_idx" ON "GithubWorkflowRun"("status");

-- CreateIndex
CREATE INDEX "GithubWorkflowRun_branch_idx" ON "GithubWorkflowRun"("branch");

-- CreateIndex
CREATE INDEX "GithubWorkflowRun_runStartedAt_idx" ON "GithubWorkflowRun"("runStartedAt");

-- CreateIndex
CREATE INDEX "GithubWorkflowJob_runId_idx" ON "GithubWorkflowJob"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "GithubWorkflowJob_runId_jobId_key" ON "GithubWorkflowJob"("runId", "jobId");

-- CreateIndex
CREATE INDEX "GithubRelease_repoId_idx" ON "GithubRelease"("repoId");

-- CreateIndex
CREATE INDEX "GithubRelease_publishedAt_idx" ON "GithubRelease"("publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GithubRelease_repoId_releaseId_key" ON "GithubRelease"("repoId", "releaseId");

-- CreateIndex
CREATE INDEX "GithubPackage_repoId_idx" ON "GithubPackage"("repoId");

-- CreateIndex
CREATE UNIQUE INDEX "GithubPackage_repoId_name_key" ON "GithubPackage"("repoId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "GithubPullRequest_url_key" ON "GithubPullRequest"("url");

-- CreateIndex
CREATE INDEX "GithubPullRequest_repoId_idx" ON "GithubPullRequest"("repoId");

-- CreateIndex
CREATE INDEX "GithubPullRequest_state_idx" ON "GithubPullRequest"("state");

-- CreateIndex
CREATE UNIQUE INDEX "GithubPullRequest_repoId_number_key" ON "GithubPullRequest"("repoId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "GithubCommit_sha_key" ON "GithubCommit"("sha");

-- CreateIndex
CREATE INDEX "GithubCommit_repoId_idx" ON "GithubCommit"("repoId");

-- CreateIndex
CREATE INDEX "GithubCommit_authorDate_idx" ON "GithubCommit"("authorDate");

-- CreateIndex
CREATE INDEX "AutomationEvent_repoId_idx" ON "AutomationEvent"("repoId");

-- CreateIndex
CREATE INDEX "AutomationEvent_eventType_idx" ON "AutomationEvent"("eventType");

-- CreateIndex
CREATE INDEX "AutomationEvent_createdAt_idx" ON "AutomationEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AutomationSyncRun_repoId_idx" ON "AutomationSyncRun"("repoId");

-- CreateIndex
CREATE INDEX "AutomationSyncRun_startedAt_idx" ON "AutomationSyncRun"("startedAt");

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubWorkflow" ADD CONSTRAINT "GithubWorkflow_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "AutomationRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubWorkflowRun" ADD CONSTRAINT "GithubWorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "GithubWorkflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubWorkflowJob" ADD CONSTRAINT "GithubWorkflowJob_runId_fkey" FOREIGN KEY ("runId") REFERENCES "GithubWorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubRelease" ADD CONSTRAINT "GithubRelease_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "AutomationRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubPackage" ADD CONSTRAINT "GithubPackage_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "AutomationRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubPullRequest" ADD CONSTRAINT "GithubPullRequest_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "AutomationRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubCommit" ADD CONSTRAINT "GithubCommit_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "AutomationRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationEvent" ADD CONSTRAINT "AutomationEvent_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "AutomationRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationSyncRun" ADD CONSTRAINT "AutomationSyncRun_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "AutomationRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

