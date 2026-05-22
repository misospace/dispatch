import { NextResponse } from "next/server";
import { prisma, asAgentWorkClient } from "@/lib/prisma";
import { isAuthorizedAgentToken } from "@/lib/dispatch-env";
import { parseStartAgentWorkInput, startAgentWork } from "@/lib/agent-work";

export async function POST(request: Request) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!isAuthorizedAgentToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = parseStartAgentWorkInput(body);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const work = await startAgentWork(asAgentWorkClient(prisma), parsed);
    return NextResponse.json(work, { status: 201 });
  } catch (error) {
    console.error("Failed to start agent work:", error);
    return NextResponse.json({ error: "Failed to start agent work" }, { status: 500 });
  }
}
