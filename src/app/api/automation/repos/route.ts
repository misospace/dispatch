import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { jsonSafe } from "@/lib/json";
import { isValidRepoName } from "@/lib/config";
import { auditTrackedRepoCreateFailure, createTrackedRepo } from "@/lib/tracked-repos";
import { authorizeRequest } from "@/lib/auth";

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
  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  try {
    const { automationRepo, repository } = await createTrackedRepo(fullName);

    return NextResponse.json(jsonSafe({ ...automationRepo, repositoryId: repository.id }), { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "Repository is already tracked" }, { status: 409 });
    }

    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await auditTrackedRepoCreateFailure(fullName, errorMessage);
    console.error("Failed to add tracked repo:", error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
