import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { authorizeRequest, getAuthorizedActor, type AuthorizedRequest, authErrorResponse } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  clearNoPrConclusionPark,
  getNoPrConclusionMode,
  noPrConclusionIsLive,
} from "@/lib/no-pr-conclusion";

const RATE_LIMIT = { limit: 10, windowMs: 10_000 };

/**
 * The park exists to stop autonomous workers from re-offering work they have
 * already concluded needs no PR, so an agent bearer token (DISPATCH_AGENT_TOKEN,
 * held by every worker) must not be able to clear it. Only operator auth paths
 * qualify: an OIDC session, basic auth, or auth-disabled mode — the same
 * auth-type split admission-override uses (#1065).
 */
function rejectAgentCaller(auth: AuthorizedRequest) {
  if (auth.authorized && auth.type === "bearer") {
    return errorResponse(
      "Clearing a no-PR conclusion park requires operator auth (OIDC session or basic auth); agent bearer tokens cannot clear it",
      403,
    );
  }
  return null;
}

/**
 * GET /api/issues/[issueId]/no-pr-conclusion — read-only diagnostics: whether
 * the issue carries a stored terminal no-PR conclusion park, whether that park
 * is still LIVE (content fingerprint unexpired), and the rollout mode. Any
 * authorized caller, including agent bearer tokens — this endpoint mutates
 * nothing.
 */
export async function GET(request: Request, context: { params: Promise<{ issueId: string }> }) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) return authErrorResponse(auth);

  try {
    const { issueId } = await context.params;
    const issue = await prisma.issue.findUnique({ where: { id: issueId } });
    if (!issue) return errorResponse("Issue not found in local cache", 404);

    const stored = await prisma.noPrConclusion.findUnique({ where: { issueId: issue.id } });

    return NextResponse.json({
      park: stored
        ? {
            agentName: stored.agentName,
            outcome: stored.outcome,
            summary: stored.summary,
            evidence: stored.evidence,
            parkedAt: stored.createdAt.toISOString(),
          }
        : null,
      live: stored ? noPrConclusionIsLive(stored, issue) : false,
      mode: getNoPrConclusionMode(),
    });
  } catch (error) {
    return handleApiError("read no-PR conclusion park", error);
  }
}

/**
 * DELETE /api/issues/[issueId]/no-pr-conclusion — clear the stored terminal
 * no-PR conclusion park on this issue so it can be re-offered. Operator auth
 * only (agent bearer tokens get 403). Idempotent: clearing an issue with no
 * park row succeeds with `cleared: false`. The clearance records a
 * conclusion_cleared lifecycle event (quiet, inside the library) and an audit
 * row capturing the park's provenance as read just before the clear.
 */
export async function DELETE(request: Request, context: { params: Promise<{ issueId: string }> }) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) return authErrorResponse(auth);
  const forbidden = rejectAgentCaller(auth);
  if (forbidden) return forbidden;

  const limited = enforceRateLimit(`no-pr-conclusion:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  try {
    const { issueId } = await context.params;
    const actor = getAuthorizedActor(auth, request);
    const issue = await prisma.issue.findUnique({ where: { id: issueId }, include: { repository: true } });
    if (!issue) return errorResponse("Issue not found in local cache", 404);

    // Provenance for the audit row, read before the clear. Tolerant of a race
    // in either direction: a concurrent clear landing first just makes the
    // clear below a no-op, and a concurrent re-park means the notes describe
    // the park that was actually retired, not the one that re-landed.
    const parked = await prisma.noPrConclusion.findUnique({ where: { issueId: issue.id } });

    const cleared = await clearNoPrConclusionPark({
      issueId: issue.id,
      repoFullName: issue.repository.fullName,
      issueNumber: issue.number,
      actor,
      source: "api:no-pr-conclusion",
      reason: "operator clear",
    });

    await prisma.auditLog.create({
      data: {
        actor,
        action: "no_pr_conclusion_cleared",
        repoFullName: issue.repository.fullName,
        issueNumber: issue.number,
        issueId: issue.id,
        beforeLabels: issue.labels,
        afterLabels: issue.labels,
        success: true,
        notes: JSON.stringify({
          cleared,
          parkedBy: parked?.agentName ?? null,
          parkedOutcome: parked?.outcome ?? null,
          authType: auth.type,
        }),
      },
    });

    return NextResponse.json({ success: true, cleared });
  } catch (error) {
    return handleApiError("clear no-PR conclusion park", error);
  }
}
