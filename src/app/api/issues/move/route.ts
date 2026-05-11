import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { updateIssueLabels, removeIssueLabel, addIssueLabel } from "@/lib/github";
import { STATUS_LABELS } from "@/types";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { issueId, repoFullName, issueNumber, oldLabels, newLabels } = body;

    if (!issueId || !repoFullName || !issueNumber === undefined || !oldLabels || !newLabels) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const oldStatusLabel = oldLabels.find((l: string) => l.startsWith("status/"));
    const newStatusLabel = newLabels.find((l: string) => l.startsWith("status/"));

    try {
      const labelsToRemove = oldStatusLabel && oldStatusLabel !== newStatusLabel ? [oldStatusLabel] : [];
      const labelsToAdd = newStatusLabel && oldStatusLabel !== newStatusLabel ? [newStatusLabel] : [];

      for (const label of labelsToRemove) {
        await removeIssueLabel(repoFullName, issueNumber, label);
      }

      for (const label of labelsToAdd) {
        await addIssueLabel(repoFullName, issueNumber, label);
      }

      const issue = await prisma.issue.findUnique({ where: { id: issueId } });
      if (issue) {
        await prisma.issue.update({
          where: { id: issueId },
          data: { labels: newLabels, lastSyncedAt: new Date() },
        });
      }

      await prisma.auditLog.create({
        data: {
          actor: "user",
          action: "move_issue",
          repoFullName,
          issueNumber,
          issueId,
          beforeLabels: oldLabels,
          afterLabels: newLabels,
          success: true,
        },
      });

      return NextResponse.json({ success: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      await prisma.auditLog.create({
        data: {
          actor: "user",
          action: "move_issue",
          repoFullName,
          issueNumber,
          issueId,
          beforeLabels: oldLabels,
          afterLabels: newLabels,
          success: false,
          errorMessage,
        },
      });

      return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
  } catch (error) {
    console.error("Move issue failed:", error);
    return NextResponse.json({ error: "Failed to move issue" }, { status: 500 });
  }
}