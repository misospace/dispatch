import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchIssues } from "@/lib/github";
import { getSyncRepos } from "@/lib/config";
import { syncIssuesForRepos, mergeLabels } from "@/lib/issue-sync";
import { authorizeRequest } from "@/lib/auth";

export async function POST(request: NextRequest) {
  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const text = await request.text();
    const body = text ? JSON.parse(text) : {};
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

    const result = await syncIssuesForRepos(repos, fetchIssues, {
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
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Sync failed:", error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
