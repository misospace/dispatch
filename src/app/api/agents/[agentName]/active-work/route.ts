import { NextResponse } from "next/server";
import { resolveActiveWork } from "@/lib/lease";
import type { ActiveWorkResult } from "@/lib/next-action";

export async function GET(_request: Request, { params }: { params: Promise<{ agentName: string }> }) {
  const { agentName } = await params;

  try {
    const context = await resolveActiveWork(agentName);

    if (!context) {
      const response: ActiveWorkResult = { hasActiveWork: false };
      return NextResponse.json(response);
    }

    const response: ActiveWorkResult = { hasActiveWork: true, context };
    return NextResponse.json(response);
  } catch (error) {
    console.error("Failed to fetch active work:", error);
    return NextResponse.json({ error: "Failed to fetch active work" }, { status: 500 });
  }
}
