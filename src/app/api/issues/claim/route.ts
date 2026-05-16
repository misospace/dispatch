import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { addIssueLabel, removeIssueLabel } from "@/lib/github";
import { AGENT_PREFIX } from "@/types";
import { resolveClaimConflict, getAgentFromLabels, isAdminAgent } from "@/lib/assignment-conflicts";

export async function POST(request: Request) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (token !== process.env.MISSION_CONTROL_AGENT_TOKEN) {
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

    const agentLabel = `${AGENT_PREFIX}${agentName}` as const;

    // Fetch the issue from the local database to check its state and current labels
    const issue = await prisma.issue.findUnique({
      where: { id: issueId as string },
      include: { repository: true },
    });

    if (!issue) {
      return NextResponse.json({ error: "Issue not found in local cache" }, { status: 404 });
    }

    // Resolve assignment conflict using the shared policy module
    const conflict = resolveClaimConflict(
      issue.labels,
      issue.state,
      agentName as string,
      force === true,
      isAdminAgent(agentName as string),
    );

    if (conflict.conflict !== "none") {
      return NextResponse.json({ error: conflict.reason }, { status: 409 });
    }

    // Determine if this is a force-claim (overriding another agent)
    const currentAgent = getAgentFromLabels(issue.labels);
    const isForceClaim = currentAgent && currentAgent !== agentLabel;

    if (isForceClaim && force === true) {
      // Force claim: remove the old agent label first
      try {
        await removeIssueLabel(repoFullName as string, issueNumber as number, currentAgent);
      } catch (e) {
        console.error(`Failed to remove stale agent label ${currentAgent} during force claim:`, e);
        // Non-fatal: continue with force claim even if label removal fails
      }
    }

    // Build updated labels list
    const updatedLabels = [...issue.labels];
    if (!updatedLabels.includes(agentLabel)) {
      updatedLabels.push(agentLabel);
    }

    // Optionally move to in-progress (unless force=false)
    const currentStatus = issue.labels.find((l) => l.startsWith("status/"));
    if (force !== false && !currentStatus) {
      const inProgressLabel = "status/in-progress";
      if (!updatedLabels.includes(inProgressLabel)) {
        updatedLabels.push(inProgressLabel);
      }
    }

    try {
      // Add labels on GitHub
      await addIssueLabel(repoFullName as string, issueNumber as number, agentLabel);

      // Optionally add status/in-progress label
      if (force !== false && !currentStatus) {
        await addIssueLabel(repoFullName as string, issueNumber as number, "status/in-progress");
      }

      // Update local cache
      await prisma.issue.update({
        where: { id: issueId as string },
        data: { labels: updatedLabels, lastSyncedAt: new Date() },
      });

      // Write audit log
      await prisma.auditLog.create({
        data: {
          actor: agentName as string,
          action: isForceClaim ? "force_claim_issue" : "claim_issue",
          repoFullName: repoFullName as string,
          issueNumber: issueNumber as number,
          issueId: issueId as string,
          beforeLabels: issue.labels,
          afterLabels: updatedLabels,
          success: true,
        },
      });

      return NextResponse.json({ success: true, labels: updatedLabels });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      // Write failure audit log
      await prisma.auditLog.create({
        data: {
          actor: agentName as string,
          action: isForceClaim ? "force_claim_issue" : "claim_issue",
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
