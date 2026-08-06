import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { authorizeRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Read a PR-fix item's audit trail: `GET /api/pr-fix-queue/history?repo=o/n&pr=N`.
 *
 * Every enqueue and status transition already writes a `PrFixHistory` row, but
 * nothing could read them back, so answering "why did this item change?" meant
 * grepping pod logs — and those are gone the moment the pod restarts. A PR merged
 * in May received a BLOCKED notification in August, and the triggering transition
 * was unrecoverable for exactly that reason.
 *
 * Also accepts `?limit=` (default 50, max 200) and returns rows newest-first
 * alongside the item's current state, so one call answers what the item is now and
 * how it got there.
 *
 * Returns 404 when no item exists for that repo/PR — an item can be pruned while
 * its PR lives on, and that is a different answer from "no history".
 */
export async function GET(request: Request) {
  if (!(await authorizeRequest(request)).authorized) {
    return errorResponse("Unauthorized", 401);
  }

  const { searchParams } = new URL(request.url);
  const repo = searchParams.get("repo")?.trim();
  const prRaw = searchParams.get("pr")?.trim();
  const limitRaw = searchParams.get("limit")?.trim();

  if (!repo || !prRaw) {
    return errorResponse("Missing required query parameters: repo, pr", 400);
  }

  const pr = Number(prRaw);
  if (!Number.isInteger(pr) || pr <= 0) {
    return errorResponse(`Invalid pr: ${prRaw}`, 400);
  }

  let limit = DEFAULT_LIMIT;
  if (limitRaw) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return errorResponse(`Invalid limit: ${limitRaw}`, 400);
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  try {
    const item = await prisma.prFixQueueItem.findUnique({
      where: { repo_pr: { repo, pr } },
    });

    if (!item) {
      return errorResponse(`No PR-fix item for ${repo}#${pr}`, 404);
    }

    const history = await prisma.prFixHistory.findMany({
      where: { itemId: item.id },
      orderBy: { at: "desc" },
      take: limit,
    });

    return NextResponse.json({
      item: {
        id: item.id,
        repo: item.repo,
        pr: item.pr,
        lane: item.lane,
        status: item.status,
        type: item.type,
        reason: item.reason,
        queuedAt: item.queuedAt,
        updatedAt: item.updatedAt,
      },
      history: history.map((h) => ({
        at: h.at,
        action: h.action,
        status: h.status,
        reason: h.reason,
        note: h.note,
        evidenceKey: h.evidenceKey,
      })),
    });
  } catch (error) {
    return handleApiError("fetch pr-fix history", error);
  }
}
