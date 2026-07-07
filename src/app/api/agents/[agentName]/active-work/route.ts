import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-errors";
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

    const response: ActiveWorkResult = {
      hasActiveWork: true,
      context,
    };
    return NextResponse.json(response);
  } catch (error) {
    return handleApiError("fetch active work", error);
  }
}
