import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";
import { fetchPullRequests, fetchLinkedPrHealthInput } from "@/lib/github";
import { computeLinkedPrHealth, toPersistedLinkedPrHealth } from "@/lib/linked-pr-health";

/**
 * POST /api/issues/[issueId]/pr-health/refresh
 *
 * Recompute and persist linked PR health for a single issue on demand. The
 * periodic reconcile job keeps this fresh in the background (Option B); this
 * endpoint lets an operator or worker force an immediate refresh for one issue.
 *
 * Finds the issue's linked open PR by branch-name convention (issue-<number>),
 * computes the health snapshot, and writes it to the Issue row. If no linked
 * open PR exists, any stale snapshot is cleared.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ issueId: string }> }) {
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
  }

  try {
    const { issueId } = await context.params;

    const issue = await prisma.issue.findUnique({
      where: { id: issueId },
      include: { repository: true },
    });

    if (!issue) {
      return errorResponse("Issue not found in local cache", 404);
    }

    // Find the linked open PR by branch-name convention (matches reconcile).
    const openPrs = await fetchPullRequests(issue.repository.fullName, 100);
    const linkedPr = openPrs.find((pr) => {
      const match = (pr.head?.ref ?? "").match(/issue[-_/]?(\d+)/i);
      return match ? parseInt(match[1], 10) === issue.number : false;
    });

    const health = linkedPr
      ? computeLinkedPrHealth(await fetchLinkedPrHealthInput(issue.repository.fullName, linkedPr))
      : null;

    const persisted = toPersistedLinkedPrHealth(health);

    await prisma.issue.update({
      where: { id: issueId },
      data: persisted,
    });

    return NextResponse.json({ success: true, ...persisted });
  } catch (error) {
    console.error("Linked PR health refresh failed:", error);
    return errorResponse("Failed to refresh linked PR health", 500);
  }
}
