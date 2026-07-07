import { prisma } from "@/lib/prisma";
import { KanbanBoardClient } from "./kanban-board-client";
import { FilterBar } from "@/components/filter-bar";
import { SyncIssuesButton } from "@/components/sync-issues-button";
import { Card, CardContent } from "@/components/ui/card";
import { getTrackedRepos } from "@/lib/config";
import {
  applyRenovateIssueExclusion,
  buildLabelWhere,
  buildVisibleIssueWhere,
  discoverLabelFilterOptions,
  getDoneRetentionDays,
} from "@/lib/issue-filters";
import { getConfiguredLanes, isValidLane } from "@/lib/lane-config";

export const dynamic = "force-dynamic";

async function getIssues(repo?: string, agent?: string, owner?: string, priority?: string, lane?: string, includeClosed?: boolean) {
  const where: Record<string, unknown> = { repository: { enabled: true } };

  buildVisibleIssueWhere(where, { includeClosed });
  applyRenovateIssueExclusion(where);

  if (repo) where.repository = { ...(where.repository as object), fullName: repo };

  const labels = buildLabelWhere([agent, owner, priority]);
  if (labels) where.labels = labels;

  if (lane && isValidLane(lane)) {
    where.currentLane = lane.toLowerCase();
  }

  return prisma.issue.findMany({
    where,
    include: { repository: true },
    orderBy: { updatedAt: "desc" },
  });
}

async function getRepos() {
  return prisma.repository.findMany({
    where: { enabled: true },
    orderBy: { fullName: "asc" },
  });
}

async function getFilterOptions(includeClosed?: boolean) {
  // Same base visibility as the board itself (state/retention), but without
  // the user's active label/agent filters so all selectable options remain.
  const where: Record<string, unknown> = { repository: { enabled: true } };
  buildVisibleIssueWhere(where, { includeClosed });
  applyRenovateIssueExclusion(where);

  const issues = await prisma.issue.findMany({
    where,
    select: { labels: true },
  });

  return discoverLabelFilterOptions(issues);
}

function buildVisibleIssueStatsWhere() {
  const where: Record<string, unknown> = { repository: { enabled: true } };
  applyRenovateIssueExclusion(where);
  return where;
}

async function getIssueSyncStatus() {
  const [trackedRepos, issueStats] = await Promise.all([
    getTrackedRepos(),
    prisma.issue.aggregate({
      where: buildVisibleIssueStatsWhere(),
      _count: { _all: true },
      _max: { lastSyncedAt: true },
    }),
  ]);

  return {
    trackedRepoCount: trackedRepos.length,
    cachedIssueCount: issueStats._count._all,
    lastSyncedAt: issueStats._max.lastSyncedAt,
  };
}

interface PageProps {
  searchParams: Promise<{ repo?: string; agent?: string; owner?: string; priority?: string; lane?: string; includeClosed?: string }>;
}

export default async function BoardPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const includeClosed = params.includeClosed === "true";
  const [issues, repos, filterOptions, syncStatus] = await Promise.all([
    getIssues(params.repo, params.agent, params.owner, params.priority, params.lane, includeClosed),
    getRepos(),
    getFilterOptions(includeClosed),
    getIssueSyncStatus(),
  ]);
  const lanes = getConfiguredLanes();

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Board</h1>
          <p className="text-muted-foreground">Kanban board view of issues</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Issue sync status: {syncStatus.trackedRepoCount} tracked repos, {syncStatus.cachedIssueCount} cached issues
            {syncStatus.lastSyncedAt ? `, last synced ${syncStatus.lastSyncedAt.toLocaleString()}` : ""}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SyncIssuesButton />
        </div>
      </div>

      <FilterBar
        repos={repos}
        agents={filterOptions.agents}
        owners={filterOptions.owners}
        lanes={lanes}
        activeFilters={{
          repo: params.repo || "",
          agent: params.agent || "",
          owner: params.owner || "",
          priority: params.priority || "",
          lane: params.lane || "",
        }}
      />

      {issues.length === 0 ? (
        <Card>
          <CardContent className="space-y-4 py-8 text-center">
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">
                {syncStatus.cachedIssueCount > 0 ? "No issues match the current filters" : "No issues synced yet"}
              </h2>
              <p className="text-sm text-muted-foreground">
                {syncStatus.cachedIssueCount > 0
                  ? "Clear or adjust the filters to see synced issues."
                  : syncStatus.trackedRepoCount > 0
                  ? `Click Sync Issues to import open GitHub issues from tracked repositories. Recently completed Done issues are shown for ${getDoneRetentionDays()} days.`
                  : "No tracked repositories are configured yet. Add tracked repositories before syncing issues."}
              </p>
            </div>
            <div className="flex justify-center">
              <SyncIssuesButton />
            </div>
          </CardContent>
        </Card>
      ) : (
        <KanbanBoardClient initialIssues={issues} lanes={lanes} />
      )}
    </div>
  );
}
