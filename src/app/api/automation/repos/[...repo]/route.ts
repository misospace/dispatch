import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { jsonSafe } from "@/lib/json";
import { authorizeRequest, getAuthorizedActor } from "@/lib/auth";

interface RouteContext {
  params: Promise<{ repo: string[] }>;
}

export async function GET(request: Request, context: RouteContext) {
  const { searchParams } = new URL(request.url);
  const queryRepo = searchParams.get("repo");
  const { repo: pathRepo } = await context.params;
  const repoFullName = queryRepo ?? decodeURIComponent(pathRepo.join("/"));

  if (!repoFullName) {
    return errorResponse("repo parameter required", 400);
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
      return errorResponse("Repo not found", 404);
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
    return handleApiError("fetch repo", error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }
  const auditActor = getAuthorizedActor(auth, request);

  const { repo: pathRepo } = await context.params;
  const repoFullName = decodeURIComponent(pathRepo.join("/"));

  if (!repoFullName) {
    return errorResponse("repo parameter required", 400);
  }

  try {
    const existing = await prisma.automationRepo.findUnique({
      where: { fullName: repoFullName },
      select: { id: true, source: true },
    });

    if (!existing) {
      return errorResponse("Repository not tracked", 404);
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
        actor: auditActor,
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
        actor: auditActor,
        action: "remove_tracked_repo",
        repoFullName,
        beforeLabels: [],
        afterLabels: [],
        success: false,
        errorMessage,
      },
    });
    console.error("Failed to remove tracked repo:", error);
    return errorResponse(errorMessage, 500);
  }
}
