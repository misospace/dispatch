// (#1495) Source-neutral agent execution observation endpoint.
//
// POST /api/agent-executions — report an execution observation (create,
// update, or idempotent replay) keyed by (agentName, executionId). Semantics
// and fencing live in src/lib/agent-executions.ts.
//
// GET /api/agent-executions — capability discovery + active-execution list.
// As a capability surface, the distinction the issue requires is structural:
// a source that does NOT support this capability sees a 404 (route absent),
// while an auth failure is always 401 (unknown/missing credentials) or 403
// (known credential, insufficient tier). Consumers must treat those as
// different answers — 404 means "unsupported", 401/403 mean "supported but
// not authorized", never the reverse.
//
// Identity boundaries:
// - a BOUND worker credential may only report for its own agent
//   (`enforceWorkerAgentScope`); the legacy UNBOUND worker token carries no
//   identity and is refused (403);
// - maintainers (bearer maintainer / basic / OIDC) may report any agent;
// - GET is maintainer-tier: worker tokens are refused at the tier gate
//   (the consumer is the operator Agents page, not the worker loop).
//
// Nothing here synthesizes AgentWork rows, leases, or ownership state.

import { NextResponse } from "next/server";
import { errorResponse, handleApiError } from "@/lib/api-errors";
import { authorizeRequest, authErrorResponse, getAuthorizedActor } from "@/lib/auth";
import { enforceWorkerAgentScope } from "@/lib/worker-identity";
import { enforceRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import {
  AGENT_EXECUTION_CAPABILITY,
  AgentExecutionError,
  listActiveExecutions,
  recordExecutionReport,
  validateExecutionReport,
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
    return NextResponse.json({
      capability: AGENT_EXECUTION_CAPABILITY,
      executions,
    });
  } catch (error) {
    return handleApiError("list agent executions", error);
  }
}

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  const limited = enforceRateLimit(`agent-executions:${auth.throttleKey}`, RATE_LIMIT);
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
  // normalized agentName the report is keyed on.
  let input;
  try {
    input = validateExecutionReport(body);
  } catch (error) {
    if (error instanceof AgentExecutionError) {
      return errorResponse(error.message, error.status);
    }
    return handleApiError("validate agent execution report", error, 400);
  }

  // Identity fencing: bound workers only for their own agent; the unbound
  // legacy worker token has no identity and is refused here (403).
  const scopeError = await enforceWorkerAgentScope(auth, input.agentName);
  if (scopeError) return scopeError;

  const actor = getAuthorizedActor(auth, request, input.agentName);

  try {
    const { outcome, execution } = await recordExecutionReport(prisma, input, {
      actor,
    });
    return NextResponse.json({
      ok: true,
      created: outcome.status === "created",
      ...(outcome.status === "duplicate" ? { duplicate: true } : {}),
      execution,
    });
  } catch (error) {
    if (error instanceof AgentExecutionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return handleApiError("record agent execution report", error);
  }
}
