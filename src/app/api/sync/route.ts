import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchIssues, syncStatusLabels } from "@/lib/github";
import { getSyncRepos, parseExcludedLabels } from "@/lib/config";
import { syncIssuesForRepos, mergeLabels } from "@/lib/issue-sync";
import { authorizeRequest } from "@/lib/auth";
import { acquireLock, releaseLock } from "@/lib/sync-lock";

// Sync must see closed issues, or closedIssueStatusFix never runs: the
// closed=>done enforcement (#521) only applies to issues in the fetch set,
// and the default fetch is state=open. Regressed to open-only when the
// heartbeat cron (whose reconcile did its own closed fetch) was retired.
const fetchAllStateIssues = (repoFullName: string) => fetchIssues(repoFullName, { includeClosed: true });


export async function POST(request: NextRequest) {
  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const text = await request.text();
    let body: Record<string, unknown> = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return NextResponse.json({ error: "Malformed JSON in request body" }, { status: 400 });
      }
    }
    const { repoFullName } = body as { repoFullName?: string };

    let repos = await getSyncRepos();

    if (repoFullName) {
      repos = repos.filter((r) => r.fullName === repoFullName);
      if (repos.length === 0) {
        return NextResponse.json(
          { error: `Repo ${repoFullName} is not tracked. Track it first via /api/repos or the UI.` },
          { status: 404 },
        );
      }
    }

    // Acquire shared DB lock to prevent overlapping runs across all sync types
    const lockResult = await acquireLock("manual");
    if (!lockResult.locked) {
      return NextResponse.json(
        { error: "A sync is already running. Try again later.", locked: true },
        { status: 409 },
      );
    }

    const { runId } = lockResult;

    try {
      const excludedLabels = parseExcludedLabels(process.env.DISPATCH_EXCLUDED_LABELS);
      const result = await syncIssuesForRepos(repos, fetchAllStateIssues, {
        findIssue(repositoryId, number) {
          return prisma.issue.findUnique({
            where: { repositoryId_number: { repositoryId, number } },
          });
        },
        async updateIssue(id, data) {
          // Preserve agent/* labels from Prisma in case GitHub hasn't propagated the claim yet.
          // This prevents a race condition where the claim endpoint adds an agent label to both
          // Prisma and GitHub, but a concurrent sync overwrites Prisma with stale GitHub data.
          const existing = await prisma.issue.findUnique({
            where: { id },
            select: { labels: true },
          });

          if (existing && existing.labels.length > 0) {
            // Merge: use GitHub labels as base, add any agent/* labels from Prisma that aren't on GitHub
            data.labels = mergeLabels(data.labels, existing.labels);
          }

          await prisma.issue.update({ where: { id }, data });
        },
        async createIssue(repositoryId, data) {
          await prisma.issue.create({ data: { ...data, repositoryId } });
        },
      }, excludedLabels, syncStatusLabels);

      // Update the sync run record
      await prisma.issueSyncRun.updateMany({
        where: { id: runId, status: "running" },
        data: {
          status: "completed",
          completedAt: new Date(),
          reposFetched: result.repos ?? 0,
          syncedCount: result.syncedCount ?? 0,
        },
      });

      return NextResponse.json(result);
    } finally {
      await releaseLock(runId).catch(() => {});
    }
  } catch (error) {
    console.error("Sync failed:", error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
