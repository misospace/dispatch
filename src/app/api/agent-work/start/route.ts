import { NextResponse } from "next/server";
import { prisma, asAgentWorkClient } from "@/lib/prisma";
import { isAuthorized } from "@/lib/auth";
import { parseStartAgentWorkInput, startAgentWork } from "@/lib/agent-work";

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = parseStartAgentWorkInput(body);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const work = await startAgentWork(asAgentWorkClient(prisma), parsed);

    await prisma.auditLog.create({
      data: {
        actor: parsed.agentName,
        action: "agent_work_started",
        repoFullName: "",
        issueNumber: undefined,
        issueId: parsed.issueId ?? undefined,
        success: true,
        notes: `Agent ${parsed.agentName} started work on issue ${parsed.issueId ?? "unassigned"}`,
      },
    });

    return NextResponse.json(work, { status: 201 });
  } catch (error) {
    console.error("Failed to start agent work:", error);
    return NextResponse.json({ error: "Failed to start agent work" }, { status: 500 });
  }
}
