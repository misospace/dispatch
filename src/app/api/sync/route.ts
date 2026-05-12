import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchIssues } from "@/lib/github";
import { getSyncRepos } from "@/lib/config";

interface SyncResult {
  repo: string;
  synced: number;
  error: string | null;
}

export async function POST() {
  try {
    const repos = await getSyncRepos();
    const results: SyncResult[] = [];
    let syncedCount = 0;

    for (const repo of repos) {
      try {
        const githubIssues = await fetchIssues(repo.fullName);
        let repoSyncedCount = 0;

        for (const ghIssue of githubIssues) {
          const labelNames = ghIssue.labels.map((l) => l.name);
          const existingIssue = await prisma.issue.findUnique({
            where: { repositoryId_number: { repositoryId: repo.id, number: ghIssue.number } },
          });

          const issueData = {
            number: ghIssue.number,
            title: ghIssue.title,
            body: ghIssue.body,
            url: ghIssue.html_url,
            labels: labelNames,
            assignees: ghIssue.assignees.map((a) => a.login),
            commentsCount: ghIssue.comments,
            createdAt: new Date(ghIssue.created_at),
            updatedAt: new Date(ghIssue.updated_at),
            closedAt: ghIssue.closed_at ? new Date(ghIssue.closed_at) : null,
            lastSyncedAt: new Date(),
            state: ghIssue.state,
          };

          if (existingIssue) {
            await prisma.issue.update({
              where: { id: existingIssue.id },
              data: issueData,
            });
          } else {
            await prisma.issue.create({
              data: {
                ...issueData,
                repositoryId: repo.id,
              },
            });
          }

          repoSyncedCount++;
          syncedCount++;
        }

        results.push({ repo: repo.fullName, synced: repoSyncedCount, error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown sync error";
        console.error(`Issue sync failed for ${repo.fullName}:`, error);
        results.push({ repo: repo.fullName, synced: 0, error: message });
      }
    }

    return NextResponse.json({
      success: results.every((result) => result.error === null),
      repos: repos.length,
      syncedCount,
      results,
    });
  } catch (error) {
    console.error("Sync failed:", error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
