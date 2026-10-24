import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { parseListLimit } from "@/lib/query-limit";
import { appendIssueWhere, applyRenovateIssueExclusion, buildNoStatusWhere } from "@/lib/issue-filters";

/**
 * GET /api/issues/untriaged
 *
 * Returns open issues with no `status/*` label — an intake view for grooming.
 * These issues are excluded from normal worker queues but need to be surfaced
 * so they can be classified into status/backlog, status/ready, or closed.
 *
 * Query parameters:
 *   limit     — max results (default 50, hard cap 200)
 *   repo      — filter by repository fullName
 *   excludeRenovate  — skip Renovate/dashboard noise (default true)
 *
 * Every filter is expressed in the Prisma `where` clause and the capped limit
 * is carried by `take`, so the database returns at most `limit` untriaged rows
 * and this process never loads the whole open-issue set (issue #1309).
 */

interface UntriagedIssue {
  id: string;
  number: number;
  title: string;
  url: string;
  labels: string[];
  state: string;
  createdAt: Date;
  updatedAt: Date;
  repository: { fullName: string };
}

export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  try {
    const { searchParams } = new URL(request.url);
    // Clamp before it reaches Prisma `take`: NaN, zero and negative values
    // fall back to the default, oversized values are capped at 200.
    const limit = parseListLimit(searchParams.get("limit"));
    const repoFilter = searchParams.get("repo");
    const excludeRenovate = searchParams.get("excludeRenovate") !== "false";

    // Open issues in enabled repos, narrowed in the query so `take` below
    // bounds the rows this process ever receives.
    const where: Record<string, unknown> = {
      state: "open",
      repository: { enabled: true },
    };

    if (repoFilter) {
      where.repository = { enabled: true, fullName: repoFilter };
    }

    // Untriaged = carries no `status/*` label. Expressed in the query (not as
    // a post-fetch filter) so the capped `take` is exact.
    appendIssueWhere(where, buildNoStatusWhere(true));

    // Renovate/dashboard noise, excluded with the same criteria the shared
    // `isRenovateIssue` predicate uses (see buildRenovateIssueExclusionWhere).
    if (excludeRenovate) {
      applyRenovateIssueExclusion(where);
    }

    const issues: UntriagedIssue[] = await prisma.issue.findMany({
      where,
      select: {
        id: true,
        number: true,
        title: true,
        url: true,
        labels: true,
        state: true,
        createdAt: true,
        updatedAt: true,
        repository: { select: { fullName: true } },
      },
      orderBy: { updatedAt: "desc" },
      // The cap is applied by the query, not by slicing the fetched rows.
      take: limit,
    });

    return NextResponse.json(issues);
  } catch (error) {
    return handleApiError("fetch untriaged issues", error);
  }
}
