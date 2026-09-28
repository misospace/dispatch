import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { getAgentFromLabels, AGENT_PREFIX } from "@/types";
import { authorizeRequest, getAuthorizedActor, authErrorResponse } from "@/lib/auth";
import {
  releaseLeaseByAgentAndIssue,
  releaseAgentWorkByAgentAndIssue,
} from "@/lib/lease";
import { releaseIssueClaim } from "@/lib/issue-claim";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 };

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
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

    // Worker tokens may only release their own claim: releasing another
    // agent's claim requires a maintainer token (#1111).
    const callerIdentity = request.headers.get("x-agent-name")?.trim();
    if (auth.type === "bearer" && auth.tier === "worker" && callerIdentity !== agentName) {
      try {
        await prisma.auditLog.create({
          data: {
            actor: agentName as string,
            action: "unclaim_issue",
            repoFullName: repoFullName as string,
            issueNumber: issueNumber as number,
            issueId: issueId as string,
            beforeLabels: [],
            afterLabels: [],
            success: false,
            errorMessage: "Releasing another agent's claim requires a maintainer token",
          },
        });
      } catch {
        // Audit log failure should not mask the 403
      }
      return errorResponse("Releasing another agent's claim requires a maintainer token", 403);
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
      // The shared core keeps operator and scheduled claim release behaviour
      // consistent while allowing stale retries to be idempotent.
      const released = await releaseIssueClaim({
        prisma,
        issue,
        repoFullName: repoFullName as string,
        issueNumber: issueNumber as number,
        agentName: agentName as string,
      });

      const updatedLabels = released.labels;
      const statusNote = released.statusNote;

      // Release the durable lease after GitHub and the local cache agree.
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

      return NextResponse.json({
        success: true,
        labels: updatedLabels,
        status: released.status,
        statusNote,
      });
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
