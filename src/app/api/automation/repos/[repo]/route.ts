import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { jsonSafe } from "@/lib/json";

export async function GET(_request: Request, { params }: { params: Promise<{ repo: string }> }) {
  const fullName = (await params).repo;

  try {
    const automationRepo = await prisma.automationRepo.findUnique({
      where: { fullName },
      include: {
        workflows: {
          orderBy: { lastRunAt: "desc" },
          include: {
            runs: {
              take: 50,
              orderBy: { runStartedAt: "desc" },
              include: {
                jobs: true,
              },
            },
          },
        },
        releases: {
          take: 20,
          orderBy: { publishedAt: "desc" },
        },
        packages: {
          orderBy: { updatedAt: "desc" },
        },
        _count: {
          select: { workflows: true, releases: true, packages: true },
        },
      },
    });

    if (!automationRepo) {
      return NextResponse.json({ error: "Repository not found" }, { status: 404 });
    }

    const [failingRuns, runningRuns] = await Promise.all([
      prisma.githubWorkflowRun.count({
        where: { workflow: { repoId: automationRepo.id }, conclusion: "failure" },
      }),
      prisma.githubWorkflowRun.count({
        where: { workflow: { repoId: automationRepo.id }, status: "in_progress" },
      }),
    ]);

    const lastSyncRun = await prisma.automationSyncRun.findFirst({
      where: { repoId: automationRepo.id },
      orderBy: { startedAt: "desc" },
    });

    const result = {
      ...automationRepo,
      failingRuns,
      runningRuns,
      lastSyncRun,
    };

    return NextResponse.json(jsonSafe(result));
  } catch (error) {
    console.error("Failed to fetch repo detail:", error);
    return NextResponse.json({ error: "Failed to fetch repository details" }, { status: 500 });
  }
}
