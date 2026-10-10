import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma, asPrFixQueueClient } from "@/lib/prisma";
import { ackPrFixHandout, parseAckPrFixHandoutInput } from "@/lib/pr-fix-queue";
import { authorizeRequest, authErrorResponse } from "@/lib/auth";
import { enforceWorkerAgentScope } from "@/lib/worker-identity";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 } as const;

/**
 * Acknowledge a PR-fix hand-out (#1211). A worker calls this after it has
 * durably materialized its attempt (created the run that owns the work) so the
 * stale hand-out reclaimer knows the stamped generation was not lost. The write
 * is generation-pinned and idempotent: a repeat ack is a 200, not an error.
 *
 * Auth tier (#1211 / #1207 review): the ack carries a worker identity that
 * must match an entry in `agentHandouts` for the stamped generation — a basic
 * or OIDC session user with a maintainer tier could otherwise forge an ack
 * for any (repo, pr, generation) by submitting a body alone. The route
 * therefore restricts to bearer auth (or `disabled`, the tokenless dev mode)
 * and additionally requires the worker-tier caller to be **bound** to the
 * agent it is acking for (`enforceWorkerAgentScope`). The legacy unbound
 * `DISPATCH_WORKER_TOKEN` resolves its actor from the caller-controlled
 * `x-agent-name` header, so without the bound gate a holder of the shared
 * legacy token could spoof an ack for any other agent and strand the real
 * worker's attempt by pinning `handoutAcks` against it. Maintainer-tier
 * bearers (DISPATCH_AGENT_TOKEN / DISPATCH_MAINTAINER_TOKEN) pass through
 * unchanged — they may ack for any agent the hand-out table actually
 * stamped, which keeps the operator escape hatch for the reclaimer sweep.
 * The body's `agentName` is preserved as a redundant transport signal: a
 * caller-supplied value that disagrees with the bound/header actor is
 * rejected before any DB read so the mismatch surfaces clearly.
 */
export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }
  // Bearer only (#1211 review): a basic / OIDC session is enough to land an
  // ack today because they resolve to maintainer tier. Dev (`disabled`) is
  // accepted to keep local test runs working.
  if (auth.type !== "bearer" && auth.type !== "disabled") {
    return errorResponse(
      "Forbidden: pr-fix ack requires a bearer token (DISPATCH_AGENT_TOKEN or DISPATCH_WORKER_TOKEN); basic / OIDC sessions cannot ack on behalf of an agent",
      403,
    );
  }

  const limited = enforceRateLimit(`pr-fix-ack:${auth.actor}`, RATE_LIMIT);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const input = parseAckPrFixHandoutInput(body);
  if ("error" in input) return errorResponse(input.error, 400);

  // Identity scope (#1207 review): a worker-tier bearer must be bound to the
  // agent it is acking for. The legacy `DISPATCH_WORKER_TOKEN` has no
  // binding and is refused here, so a holder of the shared legacy token
  // cannot spoof an ack for any other agent. Maintainer-tier bearers
  // (DISPATCH_AGENT_TOKEN / DISPATCH_MAINTAINER_TOKEN) pass through — they
  // may ack for any agent the hand-out table actually stamped.
  const scopeError = await enforceWorkerAgentScope(auth, input.agentName);
  if (scopeError) return scopeError;

  // The actor is the source of truth for who is acking. A mismatch with the
  // body's `agentName` is a 400 — the caller has misconfigured its transport.
  if (input.agentName !== auth.actor) {
    return errorResponse(
      `Forbidden: agentName in body (${input.agentName}) does not match the authenticated actor (${auth.actor}); the actor identity is authoritative`,
      400,
    );
  }

  try {
    const result = await ackPrFixHandout(asPrFixQueueClient(prisma), input);
    if (result.acknowledged) {
      return NextResponse.json({ acknowledged: true, item: result.item });
    }
    switch (result.reason) {
      case "already-acknowledged":
        // Idempotent: a retry after a lost response must not error.
        return NextResponse.json({ acknowledged: true, alreadyAcknowledged: true });
      case "not-found":
        return errorResponse("pr-fix item not found", 404);
      case "generation-mismatch":
        return NextResponse.json(
          { error: "PR fix queue item generation mismatch", reason: result.reason },
          { status: 409 },
        );
      case "not-queued":
        return NextResponse.json(
          { error: "PR fix queue item is not QUEUED", reason: result.reason },
          { status: 409 },
        );
      case "not-stamped":
        return NextResponse.json(
          { error: "PR fix queue item has no live hand-out at that generation", reason: result.reason },
          { status: 409 },
        );
      case "not-handed":
        // A bare-agentName ack from an authenticated actor that doesn't
        // appear in the item's hand-out records — a token that never
        // received the work cannot pin a future reclaim against it.
        return NextResponse.json(
          {
            error: "PR fix queue item was not handed to the authenticated agent at that generation",
            reason: result.reason,
          },
          { status: 403 },
        );
    }
  } catch (error) {
    console.error("Failed to acknowledge pr-fix hand-out:", error);
    return errorResponse("Failed to acknowledge pr-fix hand-out", 500);
  }
}
