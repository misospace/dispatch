import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { authorizeRequest, getAuthorizedActor, type AuthorizedRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { enforceRateLimit } from "@/lib/rate-limit";
import { fetchLatestCommit } from "@/lib/github-ci";
import { fetchRepositoryMetadata } from "@/lib/github-code-search";
import { findOpenIssueKeys } from "@/lib/issue-dependency-annotation";
import {
  buildAdmissionOverrideData,
  clearAdmissionOverrideData,
  isValidOverrideHeadSha,
  MAX_OVERRIDE_REASON_LENGTH,
  overrideDependencyNumbers,
} from "@/lib/admission-override";

const RATE_LIMIT = { limit: 10, windowMs: 10_000 };

/**
 * The override exists to let a human admit work past the gate that stops
 * autonomous workers, so an agent bearer token (DISPATCH_AGENT_TOKEN, held by
 * every worker) must not be able to record or clear one. Only operator auth
 * paths qualify: an OIDC session, basic auth, or auth-disabled mode, the same
 * auth-type split pr-fix-queue/mark uses (#1074/#1079).
 */
function rejectAgentCaller(auth: AuthorizedRequest) {
  if (auth.authorized && auth.type === "bearer") {
    return errorResponse(
      "Admission overrides require operator auth (OIDC session or basic auth); agent bearer tokens cannot record or clear them",
      403,
    );
  }
  return null;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/issues/[issueId]/admission-override — record an explicit operator
 * override that admits this status/ready issue to the worker queue under
 * DISPATCH_QUEUE_ADMISSION_MODE=enforce without a grooming decision (#1065).
 *
 * Operator auth only: agent bearer tokens get 403.
 * Body (all optional): { reason?: string, headSha?: string (40-hex) }. The
 * actor is the authenticated operator.
 * Without headSha the live default-branch head is resolved from GitHub. The
 * override is bound to the cached issue state and that SHA, and goes stale
 * like a grooming result. It never bypasses a `depends on #N` blocker.
 */
export async function POST(request: Request, context: { params: Promise<{ issueId: string }> }) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) return errorResponse("Unauthorized", 401);
  const forbidden = rejectAgentCaller(auth);
  if (forbidden) return forbidden;

  const limited = enforceRateLimit(`admission-override:${auth.actor}`, RATE_LIMIT);
  if (limited) return limited;

  try {
    const { issueId } = await context.params;
    const body = await readBody(request);
    if (body === null) return errorResponse("Invalid JSON body", 400);

    const { reason, headSha } = body;
    if (reason !== undefined && reason !== null && typeof reason !== "string") {
      return errorResponse("'reason' must be a string", 400);
    }
    if (typeof reason === "string" && reason.length > MAX_OVERRIDE_REASON_LENGTH) {
      return errorResponse(`'reason' must be at most ${MAX_OVERRIDE_REASON_LENGTH} characters`, 400);
    }
    if (headSha !== undefined && !isValidOverrideHeadSha(headSha)) {
      return errorResponse("'headSha' must be a full 40-character commit SHA", 400);
    }
    const actorName = getAuthorizedActor(auth, request);

    const issue = await prisma.issue.findUnique({ where: { id: issueId }, include: { repository: true } });
    if (!issue) return errorResponse("Issue not found in local cache", 404);
    if (issue.state !== "open") return errorResponse("Only open issues can be admitted", 409);
    if (!issue.labels.includes("status/ready")) {
      return errorResponse(
        "The override is bound to the issue's current state, so it must already be status/ready (move it first, then override)",
        409,
      );
    }

    const repoFullName = issue.repository.fullName;
    let defaultBranch: string;
    let resolvedHead: string | null;
    try {
      defaultBranch = (await fetchRepositoryMetadata(repoFullName)).defaultBranch;
      resolvedHead = typeof headSha === "string" ? headSha : ((await fetchLatestCommit(repoFullName, defaultBranch))?.sha ?? null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(`Could not resolve the default-branch head for ${repoFullName}: ${message}`, 502);
    }
    if (!resolvedHead) {
      return errorResponse(`Could not resolve the default-branch head for ${repoFullName}; pass headSha`, 502);
    }

    const overrideIssue = {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels,
      commentsCount: issue.commentsCount,
      repoFullName,
    };
    const openDependencyKeys = await findOpenIssueKeys(overrideDependencyNumbers(overrideIssue));
    const data = buildAdmissionOverrideData(overrideIssue, {
      actor: actorName,
      reason: typeof reason === "string" ? reason : null,
      headSha: resolvedHead,
      defaultBranch,
      openDependencyKeys,
      now: new Date(),
    });

    await prisma.$transaction([
      prisma.issue.update({ where: { id: issue.id }, data }),
      prisma.auditLog.create({
        data: {
          actor: actorName,
          action: "admission_override",
          repoFullName,
          issueNumber: issue.number,
          issueId: issue.id,
          beforeLabels: issue.labels,
          afterLabels: issue.labels,
          success: true,
          notes: JSON.stringify({
            overrideId: data.admissionOverrideId,
            reason: data.admissionOverrideReason,
            headSha: resolvedHead,
            defaultBranch,
            authType: auth.type,
            replacedGroomedRunId: issue.groomedRunId,
          }),
        },
      }),
    ]);

    return NextResponse.json({
      success: true,
      override: {
        id: data.admissionOverrideId,
        actor: actorName,
        at: data.admissionOverrideAt,
        reason: data.admissionOverrideReason,
        headSha: resolvedHead,
        defaultBranch,
      },
    });
  } catch (error) {
    return handleApiError("record admission override", error);
  }
}

/**
 * DELETE /api/issues/[issueId]/admission-override — clear the override. If it
 * is still the freshness baseline, freshness returns to unknown. Operator auth
 * only, like POST.
 */
export async function DELETE(request: Request, context: { params: Promise<{ issueId: string }> }) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) return errorResponse("Unauthorized", 401);
  const forbidden = rejectAgentCaller(auth);
  if (forbidden) return forbidden;

  const limited = enforceRateLimit(`admission-override:${auth.actor}`, RATE_LIMIT);
  if (limited) return limited;

  try {
    const { issueId } = await context.params;
    const actorName = getAuthorizedActor(auth, request);
    const issue = await prisma.issue.findUnique({ where: { id: issueId }, include: { repository: true } });
    if (!issue) return errorResponse("Issue not found in local cache", 404);
    if (!issue.admissionOverrideId) return NextResponse.json({ success: true, cleared: false });

    const wasBaseline = issue.groomedRunId === issue.admissionOverrideId;
    await prisma.$transaction([
      prisma.issue.update({ where: { id: issue.id }, data: clearAdmissionOverrideData(issue) }),
      prisma.auditLog.create({
        data: {
          actor: actorName,
          action: "admission_override_cleared",
          repoFullName: issue.repository.fullName,
          issueNumber: issue.number,
          issueId: issue.id,
          beforeLabels: issue.labels,
          afterLabels: issue.labels,
          success: true,
          notes: JSON.stringify({ overrideId: issue.admissionOverrideId, wasBaseline, authType: auth.type }),
        },
      }),
    ]);
    return NextResponse.json({ success: true, cleared: true, freshnessReset: wasBaseline });
  } catch (error) {
    return handleApiError("clear admission override", error);
  }
}
