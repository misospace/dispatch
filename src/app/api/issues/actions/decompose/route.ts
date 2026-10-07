import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { setDecompositionState } from "@/lib/decomposition";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { resolveActor } from "@/lib/resolve-actor";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 } as const;

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
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`route:issues/actions/decompose:${auth.actor}`, RATE_LIMIT);
  if (limited) return limited;

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

    // Persist the decomposition state and its audit entry through the shared
    // helper, so the operator route and the hosted groomer write it identically
    // (dispatch#1066).
    await setDecompositionState(prisma, {
      issue: { id: issue.id, labels: issue.labels },
      repoFullName: `${owner}/${name}`,
      issueNumber,
      actor,
      decomposed,
      note: note ?? null,
      followUpUrls: followUpUrls ?? [],
    });

    // Re-read the issue so the response reflects the persisted state.
    const updated = await prisma.issue.findUnique({ where: { id: issue.id } });

    return NextResponse.json({
      success: true,
      issueId: updated?.id ?? issue.id,
      decomposed: updated?.decomposed ?? decomposed,
      decomposedAt: updated?.decomposedAt ?? null,
      followUpUrls: updated?.followUpUrls ?? (followUpUrls ?? []),
    }, { status: 200 });
  } catch (error) {
    return handleApiError("update decomposed state", error);
  }
}
