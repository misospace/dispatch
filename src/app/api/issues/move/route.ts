import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { removeIssueLabel } from "@/lib/github";
import { STATUS_LABELS, isStatusLabel } from "@/types";
import { authorizeRequest, getAuthorizedActor } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { transitionIssueStatus } from "@/lib/issue-status";

// Generous per-actor rate limit — normal kanban drag-and-drop and agent
// status transitions stay far below this.
const RATE_LIMIT = { limit: 60, windowMs: 60_000 };

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const limited = enforceRateLimit(`issues/move:${auth.actor}`, RATE_LIMIT);
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

    const { issueId, repoFullName, issueNumber, oldLabels, newLabels, actor: bodyActor } = body as Record<string, unknown>;
    const moveActor = getAuthorizedActor(auth, request, bodyActor);

    // Validate required fields with explicit type checks
    if (!issueId || !repoFullName || typeof issueNumber !== "number" || !oldLabels || !newLabels) {
      return errorResponse("Missing required fields", 400);
    }

    // Validate status labels are from the allowed set
    const oldStatusLabel = (oldLabels as string[]).find((l: string) => l.startsWith("status/"));
    const newStatusLabel = (newLabels as string[]).find((l: string) => l.startsWith("status/"));

    if (oldStatusLabel && !isStatusLabel(oldStatusLabel)) {
      return errorResponse(`Invalid status label: ${oldStatusLabel}. Allowed: ${STATUS_LABELS.join(", ")}`, 400);
    }

    if (newStatusLabel && !isStatusLabel(newStatusLabel)) {
      return errorResponse(`Invalid status label: ${newStatusLabel}. Allowed: ${STATUS_LABELS.join(", ")}`, 400);
    }

    try {
      // Use the cached issue's real current labels (not just the single
      // label the client computed) as the source of truth for the status
      // swap, so every status/* label on GitHub gets cleaned up even if the
      // client only knew about one of them. Falls back to the client-sent
      // oldLabels when the issue isn't in the local cache.
      const issue = await prisma.issue.findUnique({ where: { id: issueId as string } });
      const effectiveCurrentLabels = issue?.labels ?? (oldLabels as string[]);

      if (newStatusLabel) {
        await transitionIssueStatus(repoFullName as string, issueNumber as number, effectiveCurrentLabels, newStatusLabel);
      } else if (oldStatusLabel) {
        // No target status in the new label set — drop the old one with no
        // replacement (rare: kanban-board.tsx always targets a status-bearing
        // column today, but the API contract allows this).
        await removeIssueLabel(repoFullName as string, issueNumber as number, oldStatusLabel);
      }

      if (issue) {
        await prisma.issue.update({
          where: { id: issueId as string },
          data: { labels: newLabels as string[], lastSyncedAt: new Date() },
        });
      }

      await prisma.auditLog.create({
        data: {
          actor: moveActor,
          action: "move_issue",
          repoFullName: repoFullName as string,
          issueNumber: issueNumber as number,
          issueId: issueId as string,
          beforeLabels: oldLabels as string[],
          afterLabels: newLabels as string[],
          success: true,
        },
      });

      return NextResponse.json({ success: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      await prisma.auditLog.create({
        data: {
          actor: moveActor,
          action: "move_issue",
          repoFullName: repoFullName as string,
          issueNumber: issueNumber as number,
          issueId: issueId as string,
          beforeLabels: oldLabels as string[],
          afterLabels: newLabels as string[],
          success: false,
          errorMessage,
        },
      });

      return errorResponse(errorMessage, 500);
    }
  } catch (error) {
    console.error("Move issue failed:", error);
    return errorResponse("Failed to move issue", 400);
  }
}
