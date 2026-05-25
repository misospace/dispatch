import { NextResponse } from "next/server";
import { prisma, asAgentWorkClient } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";
import { parseCheckpointAgentWorkInput, checkpointAgentWork } from "@/lib/agent-work";

export async function POST(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
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
