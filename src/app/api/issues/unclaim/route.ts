import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { removeIssueLabel, updateIssueLabels } from "@/lib/github";
import { getAgentFromLabels, AGENT_PREFIX } from "@/types";
import { authorizeRequest, getAuthorizedActor } from "@/lib/auth";
import {
  releaseLeaseByAgentAndIssue,
  releaseAgentWorkByAgentAndIssue,
} from "@/lib/lease";
import { transitionIssueStatus } from "@/lib/issue-status";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 };

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const limited = enforceRateLimit(`unclaim:${auth.actor}`, RATE_LIMIT);
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

    const { issueId, repoFullName, issueNumber, agentName } = body as Record<string, unknown>;

    // Validate required fields
    if (!issueId || !repoFullName || typeof issueNumber !== "number" || !agentName || typeof agentName !== "string") {
      return errorResponse("Missing required fields: issueId, repoFullName, issueNumber, agentName", 400);
    }

    const agentLabel = `${AGENT_PREFIX}${agentName}` as const;
    const actor = getAuthorizedActor(auth, request, agentName as string);
    const isAgentSelfUnclaim = auth.type === "bearer" && actor === agentName;
    const auditAction = isAgentSelfUnclaim ? "unclaim_issue" : "unclaim_issue_by_operator";

    // Fetch the issue from the local database to get current labels
    const issue = await prisma.issue.findUnique({
      where: { id: issueId as string },
    });

    if (!issue) {
      return errorResponse("Issue not found in local cache", 404);
    }

    // Refuse closed issues
    if (issue.state === "closed") {
      return errorResponse("Cannot unclaim a closed issue", 400);
    }

    // Refuse done issues
    const currentStatus = issue.labels.find((l) => l.startsWith("status/"));
    if (currentStatus === "status/done") {
      return errorResponse("Cannot unclaim a done issue", 400);
    }

    // Check if the agent is actually assigned
    const currentAgent = getAgentFromLabels(issue.labels);
    if (!currentAgent || currentAgent !== agentLabel) {
      return errorResponse(`Issue is not assigned to ${agentName}`, 400);
    }

    try {
      // Compute the new label set: drop the agent label; if status/in-progress,
      // flip to status/ready so the issue leaves the In Progress column. The
      // status swap itself is routed through the shared helper so it removes
      // ALL status/* labels (not just in-progress) consistently with the
      // other label routes.
      let updatedLabels = issue.labels.filter((l) => l !== agentLabel);
      if (updatedLabels.includes("status/in-progress")) {
        updatedLabels = await transitionIssueStatus(
          repoFullName as string,
          issueNumber as number,
          updatedLabels,
          "status/ready",
        );
      }

      // Apply label changes to GitHub (conflict-aware: re-applies all
      // non-status labels and adds status/ready in one shot).
      await updateIssueLabels(
        repoFullName as string,
        issueNumber as number,
        updatedLabels,
      );
      // Defensive: ensure the agent/* label is removed even if GitHub's API
      // returned something different than what we expected.
      await removeIssueLabel(repoFullName as string, issueNumber as number, agentLabel);

      // Update local cache
      await prisma.issue.update({
        where: { id: issueId as string },
        data: { labels: updatedLabels, lastSyncedAt: new Date() },
      });

      // Release the lease using the shared helper (uses deleteMany under
      // the hood — see src/lib/lease.ts).
      await releaseLeaseByAgentAndIssue(agentName as string, issueId as string);

      // For the operator path, also release any AgentWork records for this
      // agent+issue (mark them RELEASED and write a released_by_operator
      // history entry). The agent self-unclaim path doesn't need this
      // because the agent is releasing its own claim.
      if (!isAgentSelfUnclaim) {
        await releaseAgentWorkByAgentAndIssue(agentName as string, issueId as string);
      }

      // Write audit log
      await prisma.auditLog.create({
        data: {
          actor,
          action: auditAction,
          repoFullName: repoFullName as string,
          issueNumber: issueNumber as number,
          issueId: issueId as string,
          beforeLabels: issue.labels,
          afterLabels: updatedLabels,
          notes: isAgentSelfUnclaim ? null : `Released agent ${agentName} as ${actor}`,
          success: true,
        },
      });

      return NextResponse.json({ success: true, labels: updatedLabels });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      // Write failure audit log
      await prisma.auditLog.create({
        data: {
          actor,
          action: auditAction,
          repoFullName: repoFullName as string,
          issueNumber: issueNumber as number,
          issueId: issueId as string,
          beforeLabels: issue.labels,
          afterLabels: [],
          success: false,
          errorMessage,
        },
      });

      return errorResponse(errorMessage, 500);
    }
  } catch (error) {
    console.error("Unclaim issue failed:", error);
    return errorResponse("Failed to unclaim issue", 500);
  }
}