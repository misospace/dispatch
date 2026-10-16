import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { rejectAgentCaller } from "@/lib/operator-only";
import { errorResponse } from "@/lib/api-errors";
import { normalizeQueueRepo, externalWaitCooldownMs } from "@/lib/pr-fix-queue";
import {
  evaluateExternalWaitTrigger,
  parseStoredExternalWait,
  type ExternalWaitEvaluation,
} from "@/lib/pr-fix-external-wait";

/**
 * Read-only external-wait trigger evaluation (#1250).
 *
 * `GET /api/pr-fix-queue/external-wait?repo=org/repo&pr=42` evaluates the
 * item's recorded structured wait against live forge state and reports
 * whether the recovery trigger is satisfied — without mutating anything.
 * A later recovery worker decides on this contract; here it is only
 * exposed. Unverifiable dependencies (external_service, fetch failures,
 * in-flight checks) evaluate to "unknown": held, never silently ready.
 */
export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }
  const agentBlocked = rejectAgentCaller(auth, "external-wait evaluation");
  if (agentBlocked) return agentBlocked;

  const repo = new URL(request.url).searchParams.get("repo");
  const pr = Number(new URL(request.url).searchParams.get("pr"));
  if (!repo || !Number.isInteger(pr) || pr <= 0) {
    return errorResponse("repo and pr query parameters are required (pr must be a positive integer)", 400);
  }

  const item = await prisma.prFixQueueItem.findUnique({ where: { repo_pr: { repo: normalizeQueueRepo(repo), pr } } });
  if (!item) {
    return errorResponse("pr-fix item not found", 404);
  }

  const wait = parseStoredExternalWait(item.externalWait);
  if (item.status !== "WAITING_EXTERNAL") {
    return errorResponse(`item is ${item.status}, not WAITING_EXTERNAL`, 409);
  }
  if (!wait) {
    return NextResponse.json({
      item: { repo: item.repo, pr: item.pr, status: item.status },
      wait: null,
      legacyWait: true,
      evaluation: "unknown" as ExternalWaitEvaluation,
      reason: "legacy free-text wait without a structured dependency contract (#1250); operator action required",
      recheckAt: item.retryAt,
      cooldownMs: externalWaitCooldownMs(),
    });
  }

  const evaluation = await evaluateExternalWaitTrigger(wait, item.repo);
  return NextResponse.json({
    item: { repo: item.repo, pr: item.pr, status: item.status },
    wait,
    legacyWait: false,
    evaluation,
    recheckAt: item.retryAt,
    cooldownMs: externalWaitCooldownMs(),
  });
}
