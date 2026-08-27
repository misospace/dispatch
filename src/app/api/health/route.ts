import { NextResponse } from "next/server";
import { getAppVersion } from "@/lib/version";
import { prisma } from "@/lib/prisma";
import { getAuthMode } from "@/lib/auth";
import { schedulerState } from "@/lib/scheduler";

export async function GET() {
  const version = getAppVersion();

  try {
    await prisma.$queryRaw`SELECT 1`;
    // Scheduler liveness is part of health: every queue in the system is fed
    // by these jobs, so a stopped timer starves the loop while the app still
    // answers requests and looks fine.
    const scheduler = schedulerState();
    const overdue = scheduler.jobs.filter((j) => j.overdue).map((j) => j.name);
    return NextResponse.json({
      ok: true,
      database: "ok",
      version,
      authMode: getAuthMode() || "legacy",
      scheduler,
      schedulerOverdue: overdue,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      database: "error",
      version,
    }, { status: 503 });
  }
}
