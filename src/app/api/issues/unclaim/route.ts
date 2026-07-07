import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { removeIssueLabel, updateIssueLabels } from "@/lib/github";
import { getAgentFromLabels, AGENT_PREFIX } from "@/types";
import { authorizeRequest, getAuthorizedActor } from "@/lib/auth";

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
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
    const actor = getAuthorizedActor(auth, request, agentName as string);
    const isAgentSelfUnclaim = auth.type === "bearer" && actor === agentName;
    const auditAction = isAgentSelfUnclaim ? "unclaim_issue" : "unclaim_issue_by_operator";

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
      // Compute the new label set: drop the agent label; if status/in-progress,
      // flip to status/ready so the issue leaves the In Progress column.
      let updatedLabels = issue.labels.filter((l) => l !== agentLabel);
      const hadInProgress = updatedLabels.includes("status/in-progress");
      if (hadInProgress) {
        updatedLabels = updatedLabels.filter((l) => l !== "status/in-progress");
        if (!updatedLabels.includes("status/ready")) {
          updatedLabels.push("status/ready");
        }
      }

      // Apply label changes to GitHub. updateIssueLabels handles conflicts and
      // re-applies all non-status labels and adds status/ready in one shot.
      await updateIssueLabels(
        repoFullName as string,
        issueNumber as number,
        updatedLabels,
      );
      // Also remove the agent/* label (updateIssueLabels already drops it from
      // the list, but call removeIssueLabel defensively to mirror agent path).
      await removeIssueLabel(repoFullName as string, issueNumber as number, agentLabel);

      // Update local cache
      await prisma.issue.update({
        where: { id: issueId as string },
        data: { labels: updatedLabels, lastSyncedAt: new Date() },
      });

      // Release the lease (issue #166)
      await releaseLeaseByAgent(issueId as string, agentName as string);

      // For the operator path, release any AgentWork records for this agent+issue.
      if (!isAgentSelfUnclaim) {
        await releaseAgentWork(issueId as string, agentName as string, actor);
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

/**
 * Mark AgentWork records for this agent+issue as RELEASED with a
 * `released_by_operator` history entry. Used by the operator-unclaim path.
 */
async function releaseAgentWork(issueId: string, agentName: string, actor: string): Promise<void> {
  const works = await prisma.agentWork.findMany({
    where: { issueId, agentName },
  });
  const now = new Date();
  for (const work of works) {
    const existing = (work as unknown as { history?: unknown[] }).history;
    const history: unknown[] = Array.isArray(existing) ? [...existing] : [];
    history.push({
      kind: "released_by_operator",
      actor,
      at: now.toISOString(),
    });
    await prisma.agentWork.update({
      where: { id: work.id },
      data: {
        status: "RELEASED",
        history: history as unknown as object,
        completedAt: now,
      } as never,
    });
  }
}