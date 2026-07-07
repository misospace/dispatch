import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { jsonSafe } from "@/lib/json";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoFullName = searchParams.get("repo");

  try {
    const where: Record<string, unknown> = {};
    if (repoFullName) {
      where.repo = { fullName: repoFullName };
    }

    const workflows = await prisma.githubWorkflow.findMany({
      where,
      include: {
        _count: { select: { runs: true } },
        runs: {
          take: 1,
          orderBy: { runStartedAt: "desc" },
        },
      },
      orderBy: { name: "asc" },
    });

    return NextResponse.json(jsonSafe(workflows));
  } catch (error) {
    return handleApiError("fetch workflows", error);
  }
}