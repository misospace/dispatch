// (#1495) Source-neutral agent execution observation endpoint — the Courier
// (#637) wire contract, accepted natively.
//
// POST /api/agent-work/observations — report an execution observation
// (create, update, idempotent replay, or stale-ack) keyed by the durable run
// UID. Semantics and fencing live in src/lib/agent-executions.ts. Per-item
// failures are 400 (invalid_report) or 409 (execution_terminal /
// stale_report) — NEVER 404/405/501, which the source latches as "route
// unsupported" for the whole process. Auth failures are 401/403.
//
// GET /api/agent-work/observations — active-execution list for the operator
// Agents page. Maintainer-tier only: the route is absent from
// WORKER_ALLOWLIST for GET, so worker tokens are refused at the tier gate.
//
// Identity boundaries (POST):
// - a BOUND worker credential may only report for its own agent
//   (`enforceWorkerAgentScope`); the legacy UNBOUND worker token carries no
//   identity and is refused (403);
// - maintainers (bearer maintainer / basic / OIDC) may report any agent.
//
// Reports carry no claim receipts, fence tokens, or lease data. Nothing
// here synthesizes AgentWork rows, leases, or ownership state.

import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { authorizeRequest, authErrorResponse, getAuthorizedActor } from "@/lib/auth";
import { enforceWorkerAgentScope } from "@/lib/worker-identity";
import { enforceRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import {
  AgentExecutionError,
  listActiveExecutions,
  reportExecutionObservation,
  validateExecutionObservation,
} from "@/lib/agent-executions";

// Generous per-credential rate limit — sources report observations
// frequently (heartbeats/checkpoints), so this only backstops runaway loops.
const RATE_LIMIT = { limit: 120, windowMs: 60_000 };

export async function GET(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  try {
    const executions = await listActiveExecutions(prisma);
    return NextResponse.json({ executions });
  } catch (error) {
    return handleApiError("list agent executions", error);
  }
}

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(
    `agent-work-observations:${auth.throttleKey}`,
    RATE_LIMIT,
  );
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse("Invalid JSON body", 400);
  }

  // Validate before the identity gate so the scope check compares the same
  // normalized agent name the report is keyed on.
  let input;
  try {
    input = validateExecutionObservation(body);
  } catch (error) {
    if (error instanceof AgentExecutionError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return handleApiError("validate agent execution observation", error, 400);
  }

  // Identity fencing: bound workers only for their own agent; the unbound
  // legacy worker token has no identity and is refused here (403).
  const scopeError = await enforceWorkerAgentScope(auth, input.agentName);
  if (scopeError) return scopeError;

  const actor = getAuthorizedActor(auth, request, input.agentName);

  try {
    const { outcome } = await reportExecutionObservation(prisma, input, {
      actor,
    });
    return NextResponse.json({
      ok: true,
      ...(outcome.status === "created" ? { created: true } : {}),
      ...(outcome.status === "updated" ? { updated: true } : {}),
      ...(outcome.status === "duplicate" ? { duplicate: true } : {}),
      ...(outcome.status === "staleIgnored" ? { staleIgnored: true } : {}),
    });
  } catch (error) {
    if (error instanceof AgentExecutionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return handleApiError("record agent execution observation", error);
  }
}
