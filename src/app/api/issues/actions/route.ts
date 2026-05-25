import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { updateIssueLabels } from "@/lib/github";
import { analyzeAssignmentConflict, buildNewLabels } from "@/lib/assignment-conflicts";
import { AGENT_PREFIX, OWNER_PREFIX } from "@/types";
import { isAuthorized } from "@/lib/auth";

type ActionPayload = {
  issueId?: string;
  repoFullName?: string;
  issueNumber?: number;
  action: "assign_agent" | "assign_owner";
  value: string;
  force_claim?: boolean;
};

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

    const payload = body as ActionPayload;

    // Validate required fields
    if (!payload.action || payload.value == null) {
      return NextResponse.json({ error: "Missing required fields: action, value" }, { status: 400 });
    }

    if (payload.action !== "assign_agent" && payload.action !== "assign_owner") {
      return NextResponse.json(
        { error: `Invalid action: ${payload.action}. Allowed: assign_agent, assign_owner` },
        { status: 400 },
      );
    }

    if (typeof payload.value !== "string" || payload.value.length === 0) {
      return NextResponse.json({ error: "value must be a non-empty string" }, { status: 400 });
    }

    const { issueId, repoFullName, issueNumber } = payload;

    if (!issueId || !repoFullName || typeof issueNumber !== "number") {
      return NextResponse.json({ error: "Missing required fields: issueId, repoFullName, issueNumber" }, { status: 400 });
    }

    // Validate value format: must match agent/<name> or owner/<name>
    const expectedPrefix = payload.action === "assign_agent" ? AGENT_PREFIX : OWNER_PREFIX;
    if (!payload.value.startsWith(expectedPrefix)) {
      return NextResponse.json(
        { error: `value must start with "${expectedPrefix}" (e.g. "${expectedPrefix}worker")` },
        { status: 400 },
      );
    }

    try {
      // Fetch current issue to get existing labels and state
      const issue = await prisma.issue.findUnique({ where: { id: issueId } });
      if (!issue) {
        return NextResponse.json({ error: `Issue not found: ${issueId}` }, { status: 404 });
      }

      // Policy §1: agents may only claim open issues
      if (issue.state !== "open") {
        return NextResponse.json(
          { error: `Cannot assign to closed issue (state: ${issue.state})` },
          { status: 400 },
        );
      }

      const currentLabels = issue.labels;

      // Analyze conflicts using the shared conflict resolution module
      const analysis = analyzeAssignmentConflict(currentLabels);

      // Build new label set using the shared module
      const newLabels = buildNewLabels(currentLabels, payload.action, payload.value);

      // Update GitHub labels atomically via updateIssueLabels (replaces all)
      await updateIssueLabels(repoFullName, issueNumber, newLabels);

      // Update local cache
      await prisma.issue.update({
        where: { id: issueId },
        data: { labels: newLabels, lastSyncedAt: new Date() },
      });

      // Build audit log notes with conflict analysis and force_claim acknowledgment
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
      // Acknowledge force_claim flag in audit trail (policy §4)
      if (payload.force_claim === true) {
        auditNotesParts.push("force_claim=true (accepted per policy §4, no additional blocking applied)");
      }

      await prisma.auditLog.create({
        data: {
          actor: "user",
          action: payload.action,
          repoFullName,
          issueNumber,
          issueId,
          beforeLabels: currentLabels,
          afterLabels: newLabels,
          success: true,
          notes: auditNotesParts.length > 0 ? auditNotesParts.join(" | ") : undefined,
        },
      });

      return NextResponse.json({ success: true, labels: newLabels });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      // Write audit log even on failure
      try {
        const issue = await prisma.issue.findUnique({ where: { id: issueId } });
        const beforeLabels = issue?.labels ?? [];

        await prisma.auditLog.create({
          data: {
            actor: "user",
            action: payload.action,
            repoFullName: repoFullName!,
            issueNumber: issueNumber!,
            issueId,
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
    console.error("Assign agent/owner action failed:", error);
    return NextResponse.json({ error: "Failed to process action" }, { status: 500 });
  }
}
