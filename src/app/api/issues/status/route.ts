import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { STATUS_LABELS, StatusLabel, isStatusLabel } from "@/types";
import { authorizeRequest, getAuthorizedActor } from "@/lib/auth";
import { transitionIssueStatus } from "@/lib/issue-status";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 };

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const limited = enforceRateLimit(`status:${auth.actor}`, RATE_LIMIT);
  if (limited) return limited;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("Invalid JSON body", 400);
    }

    if (typeof body !== "object" || body === null) {
      return errorResponse("Invalid JSON body", 400);
    }

    const { issueId, repoFullName, issueNumber, status, agentName, actor } = body as Record<string, unknown>;

    if (!issueId || !repoFullName || typeof issueNumber !== "number" || typeof status !== "string") {
      return errorResponse("Missing required fields: issueId, repoFullName, issueNumber, status", 400);
    }

    const targetLabel = `status/${status}` as StatusLabel;
    if (!isStatusLabel(targetLabel)) {
      return errorResponse(`Invalid status label: ${status}. Allowed: ${STATUS_LABELS.join(", ")}`, 400);
    }

    const actorName = getAuthorizedActor(auth, request, (actor as string | undefined) ?? (agentName as string | undefined));

    try {
      const issue = await prisma.issue.findUnique({
        where: { id: issueId as string },
        include: { repository: true },
      });

      if (!issue) {
        return errorResponse("Issue not found in local cache", 404);
      }

      // Update GitHub labels
      const effectiveRepo = (issue.repository?.fullName ?? repoFullName) as string;
      const effectiveNumber = issue.number;

      // Remove ALL existing status labels before adding the new one, via the
      // shared status-swap helper (also used by claim/groom/move/unclaim).
      const labelsToSet = await transitionIssueStatus(effectiveRepo, effectiveNumber, issue.labels, targetLabel);

      // Update local cache
      await prisma.issue.update({
        where: { id: issueId as string },
        data: { labels: labelsToSet, lastSyncedAt: new Date() },
      });

      // Write audit log
      await prisma.auditLog.create({
        data: {
          actor: actorName,
          action: "set_status",
          repoFullName: effectiveRepo,
          issueNumber: effectiveNumber,
          issueId: issueId as string,
          beforeLabels: issue.labels,
          afterLabels: labelsToSet,
          success: true,
        },
      });

      return NextResponse.json({ success: true, status: targetLabel, labels: labelsToSet });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      await prisma.auditLog.create({
        data: {
          actor: actorName,
          action: "set_status",
          repoFullName: repoFullName as string,
          issueNumber: issueNumber as number,
          issueId: issueId as string,
          beforeLabels: [],
          afterLabels: [],
          success: false,
          errorMessage,
        },
      });

      return errorResponse(errorMessage, 500);
    }
  } catch (error) {
    console.error("Set issue status failed:", error);
    return errorResponse("Failed to set issue", 500);
  }
}