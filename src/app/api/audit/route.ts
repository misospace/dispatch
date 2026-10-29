import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { parseListLimit } from "@/lib/query-limit";
import { withNormalizedReleaseSignal } from "@/lib/groomer/plan";

export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }
  const { searchParams } = new URL(request.url);
  const limit = parseListLimit(searchParams.get("limit"));
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

    // #1487: the nested issue row carries the release-signal projection;
    // normalize a cleared-projection tombstone back to null for consumers.
    return NextResponse.json(
      logs.map((log) => (log.issue ? { ...log, issue: withNormalizedReleaseSignal(log.issue) } : log)),
    );
  } catch (error) {
    return handleApiError("fetch audit logs", error);
  }
}