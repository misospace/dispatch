import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { updateIssueLabels, removeIssueLabel, addIssueLabel } from "@/lib/github";
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

    const { issueId, repoFullName, issueNumber, oldLabels, newLabels, actor: bodyActor } = body as Record<string, unknown>;
    const moveActor = typeof bodyActor === "string" ? bodyActor : "agent";

    // Validate required fields with explicit type checks
    if (!issueId || !repoFullName || typeof issueNumber !== "number" || !oldLabels || !newLabels) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Validate status labels are from the allowed set
    const oldStatusLabel = (oldLabels as string[]).find((l: string) => l.startsWith("status/"));
    const newStatusLabel = (newLabels as string[]).find((l: string) => l.startsWith("status/"));

    if (oldStatusLabel && !isStatusLabel(oldStatusLabel)) {
      return NextResponse.json(
        { error: `Invalid status label: ${oldStatusLabel}. Allowed: ${STATUS_LABELS.join(", ")}` },
        { status: 400 },
      );
    }

    if (newStatusLabel && !isStatusLabel(newStatusLabel)) {
      return NextResponse.json(
        { error: `Invalid status label: ${newStatusLabel}. Allowed: ${STATUS_LABELS.join(", ")}` },
        { status: 400 },
      );
    }

    try {
      const labelsToRemove = oldStatusLabel && oldStatusLabel !== newStatusLabel ? [oldStatusLabel] : [];
      const labelsToAdd = newStatusLabel && oldStatusLabel !== newStatusLabel ? [newStatusLabel] : [];

      for (const label of labelsToRemove) {
        await removeIssueLabel(repoFullName as string, issueNumber as number, label);
      }

      for (const label of labelsToAdd) {
        await addIssueLabel(repoFullName as string, issueNumber as number, label);
      }

      const issue = await prisma.issue.findUnique({ where: { id: issueId as string } });
      if (issue) {
        await prisma.issue.update({
          where: { id: issueId as string },
          data: { labels: newLabels as string[], lastSyncedAt: new Date() },
        });
      }

      await prisma.auditLog.create({
        data: {
          actor: moveActor,
          action: "move_issue",
          repoFullName: repoFullName as string,
          issueNumber: issueNumber as number,
          issueId: issueId as string,
          beforeLabels: oldLabels as string[],
          afterLabels: newLabels as string[],
          success: true,
        },
      });

      return NextResponse.json({ success: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      await prisma.auditLog.create({
        data: {
          actor: moveActor,
          action: "move_issue",
          repoFullName: repoFullName as string,
          issueNumber: issueNumber as number,
          issueId: issueId as string,
          beforeLabels: oldLabels as string[],
          afterLabels: newLabels as string[],
          success: false,
          errorMessage,
        },
      });

      return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
  } catch (error) {
    console.error("Move issue failed:", error);
    return NextResponse.json({ error: "Failed to move issue" }, { status: 400 });
  }
}
