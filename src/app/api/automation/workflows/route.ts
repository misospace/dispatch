import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { jsonSafe } from "@/lib/json";
import { authorizeRequest } from "@/lib/auth";

export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }

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
