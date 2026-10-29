// POST /api/issues/requeue (#1491)
//
// Fenced, idempotent requeue of `implement` (issue) work for Courier's
// explicit operator retry (misospace/courier#608 pins the wire contract).
// The caller presents the claim receipt the run was ISSUED; the release is
// fenced to that exact claim via the durable issuance history (the terminal
// report already released the live lease). The issue returns to offerable
// without consuming anything and without resolving it.
//
// Refusals are the pinned coded-409 vocabulary `{reason: stale-generation |
// superseded | item-closed | human-hold}`; 404 is RESERVED for route
// absence. Success carries `attemptId` only when the server can honestly
// promise one (a lease row existed) — Courier forwards it verbatim.
//
// Auth follows the CI-park family the connector already calls with:
// MAINTAINER tier (absent from `WORKER_ALLOWLIST`) plus the bearer-only
// gate; the requested agent is authorized by the FENCE, and
// `enforceWorkerAgentScope` still scopes any bound worker credential.
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { requeueIssueAttempt, parseIssueRequeueInput } from "@/lib/issue-requeue";
import { authorizeRequest, getAuthorizedActor, authErrorResponse } from "@/lib/auth";
import { enforceWorkerAgentScope } from "@/lib/worker-identity";
import { enforceRateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = { limit: 30, windowMs: 10_000 };

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) {
    return authErrorResponse(auth);
  }

  // Bearer only (or `disabled`, the tokenless dev mode) — same posture as
  // the CI-park family.
  if (auth.type !== "bearer" && auth.type !== "disabled") {
    return errorResponse(
      "Forbidden: issue requeue requires a bearer token (DISPATCH_AGENT_TOKEN or DISPATCH_MAINTAINER_TOKEN); basic / OIDC sessions cannot requeue on behalf of an agent",
      403,
    );
  }

  const limited = enforceRateLimit(`issues-requeue:${auth.throttleKey}`, RATE_LIMIT);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const input = parseIssueRequeueInput(body);
  if ("error" in input) return errorResponse(input.error, 400);

  const auditActor = getAuthorizedActor(auth, request, input.agentName);

  const scopeError = await enforceWorkerAgentScope(auth, input.agentName);
  if (scopeError) return scopeError;

  const audit = async (data: { success: boolean; errorMessage?: string; notes?: string }) => {
    try {
      await prisma.auditLog.create({
        data: {
          actor: auditActor,
          action: "issue_attempt_requeue",
          repoFullName: input.repoFullName,
          issueNumber: input.issueNumber,
          issueId: input.issueId,
          beforeLabels: [],
          afterLabels: [],
          ...data,
        },
      });
    } catch {
      // Audit failure never masks the response.
    }
  };

  try {
    const result = await requeueIssueAttempt({ client: prisma as any, ...input, actor: auditActor });
    if (result.ok) {
      await audit({
        success: true,
        notes:
          `issue requeued (${result.replayed ? "replayed durable settlement" : "committed"}) agent=${input.agentName}` +
          (input.note ? ` note=${input.note}` : ""),
      });
      const payload: Record<string, unknown> = { success: true, replayed: result.replayed };
      // `attemptId` is optional by contract: the server promises an identity
      // only when one existed (a lease row). A bare success is complete in
      // itself — Courier correlates the successor by what it can normalize.
      if (result.attemptId) payload.attemptId = result.attemptId;
      return NextResponse.json(payload);
    }
    if ("refusal" in result) {
      await audit({
        success: false,
        errorMessage: `refused: ${result.refusal}`,
        notes: `code=${result.refusal} agent=${input.agentName}`,
      });
      return NextResponse.json({ reason: result.refusal }, { status: 409 });
    }
    if ("keyConflict" in result) {
      await audit({ success: false, errorMessage: result.keyConflict });
      return errorResponse(result.keyConflict, 409);
    }
    if ("badRequest" in result) {
      await audit({ success: false, errorMessage: result.badRequest });
      return errorResponse(result.badRequest, 400);
    }
    await audit({ success: false, errorMessage: "attempt-requeue unavailable (ledger/guard contention)" });
    return errorResponse("Issue requeue is busy or the settlement ledger is unavailable; retry shortly", 503);
  } catch (error) {
    console.error("Failed to requeue issue attempt:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await audit({ success: false, errorMessage });
    return errorResponse("Failed to requeue issue attempt", 500);
  }
}
