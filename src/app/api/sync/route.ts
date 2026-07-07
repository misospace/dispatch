import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { syncStatusLabels } from "@/lib/github";
import { getSyncRepos, parseExcludedLabels } from "@/lib/config";
import { syncIssuesForRepos, makePrismaIssueStore, fetchAllStateIssues } from "@/lib/issue-sync";
import { authorizeRequest } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { acquireLock, releaseLock } from "@/lib/sync-lock";

// Generous per-actor rate limit — each sync fans out GitHub API fetches, but
// the shared sync lock already serializes runs, so this only backstops abuse.
const RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export async function POST(request: NextRequest) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const limited = enforceRateLimit(`sync:${auth.actor}`, RATE_LIMIT);
  if (limited) return limited;

  try {
    const text = await request.text();
    let body: Record<string, unknown> = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return errorResponse("Malformed JSON in request body", 400);
      }
    }
    const { repoFullName } = body as { repoFullName?: string };

    let repos = await getSyncRepos();

    if (repoFullName) {
      repos = repos.filter((r) => r.fullName === repoFullName);
      if (repos.length === 0) {
        return errorResponse(`Repo ${repoFullName} is not tracked. Track it first via /api/repos or the UI.`, 404);
      }
    }

    // Acquire shared DB lock to prevent overlapping runs across all sync types
    const lockResult = await acquireLock("manual");
    if (!lockResult.locked) {
      return NextResponse.json(
        { error: "A sync is already running. Try again later.", locked: true },
        { status: 409 },
      );
    }

    const { runId } = lockResult;

    try {
      const excludedLabels = parseExcludedLabels(process.env.DISPATCH_EXCLUDED_LABELS);
      const result = await syncIssuesForRepos(repos, fetchAllStateIssues, makePrismaIssueStore(), excludedLabels, syncStatusLabels);

      // Update the sync run record
      await prisma.issueSyncRun.updateMany({
        where: { id: runId, status: "running" },
        data: {
          status: "completed",
          completedAt: new Date(),
          reposFetched: result.repos ?? 0,
          syncedCount: result.syncedCount ?? 0,
        },
      });

      return NextResponse.json(result);
    } finally {
      await releaseLock(runId).catch(() => {});
    }
  } catch (error) {
    console.error("Sync failed:", error);
    return errorResponse("Sync failed", 500);
  }
}
