import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { removeIssueLabel, addIssueLabel } from "@/lib/github";
import { STATUS_LABELS, StatusLabel } from "@/types";
import { isAuthorized } from "@/lib/auth";

function isStatusLabel(label: string): label is StatusLabel {
  return (STATUS_LABELS as readonly string[]).includes(label);
}

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

    const { issueId, repoFullName, issueNumber, status, agentName, actor } = body as Record<string, unknown>;

    if (!issueId || !repoFullName || typeof issueNumber !== "number" || typeof status !== "string") {
      return NextResponse.json(
        { error: "Missing required fields: issueId, repoFullName, issueNumber, status" },
        { status: 400 },
      );
    }

    const targetLabel = `status/${status}` as StatusLabel;
    if (!isStatusLabel(targetLabel)) {
      return NextResponse.json(
        { error: `Invalid status label: ${status}. Allowed: ${STATUS_LABELS.join(", ")}` },
        { status: 400 },
      );
    }

    const actorName = (actor as string | undefined) ?? (agentName as string | undefined) ?? "unknown";

    try {
      const issue = await prisma.issue.findUnique({
        where: { id: issueId as string },
        include: { repository: true },
      });

      if (!issue) {
        return NextResponse.json({ error: "Issue not found in local cache" }, { status: 404 });
      }

      // Find existing status label to remove
      const existingStatus = issue.labels.find((l) => l.startsWith("status/"));
      const labelsToSet = existingStatus && existingStatus !== targetLabel
        ? issue.labels.filter((l) => !l.startsWith("status/"))
        : [...issue.labels];

      if (existingStatus !== targetLabel) {
        labelsToSet.push(targetLabel);
      }

      // Update GitHub labels
      const effectiveRepo = (issue.repository?.fullName ?? repoFullName) as string;
      const effectiveNumber = issue.number;

      if (existingStatus && existingStatus !== targetLabel) {
        await removeIssueLabel(effectiveRepo, effectiveNumber, existingStatus);
      }

      if (existingStatus !== targetLabel) {
        await addIssueLabel(effectiveRepo, effectiveNumber, targetLabel);
      }

      // Update local cache
      await prisma.issue.update({
        where: { id: issueId as string },
        data: { labels: labelsToSet, lastSyncedAt: new Date() },
      });

      // Write audit log
      await prisma.auditLog.create({
        data: {
          actor: actorName,
          action: "set_status",
          repoFullName: effectiveRepo,
          issueNumber: effectiveNumber,
          issueId: issueId as string,
          beforeLabels: issue.labels,
          afterLabels: labelsToSet,
          success: true,
        },
      });

      return NextResponse.json({ success: true, status: targetLabel, labels: labelsToSet });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      await prisma.auditLog.create({
        data: {
          actor: actorName,
          action: "set_status",
          repoFullName: repoFullName as string,
          issueNumber: issueNumber as number,
          issueId: issueId as string,
          beforeLabels: [],
          afterLabels: [],
          success: false,
          errorMessage,
        },
      });

      return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
  } catch (error) {
    console.error("Set issue status failed:", error);
    return NextResponse.json({ error: "Failed to set issue status" }, { status: 500 });
  }
}
