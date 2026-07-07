import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";

export async function GET(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
  }
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
    return handleApiError("fetch audit logs", error);
  }
}