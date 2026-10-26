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
  // a repair opportunity on the PR-fix queue on behalf of an agent. These
  // routes are MAINTAINER-tier (absent from `WORKER_ALLOWLIST`), so a
  // worker-tier credential is refused by `authorizeRequest` before this
  // check — the maintainer bearer is the connector's credential, and the
  // agent it names in the body is bound by the queue hand-out marker below.
  if (auth.type !== "bearer" && auth.type !== "disabled") {
    return errorResponse(
      "Forbidden: pr-fix CI repair requires a bearer token (DISPATCH_AGENT_TOKEN or DISPATCH_MAINTAINER_TOKEN); basic / OIDC sessions cannot repair on behalf of an agent",
      403,
    );
  }

  const limited = enforceRateLimit(`pr-fix-cirepair:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const input = parseCIRepairInput(body);
  if ("error" in input) return errorResponse(input.error, 400);

  // The audit actor falls back to the agent the notice acts FOR: a
  // maintainer bearer that sends no `x-agent-name` header otherwise
  // attributes every row to the literal placeholder "agent". A bound
  // worker credential keeps its immutable token-derived identity.
  const auditActor = getAuthorizedActor(auth, request, input.agentName);

  const scopeError = await enforceWorkerAgentScope(auth, input.agentName);
  if (scopeError) return scopeError;

  // The body's `agentName` names the agent the notice acts FOR and is never
  // compared with the authenticated actor. A maintainer credential may act for
  // any agent (see `enforceWorkerAgentScope`), and the identity such a
  // credential carries is a placeholder — the literal "agent" for a
  // maintainer bearer that sends no `x-agent-name` header — so the
  // comparison rejected every well-formed request. The requested agent is
  // authorized by the QUEUE binding instead: the lifecycle resolves the row
  // through the hand-out marker `<agentName>@<generation>` next-task wrote,
  // and an agent with no live hand-out there answers `opportunity-missing`.

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
