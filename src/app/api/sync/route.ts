import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchIssues } from "@/lib/github";
import { getSyncRepos } from "@/lib/config";

export async function POST() {
  try {
    const repos = await getSyncRepos();
    let syncedCount = 0;

    for (const repo of repos) {
      const githubIssues = await fetchIssues(repo.fullName);

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
        syncedCount++;
      }
    }

    return NextResponse.json({ success: true, syncedCount });
  } catch (error) {
    console.error("Sync failed:", error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}