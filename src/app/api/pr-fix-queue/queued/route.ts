import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { listQueuedPrFixItems } from "@/lib/pr-fix-queue";
import { isValidPrFixLane, VALID_PR_FIX_LANES } from "@/types";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";

export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  try {
    const { searchParams } = new URL(request.url);
    const lane = searchParams.get("lane");
    const includeBlocked = searchParams.get("include_blocked") === "true";
    const prioritizeByType = searchParams.get("prioritize_by_type") !== "false"; // default true

    if (lane) {
      const normalized = lane.trim().toUpperCase().replace(/-/g, "_");
      if (!isValidPrFixLane(normalized)) {
        return errorResponse(`Invalid lane. Valid lanes: ${VALID_PR_FIX_LANES.join(", ")}`, 400);
      }
    }

    const items = await listQueuedPrFixItems(asPrFixQueueClient(prisma), { lane, includeBlocked, prioritizeByType });
    return NextResponse.json(items);
  } catch (error) {
    return handleApiError("list PR fix queue", error);
  }
}
