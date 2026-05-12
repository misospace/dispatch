import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { jsonSafe } from "@/lib/json";

export async function GET(request: Request) {
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
    return NextResponse.json({ error: "Failed to fetch events" }, { status: 500 });
  }
}