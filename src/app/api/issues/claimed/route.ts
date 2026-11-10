import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { appendIssueWhere, buildExcludedLabelWhere } from "@/lib/issue-filters";
import { parseExcludedLabels } from "@/lib/config";

/** Statuses this endpoint will list. Kept narrow: it exists to find claimed work,
 *  not as a general issue query. */
const ALLOWED_CLAIMED_STATUSES = ["in-progress", "ready"];

export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
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
    // #1610: an issue whose cached labels match DISPATCH_EXCLUDED_LABELS is an
    // operator visibility opt-out, but the sync prune (#1594) keeps the row
    // cached when dependent work blocks deletion — without this filter such a
    // row is listed as claimed work. Same shared filter the issues list and
    // board apply; the excluded set comes from parseExcludedLabels, so there
    // is no second definition of it.
    const where: Record<string, unknown> = {
      repository: { enabled: true },
      state: "open",
      labels: { hasEvery: [`status/${status}`, `agent/${agentName}`] },
    };
    appendIssueWhere(where, buildExcludedLabelWhere(parseExcludedLabels(process.env.DISPATCH_EXCLUDED_LABELS)));

    const issues = await prisma.issue.findMany({
      where,
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
