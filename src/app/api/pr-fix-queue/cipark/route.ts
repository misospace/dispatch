import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { ciParkPrFixItem, parseCIParkInput } from "@/lib/pr-fix-ci-park";
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

  // Bearer only (or `disabled`, the tokenless dev mode): the park announces a
  // deferral on the PR-fix queue on behalf of an agent, the same identity gate
  // the ack route enforces.
  if (auth.type !== "bearer" && auth.type !== "disabled") {
    return errorResponse(
      "Forbidden: pr-fix CI park requires a bearer token (DISPATCH_AGENT_TOKEN or DISPATCH_WORKER_TOKEN); basic / OIDC sessions cannot park on behalf of an agent",
      403,
    );
  }

  const limited = enforceRateLimit(`pr-fix-cipark:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  const auditActor = getAuthorizedActor(auth, request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const input = parseCIParkInput(body);
  if ("error" in input) return errorResponse(input.error, 400);

  const scopeError = await enforceWorkerAgentScope(auth, input.agentName);
  if (scopeError) return scopeError;

  // The actor is the source of truth for who is parking (the body's agentName
  // is redundant transport identity); a mismatch is a 400 at the ack route's
  // phrasing.
  if (input.agentName !== auth.actor) {
    return errorResponse(
      `Forbidden: agentName in body (${input.agentName}) does not match the authenticated actor (${auth.actor}); the actor identity is authoritative`,
      400,
    );
  }

  try {
    const result = await ciParkPrFixItem(asPrFixQueueClient(prisma), input);
    if (result.ok) {
      await prisma.auditLog.create({
        data: {
          actor: auditActor,
          action: "pr_fix_ci_park",
          repoFullName: normalizeQueueRepo(input.repo),
          issueNumber: null,
          success: true,
          beforeLabels: [],
          afterLabels: [],
          notes: `pr=${result.item?.pr ?? "unknown"} generation=${input.generation} result=${result.replayed ? "replayed" : "committed"} agent=${input.agentName}`,
        },
      });
      return new NextResponse(null, { status: 204 });
    }
    // The legacy generation fence answers the mark family's exact literal —
    // Courier superseded sniff matches substrings "generation mismatch" /
    // "expected generation", so the body must carry it verbatim.
    if (result.reason === "generation-mismatch") {
      return errorResponse(
        `PR fix queue item generation mismatch: expected generation ${input.generation} did not match the item's current generation`,
        409,
      );
    }
    // A refusal is an audit event for the coordinator's lifecycle observer
    // (bounded by the route's rate limit), structured like the denial audits
    // around it; it never settles anything.
    await prisma.auditLog.create({
      data: {
        actor: auditActor,
        action: "pr_fix_ci_park",
        repoFullName: normalizeQueueRepo(input.repo),
        issueNumber: null,
        success: false,
        errorMessage: `refused: ${result.reason}`,
        beforeLabels: [],
        afterLabels: [],
        notes: `generation=${input.generation} code=${result.reason} agent=${input.agentName}`,
      },
    });
    return NextResponse.json({ reason: result.reason }, { status: 409 });
  } catch (error) {
    console.error("Failed to park PR fix queue item for CI:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await prisma.auditLog.create({
      data: {
        actor: auditActor,
        action: "pr_fix_ci_park",
        repoFullName: "unknown",
        success: false,
        errorMessage,
        beforeLabels: [],
        afterLabels: [],
      },
    });

    return errorResponse("Failed to park PR fix queue item for CI", 500);
  }
}
