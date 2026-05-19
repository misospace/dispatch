import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchIssues } from "@/lib/github";
import { getSyncRepos } from "@/lib/config";
import { syncIssuesForRepos } from "@/lib/issue-sync";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
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
