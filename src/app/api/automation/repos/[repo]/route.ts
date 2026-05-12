import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { jsonSafe } from "@/lib/json";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoFullName = searchParams.get("repo");

  if (!repoFullName) {
    return NextResponse.json({ error: "repo parameter required" }, { status: 400 });
  }

  try {
    const repo = await prisma.automationRepo.findUnique({
      where: { fullName: repoFullName },
      include: {
        workflows: {
          include: {
            runs: {
              take: 5,
              orderBy: { runStartedAt: "desc" },
            },
          },
        },
        releases: {
          take: 10,
          orderBy: { publishedAt: "desc" },
        },
        packages: true,
        _count: {
          select: { workflows: true, releases: true },
        },
      },
    });

    if (!repo) {
      return NextResponse.json({ error: "Repo not found" }, { status: 404 });
    }

    const failingRuns = await prisma.githubWorkflowRun.count({
      where: {
        workflow: { repoId: repo.id },
        conclusion: "failure",
      },
    });

    const runningRuns = await prisma.githubWorkflowRun.count({
      where: {
        workflow: { repoId: repo.id },
        status: "in_progress",
      },
    });

    const lastSyncRun = await prisma.automationSyncRun.findFirst({
      where: { repoId: repo.id },
      orderBy: { startedAt: "desc" },
    });

    const recentEvents = await prisma.automationEvent.findMany({
      where: { repoId: repo.id },
      take: 10,
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(jsonSafe({
      ...repo,
      failingRuns,
      runningRuns,
      lastSyncRun,
      recentEvents,
    }));
  } catch (error) {
    console.error("Failed to fetch repo:", error);
    return NextResponse.json({ error: "Failed to fetch repo" }, { status: 500 });
  }
}