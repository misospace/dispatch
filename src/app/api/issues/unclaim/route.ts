import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { removeIssueLabel } from "@/lib/github";
import { getAgentFromLabels, AGENT_PREFIX } from "@/types";
import { isAuthorized } from "@/lib/auth";
import { releaseLease } from "@/lib/lease";

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
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

    const { issueId, repoFullName, issueNumber, agentName } = body as Record<string, unknown>;

    // Validate required fields
    if (!issueId || !repoFullName || typeof issueNumber !== "number" || !agentName || typeof agentName !== "string") {
      return NextResponse.json({ error: "Missing required fields: issueId, repoFullName, issueNumber, agentName" }, { status: 400 });
    }

    const agentLabel = `${AGENT_PREFIX}${agentName}` as const;

    // Fetch the issue from the local database to get current labels
    const issue = await prisma.issue.findUnique({
      where: { id: issueId as string },
      include: { repository: true },
    });

    if (!issue) {
      return NextResponse.json({ error: "Issue not found in local cache" }, { status: 404 });
    }

    // Refuse closed issues
    if (issue.state === "closed") {
      return NextResponse.json({ error: "Cannot unclaim a closed issue" }, { status: 400 });
    }

    // Refuse done issues
    const currentStatus = issue.labels.find((l) => l.startsWith("status/"));
    if (currentStatus === "status/done") {
      return NextResponse.json({ error: "Cannot unclaim a done issue" }, { status: 400 });
    }

    // Check if the agent is actually assigned
    const currentAgent = getAgentFromLabels(issue.labels);
    if (!currentAgent || currentAgent !== agentLabel) {
      return NextResponse.json(
        { error: `Issue is not assigned to ${agentName}` },
        { status: 400 },
      );
    }

    try {
      // Remove the agent label from GitHub
      await removeIssueLabel(repoFullName as string, issueNumber as number, agentLabel);

      // Update local cache
      const updatedLabels = issue.labels.filter((l) => l !== agentLabel);
      await prisma.issue.update({
        where: { id: issueId as string },
        data: { labels: updatedLabels, lastSyncedAt: new Date() },
      });

      // Release the lease (issue #166)
      await releaseLeaseByAgent(issueId as string, agentName as string);

      // Write audit log
      await prisma.auditLog.create({
        data: {
          actor: agentName as string,
          action: "unclaim_issue",
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
          action: "unclaim_issue",
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
    console.error("Unclaim issue failed:", error);
    return NextResponse.json({ error: "Failed to unclaim issue" }, { status: 500 });
  }
}

/**
 * Release the lease for a specific agent on an issue.
 */
async function releaseLeaseByAgent(issueId: string, agentName: string): Promise<void> {
  const lease = await prisma.lease.findUnique({
    where: { agentName_issueId: { agentName, issueId } },
  });
  if (lease) {
    await prisma.lease.delete({ where: { id: lease.id } });
  }
}
