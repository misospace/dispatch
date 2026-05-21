import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { jsonSafe } from "@/lib/json";
import { isAuthorizedAgentToken } from "@/lib/dispatch-env";

interface RouteContext {
  params: Promise<{ repo: string[] }>;
}

export async function GET(request: Request, context: RouteContext) {
  const { searchParams } = new URL(request.url);
  const queryRepo = searchParams.get("repo");
  const { repo: pathRepo } = await context.params;
  const repoFullName = queryRepo ?? decodeURIComponent(pathRepo.join("/"));

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

export async function DELETE(request: Request, context: RouteContext) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!isAuthorizedAgentToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { repo: pathRepo } = await context.params;
  const repoFullName = decodeURIComponent(pathRepo.join("/"));

  if (!repoFullName) {
    return NextResponse.json({ error: "repo parameter required" }, { status: 400 });
  }

  try {
    const existing = await prisma.automationRepo.findUnique({
      where: { fullName: repoFullName },
      select: { id: true, source: true },
    });

    if (!existing) {
      return NextResponse.json({ error: "Repository not tracked" }, { status: 404 });
    }

    // Hard delete AutomationRepo (cascades to workflows/runs/releases/etc).
    await prisma.automationRepo.delete({ where: { fullName: repoFullName } });

    // Soft-disable the matching Repository row so cached issues stay visible in
    // history but are excluded from active board filters. Use updateMany so it
    // is a no-op when no Repository row exists yet.
    await prisma.repository.updateMany({
      where: { fullName: repoFullName },
      data: { enabled: false },
    });

    await prisma.auditLog.create({
      data: {
        actor: "user",
        action: "remove_tracked_repo",
        repoFullName,
        beforeLabels: [existing.source],
        afterLabels: [],
        success: true,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await prisma.auditLog.create({
      data: {
        actor: "user",
        action: "remove_tracked_repo",
        repoFullName,
        beforeLabels: [],
        afterLabels: [],
        success: false,
        errorMessage,
      },
    });
    console.error("Failed to remove tracked repo:", error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
