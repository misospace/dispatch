import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get("limit") || "50");
  const repo = searchParams.get("repo");

  try {
    const where: Record<string, unknown> = {};
    if (repo) {
      where.repoFullName = repo;
    }

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { issue: { include: { repository: true } } },
    });

    return NextResponse.json(logs);
  } catch (error) {
    console.error("Failed to fetch audit logs:", error);
    return NextResponse.json({ error: "Failed to fetch audit logs" }, { status: 500 });
  }
}