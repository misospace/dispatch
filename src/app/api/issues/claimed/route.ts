import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { authorizeRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/** Statuses this endpoint will list. Kept narrow: it exists to find claimed work,
 *  not as a general issue query. */
const ALLOWED_CLAIMED_STATUSES = ["in-progress", "ready"];

export async function GET(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const { searchParams } = new URL(request.url);
  const agentName = searchParams.get("agentName")?.trim();
  // Which status to list alongside the agent label. Defaults to in-progress so
  // existing callers are unaffected. `ready` exposes the stuck-claim shape: an
  // issue still holding its agent label while back at status/ready, which no
  // reaper could see because this endpoint only ever returned in-progress.
  const status = searchParams.get("status")?.trim() || "in-progress";

  if (!agentName) {
    return errorResponse("Missing required query parameter: agentName", 400);
  }

  if (!ALLOWED_CLAIMED_STATUSES.includes(status)) {
    return errorResponse(
      `Invalid status: ${status}. Allowed: ${ALLOWED_CLAIMED_STATUSES.join(", ")}`,
      400,
    );
  }

  try {
    const issues = await prisma.issue.findMany({
      where: {
        repository: { enabled: true },
        state: "open",
        labels: { hasEvery: [`status/${status}`, `agent/${agentName}`] },
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
