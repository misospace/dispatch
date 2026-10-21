import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { getTrackedRepos } from "@/lib/config";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { acquireLock, releaseLock } from "@/lib/sync-lock";
import { syncAutomationRepo } from "@/lib/automation-sync";
import { enforceRateLimit } from "@/lib/rate-limit";

// 30 requests / 60s: each call syncs the tracked repos (expensive), so
// bursts are capped — while the automation UI's per-repo Sync buttons (one
// click per repo card) stay usable.
const RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }
  const repos = await prisma.automationRepo.findMany({
    orderBy: { fullName: "asc" },
    include: {
      _count: { select: { workflows: true, releases: true, automationEvents: true } },
    },
  });
  return NextResponse.json(repos);
}

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`automation-sync:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const repoFullName = body.repo || body.fullName;

  // Acquire shared DB lock to prevent overlapping runs across all sync types
  const lockResult = await acquireLock("automation");
  if (!lockResult.locked) {
    return NextResponse.json(
      { error: "A sync is already running. Try again later.", locked: true },
      { status: 409 },
    );
  }

  const { runId } = lockResult;

  try {
    if (repoFullName) {
      const result = await syncAutomationRepo(repoFullName);
      if (result.success) {
        return NextResponse.json({ success: true, syncRunId: result.syncRunId });
      } else {
        return NextResponse.json({ error: result.error }, { status: 500 });
      }
    }

    const repos = await getTrackedRepos();
    const results = [];
    for (const repo of repos) {
      results.push({ repo, result: await syncAutomationRepo(repo) });
    }

    return NextResponse.json({
      synced: results.filter((r) => r.result.success).length,
      failed: results.filter((r) => !r.result.success).length,
      results,
    });
  } finally {
    await releaseLock(runId).catch((error) => {
      console.error("Failed to release automation sync lock:", error);
    });
  }
}
