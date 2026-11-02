import { NextResponse } from "next/server";
import { errorResponse, readJsonObjectBody } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, getAuthorizedActor, authErrorResponse } from "@/lib/auth";
import { addIssueComment } from "@/lib/github-issues";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 };

/**
 * POST /api/issues/comment
 *
 * Posts a comment on an issue via the GitHub API.
 *
 * Payload (matches bridge/claim.py comment):
 *   { issueId, repoFullName, issueNumber, body }
 *
 * - `body` must be non-empty.
 * - An unknown issue returns 404 naming the issue.
 */
export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`comment:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  try {
    const parsed = await readJsonObjectBody(request);
    if ("error" in parsed) return parsed.error;
    const { issueId, repoFullName, issueNumber, body, agentName, actor } =
      parsed.body;

    if (
      !issueId ||
      !repoFullName ||
      typeof issueNumber !== "number" ||
      typeof body !== "string" ||
      !body.trim()
    ) {
      return errorResponse(
        "Missing required fields: issueId, repoFullName, issueNumber, body",
        400,
      );
    }

    const commentBody = body;

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

    const result = await addIssueComment(
      effectiveRepo,
      effectiveNumber,
      commentBody,
    );

    await prisma.issue.update({
      where: { id: issueId as string },
      data: { lastSyncedAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        actor: actorName,
        action: "add_comment",
        repoFullName: effectiveRepo,
        issueNumber: effectiveNumber,
        issueId: issueId as string,
        notes: commentBody,
        success: true,
      },
    });

    return NextResponse.json({
      success: true,
      url: result.url,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Add issue comment failed:", error);
    return errorResponse(errorMessage, 500);
  }
}