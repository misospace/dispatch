import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { updateIssueLabels } from "@/lib/github";
import { AGENT_PREFIX, OWNER_PREFIX } from "@/types";

type UnassignPayload = {
  issueId: string;
  repoFullName: string;
  issueNumber: number;
  action: "unassign_agent" | "unassign_owner";
};

function isAgentLabel(label: string): boolean {
  return label.startsWith(AGENT_PREFIX);
}

function isOwnerLabel(label: string): boolean {
  return label.startsWith(OWNER_PREFIX);
}

/**
 * POST /api/issues/unassign
 * Removes the agent or owner assignment from an issue.
 * - unassign_agent: removes all agent/* labels
 * - unassign_owner: removes all owner/* labels
 */
export async function POST(request: Request) {
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

    const payload = body as UnassignPayload;

    if (!payload.action || !payload.issueId || !payload.repoFullName || typeof payload.issueNumber !== "number") {
      return NextResponse.json(
        { error: "Missing required fields: action, issueId, repoFullName, issueNumber" },
        { status: 400 }
      );
    }

    if (payload.action !== "unassign_agent" && payload.action !== "unassign_owner") {
      return NextResponse.json(
        { error: `Invalid action: ${payload.action}. Allowed: unassign_agent, unassign_owner` },
        { status: 400 }
      );
    }

    const isConflicting = payload.action === "unassign_agent" ? isAgentLabel : isOwnerLabel;

    try {
      const issue = await prisma.issue.findUnique({ where: { id: payload.issueId } });
      if (!issue) {
        return NextResponse.json({ error: `Issue not found: ${payload.issueId}` }, { status: 404 });
      }

      const currentLabels = issue.labels;
      const labelsToRemove = currentLabels.filter(isConflicting);

      if (labelsToRemove.length === 0) {
        return NextResponse.json({ error: `No ${payload.action === "unassign_agent" ? "agent" : "owner"} label found on this issue` }, { status: 400 });
      }

      const newLabels = currentLabels.filter((l) => !isConflicting(l));

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
          actor: "user",
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
            actor: "user",
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

      return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
  } catch (error) {
    console.error("Unassign action failed:", error);
    return NextResponse.json({ error: "Failed to process unassign" }, { status: 500 });
  }
}
