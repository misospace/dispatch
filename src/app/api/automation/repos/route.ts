import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { jsonSafe } from "@/lib/json";
import { isValidRepoName } from "@/lib/config";
import { auditTrackedRepoCreateFailure, createTrackedRepo } from "@/lib/tracked-repos";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { collectReleasePulse, asReleaseDeltaState } from "@/lib/release-pulse-read";
import { deriveReleaseReadiness, releaseCiStatus } from "@/lib/release-readiness";

// 10 requests / 60s — tracked-repo creation is a DB-only write, so this
// ceiling is generous but still caps runaway callers. The deprecated
// POST /api/repos alias was removed (#1310); this is the only create path.
const RATE_LIMIT = { limit: 10, windowMs: 60_000 };

export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }
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
        const [failingRuns, runningRuns, succeededRuns, pulse] = await Promise.all([
          prisma.githubWorkflowRun.count({
            where: { workflow: { repoId: repo.id }, conclusion: "failure" },
          }),
          prisma.githubWorkflowRun.count({
            where: { workflow: { repoId: repo.id }, status: "in_progress" },
          }),
          // Positive success evidence separates "CI green" from "no usable
          // run evidence" for the advisory readiness context (#1483).
          prisma.githubWorkflowRun.count({
            where: { workflow: { repoId: repo.id }, conclusion: "success" },
          }),
          collectReleasePulse({
            fullName: repo.fullName,
            releaseState: asReleaseDeltaState(repo.releaseState),
            releaseBaselineTag: repo.releaseBaselineTag,
            releaseBaselineSha: repo.releaseBaselineSha,
            releaseBaselinePublishedAt: repo.releaseBaselinePublishedAt,
            releaseHeadSha: repo.releaseHeadSha,
            releaseAheadBy: repo.releaseAheadBy,
          }),
        ]);

        const lastSyncRun = await prisma.automationSyncRun.findFirst({
          where: { repoId: repo.id },
          orderBy: { startedAt: "desc" },
        });

        // Advisory release-readiness badge (#1483): pure derivation from the
        // pulse snapshot plus the coarse CI context. No forge call, no model
        // call, no release mutation, and no effect on queue/admission.
        const readiness = deriveReleaseReadiness({
          pulse,
          now: new Date(),
          ci: releaseCiStatus({ failingRuns, runningRuns, succeededRuns }),
        });

        return {
          id: repo.id,
          fullName: repo.fullName,
          name: repo.name,
          owner: repo.owner,
          defaultBranch: repo.defaultBranch,
          latestCommitSha: repo.latestCommitSha,
          releaseState: repo.releaseState,
          releaseBaselineTag: repo.releaseBaselineTag,
          releaseBaselineSha: repo.releaseBaselineSha,
          releaseBaselinePublishedAt: repo.releaseBaselinePublishedAt,
          releaseHeadSha: repo.releaseHeadSha,
          releaseAheadBy: repo.releaseAheadBy,
          releaseError: repo.releaseError,
          releaseDeltaSyncedAt: repo.releaseDeltaSyncedAt,
          pulse,
          readiness,
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
    return handleApiError("fetch repos", error);
  }
}

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`repos:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (typeof body !== "object" || body === null) {
    return errorResponse("Invalid JSON body", 400);
  }

  const { fullName } = body as Record<string, unknown>;

  if (typeof fullName !== "string" || !fullName) {
    return errorResponse("fullName is required", 400);
  }

  if (!isValidRepoName(fullName)) {
    return errorResponse("Invalid fullName format. Expected: owner/repo", 400);
  }

  try {
    const { automationRepo, repository } = await createTrackedRepo(fullName);

    return NextResponse.json(jsonSafe({ ...automationRepo, repositoryId: repository.id }), { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return errorResponse("Repository is already tracked", 409);
    }

    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await auditTrackedRepoCreateFailure(fullName, errorMessage);
    console.error("Failed to add tracked repo:", error);
    return errorResponse(errorMessage, 500);
  }
}
