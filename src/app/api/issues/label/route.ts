import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, getAuthorizedActor } from "@/lib/auth";
import { addIssueLabel, removeIssueLabel } from "@/lib/github-issues";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 };

/**
 * POST /api/issues/label
 *
 * Applies (or, with `action: "remove"`, clears) a single label on an issue,
 * on GitHub and in the local cache.
 *
 * Payload (matches bridge/claim.py add_label / remove_label):
 *   { issueId, repoFullName, number, label, action?: "add" | "remove" }
 *
 * - Adding a label that is already present succeeds (idempotent — the bridge
 *   retries parks on later ticks).
 * - A label that does not exist in the repo is created by the GitHub API
 *   (POST /issues/{n}/labels auto-creates missing labels).
 * - An unknown issue returns 404 naming the issue.
 */
export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const limited = enforceRateLimit(`label:${auth.actor}`, RATE_LIMIT);
  if (limited) return limited;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("Invalid JSON body", 400);
    }

    if (typeof body !== "object" || body === null) {
      return errorResponse("Invalid JSON body", 400);
    }

    const { issueId, repoFullName, number, label, action, agentName, actor } =
      body as Record<string, unknown>;

    if (
      !issueId ||
      !repoFullName ||
      typeof number !== "number" ||
      typeof label !== "string" ||
      !label.trim()
    ) {
      return errorResponse(
        "Missing required fields: issueId, repoFullName, number, label",
        400,
      );
    }

    const op = action === "remove" ? "remove" : "add";
    const labelName = label.trim();

    const actorName = getAuthorizedActor(
      auth,
      request,
      (actor as string | undefined) ?? (agentName as string | undefined),
    );

    const issue = await prisma.issue.findUnique({
      where: { id: issueId as string },
      include: { repository: true },
    });

    if (!issue) {
      return errorResponse(
        `Issue not found in local cache: ${repoFullName}#${number} (issueId: ${issueId})`,
        404,
      );
    }

    const effectiveRepo = (issue.repository?.fullName ?? repoFullName) as string;
    const effectiveNumber = issue.number;

    let labelsToSet: string[];
    if (op === "add") {
      // Idempotent: skip the GitHub call if the label is already present.
      if (issue.labels.includes(labelName)) {
        labelsToSet = issue.labels;
      } else {
        // GitHub auto-creates a label that does not exist in the repo.
        await addIssueLabel(effectiveRepo, effectiveNumber, labelName);
        labelsToSet = [...issue.labels, labelName];
      }
    } else {
      // removeIssueLabel tolerates a 404 (label not present), so this is
      // idempotent as well.
      await removeIssueLabel(effectiveRepo, effectiveNumber, labelName);
      labelsToSet = issue.labels.filter((l) => l !== labelName);
    }

    await prisma.issue.update({
      where: { id: issueId as string },
      data: { labels: labelsToSet, lastSyncedAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        actor: actorName,
        action: op === "add" ? "add_label" : "remove_label",
        repoFullName: effectiveRepo,
        issueNumber: effectiveNumber,
        issueId: issueId as string,
        beforeLabels: issue.labels,
        afterLabels: labelsToSet,
        success: true,
      },
    });

    return NextResponse.json({
      success: true,
      action: op,
      label: labelName,
      labels: labelsToSet,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Set issue label failed:", error);
    return errorResponse(errorMessage, 500);
  }
}
