import { NextResponse } from "next/server";
import { prisma, asAgentWorkClient } from "@/lib/prisma";
import { isAuthorized } from "@/lib/auth";
import { parseCheckpointAgentWorkInput, checkpointAgentWork } from "@/lib/agent-work";

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = parseCheckpointAgentWorkInput(body);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const work = await checkpointAgentWork(asAgentWorkClient(prisma), parsed);
    if (!work) {
      // No active work found — check if there's an orphaned lease to clean up
      const now = new Date();
      const lease = await prisma.lease.findFirst({
        where: { agentName: parsed.agentName, expiredAt: { gt: now } },
        include: { issue: true },
      });

      if (lease && (!lease.issueId || !(await prisma.issue.findUnique({ where: { id: lease.issueId } })))) {
        // Orphaned lease detected — release it so the agent can pick up new work
        await prisma.lease.delete({ where: { id: lease.id } });
        await prisma.auditLog.create({
          data: {
            actor: parsed.agentName,
            action: "orphan_lease_released_during_checkpoint",
            repoFullName: "",
            issueId: lease.issueId ?? undefined,
            success: true,
            notes: `Released orphaned lease during checkpoint for agent ${parsed.agentName}: referenced issue not found`,
          },
        });
        return NextResponse.json({ releasedOrphan: true, message: "Orphaned lease released — no active work to checkpoint" });
      }

      return NextResponse.json({ error: "No active work found for agent" }, { status: 404 });
    }

    await prisma.auditLog.create({
      data: {
        actor: parsed.agentName,
        action: "agent_work_checkpoint",
        repoFullName: "",
        issueNumber: undefined,
        issueId: work.issueId ?? undefined,
        success: true,
        notes: `Agent ${parsed.agentName} checkpointed (${parsed.checkpoint}): ${parsed.summary ?? parsed.blockerReason ?? "-"}`,
      },
    });

    return NextResponse.json(work);
  } catch (error) {
    console.error("Failed to checkpoint agent work:", error);
    return NextResponse.json({ error: "Failed to checkpoint agent work" }, { status: 500 });
  }
}
