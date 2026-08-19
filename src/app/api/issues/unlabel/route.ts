import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, getAuthorizedActor } from "@/lib/auth";
import { removeIssueLabel } from "@/lib/github-issues";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 };

/**
 * POST /api/issues/unlabel
 *
 * Removes a label from an issue on GitHub and in the local cache.
 *
 * Payload (matches bridge/claim.py remove_label):
 *   { issueId, repoFullName, issueNumber, label }
 *
 * - Removing a label that is not present is idempotent (removeIssueLabel
 *   tolerates a 404 from the GitHub API for missing labels).
 * - An unknown issue returns 404 naming the issue.
 */
export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const limited = enforceRateLimit(`unlabel:${auth.actor}`, RATE_LIMIT);
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

    const { issueId, repoFullName, issueNumber, label, agentName, actor } =
      body as Record<string, unknown>;

    if (
      !issueId ||
      !repoFullName ||
      typeof issueNumber !== "number" ||
      typeof label !== "string" ||
      !label.trim()
    ) {
      return errorResponse(
        "Missing required fields: issueId, repoFullName, issueNumber, label",
        400,
      );
    }

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
        `Issue not found in local cache: ${repoFullName}#${issueNumber} (issueId: ${issueId})`,
        404,
      );
    }

    const effectiveRepo = (issue.repository?.fullName ?? repoFullName) as string;
    const effectiveNumber = issue.number;

    // removeIssueLabel tolerates a 404 (label not present), so this is
    // idempotent.
    await removeIssueLabel(effectiveRepo, effectiveNumber, labelName);
    const labelsToSet = issue.labels.filter((l) => l !== labelName);

    await prisma.issue.update({
      where: { id: issueId as string },
      data: { labels: labelsToSet, lastSyncedAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        actor: actorName,
        action: "remove_label",
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
      label: labelName,
      labels: labelsToSet,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Remove issue label failed:", error);
    return errorResponse(errorMessage, 500);
  }
}