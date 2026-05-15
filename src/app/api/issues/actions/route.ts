import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { updateIssueLabels } from "@/lib/github";
import { analyzeAssignmentConflict, buildNewLabels } from "@/lib/assignment-conflicts";

type ActionPayload = {
  issueId?: string;
  repoFullName?: string;
  issueNumber?: number;
  action: "assign_agent" | "assign_owner";
  value: string;
  force_claim?: boolean;
};

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
    const expectedPrefix = payload.action === "assign_agent" ? "agent/" : "owner/";
    if (!payload.value.startsWith(expectedPrefix)) {
      return NextResponse.json(
        { error: `value must start with "${expectedPrefix}" (e.g. "${expectedPrefix}worker")` },
        { status: 400 },
      );
    }

    try {
      // Fetch current issue to get existing labels
      const issue = await prisma.issue.findUnique({ where: { id: issueId } });
      if (!issue) {
        return NextResponse.json({ error: `Issue not found: ${issueId}` }, { status: 404 });
      }

      const currentLabels = issue.labels;

      // Analyze conflicts using the shared conflict resolution module
      const analysis = analyzeAssignmentConflict(currentLabels);

      // Check for conflicts and log them in the audit trail
      if (payload.action === "assign_agent" && analysis.hasAgentConflict) {
        // Agent conflict detected — existing agent labels will be replaced
      }
      if (payload.action === "assign_owner" && analysis.hasOwnerConflict) {
        // Owner conflict detected — existing owner labels will be replaced
      }

      // Build new label set using the shared module
      const newLabels = buildNewLabels(currentLabels, payload.action, payload.value);

      // Update GitHub labels atomically via updateIssueLabels (replaces all)
      await updateIssueLabels(repoFullName, issueNumber, newLabels);

      // Update local cache
      await prisma.issue.update({
        where: { id: issueId },
        data: { labels: newLabels, lastSyncedAt: new Date() },
      });

      // Write audit log with conflict details
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
