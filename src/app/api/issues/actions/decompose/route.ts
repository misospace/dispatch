import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest } from "@/lib/auth";
import { resolveActor } from "@/lib/resolve-actor";

/**
 * Mark an issue as decomposed (escalated-lane audit parent tracking).
 *
 * This allows broad audit/umbrella issues to be marked as decomposed or
 * no longer actionable without closing child work. Follow-up issue URLs
 * can be linked to the parent issue so the queue endpoint can exclude them.
 *
 * No hardcoded agent names or repo names — applies uniformly.
 */
export async function POST(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
  }

  try {
    const body = await request.json();
    const { repo, issueNumber, decomposed, followUpUrls, note } = body;

    if (!repo || !issueNumber) {
      return errorResponse("Missing required fields: repo, issueNumber", 400);
    }

    if (typeof decomposed !== "boolean") {
      return errorResponse("Field 'decomposed' must be a boolean", 400);
    }

    // Resolve attribution actor
    const { actor, error: actorError } = resolveActor(body);
    if (actorError) {
      return errorResponse(actorError, 400);
    }

    // Parse repo as owner/repo format
    const parts = repo.split("/");
    if (parts.length !== 2) {
      return errorResponse("Invalid repo format. Expected 'owner/repo'", 400);
    }
    const [owner, name] = parts;

    // Find the issue in the database
    const issue = await prisma.issue.findFirst({
      where: {
        number: issueNumber,
        repository: {
          owner,
          name,
        },
      },
    });

    if (!issue) {
      return errorResponse(`Issue #${issueNumber} not found in ${repo}`, 404);
    }

    // Update decomposed state
    const updated = await prisma.issue.update({
      where: { id: issue.id },
      data: {
        decomposed,
        decomposedAt: decomposed ? new Date() : null,
        decomposedBy: decomposed ? actor : null,
        decomposedNote: note ?? null,
        followUpUrls: followUpUrls ?? [],
      },
    });

    // Log the action in audit trail
    await prisma.auditLog.create({
      data: {
        actor,
        action: decomposed ? "issue_decomposed" : "issue_reactivated",
        repoFullName: `${owner}/${name}`,
        issueNumber,
        issueId: issue.id,
        beforeLabels: [...issue.labels],
        afterLabels: [...issue.labels],
        success: true,
        notes: decomposed
          ? `Issue marked as decomposed. Note: ${note ?? "none"}. Follow-up URLs: ${(followUpUrls ?? []).join(", ")}`
          : `Issue reactivated (decomposed set to false)`,
      },
    });

    return NextResponse.json({
      success: true,
      issueId: updated.id,
      decomposed: updated.decomposed,
      decomposedAt: updated.decomposedAt,
      followUpUrls: updated.followUpUrls,
    }, { status: 200 });
  } catch (error) {
    return handleApiError("update decomposed state", error);
  }
}
