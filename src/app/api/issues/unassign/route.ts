import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { updateIssueLabels } from "@/lib/github";
import { buildUnassignedLabels, getAgentLabels, getOwnerLabels } from "@/lib/assignment-conflicts";
import { authorizeRequest, getAuthorizedActor } from "@/lib/auth";

type UnassignPayload = {
  issueId: string;
  repoFullName: string;
  issueNumber: number;
  action: "unassign_agent" | "unassign_owner";
};

/**
 * POST /api/issues/unassign
 * Removes the agent or owner assignment from an issue.
 * - unassign_agent: removes all agent/* labels
 * - unassign_owner: removes all owner/* labels
 */
export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }
  const auditActor = getAuthorizedActor(auth, request);

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

    const payload = body as UnassignPayload;

    if (!payload.action || !payload.issueId || !payload.repoFullName || typeof payload.issueNumber !== "number") {
      return errorResponse("Missing required fields: action, issueId, repoFullName, issueNumber", 400);
    }

    if (payload.action !== "unassign_agent" && payload.action !== "unassign_owner") {
      return errorResponse(`Invalid action: ${payload.action}. Allowed: unassign_agent, unassign_owner`, 400);
    }

    try {
      const issue = await prisma.issue.findUnique({ where: { id: payload.issueId } });
      if (!issue) {
        return errorResponse(`Issue not found: ${payload.issueId}`, 404);
      }

      const currentLabels = issue.labels;

      // Use shared conflict resolution module for both removal detection and label update
      const labelsToRemove = payload.action === "unassign_agent"
        ? getAgentLabels(currentLabels)
        : getOwnerLabels(currentLabels);

      if (labelsToRemove.length === 0) {
        return errorResponse(`No ${payload.action === "unassign_agent" ? "agent" : "owner"} label found on this issue`, 400);
      }

      const newLabels = buildUnassignedLabels(currentLabels, payload.action);

      // Update GitHub labels
      await updateIssueLabels(payload.repoFullName, payload.issueNumber, newLabels);

      // Update local cache
      await prisma.issue.update({
        where: { id: payload.issueId },
        data: { labels: newLabels, lastSyncedAt: new Date() },
      });

      // Write audit log
      await prisma.auditLog.create({
        data: {
          actor: auditActor,
          action: payload.action,
          repoFullName: payload.repoFullName,
          issueNumber: payload.issueNumber,
          issueId: payload.issueId,
          beforeLabels: currentLabels,
          afterLabels: newLabels,
          success: true,
        },
      });

      return NextResponse.json({ success: true, labels: newLabels, removed: labelsToRemove });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      try {
        const issue = await prisma.issue.findUnique({ where: { id: payload.issueId } });
        const beforeLabels = issue?.labels ?? [];

        await prisma.auditLog.create({
          data: {
            actor: auditActor,
            action: payload.action,
            repoFullName: payload.repoFullName,
            issueNumber: payload.issueNumber,
            issueId: payload.issueId,
            beforeLabels,
            afterLabels: [],
            success: false,
            errorMessage,
          },
        });
      } catch {
        // Audit log failure should not mask the real error
      }

      return errorResponse(errorMessage, 500);
    }
  } catch (error) {
    console.error("Unassign action failed:", error);
    return errorResponse("Failed to process unassign", 500);
  }
}
