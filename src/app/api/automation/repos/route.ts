import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { jsonSafe } from "@/lib/json";

export async function GET() {
  try {
    const repos = await prisma.automationRepo.findMany({
      orderBy: { fullName: "asc" },
      include: {
        workflows: {
          take: 1,
          orderBy: { lastRunAt: "desc" },
        },
        releases: {
          take: 1,
          orderBy: { publishedAt: "desc" },
        },
        _count: {
          select: { workflows: true, releases: true },
        },
      },
    });

    const reposWithCounts = await Promise.all(
      repos.map(async (repo) => {
        const [failingRuns, runningRuns] = await Promise.all([
          prisma.githubWorkflowRun.count({
            where: { workflow: { repoId: repo.id }, conclusion: "failure" },
          }),
          prisma.githubWorkflowRun.count({
            where: { workflow: { repoId: repo.id }, status: "in_progress" },
          }),
        ]);

        const lastSyncRun = await prisma.automationSyncRun.findFirst({
          where: { repoId: repo.id },
          orderBy: { startedAt: "desc" },
        });

        return {
          id: repo.id,
          fullName: repo.fullName,
          name: repo.name,
          owner: repo.owner,
          defaultBranch: repo.defaultBranch,
          latestCommitSha: repo.latestCommitSha,
          openPRCount: repo.openPRCount,
          lastSyncedAt: repo.lastSyncedAt,
          syncError: repo.syncError,
          workflows: repo.workflows,
          releases: repo.releases,
          _count: repo._count,
          failingRuns,
          runningRuns,
          lastSyncRun,
        };
      })
    );

    return NextResponse.json(jsonSafe(reposWithCounts));
  } catch (error) {
    console.error("Failed to fetch repos:", error);
    return NextResponse.json({ error: "Failed to fetch repos" }, { status: 500 });
  }
}