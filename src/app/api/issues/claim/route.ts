import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { addIssueLabel, removeIssueLabel } from "@/lib/github";
import { analyzeAssignmentConflict, buildNewLabels } from "@/lib/assignment-conflicts";
import { authorizeRequest } from "@/lib/auth";
import { upsertLease, findActiveLeasesForIssue, releaseExpiredLeases } from "@/lib/lease";

const IN_PROGRESS_STATUS = "status/in-progress";

export async function POST(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (typeof body !== "object" || body === null) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { issueId, repoFullName, issueNumber, agentName, force } = body as Record<string, unknown>;

    // Validate required fields
    if (!issueId || !repoFullName || typeof issueNumber !== "number" || !agentName || typeof agentName !== "string") {
      return NextResponse.json({ error: "Missing required fields: issueId, repoFullName, issueNumber, agentName" }, { status: 400 });
    }

    // Fetch the issue from the local database to check its state and current labels
    const issue = await prisma.issue.findUnique({
      where: { id: issueId as string },
      include: { repository: true },
    });

    if (!issue) {
      return NextResponse.json({ error: "Issue not found in local cache" }, { status: 404 });
    }

    // Refuse closed issues
    if (issue.state === "closed") {
      return NextResponse.json({ error: "Cannot claim a closed issue" }, { status: 400 });
    }

    // Refuse done issues
    const currentStatus = issue.labels.find((l) => l.startsWith("status/"));
    if (currentStatus === "status/done") {
      return NextResponse.json({ error: "Cannot claim a done issue" }, { status: 400 });
    }

    // Check for active leases from OTHER agents — refuse unless force=true
    const activeLeases = await findActiveLeasesForIssue(issueId as string);
    const otherAgentLeases = activeLeases.filter((l) => l.agentName !== agentName);

    if (otherAgentLeases.length > 0 && force !== true) {
      return NextResponse.json(
        { error: `Issue is actively leased to ${otherAgentLeases[0].agentName}. Use force=true to override.` },
        { status: 409 },
      );
    }

    // Always clean up expired leases (stale recovery)
    const expiredCount = await releaseExpiredLeases(issueId as string);
    if (expiredCount > 0) {
      console.warn(`Released ${expiredCount} expired lease(s) for issue #${issueNumber}`);
    }

    // Analyze assignment conflicts using the shared conflict resolution module
    const analysis = analyzeAssignmentConflict(issue.labels);

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
        return NextResponse.json(
          { error: `Issue is already assigned to ${analysis.existingAgents[0].replace("agent/", "")}. Use force=true to override.` },
          { status: 409 },
        );
      }
    }

    // Build updated labels using the shared conflict resolution module
    const agentLabel = `agent/${agentName}`;
    const labelsWithAgent = buildNewLabels(issue.labels, "assign_agent", agentLabel);
    const updatedLabels = [...labelsWithAgent.filter((l) => !l.startsWith("status/")), IN_PROGRESS_STATUS];

    try {
      // Add agent label on GitHub
      await addIssueLabel(repoFullName as string, issueNumber as number, agentLabel);

      if (currentStatus && currentStatus !== IN_PROGRESS_STATUS) {
        await removeIssueLabel(repoFullName as string, issueNumber as number, currentStatus);
      }
      if (currentStatus !== IN_PROGRESS_STATUS) {
        await addIssueLabel(repoFullName as string, issueNumber as number, IN_PROGRESS_STATUS);
      }

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

      return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
  } catch (error) {
    console.error("Claim issue failed:", error);
    return NextResponse.json({ error: "Failed to claim issue" }, { status: 500 });
  }
}
