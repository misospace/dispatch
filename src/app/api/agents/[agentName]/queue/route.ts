import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { authorizeRequest } from "@/lib/auth";
import { fetchAgentQueueData } from "@/lib/agent-queue-fetch";

export async function GET(request: Request, { params }: { params: Promise<{ agentName: string }> }) {
  const { agentName } = await params;

  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const { searchParams } = new URL(request.url);
  const lane = searchParams.get("lane");
  const excludeDecomposed = searchParams.get("exclude_decomposed");
  const includeClaimed = searchParams.get("includeClaimed") === "true";
  const includeRenovate = searchParams.get("includeRenovate") === "true";
  // Diagnostics: append issues withheld by grooming admission (enforce mode),
  // each with claimable: false and its admission reasons. Off by default so
  // queue consumers never see work they may not pick up.
  const includeWithheld = searchParams.get("includeWithheld") === "true";

  try {
    const { laneValid, rankedQueue, withheldQueue, prFixItems, availableLanes } = await fetchAgentQueueData({
      agentName,
      lane,
      excludeDecomposed: excludeDecomposed === "true",
      includeClaimed,
      includeRenovate,
    });

    if (!laneValid) {
      return errorResponse(`Invalid lane: "${lane}". Must be one of: ${availableLanes.join(", ")}`, 400);
    }

    return NextResponse.json([...prFixItems, ...rankedQueue, ...(includeWithheld ? withheldQueue : [])]);
  } catch (error) {
    return handleApiError("fetch agent queue", error);
  }
}
