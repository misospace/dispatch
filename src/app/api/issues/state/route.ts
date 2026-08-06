import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { authorizeRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Precise state lookup for one issue: `GET /api/issues/state?repo=o/n&number=N`.
 *
 * Deliberately separate from `GET /api/issues`. That endpoint is a browse surface
 * and applies Renovate exclusion, excluded-label filters, and a default
 * open-only filter — so an absent issue there could mean closed, excluded, or
 * Renovate-authored. Callers that act on "is this still open?" need an answer they
 * can distinguish from "filtered out", because guessing wrong the other way
 * cancels legitimate work.
 *
 * Applies no filters beyond identity. Returns 404 only when the issue is genuinely
 * absent from the cache, so a caller can treat 404 as "unknown" and fail open
 * rather than inferring closure.
 */
export async function GET(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const { searchParams } = new URL(request.url);
  const repo = searchParams.get("repo")?.trim();
  const numberRaw = searchParams.get("number")?.trim();

  if (!repo || !numberRaw) {
    return errorResponse("Missing required query parameters: repo, number", 400);
  }

  const number = Number(numberRaw);
  if (!Number.isInteger(number) || number <= 0) {
    return errorResponse(`Invalid number: ${numberRaw}`, 400);
  }

  try {
    const issue = await prisma.issue.findFirst({
      where: { number, repository: { fullName: repo } },
      select: {
        id: true,
        number: true,
        state: true,
        labels: true,
        closedAt: true,
        repository: { select: { fullName: true } },
      },
    });

    if (!issue) {
      return errorResponse(`Issue not found in cache: ${repo}#${number}`, 404);
    }

    return NextResponse.json({
      issueId: issue.id,
      repoFullName: issue.repository.fullName,
      number: issue.number,
      state: issue.state,
      closedAt: issue.closedAt,
      labels: issue.labels,
    });
  } catch (error) {
    return handleApiError("fetch issue state", error);
  }
}
