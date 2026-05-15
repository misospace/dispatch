import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { jsonSafe } from "@/lib/json";
import { isValidRepoName } from "@/lib/config";

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
          source: repo.source,
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

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { fullName } = body as Record<string, unknown>;

  if (typeof fullName !== "string" || !fullName) {
    return NextResponse.json({ error: "fullName is required" }, { status: 400 });
  }

  if (!isValidRepoName(fullName)) {
    return NextResponse.json(
      { error: "Invalid fullName format. Expected: owner/repo" },
      { status: 400 },
    );
  }

  const [owner, name] = fullName.split("/");

  try {
    const repo = await prisma.automationRepo.create({
      data: { fullName, owner, name, source: "user" },
    });

    await prisma.auditLog.create({
      data: {
        actor: "user",
        action: "add_tracked_repo",
        repoFullName: fullName,
        beforeLabels: [],
        afterLabels: [],
        success: true,
      },
    });

    return NextResponse.json(jsonSafe(repo), { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "Repository is already tracked" }, { status: 409 });
    }

    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await prisma.auditLog.create({
      data: {
        actor: "user",
        action: "add_tracked_repo",
        repoFullName: fullName,
        beforeLabels: [],
        afterLabels: [],
        success: false,
        errorMessage,
      },
    });
    console.error("Failed to add tracked repo:", error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}