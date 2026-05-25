import { NextResponse } from "next/server";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { listQueuedPrFixItems } from "@/lib/pr-fix-queue";
import { isValidPrFixLane, VALID_PR_FIX_LANES } from "@/types";
import { isAuthorized } from "@/lib/auth";

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const lane = searchParams.get("lane");
    const includeBlocked = searchParams.get("include_blocked") === "true";

    if (lane) {
      const normalized = lane.trim().toUpperCase().replace(/-/g, "_");
      if (normalized !== "GPT" && !isValidPrFixLane(normalized)) {
        return NextResponse.json({ error: `Invalid lane. Valid lanes: ${VALID_PR_FIX_LANES.join(", ")}` }, { status: 400 });
      }
    }

    const items = await listQueuedPrFixItems(asPrFixQueueClient(prisma), { lane, includeBlocked });
    return NextResponse.json(items);
  } catch (error) {
    console.error("Failed to list PR fix queue:", error);
    return NextResponse.json({ error: "Failed to list PR fix queue" }, { status: 500 });
  }
}
