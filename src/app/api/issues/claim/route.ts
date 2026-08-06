import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { addIssueLabel, removeIssueLabel } from "@/lib/github";
import { analyzeAssignmentConflict, buildNewLabels } from "@/lib/assignment-conflicts";
import { AGENT_PREFIX } from "@/types";
import { authorizeRequest } from "@/lib/auth";
import { upsertLease, findActiveLeasesForIssue, releaseExpiredLeases } from "@/lib/lease";
import { findAndReleaseStaleAgentWorkForIssue } from "@/lib/agent-work";
import { transitionIssueStatus } from "@/lib/issue-status";
import { enforceRateLimit } from "@/lib/rate-limit";

const IN_PROGRESS_STATUS = "status/in-progress";
const RATE_LIMIT = { limit: 30, windowMs: 10_000 };

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const limited = enforceRateLimit(`claim:${auth.actor}`, RATE_LIMIT);
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

    const { issueId, repoFullName, issueNumber, agentName, force } = body as Record<string, unknown>;

    // Validate required fields
    if (!issueId || !repoFullName || typeof issueNumber !== "number" || !agentName || typeof agentName !== "string") {
      return errorResponse("Missing required fields: issueId, repoFullName, issueNumber, agentName", 400);
    }

    // Fetch the issue from the local database to check its state and current labels
    const issue = await prisma.issue.findUnique({
      where: { id: issueId as string },
      include: { repository: true },
    });

    if (!issue) {
      return errorResponse("Issue not found in local cache", 404);
    }

    // Refuse closed issues
    if (issue.state === "closed") {
      return errorResponse("Cannot claim a closed issue", 400);
    }

    // Refuse done issues
    const currentStatus = issue.labels.find((l) => l.startsWith("status/"));
    if (currentStatus === "status/done") {
      return errorResponse("Cannot claim a done issue", 400);
    }

    // Check for active leases from OTHER agents — refuse unless force=true
    const activeLeases = await findActiveLeasesForIssue(issueId as string);
    const otherAgentLeases = activeLeases.filter((l) => l.agentName !== agentName);

    if (otherAgentLeases.length > 0 && force !== true) {
      return errorResponse(`Issue is actively leased to ${otherAgentLeases[0].agentName}. Use force=true to override.`, 409);
    }

    // Always clean up expired leases (stale recovery)
    const expiredCount = await releaseExpiredLeases(issueId as string);
    if (expiredCount > 0) {
      console.warn(`Released ${expiredCount} expired lease(s) for issue #${issueNumber}`);
    }

    // Clean up stale AgentWork records (no matching active Lease)
    const staleWorkCount = await findAndReleaseStaleAgentWorkForIssue(prisma, issueId as string, repoFullName as string);
    if (staleWorkCount > 0) {
      console.warn(`Released ${staleWorkCount} stale AgentWork record(s) for issue #${issueNumber}`);
    }

    // Analyze assignment conflicts using the shared conflict resolution module.
    // Passing this agent's own label makes a re-claim idempotent: an issue still
    // carrying agent/<this agent> is ours to take, not a conflict to 409 on.
    const analysis = analyzeAssignmentConflict(issue.labels, `${AGENT_PREFIX}${agentName}`);

    // Check for agent conflict — if another agent is assigned, require force-claim
    if (analysis.hasAgentConflict) {
      if (force === true) {
        // Force claim: remove the old agent label first
        try {
          await removeIssueLabel(repoFullName as string, issueNumber as number, analysis.existingAgents[0]);
        } catch (e) {
          console.error(`Failed to remove stale agent label ${analysis.existingAgents[0]} during force claim:`, e);
          // Non-fatal: continue with force claim even if label removal fails
        }
      } else {
        return errorResponse(`Issue is already assigned to ${analysis.existingAgents[0].replace("agent/", "")}. Use force=true to override.`, 409);
      }
    }

    // Build updated labels using the shared conflict resolution module
    const agentLabel = `agent/${agentName}`;
    const labelsWithAgent = buildNewLabels(issue.labels, "assign_agent", agentLabel);
    const updatedLabels = [...labelsWithAgent.filter((l) => !l.startsWith("status/")), IN_PROGRESS_STATUS];

    try {
      // Add agent label on GitHub
      await addIssueLabel(repoFullName as string, issueNumber as number, agentLabel);

      // Remove ALL existing status labels (not just the first) before adding
      // status/in-progress — keeps GitHub and the Prisma cache from
      // diverging when an issue carries more than one status label.
      await transitionIssueStatus(repoFullName as string, issueNumber as number, issue.labels, IN_PROGRESS_STATUS);

      // Update local cache
      await prisma.issue.update({
        where: { id: issueId as string },
        data: { labels: updatedLabels, lastSyncedAt: new Date() },
      });

      // Create or renew a lease for this agent (issue #166)
      await upsertLease({
        agentName: agentName as string,
        issueId: issueId as string,
        checkpoint: "issue_claimed",
      });

      // Write audit log with conflict analysis details
      const auditNotesParts: string[] = [];
      if (analysis.hasAgentConflict || analysis.hasOwnerConflict) {
        auditNotesParts.push(
          `conflict: agent=${analysis.hasAgentConflict}, owner=${analysis.hasOwnerConflict}`,
        );
        if (analysis.existingAgents.length > 0) {
          auditNotesParts.push(`existingAgents=[${analysis.existingAgents.join(", ")}]`);
        }
        if (analysis.existingOwners.length > 0) {
          auditNotesParts.push(`existingOwners=[${analysis.existingOwners.join(", ")}]`);
        }
      }
      if (force === true && analysis.hasAgentConflict) {
        auditNotesParts.push("force_claim=true");
      }

      await prisma.auditLog.create({
        data: {
          actor: agentName as string,
          action: "claim_issue",
          repoFullName: repoFullName as string,
          issueNumber: issueNumber as number,
          issueId: issueId as string,
          beforeLabels: issue.labels,
          afterLabels: updatedLabels,
          success: true,
          notes: auditNotesParts.length > 0 ? auditNotesParts.join(" | ") : undefined,
        },
      });

      return NextResponse.json({ success: true, labels: updatedLabels });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      // Write failure audit log
      await prisma.auditLog.create({
        data: {
          actor: agentName as string,
          action: "claim_issue",
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
    console.error("Claim issue failed:", error);
    return errorResponse("Failed to claim issue", 500);
  }
}
