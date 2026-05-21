import { NextResponse } from "next/server";
import { prisma, asAgentWorkClient } from "@/lib/prisma";
import { isAuthorizedAgentToken } from "@/lib/dispatch-env";
import { parseCheckpointAgentWorkInput, checkpointAgentWork } from "@/lib/agent-work";

export async function POST(request: Request) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!isAuthorizedAgentToken(token)) {
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
    return NextResponse.json(work);
  } catch (error) {
    console.error("Failed to checkpoint agent work:", error);
    return NextResponse.json({ error: "Failed to checkpoint agent work" }, { status: 500 });
  }
}
