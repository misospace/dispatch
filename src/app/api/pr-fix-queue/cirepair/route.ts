import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { ciRepairPrFixItem, parseCIRepairInput } from "@/lib/pr-fix-ci-park";
import { normalizeQueueRepo } from "@/lib/pr-fix-queue";
import { authorizeRequest, getAuthorizedActor, authErrorResponse } from "@/lib/auth";
import { enforceWorkerAgentScope } from "@/lib/worker-identity";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 };

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  // Bearer only (or `disabled`, the tokenless dev mode): the outcome settles
  // a repair opportunity on the PR-fix queue on behalf of an agent, the same
  // identity gate the ack route enforces.
  if (auth.type !== "bearer" && auth.type !== "disabled") {
    return errorResponse(
      "Forbidden: pr-fix CI repair requires a bearer token (DISPATCH_AGENT_TOKEN or DISPATCH_WORKER_TOKEN); basic / OIDC sessions cannot repair on behalf of an agent",
      403,
    );
  }

  const limited = enforceRateLimit(`pr-fix-cirepair:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  const auditActor = getAuthorizedActor(auth, request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const input = parseCIRepairInput(body);
  if ("error" in input) return errorResponse(input.error, 400);

  const scopeError = await enforceWorkerAgentScope(auth, input.agentName);
  if (scopeError) return scopeError;

  // The actor is the source of truth for who is settling (the body's
  // agentName is redundant transport identity); a mismatch is a 400 at the
  // ack route's phrasing.
  if (input.agentName !== auth.actor) {
    return errorResponse(
      `Forbidden: agentName in body (${input.agentName}) does not match the authenticated actor (${auth.actor}); the actor identity is authoritative`,
      400,
    );
  }

  try {
    const result = await ciRepairPrFixItem(asPrFixQueueClient(prisma), input);
    if (result.ok) {
      await prisma.auditLog.create({
        data: {
          actor: auditActor,
          action: "pr_fix_ci_repair",
          repoFullName: normalizeQueueRepo(input.repo),
          issueNumber: null,
          success: true,
          beforeLabels: [],
          afterLabels: [],
          notes: `pr=${result.item?.pr ?? "unknown"} generation=${input.generation} result=${input.result}${result.replayed ? " replayed=true" : ""} agent=${input.agentName}`,
        },
      });
      return new NextResponse(null, { status: 204 });
    }
    if (result.reason === "generation-mismatch") {
      return errorResponse(
        `PR fix queue item generation mismatch: expected generation ${input.generation} did not match the item's current generation`,
        409,
      );
    }
    await prisma.auditLog.create({
      data: {
        actor: auditActor,
        action: "pr_fix_ci_repair",
        repoFullName: normalizeQueueRepo(input.repo),
        issueNumber: null,
        success: false,
        errorMessage: `refused: ${result.reason}`,
        beforeLabels: [],
        afterLabels: [],
        notes: `generation=${input.generation} result=${input.result} code=${result.reason} agent=${input.agentName}`,
      },
    });
    return NextResponse.json({ reason: result.reason }, { status: 409 });
  } catch (error) {
    console.error("Failed to settle PR fix queue item CI repair:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await prisma.auditLog.create({
      data: {
        actor: auditActor,
        action: "pr_fix_ci_repair",
        repoFullName: "unknown",
        success: false,
        errorMessage,
        beforeLabels: [],
        afterLabels: [],
      },
    });

    return errorResponse("Failed to settle PR fix queue item CI repair", 500);
  }
}
