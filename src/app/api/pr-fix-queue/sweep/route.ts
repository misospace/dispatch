import { NextResponse } from "next/server";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { errorResponse } from "@/lib/api-errors";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { acquireLock, releaseLock } from "@/lib/sync-lock";
import { reclaimStalePrFixHandouts } from "@/lib/pr-fix-queue";

/**
 * Reclaim stale unacknowledged PR-fix hand-outs (#1211). Maintainer-only by
 * default: it reopens queue items as fresh generations and can route them to a
 * human, so it is not part of the worker allowlist. The sync lock collapses
 * concurrent fires to one, exactly like the stale-work sweep.
 */
export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const lock = await acquireLock("pr-fix-handout-sweep");
  if (!lock.locked) {
    return NextResponse.json(
      { error: "PR-fix hand-out sweep is already running", locked: true },
      { status: 409 },
    );
  }

  try {
    const report = await reclaimStalePrFixHandouts(asPrFixQueueClient(prisma));
    return NextResponse.json({ success: report.errors.length === 0, ...report });
  } catch (error) {
    console.error("PR-fix hand-out sweep failed:", error);
    return errorResponse("PR-fix hand-out sweep failed", 500);
  } finally {
    await releaseLock(lock.runId);
  }
}
