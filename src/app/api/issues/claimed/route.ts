import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { authorizeRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const { searchParams } = new URL(request.url);
  const agentName = searchParams.get("agentName")?.trim();

  if (!agentName) {
    return errorResponse("Missing required query parameter: agentName", 400);
  }

  try {
    const issues = await prisma.issue.findMany({
      where: {
        repository: { enabled: true },
        state: "open",
        labels: { hasEvery: ["status/in-progress", `agent/${agentName}`] },
      },
      include: { repository: true },
      orderBy: { updatedAt: "desc" },
    });

    const result = issues.map((issue) => ({
      issueId: issue.id,
      number: issue.number,
      repoFullName: issue.repository.fullName,
      currentLane: issue.currentLane,
      labels: issue.labels,
      hasOpenPr: issue.linkedPrNumber !== null && issue.linkedPrUrl !== null,
    }));

    return NextResponse.json(result);
  } catch (error) {
    return handleApiError("fetch claimed issues", error);
  }
}
