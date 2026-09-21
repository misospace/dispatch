import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { STATUS_LABELS, StatusLabel, isStatusLabel } from "@/types";
import { authorizeRequest, getAuthorizedActor } from "@/lib/auth";
import { transitionIssueStatus } from "@/lib/issue-status";
import { getLiveIssueLabels } from "@/lib/claim-gate";
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

    const { issueId, repoFullName, issueNumber, status, agentName, actor, blockedReason } = body as Record<string, unknown>;

    if (!issueId || !repoFullName || typeof issueNumber !== "number" || typeof status !== "string") {
      return errorResponse("Missing required fields: issueId, repoFullName, issueNumber, status", 400);
    }

    const targetLabel = `status/${status}` as StatusLabel;
    if (!isStatusLabel(targetLabel)) {
      return errorResponse(`Invalid status label: ${status}. Allowed: ${STATUS_LABELS.join(", ")}`, 400);
    }

    if (targetLabel === "status/blocked" && (!blockedReason || typeof blockedReason !== "string" || !blockedReason.trim())) {
      return errorResponse("'blockedReason' is required when status is 'blocked'", 400);
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

      // #1037: the transition must be computed against the labels GitHub
      // currently has, not the Prisma cache — a label change made directly
      // on GitHub is invisible in the cache until the next sync. Fail closed
      // if GitHub is unreachable: no label writes, no cache update.
      let liveLabels: string[];
      try {
        liveLabels = await getLiveIssueLabels(effectiveRepo, effectiveNumber);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";

        // Failed audit entry, consistent with the failure-audit style below
        try {
          await prisma.auditLog.create({
            data: {
              actor: actorName,
              action: "set_status",
              repoFullName: effectiveRepo,
              issueNumber: effectiveNumber,
              issueId: issueId as string,
              beforeLabels: issue.labels,
              afterLabels: [],
              success: false,
              errorMessage: `Could not verify live GitHub labels: ${errorMessage}`,
            },
          });
        } catch {
          // Audit log failure should not mask the real error
        }

        return errorResponse(`Could not verify live GitHub labels: ${errorMessage}`, 503);
      }

      // Remove ALL existing status labels before adding the new one, via the
      // shared status-swap helper (also used by claim/groom/move/unclaim).
      // Base is the live GitHub label set (authoritative — #1037).
      const labelsToSet = await transitionIssueStatus(effectiveRepo, effectiveNumber, liveLabels, targetLabel);

      // Update local cache
      await prisma.issue.update({
        where: { id: issueId as string },
        data: {
          labels: labelsToSet,
          lastSyncedAt: new Date(),
          ...(targetLabel === "status/blocked"
            ? { blockedReason: (blockedReason as string).trim() }
            : { blockedReason: null }),
        },
      });

      // Write audit log
      await prisma.auditLog.create({
        data: {
          actor: actorName,
          action: "set_status",
          repoFullName: effectiveRepo,
          issueNumber: effectiveNumber,
          issueId: issueId as string,
          beforeLabels: liveLabels,
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