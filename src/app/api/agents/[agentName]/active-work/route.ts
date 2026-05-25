import { NextResponse } from "next/server";
import { resolveActiveWork, findActiveLeasesForIssue } from "@/lib/lease";
import type { ActiveWorkResult } from "@/lib/next-action";

export async function GET(_request: Request, { params }: { params: Promise<{ agentName: string }> }) {
  const { agentName } = await params;

  try {
    const context = await resolveActiveWork(agentName);

    if (!context) {
      const response: ActiveWorkResult = { hasActiveWork: false };
      return NextResponse.json(response);
    }

    // Fetch the leaseId so operators can use it for recovery via POST /api/agent-work
    const now = new Date();
    const lease = await (await import("@/lib/prisma")).prisma.lease.findFirst({
      where: { agentName, expiredAt: { gt: now } },
      orderBy: { renewedAt: "desc" },
      select: { id: true },
    });

    const response: ActiveWorkResult = {
      hasActiveWork: true,
      context: lease ? { ...context, leaseId: lease.id } : context,
    };
    return NextResponse.json(response);
  } catch (error) {
    console.error("Failed to fetch active work:", error);
    return NextResponse.json({ error: "Failed to fetch active work" }, { status: 500 });
  }
}
