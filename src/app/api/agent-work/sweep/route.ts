import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { acquireLock, releaseLock } from "@/lib/sync-lock";
import { sweepStaleWork, DEFAULT_STALE_WORK_MAX_AGE_MS, DEFAULT_STALE_WORK_BATCH_SIZE } from "@/lib/stale-work";

const MAX_AGE_MS = DEFAULT_STALE_WORK_MAX_AGE_MS;
const BATCH_SIZE = DEFAULT_STALE_WORK_BATCH_SIZE;

/** Reclaim abandoned AgentWork and release the corresponding GitHub claims. */
export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const lock = await acquireLock("stale-work");
  if (!lock.locked) {
    return NextResponse.json(
      { error: "Stale work sweep is already running", locked: true },
      { status: 409 },
    );
  }

  try {
    const report = await sweepStaleWork(prisma, MAX_AGE_MS, BATCH_SIZE);
    return NextResponse.json({ success: report.errors.length === 0, ...report });
  } catch (error) {
    console.error("Stale work sweep failed:", error);
    return errorResponse("Stale work sweep failed", 500);
  } finally {
    await releaseLock(lock.runId);
  }
}
