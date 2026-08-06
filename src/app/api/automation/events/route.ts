import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { jsonSafe } from "@/lib/json";
import { authorizeRequest } from "@/lib/auth";

export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get("limit") || "50");
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
