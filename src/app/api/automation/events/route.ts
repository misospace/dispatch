import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { jsonSafe } from "@/lib/json";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { parseListLimit } from "@/lib/query-limit";

export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const { searchParams } = new URL(request.url);
  const limit = parseListLimit(searchParams.get("limit"));
  const repo = searchParams.get("repo");
  const eventType = searchParams.get("type");

  try {
    const where: Record<string, unknown> = {};
    if (repo) where.repoId = repo;
    if (eventType) where.eventType = eventType;

    const events = await prisma.automationEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { repo: true },
    });

    return NextResponse.json(jsonSafe(events));
  } catch (error) {
    console.error("Failed to fetch automation events:", error);
    return errorResponse("Failed to fetch events", 500);
  }
}
