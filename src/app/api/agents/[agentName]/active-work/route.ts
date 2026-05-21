import { NextResponse } from "next/server";
import { prisma, asAgentWorkClient } from "@/lib/prisma";
import { getActiveWorkByAgent } from "@/lib/agent-work";

export async function GET(_request: Request, { params }: { params: Promise<{ agentName: string }> }) {
  const { agentName } = await params;

  try {
    const activeWork = await getActiveWorkByAgent(asAgentWorkClient(prisma), agentName);
    return NextResponse.json(activeWork);
  } catch (error) {
    console.error("Failed to fetch active work:", error);
    return NextResponse.json({ error: "Failed to fetch active work" }, { status: 500 });
  }
}
